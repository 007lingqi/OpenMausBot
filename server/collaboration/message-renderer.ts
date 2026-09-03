export interface PrimaryStatusCard {
  type: "primary_status_card";
  headline: "已接收";
  acknowledgement: string;
  workItemId: string;
  workItemStatus: string;
  workItemVersion: number;
  association: "created" | "associated";
  resourceCount?: number;
}

export interface AssociationChoiceCard {
  type: "association_choice_card";
  headline: "请选择问题归属";
  acknowledgement: string;
  candidateWorkItemIds: string[];
  candidateWorkItems: Array<{ id: string; title: string }>;
}

export interface InvalidReferenceCard {
  type: "invalid_reference_card";
  headline: "引用的问题不可用";
  acknowledgement: string;
  reference: string;
}

export interface ClarificationCard {
  type: "clarification_card";
  headline: "需要澄清";
  workItemId: string;
  snapshotRevision: number;
  questions: Array<{
    id: string;
    title: string;
    question: string;
    recommendedAnswer: string;
  }>;
  requestedResponders?: Array<{ targetId?: string; displayName?: string }>;
}

export interface PlanStatusCard {
  type: "plan_status_card";
  headline:
    | "计划生成中"
    | "计划已发布"
    | "计划生成失败"
    | "修改完成，需要负责人确认"
    | "修改已完成"
    | "执行未完成"
    | "候选已接受"
    | "候选已拒绝"
    | "验收操作未执行";
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status:
    | "planning"
    | "ready_for_execution"
    | "planning_failed"
    | "candidate_ready"
    | "completed"
    | "execution_failed"
    | "owner_accepted"
    | "owner_rejected"
    | "owner_action_denied";
  summary?: string;
  sequence?: Array<"analyze" | "modify" | "validate" | "report">;
  failures?: string[];
  candidateSha?: string;
  candidatePreview?: string;
  changedPaths?: string[];
  testStates?: string[];
  resultHighlights?: string[];
  approvalReasons?: string[];
  approvalRequired?: boolean;
  workItemVersion?: number;
  cardTemplateId?: string;
  outTrackId?: string;
  actions?: Array<{ label: string; actionToken: string }>;
}

export interface CommandStatusCard {
  type: "command_status_card";
  headline: "任务状态" | "控制操作已执行" | "控制操作未执行";
  command:
    | "status"
    | "pause"
    | "resume"
    | "retry"
    | "cancel"
    | "refresh_approval"
    | "approve_candidate"
    | "reject_candidate";
  workItemId: string;
  outcome: "allowed" | "denied";
  summary: string;
  workItemStatus?: string;
  definitionStatus?: string;
  controlState?: string;
}

export type InboundAcknowledgementCard = PrimaryStatusCard | AssociationChoiceCard | InvalidReferenceCard;

export type InboundCard =
  | InboundAcknowledgementCard
  | ClarificationCard
  | PlanStatusCard
  | CommandStatusCard;

const RECEIVED_ONLY = "消息已接收并写入协作账本；这不表示系统已经理解、执行或完成任务。";

export function renderPrimaryStatusCard(input: {
  workItemId: string;
  status: string;
  version: number;
  association: "created" | "associated";
  resourceCount?: number;
}): PrimaryStatusCard {
  return {
    type: "primary_status_card",
    headline: "已接收",
    acknowledgement: RECEIVED_ONLY,
    workItemId: input.workItemId,
    workItemStatus: input.status,
    workItemVersion: input.version,
    association: input.association,
    ...(input.resourceCount ? { resourceCount: input.resourceCount } : {}),
  };
}

export function renderAssociationChoiceCard(
  candidateWorkItemIds: string[],
  candidateWorkItems: Array<{ id: string; title: string }> = candidateWorkItemIds.map((id) => ({ id, title: id })),
): AssociationChoiceCard {
  const allowedIds = new Set(candidateWorkItemIds.slice(0, 3));
  const titledCandidates = candidateWorkItems
    .filter((candidate) => allowedIds.has(candidate.id))
    .slice(0, 3);
  return {
    type: "association_choice_card",
    headline: "请选择问题归属",
    acknowledgement: `${RECEIVED_ONLY} 我还不能确定这条消息属于哪个问题，请按标题选择；选择前不会修改现有问题。`,
    candidateWorkItemIds: candidateWorkItemIds.slice(0, 3),
    candidateWorkItems: titledCandidates,
  };
}

