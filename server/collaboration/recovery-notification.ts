import type { DatabaseSync } from "node:sqlite";
import { hasUnsettledRepositoryActivity } from "./repository-occupancy.ts";

/** A recovery observation is not a lasting promise about the current task. */
export function isCurrentRecoveryNotification(db: DatabaseSync, message: {
  source_event_id: string; aggregate_id: string; aggregate_version: number;
}): boolean {
  if (!message.source_event_id.startsWith("lifecycle-recovery:")) return true;
  const match = /^lifecycle-recovery:(execution|verification):(.+):(blocked|recovered)$/u.exec(message.source_event_id);
  if (!match) return false;
  const [, kind, sessionId, outcome] = match;
  // kind comes exclusively from the two literal regexp alternatives.
  const current = db.prepare(
    `SELECT s.repository_path,f.session_id AS settled FROM collaboration_${kind}_sessions s ` +
    (kind === "verification" ? "JOIN collaboration_runs r ON r.id=s.candidate_run_id " : "") +
    `LEFT JOIN collaboration_${kind}_settlements f ON f.session_id=s.id ` +
    `JOIN collaboration_work_items w ON w.id=${kind === "execution" ? "s" : "r"}.work_item_id ` +
    "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
    "WHERE s.id=? AND w.id=? AND w.version=? AND w.current_plan_revision=s.plan_revision " +
    "AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
    "AND w.definition_status='ready_for_execution' AND p.status='published' " +
    "AND p.snapshot_revision=(SELECT MAX(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id)",
  ).get(sessionId, message.aggregate_id, message.aggregate_version) as { repository_path: string; settled: string | null } | undefined;
  if (!current) return false;
  return outcome === "blocked" ? current.settled === null
    : current.settled !== null && !hasUnsettledRepositoryActivity(db, current.repository_path);
}
