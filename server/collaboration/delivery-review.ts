import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { parseDingTalkDeliveryReviewRequest } from "../integrations/dingtalk/text-actions.ts";
import { evaluateOwnerPolicy } from "./policy.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { appendControlAudit } from "./audit.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface DeliveryReviewOutcome {
  kind: "delivery_review";
  allowed: boolean;
  duplicate: boolean;
  reason: string;
  ownerGeneration: number | null;
  conversationId: string;
  total: number;
  items: Array<{ outboxId: string; workItemId: string | null; fingerprint: string }>;
}
interface ReviewRow {
  total_count: number;
  id: string; work_item_id: string | null; title: string | null; kind: string; created_at: number;
  payload_json: string; delivery_state: string; attempt: number; last_error: string | null; claim_expires_at: number | null;
  sent_at: number | null; superseded_at: number | null;
}
function fingerprint(row: ReviewRow): string {
  return hash(JSON.stringify([row.id,row.payload_json,row.delivery_state,row.attempt,row.last_error,row.claim_expires_at,row.sent_at,row.superseded_at]));
}
export function isDeliveryReviewEvent(db: DatabaseSync, sourceEventId: string): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=? AND json_extract(outcome_json,'$.kind')='delivery_review'").get(sourceEventId);
}

/** Records only the query and its reply; never changes a target delivery or Work Item. */
export function requestDeliveryReview(db: DatabaseSync, message: DingTalkInboundMessage, now: number, assertActive: () => void): DeliveryReviewOutcome {
  if (!parseDingTalkDeliveryReviewRequest(message)) throw new Error("delivery_review_request_invalid");
  const payloadHash = hash(JSON.stringify({ kind: "delivery_review", conversation: message.conversationId, text: message.text.trim(),
    reply: message.replyToSourceEventId ?? null, corp: message.sender.senderCorpId ?? null, staff: message.sender.senderStaffId ?? null, sender: message.sender.senderId }));
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive(); assertLedgerArmed(db);
    const previous = db.prepare("SELECT payload_hash,outcome_json FROM collaboration_owner_text_commands WHERE source_event_id=?").get(message.sourceEventId) as {payload_hash:string;outcome_json:string} | undefined;
    if (previous && previous.payload_hash !== payloadHash) throw new Error("delivery_review_event_conflict");
    const policy = evaluateOwnerPolicy(db, { sender: message.sender, capability: "delivery.review", now });
    if (previous) {
      const saved = JSON.parse(previous.outcome_json) as DeliveryReviewOutcome;
      db.exec("COMMIT");
      return policy.decision === "allow" && saved.ownerGeneration === policy.ownerGeneration ? { ...saved, duplicate: true }
        : { ...saved, allowed: false, duplicate: true, reason: "not_active_owner", items: [], total: 0 };
    }
    if (db.prepare("SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_attachment_recovery_requests WHERE source_event_id=? UNION ALL SELECT 1 FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?")
      .get(message.sourceEventId,message.sourceEventId,message.sourceEventId,message.sourceEventId)) throw new Error("delivery_review_event_conflict");
    const outcome: DeliveryReviewOutcome = { kind: "delivery_review", allowed: false, duplicate: false, reason: policy.reason,
      ownerGeneration: policy.ownerGeneration, conversationId: message.conversationId, total: 0, items: [] };
    let summary = "只有当前负责人可以核查回复投递情况。此操作不会修改任务或补发消息。";
    if (policy.decision === "allow") {
      const group = db.prepare("SELECT conversation_id FROM collaboration_conversation_aliases WHERE source='dingtalk' AND external_id=?").get(message.conversationId) as {conversation_id:string} | undefined;
      const quoted = message.replyToSourceEventId ? db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? AND conversation_id=?")
        .get(message.replyToSourceEventId, group?.conversation_id ?? "") as {work_item_id:string|null} | undefined : undefined;
      if (message.replyToSourceEventId && !quoted?.work_item_id) {
        outcome.reason = "delivery_review_reference_unavailable";
        summary = "没有找到这条引用对应的当前群事项。请回复原需求再说“查看待核查回复”，不会猜测其他事项。";
      } else {
        const rows = db.prepare("SELECT o.*,w.id AS work_item_id,w.title,COUNT(*) OVER() AS total_count FROM collaboration_outbox o " +
          "LEFT JOIN collaboration_work_items w ON w.id=o.aggregate_id AND o.aggregate_type IN ('work_item','plan') " +
          "LEFT JOIN collaboration_external_events e ON e.source='dingtalk' AND e.id=o.aggregate_id AND o.aggregate_type='association' " +
          "LEFT JOIN collaboration_owner_text_commands q ON q.source_event_id=o.source_event_id AND json_extract(q.outcome_json,'$.kind')='delivery_review' " +
          "WHERE o.source='dingtalk' AND o.sent_at IS NULL AND o.superseded_at IS NULL " +
          "AND (w.conversation_id=? OR e.conversation_id=? OR json_extract(q.outcome_json,'$.conversationId')=?) " +
          "AND (? IS NULL OR w.id=?) AND (o.delivery_state='dead_letter' OR (o.delivery_state='claimed' AND coalesce(o.claim_expires_at,0)<=?) " +
          "OR (o.delivery_state='pending' AND o.attempt>0 AND substr(coalesce(o.last_error,''),1,length('delivery_confirmed_unsent:'))<>'delivery_confirmed_unsent:')) " +
          "ORDER BY o.created_at,o.id LIMIT 6").all(group?.conversation_id ?? "",group?.conversation_id ?? "",message.conversationId,quoted?.work_item_id ?? null,quoted?.work_item_id ?? null,now) as unknown as ReviewRow[];
        outcome.allowed = true; outcome.reason = "delivery_review_returned"; outcome.total = rows[0]?.total_count ?? 0;
        outcome.items = rows.slice(0,5).map(row => ({ outboxId: row.id, workItemId: row.work_item_id, fingerprint: fingerprint(row) }));
        summary = rows.length ? "以下回复需要核查，尚不能确认送达；这不是任务执行失败，也不会据此补发。\n" + rows.slice(0,5).map((row,index) => {
          const title = redactSensitiveText(row.title ?? "问题归属或回复核查").replace(/[\r\n\t]/gu," ").replace(/@/gu,"＠").slice(0,80);
          const labels: Record<string,string> = { primary_status_card:"接收确认", clarification_card:"澄清或说明", plan_status_card:"执行进展", command_status_card:"操作结果", association_choice_card:"事项归属确认" };
          return `${index+1}. ${title} — ${labels[row.kind] ?? "事项回复"}`;
        }).join("\n") + (rows.length>5 ? "\n仅列出最早 5 条，仍有其他待核查回复。可回复具体原需求后再次查询。" : "")
          : "当前范围没有待核查的回复；这不代表历史消息全部送达。";
      }
    }
    appendControlAudit(db,{actorPrincipalId:policy.principalId,requestId:message.sourceEventId,action:"delivery.review",outcome:outcome.allowed?"allow":"deny",policyRule:policy.ruleId,resource:{ownerGeneration:policy.ownerGeneration,shown:outcome.items.length},now});
    db.prepare("INSERT INTO collaboration_owner_text_commands(source_event_id,payload_hash,outcome_json,processed_at) VALUES(?,?,?,?)").run(message.sourceEventId,payloadHash,JSON.stringify(outcome),now);
    enqueueInboundCard(db,{sourceEventId:message.sourceEventId,aggregateType:"association",aggregateId:message.sourceEventId,aggregateVersion:1,now,
      card:{type:"clarification_card",headline:"回复投递核查",workItemId:"",snapshotRevision:0,questions:[],contextSummary:summary}});
    db.exec("COMMIT"); return outcome;
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}

export function isCurrentDeliveryReviewNotice(db: DatabaseSync, row: { source_event_id: string }): boolean {
  const stored = db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id=? AND json_extract(outcome_json,'$.kind')='delivery_review'").get(row.source_event_id) as {outcome_json:string}|undefined;
  if (!stored) return true;
  const outcome = JSON.parse(stored.outcome_json) as DeliveryReviewOutcome;
  if (!outcome.allowed) return true;
  const owner = db.prepare("SELECT generation FROM collaboration_owner_bindings WHERE active=1").get() as {generation:number}|undefined;
  return owner?.generation === outcome.ownerGeneration && outcome.items.every(item => {
    const current = db.prepare("SELECT * FROM collaboration_outbox WHERE id=?").get(item.outboxId) as ReviewRow|undefined;
    return !!current && fingerprint(current) === item.fingerprint;
  });
}
