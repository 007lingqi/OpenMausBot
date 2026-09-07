import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkCredentialProvider, DingTalkCredentials } from "../../integrations/dingtalk/config.ts";
import type {
  DingTalkCardAction,
  DingTalkInboundMessage,
  DingTalkPrivateResourceCapability,
  DingTalkOwnerTextCommand,
  DingTalkOwnerTextCommandOutcome,
} from "../../integrations/dingtalk/types.ts";
import type { DirectOwnerControlAction, OwnerActionOutcome } from "../actions.ts";
import {
  assessCandidateApproval,
  completeVerifiedLowRiskCandidate,
  readCandidateApprovalTarget,
} from "../candidate-approval.ts";
import {
  CANDIDATE_VERIFICATION_MAX_ATTEMPTS,
  candidateHasPassedMetaReview,
  CandidateVerificationCoordinator,
  type CandidateVerificationOutcome,
} from "../candidate-verification.ts";
import type { AcceptanceMappingModels } from "../acceptance-mapping.ts";
import {
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
  verifyContainmentProof,
} from "../containment.ts";
import type { CandidateExecutorOptions, CandidateExecutionOutcome } from "../executor.ts";
import { authorizedPreparationRetrySql, preparationDispatchAllowed, recordPreparationResult } from "../execution-preparation.ts";
import { CommandCleanupError } from "../execution-limits.ts";
import { hasUnsettledRepositoryActivity } from "../repository-occupancy.ts";
import { recoverLifecycleSession, type LifecycleRecoveryOutcome } from "../lifecycle-recovery.ts";
import { registerCoordinator, type CoordinatorAuthority } from "../coordinator-lifecycle.ts";
import type { UnactivatedLaunchRecoveryPort } from "../unactivated-launch-recovery.ts";
import type { PlanningPolicy } from "../graph.ts";
import type { InboundMessageOutcome } from "../inbound.ts";
import { assertCurrentInstanceLease, InstanceLeaseCoordinator, StaleFenceError, type InstanceLease } from "../leases.ts";
import { OutboxDispatcher, type DispatchOutcome, type OutboxDispatcherOptions } from "../outbox-dispatcher.ts";
import { readDeliveryHealth, type DeliveryHealth } from "./delivery-health.ts";
import { requestDeliveryReview, isDeliveryReviewEvent } from "../delivery-review.ts";
import { recordOwnerQuery, isOwnerQueryEvent } from "../owner-query-receipt.ts";
import { commandSummary } from "../owner-command-reply.ts";
import { enqueueInboundCard, type OutboxDeliveryPort } from "../outbox.ts";
import { renderCommandStatusCard, renderPlanStatusCard } from "../message-renderer.ts";
import { syncWorkItemMetaBundle } from "../meta-bundle.ts";
import { evaluateOwnerPolicy } from "../policy.ts";
import type { PlannerPort } from "../planner.ts";
import type { NaturalIntakeInterpreter } from "../natural-intake.ts";
import type { AcceptedAttachmentEvidence } from "../plan-reviser.ts";
import { recoverAttachmentProjection } from "../attachment-projection-recovery.ts";
import { recoverNaturalIntake } from "../natural-intake-recovery.ts";
import type { AcceptanceCondition } from "../snapshot.ts";
import { renderCandidateDiffPreview } from "../candidate-preview.ts";
import type { AgentRunPort } from "../provider-runner.ts";
import type { SandboxedCommandRunner } from "../quality-gate.ts";
import { type CandidateInspectionPort, RecoveryCoordinator, type RecoveryDecision } from "../recovery.ts";
import {
  startCollaborationService,
  type CollaborationHealth,
  type CollaborationService,
  type CollaborationServiceOptions,
} from "../service.ts";
import { publishVerificationRuntimePolicy } from "../verification-runtime-policy.ts";
import { readRestoreGuard } from "../restore-guard.ts";
import { UnavailableContainmentSupervisor } from "./containment-supervisor.ts";

export type CollaborationRuntimeState = "starting" | "running" | "draining" | "degraded" | "stopped";

// Control-only changes do not invalidate a Spec. Every intervening version must
// be accounted for; a durable contribution not yet projected must block execution.
const currentExecutionSpecSql =
  "AND s.revision=(SELECT MAX(latest.revision) FROM collaboration_work_item_snapshots latest WHERE latest.work_item_id=w.id) " +
  "AND w.version>=s.source_work_item_version AND w.version-s.source_work_item_version=(" +
  "SELECT count(DISTINCT c.work_item_version) FROM collaboration_control_events c WHERE c.work_item_id=w.id " +
  "AND c.work_item_version>s.source_work_item_version AND c.work_item_version<=w.version " +
  "AND c.action IN ('pause','resume','retry')) " +
  "AND EXISTS (SELECT 1 FROM collaboration_work_nodes n WHERE n.work_item_id=w.id AND n.plan_revision=w.current_plan_revision " +
  "AND n.node_type='modify' AND n.active=1 AND n.control_state='active') ";

export interface RuntimeClock {
  now(): number;
}

export interface RuntimeLogEvent {
  event: string;
  code?: string;
  state?: CollaborationRuntimeState;
  recoveryCount?: number;
  workItemId?: string;
}

export interface RuntimeLogger {
  write(event: RuntimeLogEvent): void;
}

export interface RuntimeStream {
  start(): Promise<"connected" | "reconnecting">;
  stop(): void | Promise<void>;
  state(): string;
  maintain?(): Promise<string>;
}

export interface RuntimeDingTalkSinks {
  reviewDeliveries(message: DingTalkInboundMessage): ReturnType<typeof requestDeliveryReview>;
  recoverRequirements(message: DingTalkInboundMessage): ReturnType<typeof recoverNaturalIntake>;
  recoverProjection(message: DingTalkInboundMessage): ReturnType<typeof recoverAttachmentProjection>;
  ingest(message: DingTalkInboundMessage): InboundMessageOutcome;
  ingestAttachments?(capabilities: readonly DingTalkPrivateResourceCapability[]): Promise<void>;
  perform(action: DingTalkCardAction): OwnerActionOutcome;
  performCommand(command: DingTalkOwnerTextCommand): DingTalkOwnerTextCommandOutcome;
}

export interface RuntimeAttachmentIngestionPort {
  persist(capabilities: readonly DingTalkPrivateResourceCapability[], now: number): void | Promise<void>;
  process(capabilities: readonly DingTalkPrivateResourceCapability[], now: number): Promise<unknown>;
}

export interface RuntimeAttachmentIngestionContext {
  instance: Pick<InstanceLease, "ownerId" | "fence">;
  databaseFile: string;
  dataDirectory: string;
  signal: AbortSignal;
  assertActive(): void;
  onEvidence(workItemId: string, evidence: AcceptedAttachmentEvidence): void;
}

export type RuntimeStreamFactory = (
  credentials: DingTalkCredentials,
  sinks: RuntimeDingTalkSinks,
  logger: RuntimeLogger,
) => RuntimeStream;

export interface RuntimeMaintenancePort {
  run(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): void | Promise<void>;
}

export interface RuntimeMaintenanceContext {
  database: DatabaseSync;
  dataDirectory: string;
}

export type RuntimeExecutionConfiguration = Omit<
  CandidateExecutorOptions,
  "agent" | "containment" | "commandRunner" | "scheduler"
>;

export interface CollaborationHeadlessRuntimeOptions {
  dataDirectory: string;
  ownerId?: string;
  instanceLeaseTtlMs?: number;
  shutdownTimeoutMs?: number;
  /** Upper bound for one passive recovery inspection, not a process-kill timeout. */
  lifecycleRecoveryTimeoutMs?: number;
  clock?: RuntimeClock;
  logger?: RuntimeLogger;
  platform?: NodeJS.Platform;
  executionIsolation?: "native_linux" | "docker_linux";
  autoExecuteReady?: boolean;
  /** Opens and validates configuration without leasing, recovering, streaming, dispatching, or maintaining. */
  probeOnly?: boolean;
  planner?: PlannerPort;
  naturalIntake?: NaturalIntakeInterpreter;
  onlineDocuments?: import("./dws-online-reader.ts").DwsOnlineDocumentReader;
  acceptanceMapping?: AcceptanceMappingModels;
  planningPolicy?: PlanningPolicy;
  planningDefaultDefinition?: { repository: string; acceptanceConditions: AcceptanceCondition[] };
  agent?: AgentRunPort;
  containment?: ContainmentPort;
  coordinator?: CoordinatorAuthority;
  unactivatedLaunchRecovery?: UnactivatedLaunchRecoveryPort;
  commandRunner?: SandboxedCommandRunner;
  execution?: RuntimeExecutionConfiguration;
  candidateInspector?: CandidateInspectionPort;
  recoveryMaxAttempts?: number;
  outboxDelivery?: OutboxDeliveryPort;
  outbox?: Partial<OutboxDispatcherOptions>;
  maintenance?: RuntimeMaintenancePort;
  maintenanceFactory?: (context: RuntimeMaintenanceContext) => RuntimeMaintenancePort;
  attachmentIngestionFactory?: (
    context: RuntimeAttachmentIngestionContext,
  ) => RuntimeAttachmentIngestionPort;
  dingTalk?: {
    enabled: boolean;
    cardTemplateId?: string;
    credentials: DingTalkCredentialProvider;
    createStream: RuntimeStreamFactory;
  };
}

export interface CollaborationRuntimeHealth {
  /** Independent from readiness: a quarantined reply must not gate unrelated work. */
  delivery: DeliveryHealth;
  app: "openmausbot-collaboration";
  sourceBaseline?: CollaborationHealth["sourceBaseline"];
  authority?: "headless";
  defaults?: CollaborationHealth["defaults"];
  state: CollaborationRuntimeState;
  status: "healthy" | "degraded" | "stopped";
  ready: boolean;
  reason?: string;
  database?: CollaborationHealth["database"];
  instanceLease: "held" | "not_held";
  dingtalk: {
    enabled: boolean;
    state: "disabled" | "configured" | "connected" | "reconnecting" | "needs_configuration" | "stopped";
  };
  executionMode: "execute" | "observe_plan_only" | "not_configured";
}

export interface DrainOutcome {
  dispatched: DispatchOutcome | null;
  maintained: boolean;
}

interface UnresolvedRun {
  id: string;
  work_item_id: string;
  plan_revision: number;
  node_id: string;
  worktree_path: string;
  runtime_identity_json: string | null;
  containment_binding_json: string | null;
  containment_fingerprint: string | null;
}

const SYSTEM_CLOCK: RuntimeClock = { now: Date.now };
const NULL_LOGGER: RuntimeLogger = { write() {} };
const CANDIDATE_READY_SUMMARY = "本次改动已完成并通过基础验证，但存在需要负责人确认的风险。";
const DIRECT_TEXT_ACTIONS: Readonly<Partial<Record<DingTalkOwnerTextCommand["command"], DirectOwnerControlAction>>> = {
  pause: "pause",
  resume: "resume",
  retry: "retry",
  cancel: "cancel",
};

