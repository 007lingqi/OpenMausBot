import type { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { renderPlanStatusCard } from "./message-renderer.ts";
import { enqueueInboundCard } from "./outbox.ts";

interface Preparation {
  attempt: number;
  state: "failed" | "interrupted" | "unsettled" | null;
  work_item_version: number | null;
  max_attempts: number | null;
}

/** null means there is no unfinished pre-run dispatch; actual runs use existing recovery policy. */
export function pendingPreparation(database: DatabaseSync, workItemId: string, planRevision: number): Preparation | null {
  return database.prepare(
    "SELECT d.attempt,f.state,f.work_item_version,f.max_attempts FROM collaboration_execution_dispatches d " +
    "LEFT JOIN collaboration_execution_preparation_results f ON f.work_item_id=d.work_item_id AND f.attempt=d.attempt " +
    "WHERE d.work_item_id=? AND d.plan_revision=? " +
    "AND d.attempt=(SELECT MAX(latest.attempt) FROM collaboration_execution_dispatches latest WHERE latest.work_item_id=d.work_item_id) " +
    "AND NOT EXISTS (SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=d.work_item_id AND r.plan_revision=d.plan_revision AND r.attempt=d.attempt)",
  ).get(workItemId, planRevision) as Preparation | undefined ?? null;
}

// Aliases w (work item) and d (latest dispatch). The decision must follow the failure,
// not merely predate it, and a new reservation consumes it by becoming latest.
export const authorizedPreparationRetrySql =
  "EXISTS (SELECT 1 FROM collaboration_execution_preparation_results f WHERE f.work_item_id=d.work_item_id AND f.attempt=d.attempt " +
  "AND f.state='failed' AND d.attempt<f.max_attempts AND EXISTS (SELECT 1 FROM collaboration_control_events c " +
  "WHERE c.work_item_id=w.id AND c.action='retry' AND c.work_item_version>f.work_item_version AND c.work_item_version<=w.version))";

export function preparationDispatchAllowed(database: DatabaseSync, workItemId: string, planRevision: number): boolean {
  if (!pendingPreparation(database, workItemId, planRevision)) return true;
  return Boolean(database.prepare(
    "SELECT 1 FROM collaboration_work_items w JOIN collaboration_execution_dispatches d ON d.work_item_id=w.id " +
    "WHERE w.id=? AND d.plan_revision=? AND d.attempt=(SELECT MAX(latest.attempt) FROM collaboration_execution_dispatches latest WHERE latest.work_item_id=w.id) AND " +
    authorizedPreparationRetrySql,
  ).get(workItemId, planRevision));
}

/** Called only after preparation settled, or for an older fenced instance at startup. */
export function recordPreparationResult(database: DatabaseSync, input: {
  workItemId: string; planRevision: number; attempt: number; state: "failed" | "interrupted" | "unsettled";
  lease: InstanceLease; maxAttempts: number; now: number;
}): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    assertCurrentInstanceLease(database, input.lease, input.now);
    const row = database.prepare(
      "SELECT w.version FROM collaboration_work_items w JOIN collaboration_execution_dispatches d ON d.work_item_id=w.id " +
      "WHERE w.id=? AND w.current_plan_revision=? AND d.plan_revision=w.current_plan_revision AND d.attempt=? " +
      "AND w.status NOT IN ('accepted','cancelled') " +
      "AND d.attempt=(SELECT MAX(latest.attempt) FROM collaboration_execution_dispatches latest WHERE latest.work_item_id=w.id) " +
      "AND NOT EXISTS (SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=w.id AND r.plan_revision=d.plan_revision AND r.attempt=d.attempt) " +
      "AND NOT EXISTS (SELECT 1 FROM collaboration_execution_preparation_results f WHERE f.work_item_id=w.id AND f.attempt=d.attempt) " +
      (input.state !== "interrupted" ? "AND d.instance_owner=? AND d.instance_fence=?" : "AND (d.instance_owner<>? OR d.instance_fence<>?)"),
    ).get(input.workItemId, input.planRevision, input.attempt, input.lease.ownerId, input.lease.fence) as { version: number } | undefined;
    if (!row) { database.exec("COMMIT"); return false; }
    database.prepare("INSERT INTO collaboration_execution_preparation_results (work_item_id,attempt,state,work_item_version,max_attempts,created_at) VALUES (?,?,?,?,?,?)")
      .run(input.workItemId, input.attempt, input.state, row.version, input.maxAttempts, input.now);
    const message = input.state === "unsettled"
      ? "修改尚未开始，但执行准备的残留进程未能确认退出。已禁止直接重试，请负责人检查并清理隔离环境后安排恢复。"
      : input.state === "interrupted"
      ? "修改尚未开始，执行准备在服务中断时未能确认结束。已停止自动尝试，请负责人检查遗留执行环境后安排恢复。"
      : input.attempt >= input.maxAttempts
        ? "修改尚未开始，执行准备失败且已达到尝试上限。请负责人检查原因并重新安排，不会继续自动重试。"
        : "修改尚未开始，执行准备失败。请负责人检查执行环境，修复后由 Owner 明确重试；不会自动重复执行。";
    enqueueInboundCard(database, {
      sourceEventId: `execution-preparation:${input.workItemId}:${input.attempt}`,
      aggregateType: "plan", aggregateId: input.workItemId, aggregateVersion: input.planRevision,
      card: renderPlanStatusCard({ workItemId: input.workItemId, planRevision: input.planRevision, status: "execution_failed", failures: [message] }),
      supersessionKey: `work-item:${input.workItemId}:execution-status`, now: input.now,
    });
    database.exec("COMMIT");
    return true;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
