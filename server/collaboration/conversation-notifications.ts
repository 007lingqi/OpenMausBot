import type { DatabaseSync } from "node:sqlite";
import type { InboundCard } from "./message-renderer.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";

/** Called inside enqueueInboundCard's savepoint. Keep all records, but avoid
 * delivering a generic receipt and a current stage for the same text input.
 * No attempted send is cancelled or rewritten by this presentation rule. */
export function coalesceConversationNotification(db: DatabaseSync, outboxId: string, now: number): "pending" | "superseded" {
  const row = db.prepare("SELECT aggregate_type,aggregate_id,aggregate_version,payload_json FROM collaboration_outbox WHERE id=? AND delivery_state='pending' AND attempt=0 AND sent_at IS NULL AND superseded_at IS NULL")
    .get(outboxId) as { aggregate_type: string; aggregate_id: string; aggregate_version: number; payload_json: string } | undefined;
  if (!row || row.aggregate_type !== "plan") return "pending";
  const card = JSON.parse(row.payload_json) as InboundCard;
  if (card.type !== "clarification_card" && card.type !== "plan_status_card") return "pending";
  const item = db.prepare("SELECT version,definition_status FROM collaboration_work_items WHERE id=? AND control_state='active' AND status NOT IN ('accepted','cancelled')")
    .get(row.aggregate_id) as { version: number; definition_status: string } | undefined;
  const snapshot = item ? readLatestWorkItemSnapshot(db, row.aggregate_id) : null;
  if (!item || !snapshot || card.workItemId !== row.aggregate_id || card.snapshotRevision !== snapshot.revision ||
    row.aggregate_version !== snapshot.revision || snapshot.sourceWorkItemVersion !== item.version) return "pending";
  const origins = db.prepare("SELECT o.id,o.delivery_state,o.attempt,n.status AS intake_status,n.base_revision,n.result_revision " +
    "FROM collaboration_outbox o JOIN collaboration_external_events e ON e.id=o.aggregate_id AND e.source='dingtalk' " +
    "JOIN collaboration_conversation_intents j ON j.event_id=e.id JOIN collaboration_natural_intake_jobs n ON n.source_event_id=e.source_event_id " +
    "JOIN collaboration_work_items w ON w.id=n.work_item_id " +
    "WHERE o.aggregate_type='association' AND o.kind='primary_status_card' AND o.source_event_id='conversation:'||e.source_event_id " +
    "AND json_extract(o.payload_json,'$.type')='primary_status_card' AND json_extract(o.payload_json,'$.workItemId')=w.id " +
    "AND json_extract(o.payload_json,'$.workItemVersion')=w.version AND COALESCE(json_extract(o.payload_json,'$.resourceCount'),0)=0 " +
    "AND json_array_length(e.normalized_json,'$.resources')=0 AND e.conversation_id=w.conversation_id AND e.work_item_id=w.id " +
    "AND j.target_work_item_id=w.id AND j.status IN ('routed','applied') AND json_extract(j.proposal_json,'$.action') IN ('create_work','contribute') " +
    "AND w.id=? AND (n.base_revision=? OR n.result_revision=?) LIMIT 2")
    .all(row.aggregate_id, snapshot.revision, snapshot.revision) as Array<{ id: string; delivery_state: string; attempt: number;
      intake_status: string; base_revision: number; result_revision: number | null }>;
  if (origins.length !== 1) return "pending";
  const receipt = origins[0];
  if (card.type === "clarification_card" && item.definition_status === "waiting_clarification" &&
    snapshot.blockingAmbiguities.some(question => question.id === "natural-input-pending") &&
    ["pending", "running"].includes(receipt.intake_status) && receipt.base_revision === snapshot.revision &&
    ["pending", "claimed", "sent"].includes(receipt.delivery_state)) {
    // The new message has not been interpreted yet. Earlier questions and
    // generic goal gates are not fresh questions for this turn. The receipt
    // remains available immediately, including during a slow model call.
    db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE id=? AND delivery_state='pending' AND attempt=0 AND sent_at IS NULL")
      .run(now, outboxId);
    return "superseded";
  }
  if (receipt.intake_status !== "applied" || receipt.result_revision !== snapshot.revision) return "pending";
  if (card.type === "clarification_card") {
    if (item.definition_status !== "waiting_clarification" || !card.questions.length ||
      snapshot.blockingAmbiguities.some(question => question.id === "natural-input-pending")) return "pending";
    const round = db.prepare("SELECT questions_json FROM collaboration_clarification_rounds WHERE work_item_id=? AND snapshot_revision=?")
      .get(row.aggregate_id, snapshot.revision) as { questions_json: string } | undefined;
    const questions = round ? JSON.parse(round.questions_json) as Array<{ id: string; question: string }> : [];
    if (!card.questions.every(question => questions.some(current => current.id === question.id && current.question === question.question))) return "pending";
  } else {
    if (!["planning", "ready_for_execution", "planning_failed"].includes(card.status) || item.definition_status !== card.status) return "pending";
    const matching = card.status === "planning"
      ? db.prepare("SELECT 1 FROM collaboration_planning_attempts WHERE work_item_id=? AND snapshot_revision=? AND status='pending'").get(row.aggregate_id, snapshot.revision)
      : db.prepare("SELECT 1 FROM collaboration_plan_revisions WHERE work_item_id=? AND snapshot_revision=? AND revision=? AND status=?")
        .get(row.aggregate_id, snapshot.revision, card.planRevision ?? -1, card.status === "planning_failed" ? "planning_failed" : "published");
    if (!matching) return "pending";
  }
  // The replacement has been durably staged in this transaction; if anything
  // fails, both it and this supersession roll back together. Sent, in-flight,
  // unknown, failed and retrying receipts are deliberately untouched.
  db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE id=? AND delivery_state='pending' AND attempt=0 AND sent_at IS NULL AND superseded_at IS NULL")
    .run(now, receipt.id);
  return "pending";
}
