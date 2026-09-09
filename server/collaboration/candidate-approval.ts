import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { appendControlAudit } from "./audit.ts";
import { candidateHasPassedMetaReview, readCandidateTechnicalAcceptance } from "./candidate-verification.ts";
import { readVerifiedCandidateResultReply } from "./candidate-result-evidence.ts";
import { renderPlanStatusCard } from "./message-renderer.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface CandidateApprovalTarget {
  workItemId: string;
  workItemVersion: number;
  planRevision: number;
  runId: string;
  resultSha: string;
  changedPaths: string[];
}

export interface CandidateApprovalAssessment {
  target: CandidateApprovalTarget | null;
  approvalRequired: boolean;
  approvalReasons: string[];
  summary: string;
  approvalTopic: string;
  resultHighlights: string[];
}

export interface CandidateCompletionOutcome extends CandidateApprovalAssessment {
  completed: boolean;
  workItemVersion: number | null;
}

interface CandidateRow {
  work_item_id: string;
  work_item_version: number;
  plan_revision: number;
  run_id: string;
  result_sha: string;
  changed_paths_json: string;
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return null;
    return parsed.map((item) => item.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function readableChinese(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || !/[\u3400-\u9fff]/u.test(normalized)) return null;
  return normalized.slice(0, 300);
}

function businessSentences(value: string | null | undefined): string[] {
  const normalized = readableChinese(value)
    ?.replace(/^(?:创建|完成)?(?:一个)?(?:非生产)?(?:\s*UI)?\s*测试任务[：:]\s*/u, "")
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/[。；;\n]+/u)
    .map((item) => item.trim().replace(/[。；;]+$/u, ""))
    .filter(Boolean)
    .filter((item) => !/(?:只允许|不得|验收|测试(?:命令|证据|通过)|修改文件|write scope|diff|SHA|网络请求|真实数据)/iu.test(item))
    .slice(0, 3)
    .map((item) => item.slice(0, 180));
}

function resultCopy(database: DatabaseSync, workItemId: string): { summary: string; approvalTopic: string; resultHighlights: string[] } {
  const snapshot = readLatestWorkItemSnapshot(database, workItemId);
  const goalHighlights = businessSentences(snapshot?.goal);
  const summary = goalHighlights[0] ?? "已按确认的需求完成修改。";
  // A source excerpt naming the requested work, not a claim about changed behavior.
  const topic = Array.from(redactSensitiveText(goalHighlights[0] ?? "本次需求").replace(/WI-[A-Z0-9-]+/giu, "").replace(/\s+/gu, " ").trim());
  const highlights = (snapshot?.acceptanceConditions ?? [])
    .flatMap((condition) => businessSentences(condition.description))
    .slice(0, 3);
  return {
    summary,
    approvalTopic: topic.slice(0, 96).join("") + (topic.length > 96 ? "…" : "") || "本次需求",
    resultHighlights: highlights.length
      ? highlights
      : goalHighlights.length
        ? goalHighlights
        : ["相关功能已按确认要求更新"],
  };
}

function impactReason(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").toLowerCase().replace(/^\.\//u, "");
  if (normalized === "package.json" || /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/u.test(normalized)) {
    return "涉及项目依赖，可能影响整体构建或运行。";
  }
  if (
    normalized === "dockerfile" ||
    /(?:^|\/)dockerfile(?:\.|$)/u.test(normalized) ||
    /(?:^|\/)(?:docker-compose|compose)(?:\.[^/]+)?\.ya?ml$/u.test(normalized) ||
    /^(?:\.github|packaging|deploy|infra)\//u.test(normalized)
  ) {
    return "涉及部署或运行环境，可能影响服务可用性。";
  }
  if (/(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)/u.test(normalized)) {
    return "涉及数据结构变更，需要确认兼容性和回退方式。";
  }
  if (/(?:^|[\/._-])(?:auth|security|permission|credential|secret)s?(?:$|[\/._-])/u.test(normalized)) {
    return "涉及账号、权限或敏感配置，需要负责人确认。";
  }
  return null;
}

function readTarget(database: DatabaseSync, workItemId: string, runId?: string): CandidateRow | null {
  const row = database.prepare(
    "SELECT w.id AS work_item_id, w.version AS work_item_version, w.current_plan_revision AS plan_revision, " +
      "r.id AS run_id, c.result_sha, c.changed_paths_json " +
      "FROM collaboration_work_items w " +
      "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' " +
      "AND w.control_state = 'active' AND w.accepted_candidate_sha IS NULL " +
      "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
      (runId ? "AND r.id = ? " : "") +
      "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
      "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
      "ORDER BY c.created_at DESC LIMIT 1",
  ).get(...(runId ? [workItemId, runId] : [workItemId])) as CandidateRow | undefined;
  if (!row || !candidateHasPassedMetaReview(database, row.run_id, row.result_sha)) return null;
  return row;
}

export function readCandidateApprovalTarget(
  database: DatabaseSync,
  workItemId: string,
): CandidateApprovalTarget | null {
  const row = readTarget(database, workItemId);
  if (!row) return null;
  const changedPaths = parseStringArray(row.changed_paths_json);
  if (!changedPaths || !FULL_SHA.test(row.result_sha)) return null;
  return {
    workItemId: row.work_item_id,
    workItemVersion: row.work_item_version,
    planRevision: row.plan_revision,
    runId: row.run_id,
    resultSha: row.result_sha,
    changedPaths,
  };
}

