import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { reserveVerification, recordVerificationCommand, recordVerificationProof, settleVerification } from "./verification-lifecycle.ts";
import { hasUnsettledRepositoryActivity } from "./repository-occupancy.ts";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { appendExecutionAudit } from "./audit.ts";
import type { ContainmentPort } from "./containment.ts";
import { CommandCleanupError, isolatedExecutionEnvironment } from "./execution-limits.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";
import {
  runTargetTests,
  type SandboxedCommandRunner,
  type TargetCommandSpec,
  type TestEvidence,
} from "./quality-gate.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { assertionCoverage, readAssertionReport, type CoverageCommand, type CoverageItem } from "./acceptance-assertions.ts";
import { AcceptanceMappingCoordinator, readApprovedAcceptanceMapping, type AcceptanceMappingModels } from "./acceptance-mapping.ts";
import { collectAcceptanceMappingRequest } from "./acceptance-source.ts";
import { verificationRuntimePolicyAllows, verificationRuntimePolicyHash } from "./verification-runtime-policy.ts";

const VERIFIER_AGENT_ID = "deterministic-verifier-v1";
const META_AGENT_ID = "meta-acceptance-gate-v1";
export const CANDIDATE_VERIFICATION_MAX_ATTEMPTS = 3;
const VERIFICATION_CONTRACT_SCHEMA_VERSION = 3 as const;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IN_FLIGHT = new WeakMap<DatabaseSync, Map<string, Promise<CandidateVerificationOutcome>>>();

interface VerificationRow {
  candidate_run_id: string;
  work_item_id: string;
  plan_revision: number;
  snapshot_revision: number;
  proposal_hash: string;
  modify_agent_id: string;
  verifier_agent_id: string;
  commands_json: string;
  read_scope_json: string;
  deny_scope_json: string;
  repository_path: string;
  result_sha: string;
  changed_paths_json: string;
  acceptance_json: string;
  blocking_ambiguities_json: string;
  goal: string | null;
  facts_json: string;
  assumptions_json: string;
}

interface StoredReview {
  attempt: number;
  status: CandidateReviewStatus;
  agent_id: string;
  snapshot_revision: number;
  spec_hash: string;
  candidate_sha: string;
  verdict_json: string;
}

export type CandidateReviewStatus =
  | "passed"
  | "failed"
  | "needs_clarification"
  | "needs_configuration"
  | "stale";

export interface CandidateVerificationOutcome {
  passed: boolean;
  status: CandidateReviewStatus;
  reasons: string[];
  specHash: string;
  verifierAttempt: number;
  metaAttempt: number | null;
}

export interface CandidateVerificationOptions {
  commandRunner: SandboxedCommandRunner;
  containment: ContainmentPort;
  commands: Readonly<Record<string, TargetCommandSpec>>;
  dataDirectory: string;
  maxAttempts?: number;
  acceptanceMapping?: AcceptanceMappingModels;
  clock?: () => number;
}

interface AcceptanceCondition {
  description: string;
  observation: string;
}

