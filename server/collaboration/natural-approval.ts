import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { directControlText } from "../integrations/dingtalk/text-actions.ts";
import { readApprovalPresentation, type ApprovalPresentation } from "./approval-presentation.ts";
import { redactSensitiveText } from "./sensitive-text.ts";
import type { OwnerActionOutcome } from "./actions.ts";

export interface NaturalApprovalIntent { action: "accept" | "reject"; topic: string; reason?: string; contextual: boolean }
export interface NaturalApprovalQuestion {
  kind: "choose" | "reason";
  action: "accept" | "reject";
  presentationIds: string[];
  ownerBindingId: string;
  ownerGeneration: number;
  expiresAt: number;
}
export interface NaturalApprovalOutcome extends OwnerActionOutcome {
  kind: "natural_approval";
  approvalPresentationId?: string;
  question?: NaturalApprovalQuestion;
}
interface Display { id: string; source_event_id: string; sent_at: number; delivery_sequence: number }
export interface ShownApproval { proof: ApprovalPresentation; name: string }

export function naturalApprovalHash(message: DingTalkInboundMessage): string {
  return createHash("sha256").update(JSON.stringify({ kind: "natural_approval", sourceEventId: message.sourceEventId,
    conversationId: message.conversationId, text: message.text, addressedToBot: message.addressedToBot,
    senderCorpId: message.sender.senderCorpId ?? null, senderStaffId: message.sender.senderStaffId ?? null,
    senderId: message.sender.senderId, resources: message.resources ?? [], replyToSourceEventId: message.replyToSourceEventId ?? null,
  })).digest("hex");
}

function topic(text: string): string {
  return text.trim().replace(/[。！!]$/u, "").replace(/(?:的)?(?:(?:这次|本次|这个|那个|这项|那项)(?:的)?)?(?:改动|修改|结果)$/u, "")
    .replace(/(?:这个|那个|这项|那项)$/u, "").trim();
}

/** A direct utterance conveys intent only. Quoted text, conditions, attachments
 * and platform reply IDs without a verified outbound mapping never authorize. */