export function renderInvalidReferenceCard(reference: string): InvalidReferenceCard {
  return {
    type: "invalid_reference_card",
    headline: "引用的问题不可用",
    acknowledgement: `${RECEIVED_ONLY} 未找到当前会话中的 ${reference}，因此没有创建或更新 Work Item。`,
    reference,
  };
}

export function renderClarificationCard(input: Omit<ClarificationCard, "type" | "headline">): ClarificationCard {
  return { type: "clarification_card", headline: "需要澄清", ...input };
}

export function renderCommandStatusCard(
  input: Omit<CommandStatusCard, "type" | "headline">,
): CommandStatusCard {
  return {
    type: "command_status_card",
    headline: input.command === "status"
      ? "任务状态"
      : input.outcome === "allowed"
        ? "控制操作已执行"
        : "控制操作未执行",
    ...input,
  };
}

export function renderPlanStatusCard(input: {
  workItemId: string;
  planRevision?: number;
  snapshotRevision?: number;
  status:
    | "planning"
    | "ready_for_execution"
    | "planning_failed"
    | "candidate_ready"
    | "completed"
    | "execution_failed"
    | "owner_accepted"
    | "owner_rejected"
    | "owner_action_denied";
  summary?: string;
  failures?: string[];
  candidateSha?: string;
  candidatePreview?: string;
  changedPaths?: string[];
  testStates?: string[];
  resultHighlights?: string[];
  approvalReasons?: string[];
  workItemVersion?: number;
}): PlanStatusCard {
  if (["owner_accepted", "owner_rejected", "owner_action_denied"].includes(input.status)) {
    return {
      type: "plan_status_card",
      headline: input.status === "owner_accepted"
        ? "候选已接受"
        : input.status === "owner_rejected"
          ? "候选已拒绝"
          : "验收操作未执行",
      workItemId: input.workItemId,
      status: input.status,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.failures ? { failures: input.failures } : {}),
    };
  }
  if (input.status === "planning") {
    return {
      type: "plan_status_card",
      headline: "计划生成中",
      workItemId: input.workItemId,
      snapshotRevision: input.snapshotRevision,
      status: input.status,
    };
  }
  if (input.status === "planning_failed") {
    return {
      type: "plan_status_card",
      headline: "计划生成失败",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      failures: input.failures ?? ["未知计划错误"],
    };
  }
  if (input.status === "candidate_ready") {
    return {
      type: "plan_status_card",
      headline: "修改完成，需要负责人确认",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      summary: input.summary,
      candidateSha: input.candidateSha,
      candidatePreview: input.candidatePreview,
      changedPaths: input.changedPaths ?? [],
      testStates: input.testStates ?? [],
      approvalReasons: input.approvalReasons ?? ["本次改动需要负责人确认后才能完成。"],
      approvalRequired: true,
      workItemVersion: input.workItemVersion,
    };
  }
  if (input.status === "completed") {
    return {
      type: "plan_status_card",
      headline: "修改已完成",
      workItemId: input.workItemId,
      status: input.status,
      summary: input.summary ?? "已按确认的需求完成修改。",
      resultHighlights: input.resultHighlights ?? ["相关功能已按确认要求更新"],
      approvalRequired: false,
    };
  }
  if (input.status === "execution_failed") {
    return {
      type: "plan_status_card",
      headline: "执行未完成",
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      status: input.status,
      failures: input.failures ?? ["执行未产生可验收候选"],
    };
  }
  return {
    type: "plan_status_card",
    headline: "计划已发布",
    workItemId: input.workItemId,
    planRevision: input.planRevision,
    status: input.status,
    summary: input.summary,
    sequence: ["analyze", "modify", "validate", "report"],
  };
}