export function assessCandidateApproval(
  database: DatabaseSync,
  input: { workItemId: string; runId?: string },
): CandidateApprovalAssessment {
  const copy = resultCopy(database, input.workItemId);
  const row = readTarget(database, input.workItemId, input.runId);
  if (!row) {
    return {
      target: null,
      approvalRequired: true,
      approvalReasons: ["候选结果与当前任务状态无法完整对应，需要负责人确认。"],
      ...copy,
    };
  }
  const changedPaths = parseStringArray(row.changed_paths_json);
  const target = changedPaths && FULL_SHA.test(row.result_sha)
    ? {
        workItemId: row.work_item_id,
        workItemVersion: row.work_item_version,
        planRevision: row.plan_revision,
        runId: row.run_id,
        resultSha: row.result_sha,
        changedPaths,
      }
    : null;
  const reasons = new Set<string>();
  if (!target) reasons.add("候选结果信息不完整，需要负责人确认。");

  const risks = database.prepare(
    "SELECT risk FROM collaboration_work_nodes WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
  ).all(row.work_item_id, row.plan_revision) as unknown as Array<{ risk: string }>;
  if (!risks.length) reasons.add("本次改动缺少完整的风险分级，需要负责人确认。");
  if (risks.some((item) => item.risk === "medium" || item.risk === "high")) {
    reasons.add("本次改动被标记为中高风险，可能影响较大范围。");
  }

  for (const path of changedPaths ?? []) {
    const reason = impactReason(path);
    if (reason) reasons.add(reason);
  }

  const validateRows = database.prepare(
    "SELECT commands_json FROM collaboration_work_nodes " +
      "WHERE work_item_id = ? AND plan_revision = ? AND node_type = 'validate' AND active = 1",
  ).all(row.work_item_id, row.plan_revision) as unknown as Array<{ commands_json: string }>;
  const required = validateRows.flatMap((item) => parseStringArray(item.commands_json) ?? []);
  const evidence = database.prepare(
    "SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ?",
  ).all(row.run_id) as unknown as Array<{ command_id: string; state: string }>;
  const passed = new Set(evidence.filter((item) => item.state === "target_passed").map((item) => item.command_id));
  if (!required.length || required.some((commandId) => !passed.has(commandId))) {
    reasons.add("验证信息不完整，需要负责人判断是否继续。");
  }

  return {
    target,
    approvalRequired: reasons.size > 0,
    approvalReasons: [...reasons].slice(0, 3),
    ...copy,
  };
}

function stateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function completeVerifiedLowRiskCandidate(
  database: DatabaseSync,
  input: { workItemId: string; runId: string; sourceEventId: string; now: number },
): CandidateCompletionOutcome {
  database.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(database);
    const assessment = assessCandidateApproval(database, input);
    if (assessment.approvalRequired || !assessment.target) {
      database.exec("COMMIT");
      return { ...assessment, completed: false, workItemVersion: assessment.target?.workItemVersion ?? null };
    }
    const target = assessment.target;
    const technical=readCandidateTechnicalAcceptance(database,target.runId,target.resultSha);
    const resultAlreadyDelivered=technical && readVerifiedCandidateResultReply(database,{candidateRunId:target.runId,candidateSha:target.resultSha,
      specHash:technical.specHash,specIdentityHash:technical.specIdentityHash,policyHash:technical.policyHash});
    const before = {
      status: "collecting",
      controlState: "active",
      version: target.workItemVersion,
      acceptedCandidateSha: null,
    };
    const update = database.prepare(
      "UPDATE collaboration_work_items SET status = 'accepted', control_state = 'accepted', " +
        "accepted_candidate_sha = ?, accepted_by = NULL, accepted_at = ?, paused_at = NULL, " +
        "version = version + 1, updated_at = ? " +
        "WHERE id = ? AND version = ? AND current_plan_revision = ? " +
        "AND control_state = 'active' AND accepted_candidate_sha IS NULL",
    ).run(target.resultSha, input.now, input.now, target.workItemId, target.workItemVersion, target.planRevision);
    if (update.changes !== 1) throw new Error("candidate_auto_complete_compare_and_swap_failed");
    database.prepare(
      "UPDATE collaboration_work_nodes SET control_state = 'cancelled', version = version + 1 " +
        "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
    ).run(target.workItemId, target.planRevision);
    const completedVersion = target.workItemVersion + 1;
    const after = {
      status: "accepted",
      controlState: "accepted",
      version: completedVersion,
      acceptedCandidateSha: target.resultSha,
      acceptedBy: null,
    };
    appendControlAudit(database, {
      workItemId: target.workItemId,
      requestId: randomUUID(),
      action: "candidate.auto_complete",
      outcome: "allow",
      policyRule: "verified-low-risk-candidate-v1",
      resource: {
        runId: target.runId,
        planRevision: target.planRevision,
        candidateSha: target.resultSha,
        requiredApproval: false,
      },
      beforeHash: stateHash(before),
      afterHash: stateHash(after),
      now: input.now,
    });
    if(!resultAlreadyDelivered) enqueueInboundCard(database, {
      sourceEventId: input.sourceEventId,
      aggregateType: "work_item",
      aggregateId: target.workItemId,
      aggregateVersion: completedVersion,
      card: renderPlanStatusCard({
        workItemId: target.workItemId,
        status: "completed",
        summary: assessment.summary,
        resultHighlights: assessment.resultHighlights,
      }),
      supersessionKey: `work-item:${target.workItemId}:execution-status`,
      now: input.now,
    });
    database.exec("COMMIT");
    return { ...assessment, completed: true, workItemVersion: completedVersion };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