export function parseNaturalApproval(message: DingTalkInboundMessage): NaturalApprovalIntent | null {
  const value = directControlText(message);
  if (value === null || message.replyToSourceEventId || /WI-|[`"“”「」<>?？]/iu.test(value)) return null;
  const text = value.replace(/[。！!]$/u, "");
  if (/^(?:可以[，,]?就按这次改动来|同意[，,]?就按这次改动来|可以|同意|好的?)$/u.test(text)) {
    return { action: "accept", topic: "", contextual: true };
  }
  const reject = /^(?:请)?(?:退回|不同意)([^，,：:]*?)(?:[，,：:]\s*(?:因为|原因是[：:]?)?(.{1,2000}))?$/u.exec(text);
  if (reject) return { action: "reject", topic: topic(reject[1]), ...(reject[2] ? { reason: reject[2].trim() } : {}), contextual: false };
  const accept = /^(?:请)?(?:批准|同意)(.{0,100})$/u.exec(text);
  if (!accept || /如果|但是|不过|前提|之后|先|再|等|不|[，,；;]/u.test(accept[1])) return null;
  return { action: "accept", topic: topic(accept[1]), contextual: false };
}

/** Feedback is data answering an already delivered, fixed-target rejection
 * question. This helper never selects an action or confers Owner authority.
 * Do not mistake a changed decision, a new question or quoted instructions for
 * feedback merely because the text starts with "因为". */
export function rejectionFeedback(text: string): string | null {
  const value = text.trim().replace(/^(?:因为|原因是|退回原因[是为]?)\s*[：:]?\s*/u, "").trim();
  if (value.length < 4 || value.length > 2000 || /[\r\n\p{Cf}?？`"“”「」<>]|WI-/iu.test(value)) return null;
  const compact = value.replace(/[\s，,。！!、]/gu, "");
  if (/^(?:好的?|可以|行|收到|谢谢|了解|明白|嗯|哦|ok)+$/iu.test(compact)) return null;
  if (/^(?:请|先|暂时)?(?:等(?:等|一下|一会)?|暂停|恢复|取消|重试|批准|同意|部署|合并|接受|继续|算了)/u.test(value) ||
      /(?:不|别|勿)(?:用|要|必|再|想)?(?:退回?|拒绝)|改(?:成|为)(?:批准|同意|接受)|改(?:变)?主意|(?:先|暂时)不(?:改|处理)/u.test(value)) return null;
  if (/^(?:为什么|为何|怎么|如何|什么|谁|哪[个些里]|多久|什么时候|何时|能否|是否|可不可以|可以不可以|现在到哪|进度|状态)/u.test(value) ||
      /(?:吗|呢|在问什么|什么意思|怎么回事|什么情况)[。！!]?$/u.test(value)) return null;
  if (/^(?:另外|还有|新任务|另一个|换个|不是这件|我说的是|他说|她说|他们说|据说|文档|原文|示例|引用)/u.test(value) ||
      /(?:这个|那个|这项|那项)(?:问题|改动)?[。！!]?$/u.test(value)) return null;
  return value;
}

export function approvalConversation(db: DatabaseSync, externalId: string): string | null {
  return (db.prepare("SELECT conversation_id FROM collaboration_conversation_aliases WHERE source='dingtalk' AND external_id=?")
    .get(externalId) as { conversation_id: string } | undefined)?.conversation_id ?? null;
}

/** Uses real persisted destinations, not latest task ordering or user titles. */
export function latestApprovalConversationDisplay(db: DatabaseSync, conversationId: string): Display | null {
  return db.prepare(`SELECT o.id,o.source_event_id,o.sent_at,o.delivery_sequence FROM collaboration_outbox o
    LEFT JOIN collaboration_work_items w ON w.id=o.aggregate_id AND o.aggregate_type IN ('plan','work_item')
    LEFT JOIN collaboration_external_events e ON e.id=o.aggregate_id AND o.aggregate_type='association'
    LEFT JOIN collaboration_owner_text_commands c ON c.source_event_id=o.source_event_id
    LEFT JOIN collaboration_conversation_aliases a ON a.source='dingtalk' AND a.external_id=json_extract(c.outcome_json,'$.conversationId')
    WHERE o.delivery_state='sent' AND o.superseded_at IS NULL AND COALESCE(a.conversation_id,e.conversation_id,w.conversation_id)=?
    ORDER BY o.delivery_sequence DESC LIMIT 1`).get(conversationId) as unknown as Display | undefined ?? null;
}

export function uninterruptedApprovalDisplay(db: DatabaseSync, conversationId: string, display: Display, receivedAt: number): boolean {
  if (display.sent_at > receivedAt) return false;
  return !db.prepare(`SELECT 1 FROM collaboration_external_events WHERE conversation_id=? AND received_at>=?
    UNION ALL SELECT 1 FROM collaboration_owner_text_commands c JOIN collaboration_conversation_aliases a
      ON a.source='dingtalk' AND a.external_id=json_extract(c.outcome_json,'$.conversationId')
    WHERE a.conversation_id=? AND c.processed_at>=? AND c.source_event_id<>? LIMIT 1`)
    .get(conversationId, display.sent_at, conversationId, display.sent_at, display.source_event_id);
}

export function shownApprovals(db: DatabaseSync, conversationId: string, now: number, receivedAt: number, ids?: string[]): ShownApproval[] {
  const rows = db.prepare("SELECT outbox_id FROM collaboration_approval_presentations WHERE conversation_id=? AND sent_at<=? AND expires_at>? ORDER BY delivery_sequence DESC LIMIT 101")
    .all(conversationId, receivedAt, now) as Array<{ outbox_id: string }>;
  if (rows.length > 100) return [];
  const unique = new Map<string, ShownApproval>();
  for (const row of rows) {
    if (ids && !ids.includes(row.outbox_id)) continue;
    const proof = readApprovalPresentation(db, row.outbox_id, now);
    if (!proof || unique.has(proof.work_item_id)) continue;
    const card = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE id=?").get(row.outbox_id) as { payload_json: string };
    const payload = JSON.parse(card.payload_json);
    const summary = typeof payload.approvalTopic === "string" && payload.approvalTopic.trim() ? payload.approvalTopic : payload.summary;
    const work = db.prepare("SELECT title FROM collaboration_work_items WHERE id=?").get(proof.work_item_id) as { title: string };
    const name = redactSensitiveText(typeof summary === "string" && summary.trim() ? summary : work.title)
      .replace(/WI-[A-Z0-9-]+/giu, "").replace(/\s+/gu, " ").slice(0, 100).trim();
    unique.set(proof.work_item_id, { proof, name: name || "待确认的改动" });
  }
  return [...unique.values()];
}

export function matchingApprovals(shown: ShownApproval[], name: string): ShownApproval[] {
  const normalized = topic(name);
  if (!normalized) return shown;
  if (normalized.length < 2 || normalized.length > 80 || /[\s，,；;?？“”"`]|如果|不是|但是|另外|还有/u.test(normalized)) return [];
  return shown.filter(item => item.name.includes(normalized));
}

export function pendingNaturalApproval(db: DatabaseSync, display: Display, now: number): NaturalApprovalQuestion | null {
  const receipt = db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id=?").get(display.source_event_id) as { outcome_json: string } | undefined;
  if (!receipt) return null;
  const value = JSON.parse(receipt.outcome_json) as NaturalApprovalOutcome;
  return value.kind === "natural_approval" && value.question && value.question.expiresAt > now ? value.question : null;
}

export function naturalApprovalReply(result: NaturalApprovalOutcome, shown: ShownApproval[]): string {
  const name = shown.find(item => item.proof.outbox_id === result.approvalPresentationId)?.name.split(/[，,。；;]/u)[0];
  const change = name ? `「${name}」这项改动` : "这次改动";
  if (result.allowed) return result.action === "accept"
    ? `已批准${change}，相关检查已通过，修改完成。尚未部署或合并。`
    : `已退回${change}，并记录需要调整的内容；接下来会重新整理需求。`;
  if (result.reason === "not_active_owner") return "这项风险改动需要当前负责人决定；我还没有执行审批。";
  if (result.reason === "stable_identity_required") return "暂时无法核实你的钉钉身份，这次没有执行审批。请负责人从已绑定的账号确认。";
  if (result.reason === "owner_not_configured") return "还没有设置负责人，暂时不能执行风险审批。";
  if (result.question?.kind === "reason") return "需要调整哪里？请说明退回原因，我还没有退回这次改动。";
  if (result.question?.kind === "choose") return `你要${result.action === "accept" ? "批准" : "退回"}哪项改动？${shown.slice(0, 3).map(item => `「${item.name}」`).join("、")}。这次还没有执行审批。`;
  return "目前没有能与这句话对应的有效审批结果，可能已更新、过期或尚未确认送达。这次没有执行，请先确认具体改动。";
}