function verificationFailureMessage(verification: CandidateVerificationOutcome): string {
  const reasons = new Set(verification.reasons);
  if (reasons.has("acceptance_mapping_pending")) {
    return "验收要求与测试的对应关系仍在核对中，尚未确认修改完成。无需重复发送原问题。";
  }
  if (reasons.has("acceptance_mapping_incomplete")) {
    return "目前还无法确认测试已覆盖全部验收要求，本次修改不会标记完成。需要补齐测试或确认不明确的验收要求。";
  }
  if (reasons.has("acceptance_mapping_unavailable")) {
    return "核对验收要求与测试的服务暂时不可用，本次修改尚未确认完成。请负责人检查复核服务后安排恢复。";
  }
  if (reasons.has("verification_attempt_limit_exhausted")) {
    return "独立复核已连续三次未通过，系统已停止重复尝试。请补充或修正需求后再继续。";
  }
  if (reasons.has("blocking_ambiguity_present")) {
    return "需求中仍有未确认的问题，本次修改不会标记完成。请先补充确认。";
  }
  if (reasons.has("acceptance_evidence_incomplete")) {
    return "有验收要求还没有对应的自动测试证据，本次修改不会标记完成。";
  }
  if (reasons.has("executor_self_test_incomplete")) {
    return "开发自测还不完整，本次修改不会标记完成。";
  }
  if (reasons.has("verifier_modified_candidate") || reasons.has("candidate_worktree_not_clean")) {
    return "复核时发现候选内容不稳定，本次修改不会标记完成。";
  }
  if (verification.status === "needs_configuration") {
    return "自动复核环境尚未配置完整，本次修改不会标记完成。";
  }
  return "独立复核未通过，本次修改不会标记完成。系统已保留结果和验证记录。";
}

