import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { appendExecutionAudit } from "./audit.ts";
import {
  type ContainmentBinding,
  type ContainmentPort,
  verifyContainmentProof,
} from "./containment.ts";
import { CollaborationDegradationController } from "./degradation.ts";
import type { RuntimeReadiness } from "./degradation.ts";
import {
  assertCurrentInstanceLease,
  InstanceLeaseCoordinator,
  type InstanceLease,
} from "./leases.ts";
import type { AgentRunPort, AgentRunResult } from "./provider-runner.ts";
import { eventBelongsToRun } from "./provider-runner.ts";
import {
  renderCandidateStatus,
  runTargetTests,
  type CandidateStatusReport,
  type SandboxedCommandRunner,
  type TargetCommandSpec,
  type TestEvidence,
} from "./quality-gate.ts";
import { WorktreeManager, type ManagedWorktree } from "./worktree-manager.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { ExecutionLifecycle } from "./execution-lifecycle.ts";
import { assertExecutionRecoveryCanStart } from "./execution-recovery-authorization.ts";
import { CommandCleanupError } from "./execution-limits.ts";
import { resolveTargetCommandsForCandidate } from "./target-test-selection.ts";
import { assertCandidateRevisionCanStart, assertCandidateRevisionStillCurrent, readCandidateRevisionForAttempt, type CandidateRevisionGrant } from "./candidate-revision.ts";
import { hasUnsettledRepositoryActivity } from "./repository-occupancy.ts";

interface NodeRow {
  node_id: string;
  assigned_agent_id: string;
  objective: string;
  input_evidence_json: string;
  instructions: string;
  read_scope_json: string;
  write_scope_json: string;
  deny_scope_json: string;
  commands_json: string;
  target_commands_json: string;
  target_read_scope_json: string;
  target_deny_scope_json: string;
  expected_artifacts_json: string;
  completion_definition: string;
  budget_json: string;
  repository: string;
  current_plan_revision: number;
}

export interface RepositoryExecutionConfig {
  baseSha: string;
  targetCommands: Readonly<Record<string, TargetCommandSpec>>;
}

export interface CandidateExecutorOptions {
  agent: AgentRunPort;
  containment: ContainmentPort;
  commandRunner: SandboxedCommandRunner;
  managedWorktreeRoot: string;
  repositories: Readonly<Record<string, RepositoryExecutionConfig>>;
  limits: {
    maxAttempts: number;
    agentTimeoutMs: number;
    maxAgentEventBytes: number;
    interruptGraceMs: number;
  };
  scheduler?: { ownerId: string; leaseTtlMs: number };
}

export interface CandidateExecutionOutcome {
  runId: string;
  workItemId: string;
  planRevision: number;
  nodeId: string;
  baseSha: string;
  resultSha: string | null;
  branch: string;
  worktreePath: string;
  changedPaths: string[];
  report: CandidateStatusReport;
  evidence: TestEvidence[];
}

