import type { DatabaseSync } from "node:sqlite";
import { attachmentCompletenessGates } from "./attachment-completeness.ts";
import { appendWorkItemSnapshot, readLatestWorkItemSnapshot, readWorkItemSnapshotRevision } from "./snapshot.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderClarificationCard } from "./message-renderer.ts";
import { randomUUID } from "node:crypto";

/** Recompute from the current ledger and the exact planned Spec, never cached readiness or model claims. */
export function readPlanMaterialReadiness(db: DatabaseSync, workItemId: string, planRevision?: number) {
  const plan = db.prepare("SELECT p.revision,p.snapshot_revision FROM collaboration_work_items w " +
    "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
    "WHERE w.id=? AND p.status='published'").get(workItemId) as { revision: number; snapshot_revision: number } | undefined;
  const snapshot = plan && readWorkItemSnapshotRevision(db, workItemId, plan.snapshot_revision);
  const latest = readLatestWorkItemSnapshot(db, workItemId);
  const current = !!plan && !!snapshot && snapshot.revision === latest?.revision &&
    (planRevision === undefined || planRevision === plan.revision);
  const gaps = snapshot ? attachmentCompletenessGates(db, workItemId, snapshot.facts) : [];
  // Unclassified incoming text may still be a correction to this Spec. Wait
  // for routing without adding it as a requirement or bumping the version.
  const conversationPending = !!db.prepare("SELECT 1 FROM collaboration_conversation_intents j " +
    "JOIN collaboration_external_events e ON e.id=j.event_id JOIN collaboration_work_items w ON w.conversation_id=e.conversation_id " +
    "WHERE w.id=? AND ((j.status IN ('pending','running') AND (j.requested_work_item_id IS NULL OR j.requested_work_item_id=w.id)) " +
    "OR (j.status IN ('routed','failed') AND j.target_work_item_id=w.id AND json_extract(j.proposal_json,'$.action') IN ('create_work','contribute'))) LIMIT 1")
    .get(workItemId);
  return { ready: current && gaps.length === 0 && !conversationPending, current, gaps, snapshotRevision: snapshot?.revision ?? null };
}

/** Startup recovery must not require a model/planner just to stop an incomplete old plan. */
export function recheckPlanMaterials(db: DatabaseSync, workItemId: string, now: number, assertActive = () => {}): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive(); assertLedgerArmed(db);
    const state = readPlanMaterialReadiness(db, workItemId);
    const eligible = db.prepare("SELECT 1 FROM collaboration_work_items WHERE id=? AND definition_status='ready_for_execution' " +
      "AND control_state='active' AND status NOT IN ('accepted','cancelled')").get(workItemId);
    if (!state.ready && eligible && state.current && state.gaps.length) {
      const snapshot = appendWorkItemSnapshot(db, workItemId, {}, now).current;
      const questions = state.gaps.slice(0, 3).map(q => ({ id: q.id, title: "需要核对材料", question: q.question, recommendedAnswer: q.recommendedAnswer }));
      db.prepare("UPDATE collaboration_work_items SET definition_status='waiting_clarification',updated_at=? WHERE id=?").run(now, workItemId);
      db.prepare("INSERT INTO collaboration_clarification_rounds(id,work_item_id,snapshot_revision,questions_json,created_at) VALUES (?,?,?,?,?)")
        .run(randomUUID(), workItemId, snapshot.revision, JSON.stringify(questions), now);
      enqueueInboundCard(db, { sourceEventId: `plan-materials:${workItemId}:snapshot:${snapshot.revision}`, aggregateType: "plan", aggregateId: workItemId,
        aggregateVersion: snapshot.revision, supersessionKey: `work-item:${workItemId}:planning-status`, now,
        card: renderClarificationCard({ workItemId, snapshotRevision: snapshot.revision, questions,
          contextSummary: "原计划的材料还未核对完整，需要先补齐依据，尚未开始新的修改。" }) });
    }
    db.exec("COMMIT"); return state.ready;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Applies to unsent completion/approval claims only. Clarifications and historical sent receipts stay intact. */
export function isCurrentMaterialDelivery(db: DatabaseSync, row: {
  kind: string; aggregate_type: string; aggregate_id: string; payload_json: string;
}): boolean {
  if (row.kind !== "plan_status_card" || !["work_item", "plan"].includes(row.aggregate_type)) return true;
  const payload = JSON.parse(row.payload_json) as { status?: string; planRevision?: number };
  if (!["completed", "candidate_ready"].includes(payload.status ?? "")) return true;
  return readPlanMaterialReadiness(db, row.aggregate_id, payload.planRevision).ready;
}