function strings(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function arrayLength(value: string): number | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function acceptance(value: string): AcceptanceCondition[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every((item) =>
      item && typeof item === "object" && !Array.isArray(item) &&
      typeof (item as AcceptanceCondition).description === "string" &&
      typeof (item as AcceptanceCondition).observation === "string");
    return valid ? parsed as AcceptanceCondition[] : null;
  } catch {
    return null;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function verificationSpec(row: VerificationRow) {
  return {
    workItemId: row.work_item_id,
    planRevision: row.plan_revision,
    snapshotRevision: row.snapshot_revision,
    proposalHash: row.proposal_hash,
    verifierReadScope: JSON.parse(row.read_scope_json) as unknown,
    verifierDenyScope: JSON.parse(row.deny_scope_json) as unknown,
    goal: row.goal,
    facts: JSON.parse(row.facts_json) as unknown,
    assumptions: JSON.parse(row.assumptions_json) as unknown,
    acceptance: JSON.parse(row.acceptance_json) as unknown,
    blockingAmbiguities: JSON.parse(row.blocking_ambiguities_json) as unknown,
  };
}

function verificationContractHash(
  row: VerificationRow,
  commands: Readonly<Record<string, TargetCommandSpec>>,
  mappingPolicy: string | null = null,
): string {
  const commandIds = strings(row.commands_json);
  return hash({
    schemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
    mappingPolicy,
    spec: verificationSpec(row),
    selectedCommands: commandIds === null
      ? { invalidCommandsJson: row.commands_json }
      : commandIds.map((commandId) => {
          const command = commands[commandId];
          return {
            commandId,
            command: command
              ? {
                  argv: [...command.argv],
                  cwd: command.cwd ?? null,
                  timeoutMs: command.timeoutMs,
                  maxOutputBytes: command.maxOutputBytes,
                  assertionContract: command.assertionContract ?? null,
                  assertionReporter: command.assertionReporter ?? null,
                  acceptanceSourceFiles: command.acceptanceSourceFiles ?? null,
                }
              : null,
          };
        }),
  });
}

function gitState(worktreePath: string): { head: string; status: string } {
  const head = execFileSync("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  return { head, status };
}

export function mapAcceptanceCoverage(input: {
  acceptanceConditions: readonly AcceptanceCondition[];
  commandIds: readonly string[];
  commands: Readonly<Record<string, TargetCommandSpec>>;
  evidence: readonly Pick<TestEvidence, "commandId" | "state" | "assertions">[];
}): CoverageItem[] {
  return assertionCoverage(input.acceptanceConditions, input.commandIds.map(commandId => {
    const evidence = input.evidence.filter(item => item.commandId === commandId);
    return { commandId, state: evidence.length === 1 ? evidence[0].state : "missing",
      assertions: evidence.length === 1 ? evidence[0].assertions : undefined,
      assertionContract: input.commands[commandId]?.assertionContract };
  }));
}

function publicEvidence(evidence: readonly TestEvidence[], commands: Readonly<Record<string, TargetCommandSpec>>): Array<CoverageCommand & {
  exitCode: number | null;
  durationMs: number;
}> {
  return evidence.map((item) => ({
    commandId: item.commandId,
    state: item.state,
    exitCode: item.exitCode,
    durationMs: item.durationMs,
    assertions: item.assertions,
    assertionContract: commands[item.commandId]?.assertionContract,
  }));
}

function readRow(database: DatabaseSync, candidateRunId: string): VerificationRow | null {
  const row = database.prepare(
    "SELECT r.id AS candidate_run_id, r.work_item_id, r.plan_revision, p.snapshot_revision, p.proposal_hash, " +
      "m.assigned_agent_id AS modify_agent_id, v.assigned_agent_id AS verifier_agent_id, " +
      "v.commands_json, v.read_scope_json, v.deny_scope_json, r.repository_path, c.result_sha, c.changed_paths_json, " +
      "s.acceptance_json, s.blocking_ambiguities_json, s.goal, s.facts_json, s.assumptions_json " +
      "FROM collaboration_runs r " +
      "JOIN collaboration_work_items w ON w.id = r.work_item_id AND w.current_plan_revision = r.plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id = r.id " +
      "JOIN collaboration_plan_revisions p ON p.work_item_id = r.work_item_id AND p.revision = r.plan_revision " +
      "JOIN collaboration_work_item_snapshots s ON s.work_item_id = r.work_item_id AND s.revision = p.snapshot_revision " +
      "JOIN collaboration_work_nodes m ON m.work_item_id = r.work_item_id AND m.plan_revision = r.plan_revision " +
      "AND m.node_type = 'modify' AND m.active = 1 " +
      "JOIN collaboration_work_nodes v ON v.work_item_id = r.work_item_id AND v.plan_revision = r.plan_revision " +
      "AND v.node_type = 'validate' AND v.active = 1 " +
      "WHERE r.id = ? AND r.status = 'succeeded' AND c.state = 'target_tests_passed' " +
      "AND c.result_sha IS NOT NULL AND w.definition_status = 'ready_for_execution' " +
      "AND w.control_state = 'active'",
  ).get(candidateRunId) as VerificationRow | undefined;
  return row && readPlanMaterialReadiness(database, row.work_item_id, row.plan_revision).ready ? row : null;
}

function latestReview(database: DatabaseSync, runId: string, stage: "verifier" | "meta"): StoredReview | null {
  return database.prepare(
    "SELECT attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json " +
      "FROM collaboration_candidate_reviews " +
      "WHERE candidate_run_id = ? AND stage = ? ORDER BY attempt DESC LIMIT 1",
  ).get(runId, stage) as StoredReview | undefined ?? null;
}

function reviewCountForContract(
  database: DatabaseSync,
  runId: string,
  stage: "verifier" | "meta",
  contractHash: string,
): number {
  const row = database.prepare(
    "SELECT count(*) AS count FROM collaboration_candidate_reviews " +
      "WHERE candidate_run_id = ? AND stage = ? AND spec_hash = ?",
  ).get(runId, stage, contractHash) as { count: number };
  return row.count;
}

function reviewVerdict(review: StoredReview): Record<string, unknown> | null {
  try {
    const verdict = JSON.parse(review.verdict_json) as unknown;
    return verdict && typeof verdict === "object" && !Array.isArray(verdict)
      ? verdict as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function referencedVerifierAttempt(review: StoredReview): number | null {
  const attempt = reviewVerdict(review)?.verifierAttempt;
  return Number.isInteger(attempt) && Number(attempt) > 0 ? Number(attempt) : null;
}

function hasCurrentContractSchema(review: StoredReview): boolean {
  return reviewVerdict(review)?.contractSchemaVersion === VERIFICATION_CONTRACT_SCHEMA_VERSION;
}

function latestPassedReviewPair(
  database: DatabaseSync,
  row: VerificationRow,
  expectedSpecHash?: string,
): { verifier: StoredReview; meta: StoredReview } | null {
  const verifier = latestReview(database, row.candidate_run_id, "verifier");
  const meta = latestReview(database, row.candidate_run_id, "meta");
  if (
    !verifier || !meta || verifier.status !== "passed" || meta.status !== "passed" ||
    verifier.agent_id !== VERIFIER_AGENT_ID || meta.agent_id !== META_AGENT_ID ||
    !hasCurrentContractSchema(verifier) || !hasCurrentContractSchema(meta) ||
    verifier.candidate_sha !== row.result_sha || meta.candidate_sha !== row.result_sha ||
    verifier.snapshot_revision !== row.snapshot_revision || meta.snapshot_revision !== row.snapshot_revision ||
    verifier.spec_hash !== meta.spec_hash ||
    (expectedSpecHash !== undefined && verifier.spec_hash !== expectedSpecHash) ||
    referencedVerifierAttempt(meta) !== verifier.attempt
  ) return null;
  // Completion/Owner gates can read receipts without invoking verify(). Bind
  // their decision to today's persisted Spec and scopes as well as paired receipts.
  const specIdentityHash = hash(verificationSpec(row));
  if (reviewVerdict(verifier)?.specIdentityHash !== specIdentityHash ||
    reviewVerdict(meta)?.specIdentityHash !== specIdentityHash) return null;
  const runtimePolicyHash = reviewVerdict(verifier)?.runtimePolicyHash;
  if (reviewVerdict(meta)?.runtimePolicyHash !== runtimePolicyHash ||
    !verificationRuntimePolicyAllows(database, row.repository_path, runtimePolicyHash)) return null;
  const conditions = acceptance(row.acceptance_json);
  const commands = reviewVerdict(verifier)?.commands;
  const savedCoverage = reviewVerdict(meta)?.coverage;
  if (!conditions?.length || !Array.isArray(savedCoverage) || !Array.isArray(commands) || !commands.every(command => command && typeof command === "object" && typeof command.commandId === "string")) return null;
  const coverage = assertionCoverage(conditions, commands as CoverageCommand[]);
  if (coverage.some(item => item.state !== "passed") || hash(savedCoverage) !== hash(coverage)) return null;
  const selectedIds = strings(row.commands_json);
  if (!selectedIds || commands.length !== selectedIds.length || commands.some((command, index) => command.commandId !== selectedIds[index])) return null;
  const selfCommands = reviewVerdict(meta)?.selfCommands;
  const savedSelfCoverage = reviewVerdict(meta)?.selfCoverage;
  if (!Array.isArray(selfCommands) || !Array.isArray(savedSelfCoverage) || selfCommands.length !== selectedIds.length ||
    selfCommands.some((command, index) => !command || typeof command !== "object" || command.commandId !== selectedIds[index])) return null;
  const selfCoverage = assertionCoverage(conditions, selfCommands as CoverageCommand[]);
  if (selfCoverage.some(item => item.state !== "passed") || hash(savedSelfCoverage) !== hash(selfCoverage)) return null;
  const mapping=reviewVerdict(verifier)?.mapping;
  if(mapping!==undefined) {
    if(!mapping || typeof mapping!=="object" || Array.isArray(mapping) || !("requestHash" in mapping) || !("policyId" in mapping) || typeof mapping.requestHash!=="string" || typeof mapping.policyId!=="string") return null;
    const approved=readApprovedAcceptanceMapping(database,{requestHash:mapping.requestHash,policyId:mapping.policyId,
      candidateSha:row.result_sha,specHash:verifier.spec_hash,conditions});
    if(!approved || Object.entries(approved).some(([id,contract])=>
      hash(commands.find(command=>command.commandId===id)?.assertionContract)!==hash(contract) ||
      hash(selfCommands.find(command=>command.commandId===id)?.assertionContract)!==hash(contract))) return null;
  }
  return { verifier, meta };
}

function insertReview(database: DatabaseSync, input: {
  row: VerificationRow;
  stage: "verifier" | "meta";
  attempt: number;
  status: CandidateReviewStatus;
  specHash: string;
  agentId: string;
  verdict: Record<string, unknown>;
  now: number;
}): void {
  database.prepare(
    "INSERT INTO collaboration_candidate_reviews " +
      "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    input.row.candidate_run_id,
    input.stage,
    input.attempt,
    input.status,
    input.agentId,
    input.row.snapshot_revision,
    input.specHash,
    input.row.result_sha,
    JSON.stringify(input.verdict),
    input.now,
  );
}

export function candidateHasPassedMetaReview(
  database: DatabaseSync,
  candidateRunId: string,
  candidateSha: string,
): boolean {
  if (!FULL_SHA.test(candidateSha)) return false;
  const row = readRow(database, candidateRunId);
  return Boolean(row && !hasUnsettledRepositoryActivity(database,row.repository_path) && row.result_sha === candidateSha && latestPassedReviewPair(database, row));
}

export class CandidateVerificationCoordinator {
  private readonly database: DatabaseSync;
  private readonly options: Required<Pick<CandidateVerificationOptions, "maxAttempts">> &
    Omit<CandidateVerificationOptions, "maxAttempts">;

  constructor(database: DatabaseSync, options: CandidateVerificationOptions) {
    this.database = database;
    this.options = { ...options, maxAttempts: options.maxAttempts ?? CANDIDATE_VERIFICATION_MAX_ATTEMPTS };
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1) {
      throw new Error("candidate_verification_max_attempts_invalid");
    }
  }

  /** Called inside the runtime's notification transaction; never trusts a cached outcome alone. */
  isCurrentNotification(candidateRunId: string, outcome: CandidateVerificationOutcome): boolean {
    if (outcome.passed || outcome.status === "stale") return false;
    const row = readRow(this.database, candidateRunId);
    if (!row || verificationContractHash(row, this.options.commands, this.options.acceptanceMapping?.policyId) !== outcome.specHash) return false;
    const verifier = latestReview(this.database, candidateRunId, "verifier");
    if ((verifier?.attempt ?? 0) !== outcome.verifierAttempt) return false;
    if (latestPassedReviewPair(this.database, row, outcome.specHash)) return false;
    if (outcome.metaAttempt !== null && latestReview(this.database, candidateRunId, "meta")?.attempt !== outcome.metaAttempt) return false;
    return true;
  }

  verify(input: {
    candidateRunId: string;
    worktreePath: string;
    instance: Pick<InstanceLease, "ownerId" | "fence">;
    now: number;
    signal?: AbortSignal;
  }): Promise<CandidateVerificationOutcome> {
    if (input.signal?.aborted) return Promise.reject(new Error("candidate_verification_cancelled"));
    try {
      assertLedgerArmed(this.database);
      assertCurrentInstanceLease(this.database, input.instance, this.options.clock?.() ?? Date.now());
    }
    catch (error) { return Promise.reject(error); }
    let inFlight = IN_FLIGHT.get(this.database);
    if (!inFlight) {
      inFlight = new Map();
      IN_FLIGHT.set(this.database, inFlight);
    }
    const key = JSON.stringify([input.candidateRunId, input.instance.ownerId, input.instance.fence]);
    const current = inFlight.get(key);
    if (current) return current;
    let tracked!: Promise<CandidateVerificationOutcome>;
    tracked = this.verifyWithLifecycle(input).finally(() => {
      if (inFlight!.get(key) === tracked) inFlight!.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  }

  private async verifyWithLifecycle(input: Parameters<CandidateVerificationCoordinator["verify"]>[0]): Promise<CandidateVerificationOutcome> {
    const now = this.options.clock ?? Date.now;
    if (!readRow(this.database, input.candidateRunId)) throw new Error("candidate_verification_target_unavailable");
    const sessionId = reserveVerification(this.database, input.candidateRunId, input.instance, now());
    let ordinal = 0;
    let cleanupUnknown = false;
    const runner: SandboxedCommandRunner = { run: async request => {
      input.signal?.throwIfAborted();
      const command = ++ordinal;
      recordVerificationCommand(this.database, sessionId, command, request.containmentBinding, input.instance, now());
      return this.options.commandRunner.run({ ...request, registerContainment: async proof => {
        await request.registerContainment(proof);
        input.signal?.throwIfAborted();
        recordVerificationProof(this.database, sessionId, command, proof, input.instance, now());
      } });
    } };
    try {
      return await this.verifyOnce(input, this.options.commandRunner ? runner : this.options.commandRunner);
    } catch (error) { cleanupUnknown = error instanceof CommandCleanupError; throw error; }
    finally {
      let settled = false;
      if (!cleanupUnknown) {
        try { settled = await settleVerification(this.database, sessionId, input.instance, this.options.containment, now, () => true); }
        catch { /* Closed database, lost lease or unknown containment retains the durable reservation. */ }
      }
      if (!settled) throw new CommandCleanupError(new Error("verification_session_unsettled"));
    }
  }

  private async verifyOnce(input: {
    candidateRunId: string;
    worktreePath: string;
    instance: Pick<InstanceLease, "ownerId" | "fence">;
    now: number;
    signal?: AbortSignal;
  }, runner: SandboxedCommandRunner): Promise<CandidateVerificationOutcome> {
    input.signal?.throwIfAborted();
    assertLedgerArmed(this.database);
    const row = readRow(this.database, input.candidateRunId);
    if (!row) throw new Error("candidate_verification_target_unavailable");
    const currentSpecHash = verificationContractHash(row, this.options.commands, this.options.acceptanceMapping?.policyId);
    const existingPair = latestPassedReviewPair(this.database, row, currentSpecHash);
    if (existingPair) {
      return {
        passed: true,
        status: "passed",
        reasons: [],
        specHash: currentSpecHash,
        verifierAttempt: existingPair.verifier.attempt,
        metaAttempt: existingPair.meta.attempt,
      };
    }
    const previous = latestReview(this.database, input.candidateRunId, "verifier");
    const attempt = (previous?.attempt ?? 0) + 1;
    if (
      reviewCountForContract(this.database, input.candidateRunId, "verifier", currentSpecHash) >=
        this.options.maxAttempts
    ) {
      return this.attemptLimitOutcome(previous, currentSpecHash);
    }
    if (row.verifier_agent_id === row.modify_agent_id) {
      return this.persistFailure(
        row,
        currentSpecHash,
        attempt,
        "needs_configuration",
        ["verifier_identity_not_independent"],
        input.now,
        input.instance,
      );
    }
    const commandIds = strings(row.commands_json);
    const conditions = acceptance(row.acceptance_json);
    if (!commandIds?.length || !conditions?.length || !FULL_SHA.test(row.result_sha)) {
      return this.persistFailure(
        row,
        currentSpecHash,
        attempt,
        "needs_configuration",
        ["verification_contract_incomplete"],
        input.now,
        input.instance,
      );
    }

    const worktreePath = realpathSync(input.worktreePath);
    const before = gitState(worktreePath);
    let evidence: TestEvidence[] = [];
    let reasons: string[] = [];
    let commands = this.options.commands;
    const runtimePolicyHash = verificationRuntimePolicyHash(commands, this.options.acceptanceMapping?.policyId);
    if (!verificationRuntimePolicyAllows(this.database, row.repository_path, runtimePolicyHash)) reasons.push("verification_runtime_policy_changed");
    let mapping: { requestHash: string; policyId: string } | undefined;
    if (before.head !== row.result_sha || before.status) reasons.push("candidate_worktree_not_clean");
    if (!reasons.length && this.options.acceptanceMapping && commandIds.some(id => !commands[id]?.assertionContract)) {
      try {
        const readScope = strings(row.read_scope_json), denyScope = strings(row.deny_scope_json);
        if (!readScope || !denyScope) throw new Error("acceptance_source_scope_invalid");
        const request = collectAcceptanceMappingRequest({ worktree: worktreePath, candidateSha: row.result_sha, specHash: currentSpecHash,
          conditions, commandIds, commands, readScope, denyScope });
        const result = await new AcceptanceMappingCoordinator(this.database, this.options.acceptanceMapping).map(request, input.now, input.signal);
        if (result.status === "pending") return { passed: false, status: "needs_configuration", reasons: ["acceptance_mapping_pending"],
          specHash: currentSpecHash, verifierAttempt: previous?.attempt ?? 0, metaAttempt: null };
        if (result.status !== "approved" || !result.contracts) reasons.push("acceptance_mapping_incomplete");
        else {
          commands = Object.fromEntries(commandIds.map(id => [id, { ...commands[id], assertionContract: result.contracts![id] ?? commands[id].assertionContract }]));
          mapping = { requestHash: result.requestHash, policyId: this.options.acceptanceMapping.policyId };
        }
      } catch (error) { if (input.signal?.aborted) throw error; reasons.push("acceptance_mapping_unavailable"); }
      input.signal?.throwIfAborted();
      const current = readRow(this.database, input.candidateRunId);
      const state = gitState(worktreePath);
      if (!current || verificationContractHash(current, this.options.commands, this.options.acceptanceMapping.policyId) !== currentSpecHash ||
        state.head !== before.head || state.status !== before.status) reasons.push("verification_target_changed");
    }
    if (!reasons.length) {
      const home = join(this.options.dataDirectory, "collaboration", "verifier-home");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const verification = await runTargetTests({
        worktree: worktreePath,
        environment: isolatedExecutionEnvironment(process.env, home),
        commandIds,
        commands,
        runner,
        signal: input.signal,
        deniedPaths: [realpathSync(row.repository_path), realpathSync(join(this.options.dataDirectory, "collaboration"))],
        containment: this.options.containment,
        containmentContext: {
          runId: `${input.candidateRunId}:verifier:${attempt}`,
          canonicalWorktreePath: worktreePath,
          instanceOwner: input.instance.ownerId,
          instanceFence: input.instance.fence,
        },
      });
      input.signal?.throwIfAborted();
      evidence = verification.evidence;
      reasons.push(...verification.configurationProblems);
      if (evidence.length !== commandIds.length || evidence.some((item) => item.state !== "target_passed")) {
        reasons.push("independent_target_verification_failed");
      }
      const after = gitState(worktreePath);
      if (after.head !== before.head || after.status !== before.status) reasons.push("verifier_modified_candidate");
    }

    input.signal?.throwIfAborted();
    const refreshed = readRow(this.database, input.candidateRunId);
    const stale = !refreshed ||
      verificationContractHash(refreshed, this.options.commands, this.options.acceptanceMapping?.policyId) !== currentSpecHash ||
      refreshed.result_sha !== row.result_sha;
    if (stale) reasons.push("verification_target_changed");
    const verifierStatus: CandidateReviewStatus = stale
      ? "stale"
      : reasons.some((reason) => reason.includes("configuration") || reason.includes("containment"))
        ? "needs_configuration"
        : reasons.length
          ? "failed"
          : "passed";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, input.instance, this.options.clock?.() ?? Date.now());
      insertReview(this.database, {
        row,
        stage: "verifier",
        attempt,
        status: verifierStatus,
        specHash: currentSpecHash,
        agentId: VERIFIER_AGENT_ID,
        verdict: {
          candidateRunId: input.candidateRunId,
          contractSchemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
          specIdentityHash: hash(verificationSpec(row)),
          runtimePolicyHash,
          reasons,
          commands: publicEvidence(evidence, commands),
          ...(mapping ? { mapping } : {}),
        },
        now: input.now,
      });
      this.database.prepare(
        "UPDATE collaboration_work_nodes SET execution_status = ?, version = version + 1 " +
          "WHERE work_item_id = ? AND plan_revision = ? AND node_type = 'validate' AND active = 1",
      ).run(verifierStatus === "passed" ? "candidate_ready" : "failed", row.work_item_id, row.plan_revision);
      appendExecutionAudit(this.database, {
        runId: input.candidateRunId,
        action: "candidate.verifier_reviewed",
        outcome: verifierStatus,
        resource: { attempt, specHash: currentSpecHash, candidateSha: row.result_sha, reasons },
        now: input.now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (verifierStatus !== "passed") {
      return {
        passed: false,
        status: verifierStatus,
        reasons,
        specHash: currentSpecHash,
        verifierAttempt: attempt,
        metaAttempt: null,
      };
    }
    return this.metaReview(row, currentSpecHash, commandIds, conditions, evidence, attempt, input.now, commands, input.instance);
  }

  private metaReview(
    row: VerificationRow,
    currentSpecHash: string,
    commandIds: string[],
    conditions: AcceptanceCondition[],
    verifierEvidence: TestEvidence[],
    verifierAttempt: number,
    now: number,
    commands: Readonly<Record<string, TargetCommandSpec>>,
    instance: Pick<InstanceLease, "ownerId" | "fence">,
  ): CandidateVerificationOutcome {
    const selfEvidence = this.database.prepare(
      "SELECT command_id,state,stdout,containment_binding_json FROM collaboration_test_evidence WHERE run_id = ?",
    ).all(row.candidate_run_id) as unknown as Array<{
      command_id: string;
      state: string;
      stdout: string;
      containment_binding_json: string | null;
    }>;
    const selfCommands: CoverageCommand[] = commandIds.map(commandId => {
      const rows = selfEvidence.filter(item => item.command_id === commandId);
      const item = rows.length === 1 ? rows[0] : null;
      let assertions;
      try {
        const binding = item?.containment_binding_json ? JSON.parse(item.containment_binding_json) as Record<string, unknown> : null;
        if (item && binding?.runId === row.candidate_run_id && binding.commandId === commandId && typeof binding.nonce === "string") {
          assertions = readAssertionReport(item.stdout, { runId: row.candidate_run_id, nonce: binding.nonce });
        }
      } catch { /* Missing or malformed self-test provenance is not evidence. */ }
      return { commandId, state: item?.state ?? "missing", assertions, assertionContract: commands[commandId]?.assertionContract };
    });
    const selfCoverage = assertionCoverage(conditions, selfCommands);
    const coverage = mapAcceptanceCoverage({
      acceptanceConditions: conditions,
      commandIds,
      commands,
      evidence: verifierEvidence,
    });
    const ambiguityCount = arrayLength(row.blocking_ambiguities_json);
    const reasons: string[] = [];
    if (selfCoverage.some(item => item.state !== "passed")) reasons.push("executor_self_test_incomplete");
    if (coverage.some((item) => item.state !== "passed")) reasons.push("acceptance_evidence_incomplete");
    if (ambiguityCount === null || ambiguityCount > 0) reasons.push("blocking_ambiguity_present");
    const refreshed = readRow(this.database, row.candidate_run_id);
    if (
      !refreshed ||
      verificationContractHash(refreshed, this.options.commands, this.options.acceptanceMapping?.policyId) !== currentSpecHash ||
      refreshed.result_sha !== row.result_sha
    ) reasons.push("meta_target_changed");
    const status: CandidateReviewStatus = reasons.includes("blocking_ambiguity_present")
      ? "needs_clarification"
      : reasons.length
        ? "failed"
        : "passed";
    const verifierReview = latestReview(this.database, row.candidate_run_id, "verifier");
    if (
      !verifierReview || verifierReview.attempt !== verifierAttempt || verifierReview.status !== "passed" ||
      verifierReview.spec_hash !== currentSpecHash || verifierReview.candidate_sha !== row.result_sha
    ) throw new Error("candidate_verifier_review_missing");
    const latestMeta = latestReview(this.database, row.candidate_run_id, "meta");
    const metaAttempt = (latestMeta?.attempt ?? 0) + 1;
    if (
      reviewCountForContract(this.database, row.candidate_run_id, "meta", currentSpecHash) >=
        this.options.maxAttempts
    ) {
      return this.attemptLimitOutcome(verifierReview, currentSpecHash);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, this.options.clock?.() ?? Date.now());
      insertReview(this.database, {
        row,
        stage: "meta",
        attempt: metaAttempt,
        status,
        specHash: currentSpecHash,
        agentId: META_AGENT_ID,
        verdict: {
          candidateRunId: row.candidate_run_id,
          contractSchemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
          specIdentityHash: hash(verificationSpec(row)),
          runtimePolicyHash: verificationRuntimePolicyHash(this.options.commands, this.options.acceptanceMapping?.policyId),
          reasons,
          verifierAttempt,
          coverage,
          selfCommands,
          selfCoverage,
        },
        now,
      });
      this.database.prepare(
        "UPDATE collaboration_work_nodes SET execution_status = ?, version = version + 1 " +
          "WHERE work_item_id = ? AND plan_revision = ? AND node_type = 'report' AND active = 1",
      ).run(status === "passed" ? "candidate_ready" : "failed", row.work_item_id, row.plan_revision);
      appendExecutionAudit(this.database, {
        runId: row.candidate_run_id,
        action: "candidate.meta_reviewed",
        outcome: status,
        resource: { metaAttempt, specHash: currentSpecHash, candidateSha: row.result_sha, reasons, coverage },
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      passed: status === "passed",
      status,
      reasons,
      specHash: currentSpecHash,
      verifierAttempt,
      metaAttempt,
    };
  }

  private persistFailure(
    row: VerificationRow,
    currentSpecHash: string,
    attempt: number,
    status: CandidateReviewStatus,
    reasons: string[],
    now: number,
    instance: Pick<InstanceLease, "ownerId" | "fence">,
  ): CandidateVerificationOutcome {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, this.options.clock?.() ?? Date.now());
      insertReview(this.database, {
        row,
        stage: "verifier",
        attempt,
        status,
        specHash: currentSpecHash,
        agentId: VERIFIER_AGENT_ID,
        verdict: {
          candidateRunId: row.candidate_run_id,
          contractSchemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
          reasons,
          commands: [],
        },
        now,
      });
      this.database.prepare(
        "UPDATE collaboration_work_nodes SET execution_status = 'failed', version = version + 1 " +
          "WHERE work_item_id = ? AND plan_revision = ? AND node_type = 'validate' AND active = 1",
      ).run(row.work_item_id, row.plan_revision);
      appendExecutionAudit(this.database, {
        runId: row.candidate_run_id,
        action: "candidate.verifier_reviewed",
        outcome: status,
        resource: { attempt, specHash: currentSpecHash, candidateSha: row.result_sha, reasons },
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { passed: false, status, reasons, specHash: currentSpecHash, verifierAttempt: attempt, metaAttempt: null };
  }

  private attemptLimitOutcome(
    previous: StoredReview | null,
    currentSpecHash: string,
  ): CandidateVerificationOutcome {
    return {
      passed: false,
      status: previous?.status ?? "failed",
      reasons: ["verification_attempt_limit_exhausted"],
      specHash: currentSpecHash,
      verifierAttempt: previous?.attempt ?? this.options.maxAttempts,
      metaAttempt: null,
    };
  }
}