function parseStrings(value: string): string[] {
  return JSON.parse(value) as string[];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export class CandidateExecutor {
  private readonly database: DatabaseSync;
  private readonly serviceDataDirectory: string;
  private readonly worktrees: WorktreeManager;
  private readonly options: CandidateExecutorOptions;
  private readonly instanceLeases: InstanceLeaseCoordinator;
  private readonly degradation: CollaborationDegradationController;
  private ownedLease: InstanceLease | null = null;
  private closed = false;

  constructor(databaseFile: string, options: CandidateExecutorOptions) {
    this.options = options;
    this.database = new DatabaseSync(databaseFile);
    this.serviceDataDirectory = realpathSync(dirname(realpathSync(databaseFile)));
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 6) throw new Error("Fenced candidate execution schema is not installed");
    if (options.limits.maxAttempts < 1) throw new Error("Execution maxAttempts must be positive");
    this.instanceLeases = new InstanceLeaseCoordinator(
      this.database,
      options.scheduler?.ownerId ?? `candidate-executor:${randomUUID()}`,
    );
    this.degradation = new CollaborationDegradationController(this.database);
    this.worktrees = new WorktreeManager(options.managedWorktreeRoot);
  }

  async executeCurrentPlan(workItemId: string, attempt = 1, now = Date.now()): Promise<CandidateExecutionOutcome> {
    if (this.closed) throw new Error("Candidate executor is closed");
    assertLedgerArmed(this.database);
    if (attempt > this.options.limits.maxAttempts && !(attempt === 4 && this.options.limits.maxAttempts === 3)) {
      throw new Error("Execution attempt limit exceeded");
    }
    const leaseNow = Date.now();
    const instance = this.instanceLeases.acquire(
      leaseNow,
      Math.max(
        this.options.scheduler?.leaseTtlMs ?? 0,
        this.options.limits.agentTimeoutMs + this.options.limits.interruptGraceMs + 60_000,
      ),
    );
    if (!instance) throw new Error("Another collaboration scheduler owns the instance lease");
    this.ownedLease = instance;
    this.degradation.authorizeNewWork(instance, { action: "candidate.dispatch", workItemId, now: leaseNow });
    const node = this.loadModifyNode(workItemId);
    const repository = realpathSync(node.repository);
    const configured = Object.entries(this.options.repositories).find(([path]) => realpathSync(path) === repository)?.[1];
    if (!configured) throw new Error("Work Item repository is not configured for execution");
    const revisionBinding = readCandidateRevisionForAttempt(this.database, workItemId, attempt);
    const successfulCandidate = this.database.prepare("SELECT 1 FROM collaboration_runs r JOIN collaboration_candidates c ON c.run_id=r.id WHERE r.work_item_id=? AND r.plan_revision=? AND r.status='succeeded' AND c.state='target_tests_passed' LIMIT 1")
      .get(workItemId, node.current_plan_revision);
    // Preserve repository occupancy as the first failure while activity is unsettled.
    if (hasUnsettledRepositoryActivity(this.database, repository)) throw new Error("execution_repository_unsettled");
    let revision: CandidateRevisionGrant | undefined;
    if (revisionBinding || successfulCandidate) {
      revision = assertCandidateRevisionCanStart(this.database, { workItemId, attempt, maxAttempts: this.options.limits.maxAttempts,
        lease: instance, baseSha: configured.baseSha, now: Date.now() });
      if (revision.nodeId !== node.node_id || revision.planRevision !== node.current_plan_revision || realpathSync(revision.repository) !== repository)
        throw new Error("candidate_revision_execution_binding_mismatch");
    }
    if (attempt > this.options.limits.maxAttempts) {
      assertExecutionRecoveryCanStart(this.database, { workItemId, attempt, maxAttempts: this.options.limits.maxAttempts,
        lease: instance, baseSha: configured.baseSha, now: Date.now() });
    }
    const runId = randomUUID();
    const lifecycle = new ExecutionLifecycle(this.database, runId, instance);
    lifecycle.reserve({ workItemId, planRevision: node.current_plan_revision, repository, baseSha: configured.baseSha,
      attempt, maxAttempts: this.options.limits.maxAttempts, buildParentSha: revision?.buildParentSha });
    let ordinal = 0;
    let cleanupUnknown = false;
    const assertRevisionCurrent = () => {
      if (revision) assertCandidateRevisionStillCurrent(this.database, { workItemId, attempt, sessionId: runId });
    };
    const agent: AgentRunPort = {
      run: async request => {
        assertRevisionCurrent();
        const command = ++ordinal;
        lifecycle.command(command, request.containmentBinding);
        try {
          return await this.options.agent.run({ ...request, assertAuthorityCurrent: revision ? assertRevisionCurrent : undefined, registerContainment: async proof => {
            await request.registerContainment(proof);
            lifecycle.proof(command, proof);
            assertRevisionCurrent();
          } });
        } catch (error) { if (error instanceof CommandCleanupError) cleanupUnknown = true; throw error; }
      },
      interrupt: run => this.options.agent.interrupt(run),
    };
    const commandRunner: SandboxedCommandRunner | undefined = this.options.commandRunner ? { run: async request => {
      assertRevisionCurrent();
      const command = ++ordinal;
      lifecycle.command(command, request.containmentBinding);
      try {
        return await this.options.commandRunner.run({ ...request, registerContainment: async proof => {
          await request.registerContainment(proof);
          lifecycle.proof(command, proof);
          assertRevisionCurrent();
        } });
      } catch (error) { if (error instanceof CommandCleanupError) cleanupUnknown = true; throw error; }
    } } : undefined;
    try {
      return await this.executeReserved({ workItemId, attempt, now, node, repository, configured, runId, instance, agent, commandRunner, revision });
    } catch (error) { if (error instanceof CommandCleanupError) cleanupUnknown = true; throw error; }
    finally {
      let settled = false;
      if (!cleanupUnknown) {
        try { settled = await lifecycle.settle(this.options.containment); }
        catch { /* Lost lease, closed database or unknown process state must retain repository ownership. */ }
      }
      if (!settled) throw new CommandCleanupError(new Error("execution_session_unsettled"));
    }
  }

  private async executeReserved({ workItemId, attempt, now, node, repository, configured, runId, instance, agent, commandRunner, revision }: {
    workItemId: string; attempt: number; now: number; node: NodeRow; repository: string;
    configured: RepositoryExecutionConfig; runId: string; instance: InstanceLease;
    agent: AgentRunPort; commandRunner: SandboxedCommandRunner | undefined;
    revision?: CandidateRevisionGrant;
  }): Promise<CandidateExecutionOutcome> {
    const threadId = `collaboration-${runId}`;
    const turnId = randomUUID();
    const worktree = await this.worktrees.prepare({
      repository,
      workItemId,
      nodeId: node.node_id,
      attempt,
      expectedBaseSha: configured.baseSha,
      buildParentSha: revision?.buildParentSha,
    });
    const containmentBinding: ContainmentBinding = {
      runId,
      canonicalWorktreePath: realpathSync(worktree.path),
      instanceOwner: instance.ownerId,
      instanceFence: instance.fence,
      nonce: randomBytes(32).toString("base64url"),
    };
    this.startRun({
      runId,
      workItemId,
      attempt,
      node,
      threadId,
      turnId,
      worktree,
      instance,
      containmentBinding,
      now,
      revision,
    });

    const controller = new AbortController();
    let eventBytes = 0;
    let eventSequence = 0;
    let acceptingEvents = true;
    let eventLimitExceeded = false;
    const runPromise = agent.run({
      runId,
      threadId,
      turnId,
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      cwd: worktree.path,
      sourceSha: worktree.buildParentSha ?? worktree.baseSha,
      allowedChanges: revision?.allowedChanges.map(change => ({ ...change })),
      objective: node.objective,
      instructions: revision?.instructions ?? node.instructions,
      inputEvidence: parseStrings(node.input_evidence_json),
      readScope: parseStrings(node.read_scope_json),
      writeScope: parseStrings(node.write_scope_json),
      denyScope: parseStrings(node.deny_scope_json),
      expectedArtifacts: parseStrings(node.expected_artifacts_json),
      completionDefinition: node.completion_definition,
      environment: worktree.environment,
      capabilities: {
        network: false,
        dependencyInstallation: false,
        arbitraryCommands: false,
        gitCommit: false,
      },
      sandbox: {
        filesystemRoot: worktree.path,
        readOnlyPaths: [repository],
        denyGitMetadata: true,
        network: "deny",
      },
      containmentBinding,
      signal: controller.signal,
      registerContainment: async (proof) => {
        const verified = await verifyContainmentProof(this.options.containment, proof, containmentBinding);
        if (!verified.verified) throw new Error("Provider containment proof was rejected");
        this.recordVerifiedContainment(
          runId,
          proof,
          verified.fingerprint,
          containmentBinding,
          instance,
          Date.now(),
          "verified",
        );
      },
      emit: (event) => {
        if (!acceptingEvents || !eventBelongsToRun(event, { threadId, turnId })) return;
        const bytes = Buffer.byteLength(event.message, "utf8");
        if (eventBytes + bytes > this.options.limits.maxAgentEventBytes) {
          eventLimitExceeded = true;
          controller.abort(new Error("Agent event output limit exceeded"));
          return;
        }
        eventBytes += bytes;
        eventSequence += 1;
        this.database
          .prepare(
            "INSERT INTO collaboration_run_events (run_id, sequence, event_type, message, created_at) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .run(runId, eventSequence, event.type, event.message, Date.now());
      },
    }).catch((error): AgentRunResult => ({
      threadId,
      turnId,
      status: "failed",
      message: errorMessage(error),
      sandboxEnforced: false,
    }));

    const timeoutMarker = Symbol("timeout");
    const ownerInterruptMarker = Symbol("owner_interrupt");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interruptPoll: ReturnType<typeof setInterval> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Agent run timed out"));
        resolve(timeoutMarker);
      }, this.options.limits.agentTimeoutMs);
      timer.unref?.();
    });
    const ownerInterrupt = new Promise<typeof ownerInterruptMarker>((resolve) => {
      interruptPoll = setInterval(() => {
        const row = this.database
          .prepare("SELECT interrupt_requested_at FROM collaboration_runs WHERE id = ?")
          .get(runId) as { interrupt_requested_at: number | null } | undefined;
        if (row?.interrupt_requested_at !== null && row?.interrupt_requested_at !== undefined) {
          resolve(ownerInterruptMarker);
        }
      }, 25);
      interruptPoll.unref?.();
    });
    let result: AgentRunResult | null = null;
    const settled = await Promise.race([runPromise, timeout, ownerInterrupt]);
    const timedOut = settled === timeoutMarker;
    const ownerInterrupted = settled === ownerInterruptMarker;
    if (timer) clearTimeout(timer);
    if (interruptPoll) clearInterval(interruptPoll);
    if (timedOut || eventLimitExceeded || ownerInterrupted) {
      if (ownerInterrupted) controller.abort(new Error("Owner interrupted Agent run"));
      await agent.interrupt(runId);
      await Promise.race([
        runPromise.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, this.options.limits.interruptGraceMs)),
      ]);
    } else {
      result = settled as AgentRunResult;
    }
    acceptingEvents = false;

    if (timedOut) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "timed_out", ["agent_timeout"], now);
    }
    if (ownerInterrupted) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "failed",
        ["owner_interrupt"],
        now,
        [],
        true,
      );
    }
    if (eventLimitExceeded) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["agent_output_limit"], now);
    }
    if (!result || result.threadId !== threadId || result.turnId !== turnId) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["provider_identity_mismatch"], now);
    }
    if (!result.sandboxEnforced) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        ["provider_sandbox_unavailable"],
        now,
      );
    }
    if (result.status === "needs_configuration" || result.need) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        [result.need ?? "provider_configuration"],
        now,
      );
    }
    if (result.status !== "completed") {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "failed", [result.message ?? "agent_failed"], now);
    }
    const containment = await verifyContainmentProof(
      this.options.containment,
      result.containmentProof ?? null,
      containmentBinding,
    );
    if (!containment.verified || !result.containmentProof) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        ["reason" in containment ? containment.reason : "containment_proof_missing"],
        now,
      );
    }
    if (!this.isRegisteredContainment(runId, containment.fingerprint, containmentBinding)) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        ["provider_containment_not_registered"],
        now,
      );
    }
    const contained = await this.options.containment.inspect(result.containmentProof.identity);
    if (contained.state !== "empty" || contained.fingerprint !== containment.fingerprint) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        [contained.state === "unknown" ? contained.reason : "provider_containment_not_empty"],
        now,
      );
    }
    this.recordVerifiedContainment(
      runId,
      result.containmentProof,
      containment.fingerprint,
      containmentBinding,
      instance,
      Date.now(),
      "empty",
    );

    await this.worktrees.assertOriginalUnchanged(worktree);
    if ((await this.worktrees.currentHead(worktree)) !== (worktree.buildParentSha ?? worktree.baseSha)) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["unexpected_agent_commit"], now);
    }
    const changedPaths = await this.worktrees.changedPaths(worktree);
    const mandatoryDeny = [".env", ".env*", "**/.env*", ".git", ".git/**", ...parseStrings(node.deny_scope_json)];
    const diff = this.worktrees.validateDiff(worktree, changedPaths, parseStrings(node.write_scope_json), mandatoryDeny);
    if (!changedPaths.length) diff.violations.push("no_changes");
    if (revision) {
      try { await this.worktrees.assertRevisionDelta(worktree, revision.allowedChanges); }
      catch { diff.violations.push("candidate_revision_delta_invalid"); }
    }
    if (diff.violations.length) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", diff.violations, now, changedPaths);
    }
    const beforeCommitBlock = this.executionBlockReason(runId, workItemId, node.current_plan_revision, node.node_id);
    if (beforeCommitBlock) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", [beforeCommitBlock], now, changedPaths);
    }
    if (revision) {
      try { assertCandidateRevisionStillCurrent(this.database, { workItemId, attempt, sessionId: runId }); }
      catch { return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["candidate_revision_authority_stale"], now, changedPaths); }
    }
    assertCurrentInstanceLease(this.database, instance, Date.now());
    appendExecutionAudit(this.database, {
      runId,
      action: "candidate.commit_authorized",
      outcome: "allow",
      resource: { baseSha: worktree.baseSha, changedPaths },
      now: Date.now(),
    });
    const resultSha = await this.worktrees.commitCandidate(worktree, {
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      runId,
    });
    if (revision) {
      try { assertCandidateRevisionStillCurrent(this.database, { workItemId, attempt, sessionId: runId }); }
      catch { return this.finalizeCandidate(runId, workItemId, node, worktree, resultSha, changedPaths,
        renderCandidateStatus({ modified: true, violations: ["candidate_revision_authority_stale"] }), [], now); }
      try { await this.worktrees.assertRevisionDelta(worktree, revision.allowedChanges, resultSha); }
      catch { return this.finalizeCandidate(runId, workItemId, node, worktree, resultSha, changedPaths,
        renderCandidateStatus({ modified: true, violations: ["candidate_revision_committed_delta_invalid"] }), [], now); }
    }

    const afterCommitBlock = this.executionBlockReason(runId, workItemId, node.current_plan_revision, node.node_id);
    if (afterCommitBlock) {
      return this.finalizeCandidate(
        runId,
        workItemId,
        node,
        worktree,
        resultSha,
        changedPaths,
        renderCandidateStatus({ modified: true, violations: [afterCommitBlock] }),
        [],
        now,
      );
    }
    assertCurrentInstanceLease(this.database, instance, Date.now());

    let testEvidence: TestEvidence[] = [];
    let report: CandidateStatusReport;
    try {
      const commandIds = parseStrings(node.target_commands_json);
      const targets = resolveTargetCommandsForCandidate({
        worktree: worktree.path, candidateSha: resultSha, commandIds, commands: configured.targetCommands,
        readScope: parseStrings(node.target_read_scope_json), denyScope: parseStrings(node.target_deny_scope_json),
      });
      const tests = await runTargetTests({
        worktree: worktree.path,
        environment: worktree.environment,
        commandIds,
        commands: targets.commands,
        runner: commandRunner,
        containment: this.options.containment,
        containmentContext: {
          runId,
          canonicalWorktreePath: containmentBinding.canonicalWorktreePath,
          instanceOwner: instance.ownerId,
          instanceFence: instance.fence,
        },
        deniedPaths: [worktree.commonGitDir, worktree.repository, this.serviceDataDirectory],
      });
      testEvidence = tests.evidence;
      report = tests.configurationProblems.length
        ? renderCandidateStatus({ modified: true, needsConfiguration: tests.configurationProblems })
        : renderCandidateStatus({ modified: true, evidence: testEvidence });
      if (Object.keys(targets.selections).length) report.targetSelections = targets.selections;
    } catch (error) {
      if (error instanceof CommandCleanupError) throw error;
      report = renderCandidateStatus({ modified: true, needsConfiguration: [errorMessage(error)] });
    }
    if ((await this.worktrees.currentHead(worktree)) !== resultSha || (await this.worktrees.status(worktree)).length) {
      report = renderCandidateStatus({ modified: true, violations: ["test_modified_candidate"] });
    }
    await this.worktrees.assertOriginalUnchanged(worktree);
    const afterTestsBlock = this.executionBlockReason(runId, workItemId, node.current_plan_revision, node.node_id);
    if (afterTestsBlock) {
      report = renderCandidateStatus({ modified: true, violations: [afterTestsBlock] });
    }
    return this.finalizeCandidate(runId, workItemId, node, worktree, resultSha, changedPaths, report, testEvidence, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownedLease) {
      try {
        this.instanceLeases.release(this.ownedLease, Date.now());
      } catch {}
      this.ownedLease = null;
    }
    this.database.close();
  }

  readiness(): RuntimeReadiness {
    if (this.closed) throw new Error("Candidate executor is closed");
    return this.degradation.readiness();
  }

  private loadModifyNode(workItemId: string): NodeRow {
    const row = this.database
      .prepare(
        "SELECT n.node_id, n.assigned_agent_id, n.objective, n.input_evidence_json, n.instructions, " +
          "n.read_scope_json, n.write_scope_json, n.deny_scope_json, n.commands_json, n.expected_artifacts_json, " +
          "n.completion_definition, n.budget_json, s.repository, w.current_plan_revision, " +
          "(SELECT v.commands_json FROM collaboration_work_nodes v " +
          " WHERE v.work_item_id = w.id AND v.plan_revision = p.revision AND v.node_type = 'validate' AND v.active = 1) " +
          "AS target_commands_json, " +
          "(SELECT v.read_scope_json FROM collaboration_work_nodes v " +
          " WHERE v.work_item_id = w.id AND v.plan_revision = p.revision AND v.node_type = 'validate' AND v.active = 1) " +
          "AS target_read_scope_json, " +
          "(SELECT v.deny_scope_json FROM collaboration_work_nodes v " +
          " WHERE v.work_item_id = w.id AND v.plan_revision = p.revision AND v.node_type = 'validate' AND v.active = 1) " +
          "AS target_deny_scope_json " +
          "FROM collaboration_work_items w " +
          "JOIN collaboration_plan_revisions p ON p.work_item_id = w.id AND p.revision = w.current_plan_revision " +
          "JOIN collaboration_work_item_snapshots s ON s.work_item_id = w.id AND s.revision = p.snapshot_revision " +
          "JOIN collaboration_work_nodes n ON n.work_item_id = w.id AND n.plan_revision = p.revision " +
          "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' AND w.control_state = 'active' " +
          "AND n.node_type = 'modify' AND n.active = 1 AND n.control_state = 'active'",
      )
      .get(workItemId) as NodeRow | undefined;
    if (!row?.repository) throw new Error("Work Item has no current executable modify node");
    if (!readPlanMaterialReadiness(this.database, workItemId, row.current_plan_revision).ready) throw new Error("plan_materials_incomplete");
    return row;
  }

  private executionBlockReason(
    runId: string,
    workItemId: string,
    planRevision: number,
    nodeId: string,
  ): "owner_interrupt" | "plan_superseded" | "plan_materials_incomplete" | null {
    const row = this.database
      .prepare(
        "SELECT r.status AS run_status, r.interrupt_requested_at, w.control_state AS work_item_control_state, " +
          "w.current_plan_revision, n.active AS node_active, n.control_state AS node_control_state " +
          "FROM collaboration_runs r JOIN collaboration_work_items w ON w.id = r.work_item_id " +
          "LEFT JOIN collaboration_work_nodes n ON n.work_item_id = w.id AND n.plan_revision = ? AND n.node_id = ? " +
          "WHERE r.id = ? AND r.work_item_id = ? AND r.plan_revision = ? AND r.node_id = ?",
      )
      .get(planRevision, nodeId, runId, workItemId, planRevision, nodeId) as
      | {
          run_status: string;
          interrupt_requested_at: number | null;
          work_item_control_state: string;
          current_plan_revision: number;
          node_active: number | null;
          node_control_state: string | null;
        }
      | undefined;
    if (!row) return "plan_superseded";
    if (
      row.interrupt_requested_at !== null ||
      row.work_item_control_state !== "active" ||
      row.node_control_state !== "active" ||
      row.run_status !== "running"
    ) {
      return "owner_interrupt";
    }
    if (row.current_plan_revision !== planRevision || row.node_active !== 1) return "plan_superseded";
    if (!readPlanMaterialReadiness(this.database, workItemId, planRevision).ready) return "plan_materials_incomplete";
    return null;
  }

  private isCurrentExecutableNode(workItemId: string, planRevision: number, nodeId: string): boolean {
    if (!readPlanMaterialReadiness(this.database, workItemId, planRevision).ready) return false;
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM collaboration_work_items w JOIN collaboration_work_nodes n " +
            "ON n.work_item_id = w.id AND n.plan_revision = w.current_plan_revision " +
            "WHERE w.id = ? AND w.control_state = 'active' AND w.current_plan_revision = ? " +
            "AND n.node_id = ? AND n.active = 1 AND n.control_state = 'active'",
        )
        .get(workItemId, planRevision, nodeId),
    );
  }

  private startRun(input: {
    runId: string;
    workItemId: string;
    attempt: number;
    node: NodeRow;
    threadId: string;
    turnId: string;
    worktree: ManagedWorktree;
    instance: InstanceLease;
    containmentBinding: ContainmentBinding;
    now: number;
    revision?: CandidateRevisionGrant;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.isCurrentExecutableNode(input.workItemId, input.node.current_plan_revision, input.node.node_id)) {
        throw new Error("Plan changed or Owner control prevents execution");
      }
      assertCurrentInstanceLease(this.database, input.instance, Date.now());
      if (input.revision) {
        assertCandidateRevisionStillCurrent(this.database, { workItemId: input.workItemId, attempt: input.attempt, sessionId: input.runId });
        const binding = readCandidateRevisionForAttempt(this.database, input.workItemId, input.attempt);
        if (!binding || binding.stage !== "started" || binding.sessionId !== input.runId || binding.instanceOwner !== input.instance.ownerId ||
          binding.instanceFence !== input.instance.fence || binding.requestHash !== input.revision.requestHash || binding.buildParentSha !== input.worktree.buildParentSha)
          throw new Error("candidate_revision_started_binding_mismatch");
      }
      const claimed = this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET lease_owner = ?, lease_expires_at = ?, " +
            "lease_fence = COALESCE(lease_fence, 0) + 1, runtime_state = 'running', version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? AND active = 1 " +
            "AND control_state = 'active' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
        )
        .run(
          input.instance.ownerId,
          input.instance.expiresAt,
          input.workItemId,
          input.node.current_plan_revision,
          input.node.node_id,
          Date.now(),
        );
      if (claimed.changes !== 1) throw new Error("Executable node is already leased");
      const nodeLease = this.database
        .prepare(
          "SELECT lease_fence FROM collaboration_work_nodes " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ?",
        )
        .get(input.workItemId, input.node.current_plan_revision, input.node.node_id) as { lease_fence: number };
      this.database
        .prepare(
          "INSERT INTO collaboration_runs " +
            "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
            "worktree_path, branch, base_sha, started_at, instance_owner, instance_fence, node_lease_fence, heartbeat_at, " +
            "containment_binding_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.runId,
          input.workItemId,
          input.node.current_plan_revision,
          input.node.node_id,
          input.attempt,
          input.node.assigned_agent_id,
          input.threadId,
          input.turnId,
          input.worktree.repository,
          input.worktree.path,
          input.worktree.branch,
          input.worktree.baseSha,
          input.now,
          input.instance.ownerId,
          input.instance.fence,
          nodeLease.lease_fence,
          input.now,
          JSON.stringify(input.containmentBinding),
        );
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET execution_status = CASE " +
            "WHEN node_type = 'analyze' THEN 'candidate_ready' WHEN node_type = 'modify' THEN 'running' " +
            "ELSE execution_status END, version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(input.workItemId, input.node.current_plan_revision);
      appendExecutionAudit(this.database, {
        runId: input.runId,
        action: "run.started",
        outcome: "running",
        resource: { baseSha: input.worktree.baseSha, branch: input.worktree.branch },
        now: input.now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private finalizeWithoutCandidate(
    runId: string,
    workItemId: string,
    node: NodeRow,
    worktree: ManagedWorktree,
    runStatus: "failed" | "invalid" | "needs_configuration" | "timed_out",
    violations: string[],
    now: number,
    changedPaths: string[] = [],
    ownerInterrupted = false,
  ): CandidateExecutionOutcome {
    const report =
      runStatus === "needs_configuration"
        ? renderCandidateStatus({ modified: changedPaths.length > 0, needsConfiguration: violations })
        : renderCandidateStatus({ modified: changedPaths.length > 0, violations });
    return this.finalizeCandidate(
      runId,
      workItemId,
      node,
      worktree,
      null,
      changedPaths,
      report,
      [],
      now,
      runStatus,
      ownerInterrupted,
    );
  }

  private finalizeCandidate(
    runId: string,
    workItemId: string,
    node: NodeRow,
    worktree: ManagedWorktree,
    resultSha: string | null,
    changedPaths: string[],
    report: CandidateStatusReport,
    evidence: TestEvidence[],
    now: number,
    explicitRunStatus?: "failed" | "invalid" | "needs_configuration" | "timed_out",
    ownerInterrupted = false,
  ): CandidateExecutionOutcome {
    let finalizedReport = report;
    let candidateSha = resultSha;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const runFence = this.database
        .prepare("SELECT instance_owner, instance_fence, node_lease_fence FROM collaboration_runs WHERE id = ?")
        .get(runId) as
        | { instance_owner: string; instance_fence: number; node_lease_fence: number }
        | undefined;
      if (!runFence?.instance_owner || !runFence.instance_fence || !runFence.node_lease_fence) {
        throw new Error("Run has no scheduler fence");
      }
      assertCurrentInstanceLease(
        this.database,
        { ownerId: runFence.instance_owner, fence: runFence.instance_fence },
        Date.now(),
      );
      const transactionBlock = this.executionBlockReason(runId, workItemId, node.current_plan_revision, node.node_id);
      let effectiveReport = transactionBlock
        ? renderCandidateStatus({ modified: changedPaths.length > 0, violations: [transactionBlock] })
        : report;
      // SAFETY: the run fence above proved this row exists; schema requires a positive integer attempt.
      const runAttempt = this.database.prepare("SELECT attempt FROM collaboration_runs WHERE id=?").get(runId) as { attempt: number };
      const revision = readCandidateRevisionForAttempt(this.database, workItemId, runAttempt.attempt);
      let revisionAuthorityStale = false;
      let quality: CandidateStatusReport & { lineage?: object; rejectedCandidateSha?: string } = effectiveReport;
      if (revision) {
        if (revision.stage !== "started" || revision.sessionId !== runId || revision.baseSha !== worktree.baseSha || revision.buildParentSha !== worktree.buildParentSha)
          throw new Error("candidate_revision_finalization_binding_mismatch");
        try { assertCandidateRevisionStillCurrent(this.database, { workItemId, attempt: runAttempt.attempt, sessionId: runId }); }
        catch {
          revisionAuthorityStale = true;
          effectiveReport = renderCandidateStatus({ modified: changedPaths.length > 0, violations: ["candidate_revision_authority_stale"] });
          candidateSha = null;
        }
        quality = { ...effectiveReport, lineage: { version: 1, requestId: revision.requestId, requestHash: revision.requestHash,
          parentRunId: revision.parentRunId, parentSha: revision.parentSha, baseSha: revision.baseSha,
          buildParentSha: revision.buildParentSha, candidateSha } };
        if (candidateSha === null && resultSha !== null) quality.rejectedCandidateSha = resultSha;
      }
      finalizedReport = effectiveReport;
      const effectiveOwnerInterrupted = ownerInterrupted || transactionBlock === "owner_interrupt";
      const runStatus = effectiveOwnerInterrupted
        ? "failed"
        : revisionAuthorityStale ? "invalid" : explicitRunStatus ??
          (effectiveReport.state === "invalid"
            ? "invalid"
            : effectiveReport.state === "needs_configuration"
              ? "needs_configuration"
              : revision && effectiveReport.state !== "target_tests_passed" ? "failed" : "succeeded");
      const nodeRuntimeState =
        effectiveOwnerInterrupted
          ? "interrupted"
          : effectiveReport.state === "needs_configuration"
            ? "needs_configuration"
            : effectiveReport.state === "invalid" || effectiveReport.state === "test_failed"
              ? "failed"
              : "succeeded";
      const released = this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = ?, lease_owner = NULL, lease_expires_at = NULL, " +
            "version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? " +
            "AND lease_owner = ? AND lease_fence = ?",
        )
        .run(
          nodeRuntimeState,
          workItemId,
          node.current_plan_revision,
          node.node_id,
          runFence.instance_owner,
          runFence.node_lease_fence,
        );
      if (released.changes !== 1) throw new Error("Run node lease is stale");
      this.database
        .prepare(
          "UPDATE collaboration_runs SET status = ?, result_sha = ?, finished_at = ?, error = ?, " +
            "version = version + 1 WHERE id = ?",
        )
        .run(runStatus, candidateSha, Date.now(), effectiveReport.reasons.join("; ") || null, runId);
      this.database
        .prepare(
          "INSERT INTO collaboration_candidates " +
            "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          runId,
          effectiveReport.state,
          worktree.baseSha,
          candidateSha,
          JSON.stringify(changedPaths),
          JSON.stringify(effectiveReport.reasons),
          JSON.stringify(quality),
          now,
        );
      const insertEvidence = this.database.prepare(
        "INSERT INTO collaboration_test_evidence " +
          "(id, run_id, command_id, argv_json, cwd, exit_code, duration_ms, stdout, stderr, state, created_at, " +
          "containment_fingerprint, containment_binding_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const item of evidence) {
        insertEvidence.run(
          randomUUID(),
          runId,
          item.commandId,
          JSON.stringify(item.argv),
          item.cwd,
          item.exitCode,
          item.durationMs,
          item.stdout,
          item.stderr,
          item.state,
          now,
          item.containmentFingerprint,
          JSON.stringify(item.containmentBinding),
        );
      }
      let executionStatus =
        effectiveReport.state === "invalid"
          ? "invalid"
          : effectiveReport.state === "needs_configuration"
            ? "needs_configuration"
            : "candidate_ready";
      if (effectiveOwnerInterrupted) {
        const state = this.database
          .prepare("SELECT control_state FROM collaboration_work_items WHERE id = ?")
          .get(workItemId) as { control_state: string };
        executionStatus = state.control_state === "active" ? "not_started" : "invalid";
      }
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET execution_status = CASE " +
            "WHEN node_type = 'modify' THEN ? " +
            "WHEN node_type IN ('validate', 'report') AND ? = 'candidate_ready' THEN 'not_started' " +
            "WHEN node_type IN ('validate', 'report') THEN ? ELSE execution_status END " +
            ", version = version + 1 WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(executionStatus, executionStatus, executionStatus, workItemId, node.current_plan_revision);
      appendExecutionAudit(this.database, {
        runId,
        action: "candidate.finalized",
        outcome: effectiveReport.state,
        resource: { baseSha: worktree.baseSha, resultSha: candidateSha, quality: effectiveReport.state, ownerInterrupted: effectiveOwnerInterrupted },
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      runId,
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      baseSha: worktree.baseSha,
      resultSha: candidateSha,
      branch: worktree.branch,
      worktreePath: worktree.path,
      changedPaths,
      report: finalizedReport,
      evidence,
    };
  }

  private recordVerifiedContainment(
    runId: string,
    proof: NonNullable<AgentRunResult["containmentProof"]>,
    fingerprint: string,
    binding: ContainmentBinding,
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    now: number,
    containmentState: "verified" | "empty",
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const result = this.database
        .prepare(
          "UPDATE collaboration_runs SET runtime_identity_json = ?, containment_state = ?, heartbeat_at = ?, " +
            "containment_fingerprint = COALESCE(containment_fingerprint, ?), version = version + 1 " +
            "WHERE id = ? AND status = 'running' AND instance_owner = ? AND instance_fence = ? " +
            "AND containment_binding_json = ? " +
            "AND (containment_fingerprint IS NULL OR containment_fingerprint = ?)",
        )
        .run(
          JSON.stringify(proof),
          containmentState,
          now,
          fingerprint,
          runId,
          instance.ownerId,
          instance.fence,
          JSON.stringify(binding),
          fingerprint,
        );
      if (result.changes !== 1) throw new Error("Run containment update is stale");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private isRegisteredContainment(runId: string, fingerprint: string, binding: ContainmentBinding): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM collaboration_runs WHERE id = ? AND status = 'running' " +
            "AND containment_fingerprint = ? AND containment_binding_json = ?",
        )
        .get(runId, fingerprint, JSON.stringify(binding)),
    );
  }
}
