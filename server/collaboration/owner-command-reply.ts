import type { DatabaseSync } from "node:sqlite";
import type { DingTalkOwnerTextCommand } from "../integrations/dingtalk/types.ts";
import type { OwnerActionOutcome, PerformDirectOwnerActionInput } from "./actions.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderCommandStatusCard, renderPlanStatusCard } from "./message-renderer.ts";

export function commandSummary(command: DingTalkOwnerTextCommand["command"], allowed: boolean, reason: string): string {
  if (allowed) return ({
    status: "已返回任务当前状态。",
    pause: "任务已暂停；正在运行的执行会收到中断请求。",
    resume: "任务已恢复；符合条件的节点将继续执行。",
    retry: "任务已重新进入受控执行队列。",
    cancel: "任务已取消，不会再产生新的执行结果。",
    refresh_approval: "已重新生成当前候选的验收指令。",
    approve_candidate: "负责人已批准本次风险改动，任务已完成。",
    reject_candidate: "负责人已退回本次风险改动，系统将按反馈继续调整。",
  } as const)[command];
  const guidance: Readonly<Record<string, string>> = {
    not_active_owner: "只有当前唯一负责人可以执行该操作。",
    owner_not_configured: "尚未配置唯一负责人，请先完成 Owner 绑定。",
    stable_identity_required: "无法确认稳定的钉钉身份，本次操作未执行。",
    unknown_work_item: "未找到该任务，请检查任务编号。",
    work_item_not_active: "任务当前不处于可暂停状态。",
    work_item_not_paused: "任务当前不处于暂停状态。",
    work_item_not_retryable: "任务当前没有可重试的失败结果。",
    work_item_already_accepted: "任务已经验收完成，无需重复操作。",
    work_item_cancelled: "任务已经取消，不能执行该操作。",
    candidate_not_current: "当前没有可验收候选，请先查询任务状态。",
    reject_reason_required: "退回时请在任务编号后说明需要调整的内容。",
    verification_attempt_limit_exhausted: "独立复核已连续三次未通过，系统已停止重复尝试。请补充或修正需求后再继续。",
  };
  return guidance[reason] ?? "当前状态不允许执行该操作，请先查询任务状态。";
}

/** The caller owns the transaction containing control, receipt, audit and reply. */
export function enqueueDirectOwnerReply(db: DatabaseSync, input: PerformDirectOwnerActionInput, outcome: OwnerActionOutcome, now: number): void {
  if (input.action === "accept" || input.action === "reject") {
    enqueueInboundCard(db, { sourceEventId: input.sourceEventId, aggregateType: "plan", aggregateId: input.workItemId,
      aggregateVersion: outcome.workItemVersion ?? 1, now,
      card: renderPlanStatusCard({ workItemId: input.workItemId,
        status: !outcome.allowed ? "owner_action_denied" : input.action === "accept" ? "owner_accepted" : "owner_rejected",
        ...(!outcome.allowed ? { summary: "该验收操作未通过身份、有效期或候选状态校验，请使用最新候选消息中的指令。" } : {}) }) });
    return;
  }
  const row = db.prepare("SELECT status,definition_status,control_state,version FROM collaboration_work_items WHERE id=?")
    .get(input.workItemId) as { status: string; definition_status: string; control_state: string; version: number } | undefined;
  enqueueInboundCard(db, { sourceEventId: input.sourceEventId, aggregateType: "work_item", aggregateId: input.workItemId,
    aggregateVersion: row?.version ?? 1, now,
    card: renderCommandStatusCard({ command: input.action, workItemId: input.workItemId, outcome: outcome.allowed ? "allowed" : "denied",
      summary: commandSummary(input.action, outcome.allowed, outcome.reason),
      ...(row ? { workItemStatus: row.status, definitionStatus: row.definition_status, controlState: row.control_state } : {}) }) });
}
