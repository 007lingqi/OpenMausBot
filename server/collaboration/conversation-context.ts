import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ConversationIntentRequest, ConversationIntentDecision } from "./conversation-intent.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { redactSensitiveText } from "./sensitive-text.ts";
import { DINGTALK_CONVERSATION_TEXT_LIMIT, renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { completedCandidateHasPassedMetaReview } from "./candidate-verification.ts";
import { renderConversationReplyCard, type InboundCard, type ClarificationCard } from "./message-renderer.ts";
import type { NaturalApprovalOutcome } from "./natural-approval.ts";
import { readApprovalPresentation } from "./approval-presentation.ts";
import { explainHistoricalProgress } from "./conversation-explanation.ts";
import { discussionOptionsSchema, renderAdviceDiscussion, renderDiscussionSelection, type DiscussionOptions } from "./discussion-options.ts";

export interface ConversationJob {
  id: string; source_event_id: string; conversation_id: string; principal_id: string; normalized_json: string;
  received_at: number; source_hash: string; requested_work_item_id: string | null; status: string;
  context_outbox_sequence: number;
  target_work_item_id: string | null; proposal_json: string | null;
}
export const conversationSourceHash = (value: string): string => createHash("sha256").update(value).digest("hex");
type HistoryEntry = ConversationIntentRequest["history"][number] & { at: number; order: number; clipped: boolean };
interface SentReply { id: string; payload_json: string; sent_at: number; delivery_sequence: number; work_item_id: string | null;
  principal_id: string | null; created_by: string | null; proposal_json: string | null; natural_approval_json: string | null }

/** Recover a question's purpose only from its complete, delivered branch text.
 * This is conversational context, never permission to execute an action. */
function compoundReadOnlyQuestion(db: DatabaseSync, row: SentReply, proposal: ConversationIntentDecision,
  card: InboundCard, candidates: string[]): ConversationIntentRequest["pendingQuestion"] {
  if (proposal.action !== "route_turn" || card.type !== "command_status_card" || !card.summary ||
    card.summary.trim().length > DINGTALK_CONVERSATION_TEXT_LIMIT) return null;
  const questions = proposal.parts.filter(part => part.decision.action === "ask_context");
  if (!questions.length || questions.some(part => part.decision.action !== "ask_context" ||
    !(["status_query", "explanation", "advice"].includes(part.decision.intent) || part.decision.reason === "pending_read_only"))) return null;
  const parts = z.array(z.object({ ordinal: z.number(), decision_json: z.string(), reply_text: z.string() })).parse(db.prepare(
    "SELECT p.ordinal,p.decision_json,p.reply_text FROM collaboration_turn_parts p JOIN collaboration_outbox o ON o.aggregate_id=p.parent_event_id " +
    "WHERE o.id=? AND o.aggregate_type='association' ORDER BY p.ordinal").all(row.id));
  if (parts.length !== proposal.parts.length || parts.some((part, i) => part.ordinal !== i || part.decision_json !== JSON.stringify(proposal.parts[i].decision))) return null;
  const rendered = z.object({ text: z.string() }).parse(renderDingTalkSessionMessage(card).markdown);
  const texts = parts.filter((_, i) => proposal.parts[i].decision.action === "ask_context").map(part => part.reply_text);
  if (texts.some(text => !text.trim() || !rendered.text.includes(text))) return null;
  const ids = [...new Set(questions.flatMap(part => part.decision.target && candidates.includes(part.decision.target.id) ? [part.decision.target.id] : []))];
  const prompt: NonNullable<ConversationIntentRequest["pendingQuestion"]> = { kind: "read_only", sourceEventId: `outbox:${row.id}`,
    workItemIds: ids.length <= 3 ? ids : [], text: redactSensitiveText(texts.join("；")).slice(0, 500) };
  const origins = questions.map(part => part.decision.action === "ask_context" ? part.decision.origin : undefined);
  if (origins[0] && origins.every(origin => origin === origins[0])) prompt.origin = origins[0];
  return prompt;
}

/** Addressing only: historical aliases are never the current sender's authority. */
function conversationOwner(db: DatabaseSync, principalId: string): { id: string; generation: number } | undefined {
  return db.prepare("SELECT o.id,o.generation FROM collaboration_owner_bindings o " +
    "JOIN collaboration_principal_aliases a ON a.source='dingtalk' AND a.alias_kind='corp_staff' " +
    "AND a.scope_id=o.sender_corp_id AND a.external_id=o.sender_staff_id " +
    "JOIN collaboration_principals p ON p.id=a.principal_id AND p.resolution='resolved' " +
    "WHERE o.active=1 AND a.principal_id=?").get(principalId) as { id: string; generation: number } | undefined;
}

function pendingQuestion(db: DatabaseSync, job: ConversationJob, sent: SentReply[], candidates: string[]): ConversationIntentRequest["pendingQuestion"] {
  const staff = db.prepare("SELECT external_id FROM collaboration_principal_aliases WHERE principal_id=? AND source='dingtalk' AND alias_kind='corp_staff'")
    .all(job.principal_id) as Array<{ external_id: string }>;
  const pending: NonNullable<ConversationIntentRequest["pendingQuestion"]>[] = [];
  for (const row of sent) {
    const card = JSON.parse(row.payload_json) as InboundCard;
    // Requirement questions are resolved by a newer snapshot, not by an
    // unrelated message (including a progress query) from the same person.
    // Other conversational prompts retain their existing turn boundary.
    const intervening = db.prepare("SELECT 1 FROM collaboration_external_events e JOIN collaboration_conversation_intents j ON j.event_id=e.id " +
      "WHERE e.conversation_id=? AND e.principal_id=? AND e.rowid<(SELECT rowid FROM collaboration_external_events WHERE id=?) " +
      "AND j.context_outbox_sequence>=? LIMIT 1").get(job.conversation_id, job.principal_id, job.id, row.delivery_sequence);
    if (intervening && card.type !== "clarification_card") continue;
    let kind: NonNullable<ConversationIntentRequest["pendingQuestion"]>["kind"] | null = null;
    let text = "";
    if (row.natural_approval_json) {
      const receipt = JSON.parse(row.natural_approval_json) as NaturalApprovalOutcome;
      const question = receipt.question, owner = conversationOwner(db, job.principal_id);
      if (question && question.expiresAt > job.received_at && question.ownerBindingId === owner?.id && question.ownerGeneration === owner.generation) {
        const ids = question.presentationIds.map(id => readApprovalPresentation(db, id, job.received_at))
          .filter(proof => proof?.conversation_id === job.conversation_id).map(proof => proof!.work_item_id);
        if (ids.length) return { kind: "approval", sourceEventId: `outbox:${row.id}`, workItemIds: ids,
          text: redactSensitiveText("summary" in card ? card.summary ?? "" : "").slice(0, 500) };
      }
    } else if (card.type === "clarification_card" && row.work_item_id && candidates.includes(row.work_item_id)) {
      const snapshot = readLatestWorkItemSnapshot(db, row.work_item_id);
      if (snapshot?.revision !== card.snapshotRevision) continue;
      const questions = card.questions.filter(question => question.requestedResponder?.targetId
        ? staff.some(alias => alias.external_id === question.requestedResponder!.targetId)
        : row.created_by === job.principal_id);
      if (questions.length) { kind = "requirement"; text = questions.map(question => question.question).join("；"); }
    } else if (card.type === "command_status_card" && card.command === "conversation" && row.principal_id === job.principal_id && row.proposal_json) {
      const proposal = JSON.parse(row.proposal_json) as ConversationIntentDecision;
      const compoundQuestion = compoundReadOnlyQuestion(db, row, proposal, card, candidates);
      if (compoundQuestion) return compoundQuestion;
      const boundaries = proposal.action === "route_turn" ? proposal.parts.filter(part => part.decision.action === "keep_discussing").map(part => part.decision)
        : proposal.action === "keep_discussing" ? [proposal] : [];
      if (boundaries.length) {
        const ids = [...new Set(boundaries.flatMap(boundary => boundary.target && candidates.includes(boundary.target.id) ? [boundary.target.id] : []))];
        return { kind: "read_only", origin: "discussion", sourceEventId: `outbox:${row.id}`,
          workItemIds: ids.length <= 3 ? ids : [], text: redactSensitiveText(card.summary ?? "先讨论当前想法").slice(0, 500), answerExpected: false };
      }
      if (proposal.action === "select_option") return {
        kind: "read_only", origin: "advice", sourceEventId: `outbox:${row.id}`, workItemIds: row.work_item_id ? [row.work_item_id] : [],
        text: proposal.selection.option.title, answerExpected: false,
      };
      // The delivered suggestion remains a discussion even if it asked no new
      // question. Keep its actual summary as context, not a fabricated prompt.
      if (proposal.action === "offer_advice") return {
        kind: "read_only", origin: "advice", sourceEventId: `outbox:${row.id}`, workItemIds: row.work_item_id ? [row.work_item_id] : [],
        text: redactSensitiveText(proposal.advice.question ?? proposal.advice.summary).slice(0, 500),
        ...(proposal.advice.question === null ? { answerExpected: false as const } : {}),
      };
      if (proposal.action === "ask_context") {
        kind = proposal.reason === "pending_approval" ? "approval"
          : ["status_query", "explanation", "advice"].includes(proposal.intent) || proposal.reason === "pending_read_only" ? "read_only" : "association";
        text = card.summary ?? "";
        // A direct question about a read-only/control intent keeps its purpose.
        // Older requirement questions must not turn its next answer into a
        // contribution. Rows are already newest-first, actually delivered and
        // scoped to this person/group, with intervening turns excluded above.
        if (text && (kind === "read_only" || kind === "approval")) {
          const prompt: NonNullable<ConversationIntentRequest["pendingQuestion"]> = {
            kind, sourceEventId: `outbox:${row.id}`, workItemIds: row.work_item_id ? [row.work_item_id] : [],
            text: redactSensitiveText(text).slice(0, 500),
          };
          if (kind === "read_only" && (proposal.intent === "advice" || proposal.origin)) prompt.origin = proposal.origin ?? "advice";
          return prompt;
        }
      }
    } else if (card.type === "plan_status_card" && card.status === "candidate_ready" && row.work_item_id && candidates.includes(row.work_item_id)) {
      // This is only conversational addressing, never control authorization.
      // Owner bindings store stable corp/staff identity, not a principal_id column.
      const owner = conversationOwner(db, job.principal_id);
      if (owner) { kind = "approval"; text = "是否批准当前改动？需要核对动作、影响和风险。"; }
    }
    if (kind && text) pending.push({ kind, sourceEventId: `outbox:${row.id}`, workItemIds: row.work_item_id ? [row.work_item_id] : [], text: redactSensitiveText(text).slice(0, 500) });
  }
  // Never guess which of several outstanding questions a short answer means.
  return pending.length === 1 ? pending[0] : pending.length > 1 ? {
    kind: "association", sourceEventId: pending[0].sourceEventId,
    workItemIds: [...new Set(pending.flatMap(row => row.workItemIds))].slice(0, 3),
    text: "有多个问题等待确认，请说明正在回答哪一个。",
  } : null;
}

export function readConversationContext(db: DatabaseSync, job: ConversationJob): ConversationIntentRequest {
  const normalized = JSON.parse(job.normalized_json) as { text: string; replyToSourceEventId?: string | null };
  const replyId = normalized.replyToSourceEventId ?? null;
  const items = db.prepare("SELECT id,title,version,status FROM collaboration_work_items WHERE conversation_id=? " +
    "ORDER BY (id=?) DESC,updated_at DESC,id LIMIT 21").all(job.conversation_id, job.requested_work_item_id ?? "") as
    Array<{ id: string; title: string; version: number; status: string }>;
  const userSql = "SELECT e.*,e.rowid AS event_order,COALESCE(e.work_item_id,j.target_work_item_id) AS context_item_id FROM collaboration_external_events e " +
    "LEFT JOIN collaboration_conversation_intents j ON j.event_id=e.id AND j.status='applied' " +
    "WHERE e.conversation_id=? AND e.rowid<=(SELECT rowid FROM collaboration_external_events WHERE id=?) " +
    "AND NOT EXISTS(SELECT 1 FROM collaboration_turn_parts p WHERE p.child_event_id=e.id) ";
  type UserRow = { source_event_id: string; principal_id: string; normalized_json: string; context_item_id: string | null; received_at: number; event_order: number };
  const rows = db.prepare(userSql + "ORDER BY e.rowid DESC LIMIT 13").all(job.conversation_id, job.id) as UserRow[];
  const reference = replyId ? db.prepare(userSql + "AND e.source_event_id=?").get(job.conversation_id, job.id, replyId) as UserRow | undefined : undefined;
  if (reference && !rows.some(row => row.source_event_id === replyId)) rows.push(reference);
  const userHistory: HistoryEntry[] = rows.map(row => {
    const text = redactSensitiveText(String(JSON.parse(row.normalized_json).text));
    return { sourceEventId: row.source_event_id, role: "user", principalId: row.principal_id, text: text.slice(0, 2000),
      workItemId: row.context_item_id, at: row.received_at, order: row.event_order,
      clipped: text.length > 2000 && row.source_event_id !== job.source_event_id };
  });
  // Only successful deliveries are model-visible as assistant speech. A queued
  // plan or failed send is not something the person could have replied to.
  const sent = db.prepare("SELECT o.id,o.payload_json,o.sent_at,o.delivery_sequence,w.created_by,e.principal_id,j.proposal_json," +
    "CASE WHEN json_extract(c.outcome_json,'$.kind')='natural_approval' THEN c.outcome_json END AS natural_approval_json," +
    "COALESCE(w.id,j.target_work_item_id,nw.id) AS work_item_id FROM collaboration_outbox o " +
    "LEFT JOIN collaboration_work_items w ON w.id=o.aggregate_id AND o.aggregate_type IN ('work_item','plan') " +
    "LEFT JOIN collaboration_external_events e ON e.id=o.aggregate_id AND o.aggregate_type='association' " +
    "LEFT JOIN collaboration_conversation_intents j ON j.event_id=e.id " +
    "LEFT JOIN collaboration_owner_text_commands c ON c.source_event_id=o.source_event_id AND json_extract(c.outcome_json,'$.kind') IN ('natural_approval','natural_retry') " +
    "LEFT JOIN collaboration_conversation_aliases a ON a.source='dingtalk' AND a.external_id=json_extract(c.outcome_json,'$.conversationId') " +
    "LEFT JOIN collaboration_work_items nw ON nw.id=json_extract(c.outcome_json,'$.workItemId') AND nw.conversation_id=a.conversation_id " +
    "WHERE COALESCE(w.conversation_id,e.conversation_id,a.conversation_id)=? AND o.delivery_state='sent' AND o.delivery_sequence<=? " +
    "ORDER BY o.delivery_sequence DESC LIMIT 13").all(job.conversation_id, job.context_outbox_sequence) as unknown as SentReply[];
  const assistantHistory: HistoryEntry[] = sent.map(row => {
    const card = JSON.parse(row.payload_json);
    const text = redactSensitiveText((renderDingTalkSessionMessage(card).markdown as { text: string }).text);
    const conversation = z.object({ type: z.literal("command_status_card"), command: z.literal("conversation"), summary: z.string() }).safeParse(card);
    const presentationClipped = conversation.success && conversation.data.summary.trim().length > DINGTALK_CONVERSATION_TEXT_LIMIT;
    return { sourceEventId: `outbox:${row.id}`, role: "assistant", principalId: null,
      text: text.slice(0, 2000), workItemId: row.work_item_id, at: row.sent_at, order: row.delivery_sequence, clipped: text.length > 2000 || presentationClipped };
  });
  const merged = [...userHistory, ...assistantHistory].sort((a, b) => a.at - b.at || a.order - b.order);
  const selected = merged.slice(-12);
  const current = userHistory.find(row => row.sourceEventId === job.source_event_id);
  if (current && !selected.includes(current)) { selected.shift(); selected.push(current); }
  const referenced = replyId ? userHistory.find(row => row.sourceEventId === replyId) : undefined;
  if (referenced && !selected.includes(referenced)) { selected.shift(); selected.unshift(referenced); }
  const question = pendingQuestion(db, job, sent, items.slice(0, 20).filter(item => !["accepted", "cancelled"].includes(item.status)).map(item => item.id));
  const questionSource = question ? assistantHistory.find(row => row.sourceEventId === question.sourceEventId) : undefined;
  if (questionSource && !selected.includes(questionSource)) {
    const discard = selected.findIndex(row => row !== current && row !== referenced);
    selected.splice(discard, 1); selected.push(questionSource);
  }
  let discussionOptions: DiscussionOptions | null = null;
  const offerRow = question?.origin === "advice" ? sent.find(row => `outbox:${row.id}` === question.sourceEventId) : undefined;
  if (offerRow?.proposal_json) {
    const proposal = JSON.parse(offerRow.proposal_json) as ConversationIntentDecision;
    const card = JSON.parse(offerRow.payload_json) as InboundCard;
    const expected = proposal.action === "offer_advice" ? renderAdviceDiscussion(proposal.advice)
      : proposal.action === "select_option" ? renderDiscussionSelection(proposal.selection) : null;
    if (expected && expected.trim().length <= DINGTALK_CONVERSATION_TEXT_LIMIT && card.type === "command_status_card" && card.command === "conversation" && card.summary === expected &&
      (proposal.action === "offer_advice" || proposal.action === "select_option")) {
      discussionOptions = discussionOptionsSchema.parse({ sourceEventId: `outbox:${offerRow.id}`,
        kind: proposal.action === "select_option" ? "selection" : "offer",
        presentationHash: conversationSourceHash(offerRow.payload_json), workItemId: proposal.target?.id ?? null,
        workItemVersion: proposal.target?.version ?? 0, snapshotRevision: proposal.target?.snapshotRevision ?? 0,
        options: proposal.action === "offer_advice" ? proposal.advice.options : [proposal.selection.option] });
    }
  }
  return { sourceEventId: job.source_event_id, principalId: job.principal_id, text: redactSensitiveText(normalized.text),
    discussionOptions,
    referencedWorkItemId: job.requested_work_item_id, referencedReplyId: replyId, pendingQuestion: question,
    candidates: items.slice(0, 20).map(row => ({ id: row.id, title: redactSensitiveText(row.title), version: row.version,
      snapshotRevision: readLatestWorkItemSnapshot(db, row.id)?.revision ?? 0,
      state: row.status === "accepted" ? "completed" : row.status === "cancelled" ? "cancelled" : "open" })),
    history: selected.map(({ at: _at, order: _order, clipped: _clipped, ...entry }) => entry),
    // A routine recent-history window is disclosed separately from missing
    // evidence needed for this turn; otherwise every busy group deadlocks.
    historyWindowed: merged.length > 12,
    contextTruncated: (items.length > 20 && !job.requested_work_item_id) || selected.some(row => row.clipped) || (!!replyId && !referenced),
  };
}

/** A bounded source excerpt for display, never a replacement requirement. */
function statusTopicExcerpt(value: string): string {
  const title = redactSensitiveText(value).replace(/\bWI-[A-Z0-9-]+\b/giu, "").replace(/\s+/gu, " ").trim();
  if (!title) return "这个问题";
  const boundary = title.search(/[。！？；]/u);
  const firstSentence = boundary >= 6 ? title.slice(0, boundary) : title;
  const excerpt = Array.from(firstSentence).slice(0, 36).join("");
  const omitted = title.slice(excerpt.length).replace(/[。！？；\s]/gu, "").length > 0;
  return `${excerpt}${omitted ? "…" : ""}`;
}

/** Read-only reminder of an actual, still-current question already public in
 * this group when the query arrived. It is not a newly assigned question or
 * authority to treat a later answer as an Owner action. */
function currentClarificationReminder(db: DatabaseSync, workItemId: string, sourceEventId?: string): string | null {
  if (!sourceEventId) return null;
  const context = db.prepare("SELECT j.context_outbox_sequence,w.version FROM collaboration_conversation_intents j " +
    "JOIN collaboration_external_events e ON e.id=j.event_id JOIN collaboration_work_items w ON w.id=j.target_work_item_id " +
    "WHERE e.source='dingtalk' AND e.source_event_id=? AND j.target_work_item_id=? AND j.status='applied' " +
    "AND json_extract(j.proposal_json,'$.action')='read_status' AND e.conversation_id=w.conversation_id")
    .get(sourceEventId, workItemId) as { context_outbox_sequence: number; version: number } | undefined;
  const snapshot = context ? readLatestWorkItemSnapshot(db, workItemId) : null;
  if (!context || !snapshot || snapshot.sourceWorkItemVersion !== context.version) return null;
  const delivery = db.prepare("SELECT o.payload_json,r.questions_json FROM collaboration_outbox o " +
    "JOIN collaboration_clarification_rounds r ON r.work_item_id=o.aggregate_id AND r.snapshot_revision=? " +
    "WHERE o.aggregate_type='plan' AND o.aggregate_id=? AND o.delivery_state='sent' AND o.sent_at IS NOT NULL " +
    "AND o.delivery_sequence<=? AND json_extract(o.payload_json,'$.type')='clarification_card' " +
    "AND json_extract(o.payload_json,'$.workItemId')=? AND json_extract(o.payload_json,'$.snapshotRevision')=? " +
    "ORDER BY o.delivery_sequence DESC LIMIT 1")
    .get(snapshot.revision, workItemId, context.context_outbox_sequence, workItemId, snapshot.revision) as
      { payload_json: string; questions_json: string } | undefined;
  if (!delivery) return null;
  const card = JSON.parse(delivery.payload_json) as ClarificationCard;
  const round = JSON.parse(delivery.questions_json) as Array<{ id: string; question: string }>;
  const questions = card.questions.filter(question => question.id.startsWith("natural-") &&
    !["natural-input-pending", "natural-context-incomplete"].includes(question.id) &&
    snapshot.blockingAmbiguities.some(current => current.id === question.id && current.question === question.question) &&
    round.some(current => current.id === question.id && current.question === question.question));
  if (!questions.length) return null;
  const text = redactSensitiveText(questions[0].question).replace(/\bWI-[A-Z0-9-]+\b/giu, "").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  const excerpt = Array.from(text).slice(0, 120).join("");
  const label = excerpt.length < text.length ? `原问题摘录：「${excerpt}…」` : `待确认的问题是：「${text}」`;
  return `尚未开始修改。${label}${questions.length > 1 ? `；另有${questions.length - 1}个问题待确认。` : ""}`;
}

/** This is a point-in-time read, not a new execution or an Owner action. */
export function conversationStatus(db: DatabaseSync, workItemId: string, sourceEventId?: string): string {
  const row = db.prepare("SELECT title,status,definition_status,control_state,current_plan_revision,accepted_candidate_sha FROM collaboration_work_items WHERE id=?")
    .get(workItemId) as { title: string; status: string; definition_status: string; control_state: string; current_plan_revision: number | null; accepted_candidate_sha: string | null } | undefined;
  if (!row) return "暂时找不到这个问题的进度，请说一下具体的问题。";
  // Display-only excerpt: full source text and routing candidates stay intact.
  const title = statusTopicExcerpt(row.title);
  let progress: string;
  if (row.status === "cancelled" || row.control_state === "cancelled") progress = "已取消，不会继续修改。";
  else if (row.control_state === "paused") progress = "已暂停，需要负责人决定是否继续。";
  else if (row.status === "accepted") {
    const target = db.prepare("SELECT r.id FROM collaboration_runs r JOIN collaboration_candidates c ON c.run_id=r.id " +
      "WHERE r.work_item_id=? AND r.plan_revision=? AND c.result_sha=? AND r.status='succeeded' ORDER BY r.started_at DESC LIMIT 1")
      .get(workItemId, row.current_plan_revision, row.accepted_candidate_sha) as { id: string } | undefined;
    progress = target && row.accepted_candidate_sha && completedCandidateHasPassedMetaReview(db, target.id, row.accepted_candidate_sha)
      ? "修改完成，相关检查已通过。"
      : "有结果记录，但目前还不能核对完整验证依据，不能据此确认修改完成。";
  } else {
    const run = db.prepare("SELECT status FROM collaboration_runs WHERE work_item_id=? AND plan_revision=? ORDER BY started_at DESC LIMIT 1")
      .get(workItemId, row.current_plan_revision) as { status: string } | undefined;
    if (run?.status === "running") progress = "正在修改或检查，还没有完成。";
    else if (run && ["failed", "invalid", "needs_configuration", "timed_out"].includes(run.status)) progress = "这次执行没有完成，需要负责人核查后决定下一步。";
    else if (run?.status === "succeeded") progress = "已有改动结果，正在核对验证和确认条件，还不能标记完成。";
    else if (row.definition_status === "waiting_clarification") progress = currentClarificationReminder(db, workItemId, sourceEventId)
      ?? "还需要补充信息，确认后才能开始修改。";
    else progress = ({ collecting: "正在整理需求，还没有开始修改。",
      planning: "正在整理修改方案，还没有开始修改。", ready_for_execution: "修改方案已整理好，等待开始执行。",
      planning_failed: "修改方案还没有整理完成，目前没有开始修改。" } as Record<string, string>)[row.definition_status] ?? "最新进度还需要核查。";
  }
  return `关于「${title}」：${progress}`;
}

/** Freeze the actual point-in-time answer immediately before its first send.
 * Once a transmission has been attempted its idempotent payload cannot change. */
export function refreshConversationStatusReply(db: DatabaseSync, row: { id: string; source_event_id: string; aggregate_id: string; payload_json: string; attempt: number }): boolean {
  if (!row.source_event_id.startsWith("conversation:")) return true;
  const context = db.prepare("SELECT j.proposal_json,j.target_work_item_id,e.conversation_id,w.conversation_id AS target_group " +
    "FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id " +
    "LEFT JOIN collaboration_work_items w ON w.id=j.target_work_item_id WHERE j.event_id=? AND j.status IN ('applied','routed','failed') AND e.source_event_id=?")
    .get(row.aggregate_id, row.source_event_id.slice("conversation:".length)) as {
      proposal_json: string | null; target_work_item_id: string | null; conversation_id: string; target_group: string | null;
    } | undefined;
  if (!context?.proposal_json) return true;
  const result = JSON.parse(context.proposal_json) as ConversationIntentDecision;
  if (result.action !== "read_status" && result.action !== "route_turn") return true;
  let text: string;
  if (result.action === "route_turn") {
    if (!result.parts.some(part => part.decision.action === "read_status")) return true;
    for (const part of result.parts) if (part.decision.target && !db.prepare("SELECT 1 FROM collaboration_work_items WHERE id=? AND conversation_id=?")
      .get(part.decision.target.id, context.conversation_id)) return false;
    // SAFETY: migration 41 declares these three selected columns as NOT NULL
    // INTEGER/TEXT in a STRICT table; binding checks below reject mismatches.
    const parts = db.prepare("SELECT ordinal,decision_json,reply_text FROM collaboration_turn_parts WHERE parent_event_id=? ORDER BY ordinal").all(row.aggregate_id) as Array<{ ordinal: number; decision_json: string; reply_text: string }>;
    if (parts.length !== result.parts.length || parts.some((part, i) => part.ordinal !== i || part.decision_json !== JSON.stringify(result.parts[i].decision))) return false;
    text = parts.map((part, i) => result.parts[i].decision.action === "read_status"
      ? conversationStatus(db, result.parts[i].decision.target!.id, result.sourceEventId) : part.reply_text).join("\n\n");
  } else {
    if (!context.target_work_item_id || context.conversation_id !== context.target_group) return false;
    text = conversationStatus(db, context.target_work_item_id, row.source_event_id.slice("conversation:".length));
  }
  const payload = JSON.stringify(renderConversationReplyCard(text));
  if (payload === row.payload_json) return true;
  if (row.attempt !== 1) return false;
  const updated = db.prepare("UPDATE collaboration_outbox SET payload_json=? WHERE id=? AND delivery_state='claimed' AND attempt=1 AND sent_at IS NULL")
    .run(payload, row.id);
  if (!updated.changes) return false;
  row.payload_json = payload;
  return true;
}

/** Names are display hints, never numbered choices or association authority. */
function clarificationTopics(db: DatabaseSync, request: ConversationIntentRequest | undefined): string[] {
  if (!request || request.contextTruncated || !request.candidates.length || request.candidates.length > 3) return [];
  const source = db.prepare("SELECT conversation_id FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? AND principal_id=?")
    .get(request.sourceEventId, request.principalId) as { conversation_id: string } | undefined;
  if (!source) return [];
  const topics: string[] = [];
  for (const offered of request.candidates) {
    const current = db.prepare("SELECT title,version FROM collaboration_work_items WHERE id=? AND conversation_id=?")
      .get(offered.id, source.conversation_id) as { title: string; version: number } | undefined;
    if (!current || current.version !== offered.version ||
      (readLatestWorkItemSnapshot(db, offered.id)?.revision ?? 0) !== offered.snapshotRevision) return [];
    const title = statusTopicExcerpt(current.title);
    if (title === "这个问题" || topics.includes(title)) return [];
    topics.push(title);
  }
  return topics;
}

export function conversationTurnReply(db: DatabaseSync, result: Extract<ConversationIntentDecision, { action: "route_turn" }>, request?: ConversationIntentRequest): string {
  return result.parts.map(part => {
    if (["create_work", "contribute"].includes(part.decision.action)) {
      const title = statusTopicExcerpt(part.decision.target?.title ?? part.text);
      return `「${title}」：已记录这项需求，尚未完成修改。`;
    }
    return conversationReply(db, part.decision, request ? { ...request, text: part.text } : undefined);
  }).join("\n\n");
}

export function conversationReply(db: DatabaseSync, result: ConversationIntentDecision, request?: ConversationIntentRequest): string {
  if (result.action === "keep_discussing") return result.target
    ? `关于「${statusTopicExcerpt(result.target.title)}」，先讨论想法，不发起这项新改动。`
    : "先讨论这个想法，不发起这项新改动。";
  if (result.action === "ask_context" && result.reason === "compound_discussion") return "这条消息里的方案和其他事项还没能分别关联。请先说要继续哪一项；目前没有执行修改。";
  if (result.action === "offer_advice") return renderAdviceDiscussion(result.advice);
  if (result.action === "select_option") return renderDiscussionSelection(result.selection);
  if (result.action === "acknowledge") return "不客气，有需要继续说。";
  if (result.action === "control_requires_authorization") return "这涉及控制或审批操作，需要由负责人确认具体动作和影响；目前没有执行。";
  if (result.action === "read_status" && result.target) return conversationStatus(db, result.target.id, result.sourceEventId);
  if (result.action === "explain_reply" && result.reply) {
    const row = db.prepare("SELECT o.payload_json,j.proposal_json FROM collaboration_outbox o " +
      "LEFT JOIN collaboration_external_events e ON o.aggregate_type='association' AND e.id=o.aggregate_id AND e.source='dingtalk' AND o.source_event_id='conversation:'||e.source_event_id " +
      "LEFT JOIN collaboration_conversation_intents j ON j.event_id=e.id AND j.status='applied' " +
      "WHERE o.id=? AND o.delivery_state='sent'")
      .get(result.reply.sourceEventId.replace(/^outbox:/u, "")) as { payload_json: string; proposal_json: string | null } | undefined;
    if (!row) return "我还不能确认你指的是哪条回复，请说一下其中的内容。";
    const card = JSON.parse(row.payload_json) as { type: string; status?: string; command?: string; summary?: string };
    if (card.type === "command_status_card" && card.command === "conversation" && typeof card.summary === "string" &&
      row.proposal_json && (JSON.parse(row.proposal_json) as ConversationIntentDecision).action === "read_status") {
      const meaning = explainHistoricalProgress(card.summary);
      if (meaning) return meaning;
    }
    if (card.type === "clarification_card") return "之前的回复是在确认还缺哪些信息：需要先回答其中会影响修改结果的问题，并不是说已经改好了。";
    if (card.status === "completed" || card.status === "owner_accepted") return "之前的回复表示当时的修改和检查已完成；它说的是当时那次结果，不代表后来新增的要求也已经处理。";
    if (card.status === "candidate_ready") return "之前的回复表示改动已准备好，但还有风险需要负责人确认，任务尚未完成。";
    if (card.status === "planning" || card.status === "ready_for_execution") return "之前的回复是在说明准备进度，并不是修改已经完成；执行和检查后才会给出结果。";
    return `之前的回复内容是：${redactSensitiveText(result.reply.text).slice(0, 700)}\n这只是说明之前的消息，不会因此重新修改。`;
  }
  if (result.action === "ask_context" && result.reason === "missing_reply") return "你想了解哪条回复的意思？说一下其中的内容就行。";
  if (result.action === "ask_context" && request?.discussionOptions &&
    ["uncertain", "pending_answer", "pending_read_only"].includes(result.reason)) {
    const labels = request.discussionOptions.options.map(option => `「${option.title}」`);
    return labels.length === 1 ? `你是想继续细化${labels[0]}，还是提出具体修改要求？`
      : `你更倾向${labels.slice(0, -1).join("、")}还是${labels.at(-1)}？`;
  }
  if (result.action === "ask_context" && ["uncertain", "missing_target", "pending_answer", "pending_read_only"].includes(result.reason)) {
    const topics = clarificationTopics(db, request);
    if (topics.length) {
      const labels = topics.map(title => `「${title}」`);
      const names = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join("、")}还是${labels.at(-1)}`;
      if (result.intent === "status_query") return labels.length === 1
        ? `你想查看${names}的进度吗？也可以说一下其他问题。`
        : `你想查看哪件事的进度：${names}？也可以说一下其他问题。`;
      return `你指的是${names}${labels.length === 1 ? "吗" : ""}？也可以说一下其他问题。`;
    }
  }
  return "你说的是哪个问题，或者想确认哪一件事？简单说一下问题名称或具体内容就行。";
}