export function enqueueExecutionOutcomeStatus(input: {
  database: DatabaseSync;
  cardTemplateId?: string;
  outcome: CandidateExecutionOutcome;
  now: number;
}): void {
  const passed = input.outcome.report.state === "target_tests_passed" && !!input.outcome.resultSha;
  if (passed) {
    const completion = completeVerifiedLowRiskCandidate(input.database, {
      workItemId: input.outcome.workItemId,
      runId: input.outcome.runId,
      sourceEventId: `candidate:${input.outcome.runId}`,
      now: input.now,
    });
    if (completion.completed) return;
  }
  const assessment = passed
    ? assessCandidateApproval(input.database, {
        workItemId: input.outcome.workItemId,
        runId: input.outcome.runId,
      })
    : null;
  const candidatePreview = passed
    ? renderCandidateDiffPreview({
        repository: input.outcome.worktreePath,
        baseSha: input.outcome.baseSha,
        resultSha: input.outcome.resultSha!,
        changedPaths: input.outcome.changedPaths,
      })
    : undefined;
  const workItem = passed
    ? input.database
        .prepare("SELECT version FROM collaboration_work_items WHERE id = ?")
        .get(input.outcome.workItemId) as { version: number } | undefined
    : undefined;
  if (passed && !workItem) throw new Error("candidate_owner_decision_work_item_missing");
  let card;
  if (passed && input.cardTemplateId) {
    card = {
      type: "plan_status_card" as const,
      headline: "修改完成，需要负责人确认" as const,
      cardTemplateId: input.cardTemplateId,
      outTrackId: `candidate-${input.outcome.runId}`,
      workItemId: input.outcome.workItemId,
      workItemVersion: workItem!.version,
      status: "candidate_ready" as const,
      summary: CANDIDATE_READY_SUMMARY,
      approvalReasons: assessment?.approvalReasons,
      approvalRequired: true,
      candidateSha: input.outcome.resultSha!,
      ...(candidatePreview ? { candidatePreview } : {}),
      changedPaths: input.outcome.changedPaths,
      testStates: input.outcome.evidence.map((item) => `${item.commandId}: ${item.state}`),
    };
  } else {
    card = renderPlanStatusCard({
      workItemId: input.outcome.workItemId,
      planRevision: input.outcome.planRevision,
      status: passed ? "candidate_ready" : "execution_failed",
      ...(passed
        ? {
            summary: CANDIDATE_READY_SUMMARY,
            approvalReasons: assessment?.approvalReasons,
            candidateSha: input.outcome.resultSha!,
            ...(candidatePreview ? { candidatePreview } : {}),
            changedPaths: input.outcome.changedPaths,
            testStates: input.outcome.evidence.map((item) => `${item.commandId}: ${item.state}`),
            workItemVersion: workItem!.version,
          }
        : {
            failures: input.outcome.report.reasons.length
              ? input.outcome.report.reasons
              : [input.outcome.report.state],
          }),
    });
  }
  input.database.exec("BEGIN IMMEDIATE");
  try {
    enqueueInboundCard(input.database, {
      sourceEventId: `candidate:${input.outcome.runId}`,
      aggregateType: "plan",
      aggregateId: input.outcome.workItemId,
      aggregateVersion: input.outcome.planRevision,
      card,
      supersessionKey: `work-item:${input.outcome.workItemId}:execution-status`,
      now: input.now,
    });
    input.database.exec("COMMIT");
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
}

export function enqueuePendingOwnerDecisionCards(
  database: DatabaseSync,
  cardTemplateId: string | undefined,
  now: number,
): number {
  const rows = database.prepare(
    "SELECT w.id AS work_item_id, w.version AS work_item_version, w.current_plan_revision AS plan_revision, " +
      "r.id AS run_id, r.repository_path, c.base_sha, c.result_sha, c.changed_paths_json " +
      "FROM collaboration_work_items w " +
      "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "WHERE w.definition_status = 'ready_for_execution' " +
      "AND w.control_state = 'active' AND w.accepted_candidate_sha IS NULL " +
      "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
      "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
      "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
      "ORDER BY w.updated_at, w.id",
  ).all() as unknown as Array<{
    work_item_id: string;
    work_item_version: number;
    plan_revision: number;
    run_id: string;
    repository_path: string;
    base_sha: string;
    result_sha: string;
    changed_paths_json: string;
  }>;
  let enqueued = 0;
  for (const row of rows) {
    if (!candidateHasPassedMetaReview(database, row.run_id, row.result_sha)) continue;
    const completion = completeVerifiedLowRiskCandidate(database, {
      workItemId: row.work_item_id,
      runId: row.run_id,
      sourceEventId: `candidate-completed:${row.run_id}:v${row.work_item_version}`,
      now,
    });
    if (completion.completed) {
      enqueued += 1;
      continue;
    }
    const sourceEventId = `owner-decision:${row.run_id}:v${row.work_item_version}`;
    if (database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(sourceEventId)) continue;
    const evidence = database
      .prepare("SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ? ORDER BY command_id")
      .all(row.run_id) as unknown as Array<{ command_id: string; state: string }>;
    const changedPaths = parseJson<string[]>(row.changed_paths_json) ?? [];
    const candidatePreview = renderCandidateDiffPreview({
      repository: row.repository_path,
      baseSha: row.base_sha,
      resultSha: row.result_sha,
      changedPaths,
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(database, {
        sourceEventId,
        aggregateType: "plan",
        aggregateId: row.work_item_id,
        aggregateVersion: row.plan_revision,
        card: cardTemplateId
          ? {
              type: "plan_status_card",
              headline: "修改完成，需要负责人确认",
              cardTemplateId,
              outTrackId: `candidate-${row.run_id}`,
              workItemId: row.work_item_id,
              workItemVersion: row.work_item_version,
              planRevision: row.plan_revision,
              status: "candidate_ready",
              summary: CANDIDATE_READY_SUMMARY,
              approvalReasons: completion.approvalReasons,
              approvalRequired: true,
              candidateSha: row.result_sha,
              ...(candidatePreview ? { candidatePreview } : {}),
              changedPaths,
              testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
            }
          : renderPlanStatusCard({
              workItemId: row.work_item_id,
              workItemVersion: row.work_item_version,
              planRevision: row.plan_revision,
              status: "candidate_ready",
              summary: CANDIDATE_READY_SUMMARY,
              approvalReasons: completion.approvalReasons,
              candidateSha: row.result_sha,
              ...(candidatePreview ? { candidatePreview } : {}),
              changedPaths,
              testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
            }),
        supersessionKey: `work-item:${row.work_item_id}:execution-status`,
        now,
      });
      database.exec("COMMIT");
      enqueued += 1;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return enqueued;
}

export function enqueueOwnerDecisionForWorkItem(
  database: DatabaseSync,
  workItemId: string,
  cardTemplateId: string | undefined,
  sourceEventId: string,
  now: number,
): boolean {
  const row = database.prepare(
    "SELECT w.id AS work_item_id, w.version AS work_item_version, w.current_plan_revision AS plan_revision, " +
      "r.id AS run_id, r.repository_path, c.base_sha, c.result_sha, c.changed_paths_json " +
      "FROM collaboration_work_items w " +
      "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' " +
      "AND w.control_state = 'active' AND w.accepted_candidate_sha IS NULL " +
      "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
      "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
      "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
      "ORDER BY c.created_at DESC LIMIT 1",
  ).get(workItemId) as {
    work_item_id: string;
    work_item_version: number;
    plan_revision: number;
    run_id: string;
    repository_path: string;
    base_sha: string;
    result_sha: string;
    changed_paths_json: string;
  } | undefined;
  if (!row || !candidateHasPassedMetaReview(database, row.run_id, row.result_sha)) return false;
  if (database.prepare(
    "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
  ).get(sourceEventId)) return true;
  const evidence = database
    .prepare("SELECT command_id, state FROM collaboration_test_evidence WHERE run_id = ? ORDER BY command_id")
    .all(row.run_id) as unknown as Array<{ command_id: string; state: string }>;
  const changedPaths = parseJson<string[]>(row.changed_paths_json) ?? [];
  const assessment = assessCandidateApproval(database, { workItemId: row.work_item_id, runId: row.run_id });
  const candidatePreview = renderCandidateDiffPreview({
    repository: row.repository_path,
    baseSha: row.base_sha,
    resultSha: row.result_sha,
    changedPaths,
  });
  const card = cardTemplateId
    ? {
        type: "plan_status_card" as const,
        headline: "修改完成，需要负责人确认" as const,
        cardTemplateId,
        outTrackId: `candidate-${row.run_id}-refresh-${sourceEventId}`,
        workItemId: row.work_item_id,
        workItemVersion: row.work_item_version,
        planRevision: row.plan_revision,
        status: "candidate_ready" as const,
        summary: CANDIDATE_READY_SUMMARY,
        approvalReasons: assessment.approvalReasons,
        approvalRequired: true,
        candidateSha: row.result_sha,
        ...(candidatePreview ? { candidatePreview } : {}),
        changedPaths,
        testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
      }
    : renderPlanStatusCard({
        workItemId: row.work_item_id,
        workItemVersion: row.work_item_version,
        planRevision: row.plan_revision,
        status: "candidate_ready",
        summary: CANDIDATE_READY_SUMMARY,
        approvalReasons: assessment.approvalReasons,
        candidateSha: row.result_sha,
        ...(candidatePreview ? { candidatePreview } : {}),
        changedPaths,
        testStates: evidence.map((item) => `${item.command_id}: ${item.state}`),
      });
  database.exec("SAVEPOINT owner_decision_reply");
  try {
    enqueueInboundCard(database, {
      sourceEventId,
      aggregateType: "work_item",
      aggregateId: row.work_item_id,
      aggregateVersion: row.work_item_version,
      card,
      supersessionKey: `work-item:${row.work_item_id}:execution-status`,
      now,
    });
    database.exec("RELEASE owner_decision_reply");
    return true;
  } catch (error) {
    database.exec("ROLLBACK TO owner_decision_reply; RELEASE owner_decision_reply");
    throw error;
  }
}

class NoCandidateInspector implements CandidateInspectionPort {
  async inspect() {
    return { complete: false, resultSha: null, reason: "candidate_inspector_unavailable" };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeConfigurationReason(error: unknown): string {
  if (error instanceof Error && error.message === "restore_review_required") return error.message;
  return "dingtalk_credentials_invalid";
}

async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, milliseconds));
    void promise.then(() => finish(true), () => finish(true));
  });
}

async function resultBounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { completed: true; value: T } | { completed: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ completed: false }), Math.max(1, milliseconds));
    void promise.then(
      (value) => finish({ completed: true, value }),
      () => finish({ completed: false }),
    );
  });
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class CollaborationHeadlessRuntime {
  private readonly options: CollaborationHeadlessRuntimeOptions;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly lifecycleRecoveryTimeoutMs: number;
  private readonly clock: RuntimeClock;
  private readonly logger: RuntimeLogger;
  private readonly platform: NodeJS.Platform;
  private readonly executionIsolation: "native_linux" | "docker_linux";
  private currentState: CollaborationRuntimeState = "stopped";
  private reason: string | null = null;
  private service: CollaborationService | null = null;
  private database: DatabaseSync | null = null;
  private leaseCoordinator: InstanceLeaseCoordinator | null = null;
  private lease: InstanceLease | null = null;
  private dispatcher: OutboxDispatcher | null = null;
  private maintenance: RuntimeMaintenancePort | null = null;
  private attachmentIngestion: RuntimeAttachmentIngestionPort | null = null;
  private attachmentTask: Promise<void> | null = null;
  private attachmentAbort = new AbortController();
  private stream: RuntimeStream | null = null;
  private dingTalkState: CollaborationRuntimeHealth["dingtalk"]["state"];
  private naturalIntakeTask: Promise<void> | null = null;
  private onlineDocumentTask: Promise<void> | null = null;
  private lifecycleRecoveryTask: Promise<void> | null = null;
  private verificationAbort = new AbortController();
  private verificationCleanupUnconfirmed = false;
  private drainPromise: Promise<DrainOutcome> | null = null;
  private stopPromise: Promise<CollaborationRuntimeHealth> | null = null;
  private readonly activeExecutions = new Set<Promise<unknown>>();
  private readonly activeVerifications = new Set<Promise<CandidateVerificationOutcome>>();
  private readonly scheduledWorkItems = new Set<string>();
  private readonly activeRepositoryExecutions = new Set<string>();
  private readonly queuedWorkItems = new Set<string>();
  private readonly queuedVerifications = new Set<string>();
  private readonly dirtyMetaBundles = new Set<string>();
  private readonly metaBundleFailures = new Map<string, number>();
  private recoveryDecisions: RecoveryDecision[] = [];

  constructor(options: CollaborationHeadlessRuntimeOptions) {
    this.options = options;
    this.ownerId = options.ownerId?.trim() || `headless:${randomUUID()}`;
    this.leaseTtlMs = positiveInteger(options.instanceLeaseTtlMs ?? 30_000, "instanceLeaseTtlMs");
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs ?? 10_000, "shutdownTimeoutMs");
    this.lifecycleRecoveryTimeoutMs = positiveInteger(options.lifecycleRecoveryTimeoutMs ?? 5_000, "lifecycleRecoveryTimeoutMs");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? NULL_LOGGER;
    this.platform = options.platform ?? process.platform;
    this.executionIsolation = options.executionIsolation ?? "native_linux";
    this.dingTalkState = options.dingTalk?.enabled ? "stopped" : "disabled";
    if ((options.planner && !options.planningPolicy) || (!options.planner && options.planningPolicy)) {
      throw new Error("planner and planningPolicy must be configured together");
    }
    if (options.maintenance && options.maintenanceFactory) {
      throw new Error("maintenance and maintenanceFactory are mutually exclusive");
    }
    const executionParts = [options.agent, options.containment, options.commandRunner, options.execution];
    if (executionParts.some(Boolean) && !executionParts.every(Boolean) && (options.agent || options.commandRunner || options.execution)) {
      throw new Error("agent, containment, commandRunner, and execution must be configured together");
    }
  }

  async start(): Promise<CollaborationRuntimeHealth> {
    if (this.attachmentTask) throw new Error("collaboration_attachments_still_settling");
    if (this.lifecycleRecoveryTask) throw new Error("collaboration_recovery_still_settling");
    if (this.verificationCleanupUnconfirmed) throw new Error("verification_containment_unconfirmed");
    if (this.activeVerifications.size) throw new Error("collaboration_verification_still_settling");
    if (this.currentState !== "stopped" || this.service || this.database) {
      throw new Error("collaboration_runtime_already_started");
    }
    this.currentState = "starting";
    this.verificationAbort = new AbortController();
    this.attachmentAbort = new AbortController();
    this.queuedVerifications.clear();
    this.reason = null;
    this.logger.write({ event: "collaboration.runtime.starting", state: this.currentState });
    try {
      const serviceOptions: CollaborationServiceOptions = {
        dataDirectory: this.options.dataDirectory,
        ...(this.options.onlineDocuments ? { onlineDocuments: { reader: this.options.onlineDocuments,
          currentLease: () => this.currentState === "running" ? this.lease : null } } : {}),
        ...(this.options.planner && this.options.planningPolicy
          ? {
              planning: {
                planner: this.options.planner,
                policy: this.options.planningPolicy,
                ...(this.options.naturalIntake ? { naturalIntake: this.options.naturalIntake } : {}),
                ...(this.options.planningDefaultDefinition
                  ? { defaultDefinition: this.options.planningDefaultDefinition }
                  : {}),
              },
            }
          : {}),
        ...(this.executionEnabled()
          ? {
              execution: {
                ...this.options.execution!,
                agent: this.options.agent!,
                containment: this.options.containment!,
                commandRunner: this.options.commandRunner!,
                scheduler: { ownerId: this.ownerId, leaseTtlMs: this.leaseTtlMs },
              },
            }
          : {}),
      };
      this.service = startCollaborationService(serviceOptions);
      this.database = new DatabaseSync(join(this.options.dataDirectory, "collaboration", "collaboration.sqlite"));
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (this.options.probeOnly) {
        const initialHealth = this.service.health();
        if (!initialHealth.ready) this.reason = initialHealth.degradation?.reason ?? "service_not_ready";
        if (!this.reason) await this.probeDingTalk();
        this.currentState = this.reason ? "degraded" : "running";
        this.logger.write({
          event: "collaboration.runtime.probed",
          state: this.currentState,
          ...(this.reason ? { code: this.reason } : {}),
        });
        return this.health();
      }
      this.leaseCoordinator = new InstanceLeaseCoordinator(this.database, this.ownerId);
      this.lease = this.leaseCoordinator.acquire(this.clock.now(), this.leaseTtlMs);
      if (!this.lease) throw new Error("instance_lease_unavailable");
      if (this.options.coordinator) await registerCoordinator(this.database, this.lease, this.options.coordinator, () => this.clock.now());
      if (readRestoreGuard(this.database).state === "live") {
        publishVerificationRuntimePolicy(this.database, { instance: this.lease, now: this.clock.now(),
          repositories: this.options.execution?.repositories ?? {}, mappingPolicy: this.options.acceptanceMapping?.policyId });
      }
      this.maintenance = this.options.maintenanceFactory
        ? this.options.maintenanceFactory({ database: this.database, dataDirectory: this.options.dataDirectory })
        : (this.options.maintenance ?? null);
      if (this.options.attachmentIngestionFactory) {
        const database = this.database, lease = this.lease, signal = this.attachmentAbort.signal;
        const assertActive = () => {
          if (signal.aborted || this.database !== database || this.currentState !== "running" || this.reason) throw new Error("attachment_ingestion_inactive");
          assertCurrentInstanceLease(database, lease, this.clock.now());
        };
        this.attachmentIngestion = this.options.attachmentIngestionFactory({
          databaseFile: join(this.options.dataDirectory, "collaboration", "collaboration.sqlite"),
          dataDirectory: this.options.dataDirectory,
          signal, assertActive, instance: { ownerId: lease.ownerId, fence: lease.fence },
          onEvidence: (workItemId, evidence) => {
            assertActive();
            this.service!.observeAttachmentEvidence(workItemId, evidence, this.clock.now());
            this.syncMetaBundleBestEffort(workItemId, true);
            if (this.options.autoExecuteReady) this.scheduleReadyExecution(workItemId);
          },
        });
      }

      if (this.options.outboxDelivery) {
        this.dispatcher = new OutboxDispatcher(this.database, this.options.outboxDelivery, {
          maxAttempts: this.options.outbox?.maxAttempts ?? 5,
          claimTtlMs: this.options.outbox?.claimTtlMs ?? 30_000,
          baseBackoffMs: this.options.outbox?.baseBackoffMs ?? 1_000,
          maxBackoffMs: this.options.outbox?.maxBackoffMs ?? 60_000,
          ...(this.options.outbox?.jitter ? { jitter: this.options.outbox.jitter } : {}),
        });
      }

      const initialHealth = this.service.health();
      if (!initialHealth.ready) {
        this.reason = initialHealth.degradation?.reason ?? "service_not_ready";
      } else {
        await this.recoverAtStartup();
      }
      if (!this.reason && this.executionEnabled()) this.queuePendingCandidatesAtStartup();
      if (!this.reason) {
        enqueuePendingOwnerDecisionCards(this.database, this.options.dingTalk?.cardTemplateId, this.clock.now());
        this.syncAllMetaBundles();
      }
      if (!this.reason) await this.startDingTalk();
      if (!this.reason && !this.service.health().ready) {
        this.reason = this.service.health().degradation?.reason ?? "service_not_ready";
      }
      this.currentState = this.reason ? "degraded" : "running";
      this.startLifecycleRecovery();
      this.drainVerificationQueue();
      this.rebuildNeverStartedQueue();
      this.logger.write({
        event: "collaboration.runtime.started",
        state: this.currentState,
        ...(this.reason ? { code: this.reason } : {}),
        recoveryCount: this.recoveryDecisions.length,
      });
      return this.health();
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime_start_failed";
      this.reason = code === "instance_lease_unavailable" ? code : "runtime_start_failed";
      this.currentState = "degraded";
      this.logger.write({ event: "collaboration.runtime.start_failed", code: this.reason, state: this.currentState });
      await this.closeResources();
      throw error;
    }
  }

  health(): CollaborationRuntimeHealth {
    let collaborationHealth: CollaborationHealth | null = null;
    try {
      collaborationHealth = this.service?.health() ?? null;
    } catch {
      collaborationHealth = null;
    }
    const stopped = this.currentState === "stopped";
    let lowDisk = false;
    try {
      const row = this.database
        ?.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1")
        .get() as { low_disk: number } | undefined;
      lowDisk = row?.low_disk === 1;
    } catch {
      lowDisk = false;
    }
    const currentStreamState = this.stream?.state();
    const liveDingTalkState = currentStreamState
      ? currentStreamState === "connected"
        ? "connected"
        : currentStreamState === "stopped"
          ? "stopped"
          : "reconnecting"
      : this.dingTalkState;
    const streamReason =
      this.options.probeOnly !== true &&
      this.options.dingTalk?.enabled === true &&
      this.currentState === "running" &&
      liveDingTalkState !== "connected"
        ? liveDingTalkState === "stopped"
          ? "dingtalk_connection_failed"
          : "dingtalk_reconnecting"
        : null;
    const reason =
      this.reason ??
      collaborationHealth?.degradation?.reason ??
      (lowDisk || collaborationHealth?.executionGated === "low_disk" ? "low_disk" : null) ??
      streamReason;
    const ready =
      this.currentState === "running" &&
      !reason &&
      collaborationHealth?.ready === true &&
      (this.options.probeOnly === true || !!this.lease);
    return {
      app: "openmausbot-collaboration",
      delivery: readDeliveryHealth(this.database, this.clock.now()),
      state: this.currentState,
      status: stopped ? "stopped" : ready ? "healthy" : "degraded",
      ready,
      ...(reason ? { reason } : {}),
      ...(collaborationHealth ? { database: collaborationHealth.database } : {}),
      ...(collaborationHealth
        ? {
            sourceBaseline: collaborationHealth.sourceBaseline,
            authority: collaborationHealth.authority,
            defaults: collaborationHealth.defaults,
          }
        : {}),
      instanceLease: this.lease ? "held" : "not_held",
      dingtalk: { enabled: this.options.dingTalk?.enabled === true, state: liveDingTalkState },
      executionMode: this.executionEnabled()
        ? "execute"
        : this.platform === "darwin"
          ? "observe_plan_only"
          : "not_configured",
    };
  }

  recovery(): readonly RecoveryDecision[] {
    return this.recoveryDecisions.map((decision) => ({ ...decision }));
  }

  ingestDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome {
    this.assertAcceptingNewWork();
    const outcome = this.service!.ingestDingTalkMessage(message);
    if (!outcome.duplicate && outcome.workItemId) this.syncMetaBundleBestEffort(outcome.workItemId, true);
    if (this.options.autoExecuteReady && !outcome.duplicate && outcome.workItemId) {
      this.scheduleReadyExecution(outcome.workItemId);
    }
    return outcome;
  }

  performDingTalkOwnerAction(action: DingTalkCardAction): OwnerActionOutcome {
    this.assertOperational();
    if (isOwnerQueryEvent(this.database!, action.transportEventId)) throw new Error("owner_query_event_conflict");
    if (isDeliveryReviewEvent(this.database!, action.transportEventId)) throw new Error("delivery_review_event_conflict");
    let workItemId: string | null = null;
    try {
      const outcome = this.service!.performOwnerAction({
        actionToken: action.actionToken,
        request: { sourceEventId: action.transportEventId, origin: action.origin ?? "card",
          ...(action.origin === "text" ? { conversationId: action.conversationId } : {}) },
        sender: action.sender,
        ...(action.reason ? { reason: action.reason } : {}),
        now: action.receivedAt,
      });
      workItemId = outcome.workItemId;
      return outcome;
    } finally {
      if (workItemId) this.syncMetaBundleBestEffort(workItemId, true);
    }
  }

  performDingTalkOwnerTextCommand(command: DingTalkOwnerTextCommand): DingTalkOwnerTextCommandOutcome {
    try {
      if (command.command === "status" || command.command === "refresh_approval") {
        this.assertOperational();
        return recordOwnerQuery(this.database!, command, this.clock.now(), () => {
          this.assertOperational();
          assertCurrentInstanceLease(this.database!, this.lease!, this.clock.now());
        }, () => this.performDingTalkOwnerTextCommandInternal(command));
      }
      return this.performDingTalkOwnerTextCommandInternal(command);
    } finally {
      this.syncMetaBundleBestEffort(command.workItemId, true);
    }
  }

  recoverDingTalkAttachmentProjection(message: DingTalkInboundMessage): ReturnType<typeof recoverAttachmentProjection> {
    this.assertOperational();
    const database = this.database!, lease = this.lease!;
    return recoverAttachmentProjection(database, message, this.clock.now(), () => {
      this.assertOperational();
      assertCurrentInstanceLease(database, lease, this.clock.now());
    });
  }

  recoverDingTalkRequirements(message: DingTalkInboundMessage): ReturnType<typeof recoverNaturalIntake> {
    this.assertOperational();
    const database = this.database!, lease = this.lease!;
    return recoverNaturalIntake(database, message, this.clock.now(), () => {
      this.assertOperational();
      assertCurrentInstanceLease(database, lease, this.clock.now());
    });
  }

  reviewDingTalkDeliveries(message: DingTalkInboundMessage): ReturnType<typeof requestDeliveryReview> {
    this.assertOperational();
    const database = this.database!, lease = this.lease!;
    return requestDeliveryReview(database, message, this.clock.now(), () => {
      this.assertOperational();
      assertCurrentInstanceLease(database, lease, this.clock.now());
    });
  }

  private performDingTalkOwnerTextCommandInternal(command: DingTalkOwnerTextCommand): DingTalkOwnerTextCommandOutcome {
    this.assertOperational();
    const database = this.database!;
    if (isDeliveryReviewEvent(database, command.transportEventId)) throw new Error("delivery_review_event_conflict");
    if (database.prepare("SELECT 1 FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?").get(command.transportEventId)) {
      throw new Error("natural_intake_recovery_event_conflict");
    }
    if (database.prepare("SELECT 1 FROM collaboration_attachment_recovery_requests WHERE source_event_id=?").get(command.transportEventId)) {
      throw new Error("attachment_recovery_event_conflict");
    }
    const previousTextCommand = database.prepare(
      "SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id = ?",
    ).get(command.transportEventId) as { outcome_json: string } | undefined;

    if (command.command === "status") {
      const row = database.prepare(
        "SELECT status, definition_status, control_state, version FROM collaboration_work_items WHERE id = ?",
      ).get(command.workItemId) as {
        status: string;
        definition_status: string;
        control_state: string;
        version: number;
      } | undefined;
      this.enqueueOwnerTextCommandStatus(command, Boolean(row), row ? "status_returned" : "unknown_work_item", row);
      return {
        allowed: Boolean(row),
        duplicate: false,
        command: command.command,
        workItemId: command.workItemId,
        reason: row ? "status_returned" : "unknown_work_item",
      };
    }

    if (command.command === "approve_candidate" || command.command === "reject_candidate") {
      const target = readCandidateApprovalTarget(database, command.workItemId);
      const previousOutcome = previousTextCommand
        ? parseJson<OwnerActionOutcome>(previousTextCommand.outcome_json)
        : null;
      const candidateSha = previousTextCommand
        ? previousOutcome?.candidateSha ?? null
        : target?.resultSha ?? null;
      const action = command.command === "approve_candidate" ? "accept" : "reject";
      const outcome = this.service!.performDirectOwnerAction({
        sourceEventId: command.transportEventId,
        replyRequested: true,
        conversationId: command.conversationId,
        action,
        workItemId: command.workItemId,
        sender: command.sender,
        ...(candidateSha ? { candidateSha } : {}),
        ...(command.reason ? { reason: command.reason } : {}),
        now: command.receivedAt,
      });
      const ownerAction: DingTalkCardAction = {
        transportEventId: command.transportEventId,
        transportMessageId: command.transportMessageId,
        actionToken: "text-command",
        sender: command.sender,
        ...(command.reason ? { reason: command.reason } : {}),
        receivedAt: command.receivedAt,
        origin: "text",
      };
      this.enqueueTextOwnerActionStatus(ownerAction, outcome);
      return {
        allowed: outcome.allowed,
        duplicate: outcome.duplicate,
        command: command.command,
        workItemId: command.workItemId,
        reason: outcome.reason,
      };
    }

    if (command.command === "refresh_approval") {
      const policy = evaluateOwnerPolicy(database, {
        sender: command.sender,
        capability: "candidate.accept",
        now: command.receivedAt,
      });
      if (policy.decision !== "allow") {
        this.enqueueOwnerTextCommandStatus(command, false, policy.reason);
        return {
          allowed: false,
          duplicate: false,
          command: command.command,
          workItemId: command.workItemId,
          reason: policy.reason,
        };
      }
      const refreshed = enqueueOwnerDecisionForWorkItem(
        database,
        command.workItemId,
        this.options.dingTalk?.cardTemplateId,
        command.transportEventId,
        command.receivedAt,
      );
      if (!refreshed) this.enqueueOwnerTextCommandStatus(command, false, "candidate_not_current");
      return {
        allowed: refreshed,
        duplicate: false,
        command: command.command,
        workItemId: command.workItemId,
        reason: refreshed ? "approval_refreshed" : "candidate_not_current",
      };
    }

    const action = DIRECT_TEXT_ACTIONS[command.command];
    if (!action) throw new Error("unsupported_owner_text_command");
    const outcome = this.service!.performDirectOwnerAction({
      sourceEventId: command.transportEventId,
      replyRequested: true,
      conversationId: command.conversationId,
      action,
      workItemId: command.workItemId,
      sender: command.sender,
      now: command.receivedAt,
    });
    this.enqueueOwnerTextCommandStatus(command, outcome.allowed, outcome.reason);
    if (!outcome.duplicate && outcome.allowed && (action === "resume" || action === "retry")) {
      this.scheduleReadyExecution(command.workItemId);
    }
    return {
      allowed: outcome.allowed,
      duplicate: outcome.duplicate,
      command: command.command,
      workItemId: command.workItemId,
      reason: outcome.reason,
    };
  }

  private enqueueTextOwnerActionStatus(action: DingTalkCardAction, outcome: OwnerActionOutcome): void {
    if (!this.database) return;
    if (this.database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(action.transportEventId)) return;
    const status = !outcome.allowed
      ? "owner_action_denied"
      : outcome.action === "accept"
        ? "owner_accepted"
        : outcome.action === "reject"
          ? "owner_rejected"
          : "owner_action_denied";
    const summary = !outcome.allowed
      ? "该验收操作未通过身份、有效期或候选状态校验，请使用最新候选消息中的指令。"
      : undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      enqueueInboundCard(this.database, {
        sourceEventId: action.transportEventId,
        aggregateType: outcome.workItemId ? "plan" : "association",
        aggregateId: outcome.workItemId ?? action.transportEventId,
        aggregateVersion: outcome.workItemVersion ?? 1,
        card: renderPlanStatusCard({
          workItemId: outcome.workItemId ?? "unavailable",
          status,
          ...(summary ? { summary } : {}),
        }),
        now: action.receivedAt,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueueOwnerTextCommandStatus(
    command: DingTalkOwnerTextCommand,
    allowed: boolean,
    reason: string,
    state?: { status: string; definition_status: string; control_state: string; version: number },
  ): void {
    if (!this.database) return;
    if (this.database.prepare(
      "SELECT 1 FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?",
    ).get(command.transportEventId)) return;
    const row = state ?? this.database.prepare(
      "SELECT status, definition_status, control_state, version FROM collaboration_work_items WHERE id = ?",
    ).get(command.workItemId) as {
      status: string;
      definition_status: string;
      control_state: string;
      version: number;
    } | undefined;
    this.database.exec("SAVEPOINT owner_query_status_reply");
    try {
      enqueueInboundCard(this.database, {
        sourceEventId: command.transportEventId,
        aggregateType: "work_item",
        aggregateId: command.workItemId,
        aggregateVersion: row?.version ?? 1,
        card: renderCommandStatusCard({
          command: command.command,
          workItemId: command.workItemId,
          outcome: allowed ? "allowed" : "denied",
          summary: commandSummary(command.command, allowed, reason),
          ...(row
            ? {
                workItemStatus: row.status,
                definitionStatus: row.definition_status,
                controlState: row.control_state,
              }
            : {}),
        }),
        now: command.receivedAt,
      });
      this.database.exec("RELEASE owner_query_status_reply");
    } catch (error) {
      this.database.exec("ROLLBACK TO owner_query_status_reply; RELEASE owner_query_status_reply");
      throw error;
    }
  }

  async executeCurrentPlan(workItemId: string, attempt?: number): Promise<CandidateExecutionOutcome> {
    this.assertAcceptingNewWork();
    if (!this.executionEnabled()) throw new Error("collaboration_execution_not_configured");
    const row = this.database!.prepare(
      "SELECT s.repository FROM collaboration_work_items w " +
      "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
      "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision WHERE w.id=?",
    ).get(workItemId) as { repository: string } | undefined;
    if (!row) throw new Error("collaboration_execution_target_unavailable");
    const repository = this.repositoryQueueKey(row.repository);
    if (this.activeRepositoryExecutions.has(repository) || this.scheduledWorkItems.has(workItemId)) {
      throw new Error("collaboration_repository_busy");
    }
    if (this.repositoryVerificationBlocked(workItemId)) throw new Error("verification_repository_unsettled");
    // Reserve synchronously, before the executor's first asynchronous preparation step.
    const lifetime = this.verificationAbort;
    this.activeRepositoryExecutions.add(repository);
    this.scheduledWorkItems.add(workItemId);
    try {
      return await this.executeReservedPlan(workItemId, attempt);
    } finally {
      if (lifetime === this.verificationAbort) {
        this.scheduledWorkItems.delete(workItemId);
        this.activeRepositoryExecutions.delete(repository);
        this.scheduleNextQueuedWorkItem(repository);
      }
    }
  }

  /** Only callers holding this runtime's repository slot may enter this method. */
  private async executeReservedPlan(workItemId: string, attempt?: number): Promise<CandidateExecutionOutcome> {
    this.assertAcceptingNewWork();
    if (!this.executionEnabled()) throw new Error("collaboration_execution_not_configured");
    if (this.repositoryVerificationBlocked(workItemId)) throw new Error("verification_repository_unsettled");
    const execution = this.service!.executeCurrentPlan(workItemId, attempt, this.clock.now());
    this.activeExecutions.add(execution);
    try {
      return await execution;
    } finally {
      this.activeExecutions.delete(execution);
      this.syncMetaBundleBestEffort(workItemId, true);
    }
  }

  async drainOnce(): Promise<DrainOutcome> {
    if (this.drainPromise) return await this.drainPromise;
    this.drainPromise = this.performDrain();
    try {
      return await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  async stop(): Promise<CollaborationRuntimeHealth> {
    if (this.stopPromise) return await this.stopPromise;
    if (this.currentState === "stopped" && !this.service && !this.database) return this.health();
    this.stopPromise = this.performStop();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async performStop(): Promise<CollaborationRuntimeHealth> {
    const deadline = Date.now() + this.shutdownTimeoutMs;
    this.currentState = "draining";
    this.attachmentAbort.abort();
    this.verificationAbort.abort();
    this.logger.write({ event: "collaboration.runtime.draining", state: this.currentState });
    let releaseLease = false;
    try {
      const streamStop = Promise.resolve().then(() => this.stream?.stop());
      if (!(await waitBounded(streamStop, deadline - Date.now()))) this.reason = "shutdown_timeout";
      this.stream = null;
      this.dingTalkState = this.options.dingTalk?.enabled ? "stopped" : "disabled";
      if (this.drainPromise && !(await waitBounded(this.drainPromise, deadline - Date.now()))) {
        this.reason = "shutdown_timeout";
      }
      releaseLease = await this.interruptAndSettleRuns(Math.max(1, deadline - Date.now()));
      if (!releaseLease) this.reason = "shutdown_containment_unverified";
      if (this.attachmentTask && !(await waitBounded(this.attachmentTask, Math.max(1, deadline - Date.now())))) {
        releaseLease = false;
        this.reason = "shutdown_attachments_unsettled";
      }
      if (!(await waitBounded(Promise.allSettled([...this.activeVerifications]), Math.max(1, deadline - Date.now())))) {
        releaseLease = false;
        this.reason = "shutdown_verification_unsettled";
      }
      if (this.lifecycleRecoveryTask && !(await waitBounded(this.lifecycleRecoveryTask, Math.max(1, deadline - Date.now())))) {
        this.reason = "shutdown_recovery_unsettled";
        // Passive inspection cannot launch processes; durable occupancy remains,
        // and its captured abort signal prevents any late writes after closure.
      }
      if (this.verificationCleanupUnconfirmed) {
        releaseLease = false;
        this.reason = "verification_containment_unconfirmed";
      }
    } catch {
      this.reason = "shutdown_failed";
      releaseLease = false;
    } finally {
      await this.closeResources(releaseLease);
      this.currentState = "stopped";
      this.logger.write({ event: "collaboration.runtime.stopped", state: this.currentState });
    }
    return this.health();
  }

  private executionEnabled(): boolean {
    return (
      (this.platform !== "darwin" || this.executionIsolation === "docker_linux") &&
      !!this.options.agent &&
      !!this.options.containment &&
      !!this.options.commandRunner &&
      !!this.options.execution
    );
  }

  private pendingCandidateVerification(workItemId: string): {
    runId: string;
    worktreePath: string;
    repository: string;
    planRevision: number;
    candidateSha: string;
    verifierContractAttempts: number;
  } | null {
    if (!this.database) return null;
    const row = this.database.prepare(
      "SELECT r.id AS run_id,r.worktree_path,r.repository_path,r.plan_revision,c.result_sha," +
        "COALESCE((SELECT count(*) FROM collaboration_candidate_reviews review " +
        "WHERE review.candidate_run_id = r.id AND review.stage = 'verifier' " +
        "AND review.spec_hash = (SELECT latest_review.spec_hash FROM collaboration_candidate_reviews latest_review " +
        "WHERE latest_review.candidate_run_id = r.id AND latest_review.stage = 'verifier' " +
        "ORDER BY latest_review.attempt DESC LIMIT 1)),0) AS verifier_contract_attempts " +
        "FROM collaboration_work_items w " +
        "JOIN collaboration_runs r ON r.work_item_id = w.id AND r.plan_revision = w.current_plan_revision " +
        "JOIN collaboration_candidates c ON c.run_id = r.id " +
        "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' AND w.control_state = 'active' " +
        "AND w.status NOT IN ('accepted','cancelled') " +
        "AND r.status = 'succeeded' AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
        "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
        "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
        "ORDER BY r.finished_at DESC LIMIT 1",
    ).get(workItemId) as {
      run_id: string;
      worktree_path: string;
      repository_path: string;
      plan_revision: number;
      result_sha: string;
      verifier_contract_attempts: number;
    } | undefined;
    if (!row || candidateHasPassedMetaReview(this.database, row.run_id, row.result_sha)) return null;
    return {
      runId: row.run_id,
      worktreePath: row.worktree_path,
      repository: row.repository_path,
      planRevision: row.plan_revision,
      candidateSha: row.result_sha,
      verifierContractAttempts: row.verifier_contract_attempts,
    };
  }

  private scheduleReadyExecution(workItemId: string, verificationOnly = false): void {
    if (!this.executionEnabled() || this.options.probeOnly || !this.health().ready || this.scheduledWorkItems.has(workItemId) || !this.database) return;
    const pendingVerification = this.pendingCandidateVerification(workItemId);
    if (pendingVerification) {
      if (pendingVerification.verifierContractAttempts >= CANDIDATE_VERIFICATION_MAX_ATTEMPTS) {
        this.queuedVerifications.delete(workItemId);
        return;
      }
      const repository = this.repositoryQueueKey(pendingVerification.repository);
      if (this.activeRepositoryExecutions.has(repository)) {
        this.queuedVerifications.add(workItemId);
        return;
      }
      // An old, unconfirmed session is not an in-memory queue slot we can release.
      if (this.repositoryVerificationBlocked(workItemId)) return;
      this.queuedVerifications.delete(workItemId);
      this.queuedWorkItems.delete(workItemId);
      this.activeRepositoryExecutions.add(repository);
      this.scheduledWorkItems.add(workItemId);
      const lifetime = this.verificationAbort;
      void this.verifyCandidate(pendingVerification.runId, pendingVerification.worktreePath)
        .then((verification) => {
          if (lifetime.signal.aborted || lifetime !== this.verificationAbort) return;
          if (verification.passed) {
            enqueuePendingOwnerDecisionCards(
              this.database!,
              this.options.dingTalk?.cardTemplateId,
              this.clock.now(),
            );
          } else {
            this.enqueueVerificationFailure({
              runId: pendingVerification.runId,
              workItemId,
              planRevision: pendingVerification.planRevision,
            }, verification);
          }
        })
        .catch(() => {
          if (!lifetime.signal.aborted && lifetime === this.verificationAbort) {
            this.logger.write({ event: "collaboration.verification.interrupted", code: "verification_unavailable", workItemId });
          }
        })
        .finally(() => {
          if (lifetime !== this.verificationAbort) return;
          this.syncMetaBundleBestEffort(workItemId, true);
          this.scheduledWorkItems.delete(workItemId);
          this.activeRepositoryExecutions.delete(repository);
          this.scheduleNextQueuedWorkItem(repository);
        });
      return;
    }
    this.queuedVerifications.delete(workItemId);
    if (verificationOnly) return;
    const ready = this.database
      .prepare(
        "SELECT w.current_plan_revision AS plan_revision,s.repository,max(COALESCE((" +
          "SELECT MAX(previous.attempt) FROM collaboration_runs previous WHERE previous.work_item_id = w.id" +
          "), 0),COALESCE((SELECT MAX(d.attempt) FROM collaboration_execution_dispatches d WHERE d.work_item_id=w.id),0)," +
          "COALESCE((SELECT MAX(e.attempt) FROM collaboration_execution_sessions e WHERE e.work_item_id=w.id),0)) AS previous_attempt FROM collaboration_work_items w " +
          "JOIN collaboration_plan_revisions p ON p.work_item_id = w.id AND p.revision = w.current_plan_revision " +
          "JOIN collaboration_work_item_snapshots s ON s.work_item_id = w.id AND s.revision = p.snapshot_revision " +
          "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' AND w.control_state = 'active' " +
          "AND w.status NOT IN ('accepted','cancelled') AND p.status='published' " +
          currentExecutionSpecSql +
          "AND w.current_plan_revision IS NOT NULL AND NOT EXISTS (" +
          "SELECT 1 FROM collaboration_runs r WHERE r.work_item_id = w.id " +
          "AND r.plan_revision = w.current_plan_revision AND r.status IN ('running', 'succeeded'))",
      )
      .get(workItemId) as { plan_revision: number; repository: string; previous_attempt: number } | undefined;
    if (!ready) {
      this.queuedWorkItems.delete(workItemId);
      return;
    }
    if (!preparationDispatchAllowed(this.database, workItemId, ready.plan_revision)) {
      this.queuedWorkItems.delete(workItemId);
      return;
    }
    const attempt = ready.previous_attempt + 1;
    if (attempt > this.options.execution!.limits.maxAttempts) { this.queuedWorkItems.delete(workItemId); return; }
    const repository = this.repositoryQueueKey(ready.repository);
    if (this.activeRepositoryExecutions.has(repository)) {
      this.queuedWorkItems.add(workItemId);
      return;
    }
    if (this.repositoryVerificationBlocked(workItemId)) return;
    this.queuedWorkItems.delete(workItemId);
    if (!this.lease) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, this.lease, this.clock.now());
      // Reserve before worktree preparation: failures/crashes here must not reset the attempt budget.
      this.database.prepare("INSERT INTO collaboration_execution_dispatches (work_item_id,plan_revision,attempt,instance_owner,instance_fence,created_at) VALUES (?,?,?,?,?,?)")
        .run(workItemId, ready.plan_revision, attempt, this.lease.ownerId, this.lease.fence, this.clock.now());
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    this.activeRepositoryExecutions.add(repository);
    this.scheduledWorkItems.add(workItemId);
    void this.executeReservedPlan(workItemId, attempt)
      .then(async (outcome) => await this.enqueueExecutionStatus(outcome))
      .catch((error: unknown) => {
        if (!this.database || !this.lease) return;
        try {
          if (recordPreparationResult(this.database, { workItemId, planRevision: ready.plan_revision, attempt,
            state: error instanceof CommandCleanupError ? "unsettled" : "failed", lease: this.lease,
            maxAttempts: this.options.execution!.limits.maxAttempts, now: this.clock.now() })) return;
        } catch { /* A stale scheduler must not publish a new completion claim. */ return; }
        this.enqueueExecutionFailure(workItemId, ready.plan_revision, attempt);
      })
      .finally(() => {
        this.scheduledWorkItems.delete(workItemId);
        this.activeRepositoryExecutions.delete(repository);
        this.scheduleNextQueuedWorkItem(repository);
      });
  }

  private scheduleNextQueuedWorkItem(repository: string): void {
    if (!this.health().ready) return;
    this.drainVerificationQueue();
    if (this.activeRepositoryExecutions.has(repository)) return;
    for (const workItemId of this.queuedWorkItems) {
      const row = this.database?.prepare(
        "SELECT s.repository FROM collaboration_work_items w " +
          "JOIN collaboration_plan_revisions p ON p.work_item_id = w.id AND p.revision = w.current_plan_revision " +
          "JOIN collaboration_work_item_snapshots s ON s.work_item_id = w.id AND s.revision = p.snapshot_revision " +
          "WHERE w.id = ?",
      ).get(workItemId) as { repository: string } | undefined;
      if (!row) { this.queuedWorkItems.delete(workItemId); continue; }
      if (this.repositoryQueueKey(row.repository) !== repository) continue;
      this.queuedWorkItems.delete(workItemId);
      this.scheduleReadyExecution(workItemId);
      if (this.activeRepositoryExecutions.has(repository)) break;
    }
  }

  private repositoryQueueKey(repository: string): string {
    try { return realpathSync(repository); } catch { return repository; }
  }

  private rebuildNeverStartedQueue(): void {
    if (!this.options.autoExecuteReady || this.options.probeOnly || !this.executionEnabled() || !this.database || !this.health().ready) return;
    // Revalidate waiting controls on each pass; a paused head must not starve eligible siblings.
    for (const id of [...this.queuedWorkItems]) this.scheduleReadyExecution(id);
    const excluded = [...new Set([...this.scheduledWorkItems, ...this.queuedWorkItems])];
    const rows = this.database.prepare("SELECT w.id FROM collaboration_work_items w " +
      "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
      "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision " +
      "WHERE w.definition_status='ready_for_execution' AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
      currentExecutionSpecSql +
      "AND max(COALESCE((SELECT MAX(r.attempt) FROM collaboration_runs r WHERE r.work_item_id=w.id),0)," +
      "COALESCE((SELECT MAX(d.attempt) FROM collaboration_execution_dispatches d WHERE d.work_item_id=w.id),0)," +
      "COALESCE((SELECT MAX(e.attempt) FROM collaboration_execution_sessions e WHERE e.work_item_id=w.id),0)) < ? " +
      "AND p.status='published' AND NOT EXISTS (SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=w.id AND r.plan_revision=w.current_plan_revision) " +
      "AND ((NOT EXISTS (SELECT 1 FROM collaboration_execution_dispatches d WHERE d.work_item_id=w.id AND d.plan_revision=w.current_plan_revision) " +
      "AND NOT EXISTS (SELECT 1 FROM collaboration_execution_sessions e WHERE e.work_item_id=w.id AND e.plan_revision=w.current_plan_revision)) " +
      "OR EXISTS (SELECT 1 FROM collaboration_execution_dispatches d WHERE d.work_item_id=w.id AND d.plan_revision=w.current_plan_revision " +
      "AND d.attempt=(SELECT MAX(latest.attempt) FROM collaboration_execution_dispatches latest WHERE latest.work_item_id=w.id) AND " + authorizedPreparationRetrySql + ")) " +
      (excluded.length ? `AND w.id NOT IN (${excluded.map(() => "?").join(",")}) ` : "") +
      "ORDER BY p.created_at,w.created_at,w.id LIMIT 64").all(this.options.execution!.limits.maxAttempts, ...excluded) as unknown as Array<{ id: string }>;
    for (const row of rows) this.scheduleReadyExecution(row.id);
  }

  private async enqueueExecutionStatus(outcome: CandidateExecutionOutcome): Promise<void> {
    if (!this.database) return;
    try {
      if (outcome.report.state === "target_tests_passed" && outcome.resultSha) {
        const verification = await this.verifyCandidate(outcome.runId, outcome.worktreePath);
        if (!verification.passed) {
          this.enqueueVerificationFailure(outcome, verification);
          return;
        }
      }
      enqueueExecutionOutcomeStatus({
        database: this.database,
        ...(this.options.dingTalk?.cardTemplateId
          ? { cardTemplateId: this.options.dingTalk.cardTemplateId }
          : {}),
        outcome,
        now: this.clock.now(),
      });
    } finally {
      this.syncMetaBundleBestEffort(outcome.workItemId, true);
    }
  }

  private repositoryVerificationBlocked(workItemId: string): boolean {
    if (!this.database) return true;
    const row=this.database.prepare("SELECT s.repository FROM collaboration_work_items w JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision WHERE w.id=?")
      .get(workItemId) as {repository:string}|undefined;
    return !!row && hasUnsettledRepositoryActivity(this.database,row.repository);
  }

  private verificationCoordinator(candidateRunId: string, runner = this.options.commandRunner!): CandidateVerificationCoordinator {
    const row = this.database!.prepare(
      "SELECT repository_path FROM collaboration_runs WHERE id = ?",
    ).get(candidateRunId) as { repository_path: string } | undefined;
    if (!row) throw new Error("candidate_verification_run_missing");
    const configured = this.options.execution!.repositories[row.repository_path];
    if (!configured) throw new Error("candidate_verification_repository_not_configured");
    return new CandidateVerificationCoordinator(this.database!, {
      commandRunner: runner,
      containment: this.options.containment!,
      commands: configured.targetCommands,
      dataDirectory: this.options.dataDirectory,
      maxAttempts: CANDIDATE_VERIFICATION_MAX_ATTEMPTS,
      acceptanceMapping: this.options.acceptanceMapping,
      clock: () => this.clock.now(),
    });
  }

  private async verifyCandidate(candidateRunId: string, worktreePath: string): Promise<CandidateVerificationOutcome> {
    const lease=this.lease!;
    const lifetime=this.verificationAbort;
    const verification=this.verificationCoordinator(candidateRunId).verify({candidateRunId,worktreePath,instance:lease,now:this.clock.now(),signal:lifetime.signal});
    this.activeVerifications.add(verification);
    try { return await verification; }
    catch (error) {
      if (error instanceof CommandCleanupError) {
        this.verificationCleanupUnconfirmed = true;
        this.reason = "verification_containment_unconfirmed";
        if (this.currentState === "running") this.currentState = "degraded";
      }
      throw error;
    }
    finally { this.activeVerifications.delete(verification); }
  }

  private drainVerificationQueue(): void {
    for (const workItemId of [...this.queuedVerifications]) {
      this.scheduleReadyExecution(workItemId, true);
    }
  }

  private queuePendingCandidatesAtStartup(repository?: string): void {
    const rows = this.database!.prepare(
      "SELECT r.id AS run_id,r.worktree_path,r.work_item_id,r.plan_revision,r.repository_path " +
        "FROM collaboration_runs r " +
        "JOIN collaboration_work_items w ON w.id = r.work_item_id AND w.current_plan_revision = r.plan_revision " +
        "JOIN collaboration_candidates c ON c.run_id = r.id " +
        "WHERE w.definition_status = 'ready_for_execution' AND w.control_state = 'active' " +
        "AND r.status = 'succeeded' " +
        "AND c.state = 'target_tests_passed' AND c.result_sha IS NOT NULL " +
        "AND r.attempt = (SELECT MAX(latest.attempt) FROM collaboration_runs latest " +
        "WHERE latest.work_item_id = w.id AND latest.plan_revision = w.current_plan_revision) " +
        "ORDER BY r.finished_at,r.id",
    ).all() as unknown as Array<{ run_id: string; worktree_path: string; work_item_id: string; plan_revision: number; repository_path: string }>;
    for (const row of rows) {
      if (repository && this.repositoryQueueKey(row.repository_path) !== this.repositoryQueueKey(repository)) continue;
      if (this.repositoryVerificationBlocked(row.work_item_id)) continue;
      this.queuedVerifications.add(row.work_item_id);
    }
  }

  private enqueueVerificationFailure(
    outcome: Pick<CandidateExecutionOutcome, "runId" | "workItemId" | "planRevision">,
    verification: CandidateVerificationOutcome,
  ): void {
    if (!this.database || !this.lease) return;
    const pending = verification.reasons.includes("acceptance_mapping_pending");
    const sourceEventId = `verification:${outcome.runId}:attempt:${verification.verifierAttempt}` +
      (pending ? `:pending:${verification.specHash}` : "");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, this.lease, this.clock.now());
      const current = this.database.prepare(
        "SELECT 1 FROM collaboration_work_items w " +
        "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
        "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision " +
        "JOIN collaboration_runs r ON r.work_item_id=w.id AND r.plan_revision=w.current_plan_revision " +
        "WHERE w.id=? AND w.current_plan_revision=? AND r.id=? " +
        "AND w.status NOT IN ('accepted','cancelled') AND w.control_state='active' " +
        currentExecutionSpecSql +
        "AND r.attempt=(SELECT MAX(latest.attempt) FROM collaboration_runs latest WHERE latest.work_item_id=w.id AND latest.plan_revision=w.current_plan_revision) " +
        "AND NOT EXISTS (SELECT 1 FROM collaboration_outbox o WHERE o.source='dingtalk' AND o.source_event_id=?)",
      ).get(outcome.workItemId, outcome.planRevision, outcome.runId, sourceEventId);
      if (!current || !this.verificationCoordinator(outcome.runId).isCurrentNotification(outcome.runId, verification)) {
        this.database.exec("COMMIT");
        return;
      }
      enqueueInboundCard(this.database, {
        sourceEventId,
        aggregateType: "plan",
        aggregateId: outcome.workItemId,
        aggregateVersion: outcome.planRevision,
        card: renderPlanStatusCard({
          workItemId: outcome.workItemId,
          planRevision: outcome.planRevision,
          status: pending ? "verification_pending" : "verification_blocked",
          failures: [verificationFailureMessage(verification)],
        }),
        supersessionKey: `work-item:${outcome.workItemId}:execution-status`,
        now: this.clock.now(),
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof StaleFenceError) return;
      throw error;
    }
  }

  private enqueueExecutionFailure(workItemId: string, planRevision: number, attempt: number): void {
    if (!this.database || !this.lease) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, this.lease, this.clock.now());
      // A late failure belongs to its original attempt, not to a cancelled task or a new plan.
      const current = this.database.prepare(
        "SELECT 1 FROM collaboration_work_items w JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
        "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision " +
        "WHERE w.id=? AND w.current_plan_revision=? AND w.status NOT IN ('accepted','cancelled') " +
        currentExecutionSpecSql +
        "AND ?=(SELECT MAX(d.attempt) FROM collaboration_execution_dispatches d WHERE d.work_item_id=w.id) " +
        "AND NOT EXISTS (SELECT 1 FROM collaboration_outbox o WHERE o.source='dingtalk' AND o.source_event_id=?)",
      ).get(workItemId, planRevision, attempt, `execution:${workItemId}:plan:${planRevision}:failed`);
      if (!current) { this.database.exec("COMMIT"); return; }
      enqueueInboundCard(this.database, {
        sourceEventId: `execution:${workItemId}:plan:${planRevision}:failed`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: planRevision,
        card: renderPlanStatusCard({
          workItemId,
          planRevision,
          status: "execution_failed",
          failures: ["修改未完成，执行准备或处理发生异常；已停止自动尝试，需要负责人检查执行环境和任务状态后安排恢复。"],
        }),
        supersessionKey: `work-item:${workItemId}:execution-status`,
        now: this.clock.now(),
      });
      this.database.exec("COMMIT");
    } catch {
      this.database.exec("ROLLBACK");
    }
  }

  private async recoverAtStartup(): Promise<void> {
    const containment = this.options.containment ?? new UnavailableContainmentSupervisor();
    const candidates = this.options.candidateInspector ?? new NoCandidateInspector();
    try {
      this.recoveryDecisions = await new RecoveryCoordinator(
        this.database!,
        containment,
        candidates,
        positiveInteger(this.options.recoveryMaxAttempts ?? 3, "recoveryMaxAttempts"),
      ).scan(this.lease!, this.clock.now(), { skipDurableExecutions: true });
      this.recoverInterruptedPreparations();
    } catch {
      this.reason = "recovery_failed";
    }
  }

  private startLifecycleRecovery(): void {
    if (this.options.probeOnly || this.currentState !== "running" || !this.database || !this.lease || this.lifecycleRecoveryTask) return;
    const db = this.database;
    const lease = this.lease;
    const lifetime = this.verificationAbort;
    const live = () => !lifetime.signal.aborted && lifetime === this.verificationAbort && this.database === db && this.currentState === "running";
    const containment = this.options.containment ?? new UnavailableContainmentSupervisor();
    // Snapshot only old sessions once. Never poll unknown evidence or sweep newly
    // created sessions into this pass. Settlements retain original immutable IDs.
    const rows = db.prepare(
      "SELECT 'execution' AS kind,s.id,s.work_item_id,s.plan_revision,s.repository_path,f.session_id IS NOT NULL AS recovered FROM collaboration_execution_sessions s " +
      "LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id " +
      "WHERE (s.instance_owner<>? OR s.instance_fence<>?) AND (f.session_id IS NULL OR " +
      "(json_type(f.evidence_json,'$.recoveredBy')='object' AND NOT EXISTS(SELECT 1 FROM collaboration_outbox o WHERE o.source='dingtalk' AND o.source_event_id='lifecycle-recovery:execution:'||s.id||':recovered'))) " +
      "UNION ALL SELECT 'verification' AS kind,s.id,r.work_item_id,s.plan_revision,s.repository_path,f.session_id IS NOT NULL AS recovered FROM collaboration_verification_sessions s " +
      "JOIN collaboration_runs r ON r.id=s.candidate_run_id " +
      "LEFT JOIN collaboration_verification_settlements f ON f.session_id=s.id " +
      "WHERE (s.instance_owner<>? OR s.instance_fence<>?) AND (f.session_id IS NULL OR " +
      "(json_type(f.evidence_json,'$.recoveredBy')='object' AND NOT EXISTS(SELECT 1 FROM collaboration_outbox o WHERE o.source='dingtalk' AND o.source_event_id='lifecycle-recovery:verification:'||s.id||':recovered')))",
    ).all(lease.ownerId, lease.fence, lease.ownerId, lease.fence) as unknown as Array<{
      kind: "execution" | "verification"; id: string; work_item_id: string; plan_revision: number; repository_path: string; recovered: number;
    }>;
    if (!rows.length) return;
    const byRepository = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byRepository.get(row.repository_path) ?? [];
      group.push(row); byRepository.set(row.repository_path, group);
    }
    const groups = [...byRepository.values()];
    let next = 0;
    const worker = async () => {
      while (next < groups.length) for (const row of groups[next++]) {
        if (!live()) return;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.lifecycleRecoveryTimeoutMs);
        let outcome: LifecycleRecoveryOutcome;
        try {
          outcome = await recoverLifecycleSession(db, {
            kind: row.kind, sessionId: row.id, instance: lease, containment, coordinator: this.options.coordinator,
            unactivatedLaunchRecovery: this.options.unactivatedLaunchRecovery,
            now: () => this.clock.now(), signal: AbortSignal.any([lifetime.signal, timeout.signal]),
          });
        } finally { clearTimeout(timer); }
        if (!live()) return;
        assertCurrentInstanceLease(db, lease, this.clock.now());
        // A crash between settlement and Outbox enqueue leaves a durable receipt.
        // Repair only that delivery debt; ordinary terminal sessions are not scanned.
        if (outcome.state === "already_settled" && row.recovered) outcome = { ...outcome, state: "recovered" };
        this.enqueueLifecycleRecoveryNotice(row, outcome);
        if (outcome.state === "blocked") continue;
        if (this.executionEnabled()) this.queuePendingCandidatesAtStartup(row.repository_path);
        enqueuePendingOwnerDecisionCards(db, this.options.dingTalk?.cardTemplateId, this.clock.now());
        this.drainVerificationQueue();
        this.rebuildNeverStartedQueue();
      }
    };
    const task = Promise.resolve().then(async () => {
      // Bounded concurrency across repositories; serial evidence checks within one.
      const results = await Promise.allSettled(Array.from({ length: Math.min(4, groups.length) }, () => worker()));
      if (live() && results.some(result => result.status === "rejected")) {
        this.logger.write({ event: "collaboration.recovery.interrupted", code: "lifecycle_recovery_unavailable" });
      }
    }).catch(() => {
      if (live()) this.logger.write({ event: "collaboration.recovery.interrupted", code: "lifecycle_recovery_unavailable" });
    });
    this.lifecycleRecoveryTask = task;
    void task.finally(() => { if (this.lifecycleRecoveryTask === task) this.lifecycleRecoveryTask = null; });
  }

  private enqueueLifecycleRecoveryNotice(
    session: { kind: "execution" | "verification"; id: string; work_item_id: string; plan_revision: number; repository_path: string },
    outcome: LifecycleRecoveryOutcome,
  ): void {
    if (!this.database || !this.lease || this.verificationAbort.signal.aborted || outcome.state === "already_settled") return;
    const db = this.database;
    const sourceEventId = `lifecycle-recovery:${session.kind}:${session.id}:${outcome.state}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(db, this.lease, this.clock.now());
      const current = db.prepare(
        "SELECT w.version,s.goal FROM collaboration_work_items w " +
        "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
        "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision " +
        "WHERE w.id=? AND w.current_plan_revision=? AND w.status NOT IN ('accepted','cancelled') AND w.control_state='active' " +
        currentExecutionSpecSql +
        "AND NOT EXISTS(SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=?)",
      ).get(session.work_item_id, session.plan_revision, sourceEventId) as { version: number; goal: string } | undefined;
      const aborted = outcome.state !== "blocked" && !!db.prepare(
        `SELECT 1 FROM collaboration_${session.kind}_settlements WHERE session_id=? AND json_extract(evidence_json,'$.evidence[0].state')='aborted_before_activation'`,
      ).get(session.id);
      if (current) enqueueInboundCard(db, {
        sourceEventId, aggregateType: "plan", aggregateId: session.work_item_id, aggregateVersion: current.version,
        card: renderCommandStatusCard({ command: "status", workItemId: session.work_item_id, outcome: "allowed", presentation: "business",
          summary: `“${current.goal.slice(0, 200)}”：` + (outcome.state === "blocked"
            ? "服务已恢复，但还不能确认上次处理是否彻底结束。为避免重复修改，该项目的后续处理暂缓，需要负责人检查。"
            : hasUnsettledRepositoryActivity(db, session.repository_path)
              ? "已完成一次恢复检查，但该项目还有处理状态需要核实，暂不启动新的修改。需要负责人检查。"
              : aborted
                ? "上次修改尚未开始，系统已关闭它的执行入口。该项目可以继续安排后续工作；这不代表修改完成，中断的任务不会擅自重做，需要负责人安排。"
                : "已确认上次处理彻底结束，该项目可以继续安排后续工作。修改结果仍以代码和测试核对为准；中断的修改不会擅自重做，需要负责人安排。"),
        }),
        supersessionKey: `lifecycle-recovery:${session.kind}:${session.id}`,
        now: this.clock.now(),
      });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private recoverInterruptedPreparations(): void {
    if (!this.database || !this.lease || !this.executionEnabled()) return;
    const rows = this.database.prepare(
      "SELECT d.work_item_id,d.plan_revision,d.attempt FROM collaboration_execution_dispatches d " +
      "JOIN collaboration_work_items w ON w.id=d.work_item_id AND w.current_plan_revision=d.plan_revision " +
      "WHERE (d.instance_owner<>? OR d.instance_fence<>?) " +
      "AND w.status NOT IN ('accepted','cancelled') " +
      "AND d.attempt=(SELECT MAX(latest.attempt) FROM collaboration_execution_dispatches latest WHERE latest.work_item_id=w.id) " +
      "AND NOT EXISTS (SELECT 1 FROM collaboration_execution_preparation_results f WHERE f.work_item_id=w.id AND f.attempt=d.attempt) " +
      "AND NOT EXISTS (SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=w.id AND r.plan_revision=d.plan_revision AND r.attempt=d.attempt) " +
      "ORDER BY d.created_at,w.id LIMIT 64",
    ).all(this.lease.ownerId, this.lease.fence) as unknown as Array<{ work_item_id: string; plan_revision: number; attempt: number }>;
    for (const row of rows) recordPreparationResult(this.database, {
      workItemId: row.work_item_id, planRevision: row.plan_revision, attempt: row.attempt, state: "interrupted",
      lease: this.lease, maxAttempts: this.options.execution!.limits.maxAttempts, now: this.clock.now(),
    });
  }

  private async startDingTalk(): Promise<void> {
    const configuration = this.options.dingTalk;
    if (!configuration?.enabled) {
      this.dingTalkState = "disabled";
      return;
    }
    let credentials: DingTalkCredentials | null;
    try {
      credentials = configuration.credentials.load();
    } catch (error) {
      this.reason = safeConfigurationReason(error);
      this.dingTalkState = "needs_configuration";
      return;
    }
    if (!credentials) {
      this.reason = "dingtalk_credentials_missing";
      this.dingTalkState = "needs_configuration";
      return;
    }
    try {
      this.stream = configuration.createStream(
        credentials,
        {
          ingest: (message) => this.ingestDingTalkMessage(message),
          ...(this.attachmentIngestion
            ? { ingestAttachments: (capabilities) => this.ingestDingTalkAttachments(capabilities) }
            : {}),
          perform: (action) => this.performDingTalkOwnerAction(action),
          performCommand: (command) => this.performDingTalkOwnerTextCommand(command),
          recoverProjection: (message) => this.recoverDingTalkAttachmentProjection(message),
          recoverRequirements: (message) => this.recoverDingTalkRequirements(message),
          reviewDeliveries: (message) => this.reviewDingTalkDeliveries(message),
        },
        this.logger,
      );
      const state = await this.stream.start();
      this.dingTalkState = state;
      // Transient connection state is computed live by health(). Persisting it in
      // reason would keep intake/outbox disabled even after Stream recovers.
    } catch {
      this.stream = null;
      this.reason = "dingtalk_connection_failed";
      this.dingTalkState = "needs_configuration";
    }
  }

  private async ingestDingTalkAttachments(
    capabilities: readonly DingTalkPrivateResourceCapability[],
  ): Promise<void> {
    this.assertOperational();
    if (!this.attachmentIngestion) throw new Error("dingtalk_attachment_ingestion_not_configured");
    const signal = this.attachmentAbort.signal;
    await this.attachmentIngestion.persist(capabilities, this.clock.now());
    signal.throwIfAborted();
    this.assertOperational();
    // The maintenance loop starts downloads, never the Stream ACK path.
  }

  private startAttachmentProcessing(): void {
    if (this.attachmentTask || !this.attachmentIngestion || this.currentState !== "running" || this.reason) return;
    const ingestion = this.attachmentIngestion, signal = this.attachmentAbort.signal;
    this.attachmentTask = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      await ingestion.process([], this.clock.now());
    }).catch(() => {
      if (!signal.aborted) this.logger.write({ event: "collaboration.attachment.processing_failed", code: "attachment_processing_failed" });
    }).finally(() => { this.attachmentTask = null; });
  }

  private async probeDingTalk(): Promise<void> {
    const configuration = this.options.dingTalk;
    if (!configuration?.enabled) {
      this.dingTalkState = "disabled";
      return;
    }
    try {
      if (!configuration.credentials.load()) {
        this.reason = "dingtalk_credentials_missing";
        this.dingTalkState = "needs_configuration";
        return;
      }
      this.dingTalkState = "configured";
    } catch (error) {
      this.reason = safeConfigurationReason(error);
      this.dingTalkState = "needs_configuration";
    }
  }

  private syncAllMetaBundles(): void {
    if (!this.database || this.options.probeOnly) return;
    const rows = this.database.prepare(
      "SELECT id FROM collaboration_work_items ORDER BY updated_at,id",
    ).all() as unknown as Array<{ id: string }>;
    for (const row of rows) this.syncMetaBundleBestEffort(row.id, true);
  }

  private syncMetaBundleBestEffort(workItemId: string, stateChanged = false): void {
    if (!this.database || this.options.probeOnly) return;
    if (stateChanged) this.metaBundleFailures.delete(workItemId);
    if (this.database.isTransaction) {
      this.dirtyMetaBundles.add(workItemId);
      return;
    }
    const exists = this.database.prepare(
      "SELECT 1 FROM collaboration_work_items WHERE id = ?",
    ).get(workItemId);
    if (!exists) {
      this.dirtyMetaBundles.delete(workItemId);
      this.metaBundleFailures.delete(workItemId);
      return;
    }
    const failures = this.metaBundleFailures.get(workItemId) ?? 0;
    if (!stateChanged && failures >= 3) return;
    try {
      syncWorkItemMetaBundle(this.database, {
        artifactRoot: join(this.options.dataDirectory, "collaboration", "meta-bundles"),
        workItemId,
      });
      this.dirtyMetaBundles.delete(workItemId);
      this.metaBundleFailures.delete(workItemId);
    } catch {
      const next = failures + 1;
      this.dirtyMetaBundles.add(workItemId);
      this.metaBundleFailures.set(workItemId, next);
      if (next === 1 || next === 3) {
        this.logger.write({
          event: "collaboration.meta_bundle.sync_failed",
          code: next >= 3 ? "retry_limit_reached" : "retry_scheduled",
          workItemId,
        });
      }
    }
  }

  private retryDirtyMetaBundles(): void {
    for (const workItemId of [...this.dirtyMetaBundles].slice(0, 4)) {
      this.syncMetaBundleBestEffort(workItemId);
    }
  }

  private async performDrain(): Promise<DrainOutcome> {
    if (this.currentState === "draining" || this.currentState === "stopped") {
      throw new Error("collaboration_runtime_not_accepting_work");
    }
    const now = this.clock.now();
    try {
      this.lease = this.leaseCoordinator!.renew(this.lease!, now, this.leaseTtlMs);
    } catch {
      this.reason = "lease_failed";
      this.attachmentAbort.abort();
      this.currentState = "degraded";
      this.lease = null;
      return { dispatched: null, maintained: false };
    }
    if (this.stream?.maintain) {
      try {
        const streamState = await this.stream.maintain();
        this.dingTalkState = streamState === "connected" ? "connected" : "reconnecting";
      } catch {
        this.dingTalkState = "reconnecting";
      }
    }
    let dispatched: DispatchOutcome | null = null;
    const dispatchNow = this.clock.now();
    if (!this.checkDrainLease(dispatchNow)) return { dispatched: null, maintained: false };
    const serviceReady = !this.reason && this.service!.health().ready;
    if (serviceReady && this.dispatcher) dispatched = await this.dispatcher.dispatchOne(this.lease!, dispatchNow);
    const maintenanceNow = this.clock.now();
    if (!this.checkDrainLease(maintenanceNow)) return { dispatched, maintained: false };
    let maintained = false;
    if (serviceReady && this.maintenance) {
      await this.maintenance.run(this.lease!, maintenanceNow);
      maintained = true;
    }
    if (!this.checkDrainLease(this.clock.now())) return { dispatched, maintained };
    if (serviceReady && this.attachmentIngestion) {
      this.startAttachmentProcessing();
      maintained = true;
    }
    if (serviceReady) this.retryDirtyMetaBundles();
    if (serviceReady && !this.options.probeOnly) this.recoverInterruptedPreparations();
    if (serviceReady) {
      this.drainVerificationQueue();
      this.rebuildNeverStartedQueue();
    }
    // Enqueue reading before interpretation, including installations without a model interpreter.
    if (serviceReady && this.options.onlineDocuments && !this.onlineDocumentTask) this.startOnlineDocumentProcessing();
    if (serviceReady && this.options.naturalIntake && !this.naturalIntakeTask) {
      // Do not block lease renewal, Stream maintenance or other group messages on model latency.
      this.naturalIntakeTask = this.service!.processNaturalIntake(this.clock.now()).then(workItemId => {
        if (!workItemId || this.currentState !== "running") return;
        this.syncMetaBundleBestEffort(workItemId, true);
        if (this.options.autoExecuteReady) this.scheduleReadyExecution(workItemId);
      }).catch(() => undefined).finally(() => { this.naturalIntakeTask = null; });
    }
    return { dispatched, maintained };
  }

  private startOnlineDocumentProcessing(): void {
    this.onlineDocumentTask = this.service!.processOnlineDocuments(this.clock.now()).then(workItemId => {
      if (!workItemId || this.currentState !== "running") return;
      this.syncMetaBundleBestEffort(workItemId, true);
      if (this.options.autoExecuteReady) this.scheduleReadyExecution(workItemId);
    }).catch(() => undefined).finally(() => { this.onlineDocumentTask = null; });
  }

  private assertOperational(): void {
    if (this.currentState !== "running" || this.reason || !this.service) {
      throw new Error("collaboration_runtime_not_accepting_work");
    }
  }

  private assertAcceptingNewWork(): void {
    this.assertOperational();
    const row = this.database
      ?.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1")
      .get() as { low_disk: number } | undefined;
    if (row?.low_disk === 1) throw new Error("collaboration_runtime_low_disk");
  }

  private async interruptAndSettleRuns(timeoutMs: number): Promise<boolean> {
    if (!this.database || !this.lease) return true;
    const deadline = Date.now() + timeoutMs;
    const now = this.clock.now();
    const rows = this.database
      .prepare(
        "SELECT id FROM collaboration_runs WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .all(this.lease.ownerId, this.lease.fence) as unknown as Array<{ id: string }>;
    this.database
      .prepare(
        "UPDATE collaboration_runs SET interrupt_requested_at = COALESCE(interrupt_requested_at, ?), " +
          "version = version + 1 WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .run(now, this.lease.ownerId, this.lease.fence);
    const interrupts = this.options.agent
      ? Promise.allSettled(rows.map((row) => Promise.resolve().then(() => this.options.agent!.interrupt(row.id))))
      : Promise.resolve([]);
    const shutdownWork = interrupts.then(async () => {
      await Promise.allSettled([...this.activeExecutions]);
    });
    if (!(await waitBounded(shutdownWork, timeoutMs))) this.reason = "shutdown_timeout";
    const unresolved = this.database
      .prepare(
        "SELECT id, work_item_id, plan_revision, node_id, worktree_path, runtime_identity_json, " +
          "containment_binding_json, containment_fingerprint FROM collaboration_runs " +
          "WHERE status = 'running' AND instance_owner = ? AND instance_fence = ?",
      )
      .all(this.lease.ownerId, this.lease.fence) as unknown as UnresolvedRun[];
    const containmentEmpty = await this.terminateUnresolvedContainment(unresolved, deadline);
    for (const row of unresolved) {
      this.database
        .prepare(
          "UPDATE collaboration_runs SET status = 'needs_configuration', recovery_state = 'unsafe_to_retry', " +
            "finished_at = ?, error = 'shutdown_unsettled', version = version + 1 WHERE id = ? AND status = 'running'",
        )
        .run(now, row.id);
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = 'needs_configuration', lease_owner = NULL, " +
            "lease_expires_at = NULL, version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ?",
        )
        .run(row.work_item_id, row.plan_revision, row.node_id);
    }
    return containmentEmpty;
  }

  private checkDrainLease(now: number): boolean {
    if (!this.database || !this.lease || this.currentState === "draining" || this.currentState === "stopped") return false;
    try {
      assertCurrentInstanceLease(this.database, this.lease, now);
      return true;
    } catch {
      this.reason = "lease_failed";
      this.attachmentAbort.abort();
      this.currentState = "degraded";
      this.lease = null;
      return false;
    }
  }

  private async terminateUnresolvedContainment(rows: readonly UnresolvedRun[], deadline: number): Promise<boolean> {
    if (rows.length === 0) return true;
    const containment = this.options.containment;
    if (!containment || !this.lease) return false;
    let allEmpty = true;
    for (const row of rows) {
      const proof = parseJson<ContainmentProof>(row.runtime_identity_json);
      const binding = parseJson<ContainmentBinding>(row.containment_binding_json);
      if (
        !proof ||
        !binding ||
        binding.runId !== row.id ||
        binding.canonicalWorktreePath !== row.worktree_path ||
        binding.instanceOwner !== this.lease.ownerId ||
        binding.instanceFence !== this.lease.fence
      ) {
        allEmpty = false;
        continue;
      }
      const verifiedResult = await resultBounded(
        verifyContainmentProof(containment, proof, binding),
        Math.max(1, deadline - Date.now()),
      );
      if (
        !verifiedResult.completed ||
        !verifiedResult.value.verified ||
        verifiedResult.value.fingerprint !== row.containment_fingerprint
      ) {
        allEmpty = false;
        continue;
      }
      const terminated = await resultBounded(
        containment.terminateAndWaitEmpty(proof.identity),
        Math.max(1, deadline - Date.now()),
      );
      if (
        !terminated.completed ||
        terminated.value.state !== "empty" ||
        terminated.value.fingerprint !== verifiedResult.value.fingerprint
      ) {
        allEmpty = false;
      }
    }
    return allEmpty;
  }

  private async closeResources(releaseLease = true): Promise<void> {
    this.attachmentAbort.abort();
    this.verificationAbort.abort();
    if (releaseLease && this.leaseCoordinator && this.lease) {
      try {
        this.leaseCoordinator.release(this.lease, this.clock.now());
      } catch {}
    }
    this.lease = null;
    this.leaseCoordinator = null;
    this.dispatcher = null;
    this.maintenance = null;
    this.attachmentIngestion = null;
    try {
      this.database?.close();
    } catch {}
    this.database = null;
    try {
      this.service?.close();
    } catch {}
    this.service = null;
  }
}
