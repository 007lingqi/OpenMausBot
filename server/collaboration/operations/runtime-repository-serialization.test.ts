import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../worktree-manager.ts";
import { CommandCleanupError } from "../execution-limits.ts";
import { ExecutionLifecycle } from "../execution-lifecycle.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";

import type { DingTalkInboundMessage } from "../../integrations/dingtalk/types.ts";
import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "../containment.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "../provider-runner.ts";
import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
  TargetCommandSpec,
} from "../quality-gate.ts";
import { startCollaborationService } from "../service.ts";
import { currentInstanceLease } from "../leases.ts";
import { recordPreparationResult } from "../execution-preparation.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./runtime.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "runtime-repository-serialization-"));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(root: string, name: string): { path: string; baseSha: string } {
  const path = join(root, name);
  mkdirSync(join(path, "src"), { recursive: true });
  git(root, ["init", "-b", "main", path]);
  writeFileSync(join(path, "src", "value.txt"), "before\n");
  git(path, ["add", "."]);
  git(path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  return { path, baseSha: git(path, ["rev-parse", "HEAD"]) };
}

function proof(binding: ContainmentBinding): ContainmentProof {
  return {
    identity: {
      backend: "test_verified_runtime",
      opaqueId: "repository-serialization-runtime-0001",
      hostGeneration: "repository-serialization-host-1",
      verifierVersion: "repository-serialization-v1",
    },
    receipt: containmentBindingHash(binding),
  };
}

class FakeContainment implements ContainmentPort {
  async verifyProof(candidate: ContainmentProof, expected: ContainmentBinding) {
    const bindingHash = containmentBindingHash(expected);
    return candidate.receipt === bindingHash
      ? { verified: true as const, fingerprint: runtimeIdentityFingerprint(candidate.identity), bindingHash }
      : { verified: false as const, reason: "unverified" };
  }

  async inspect(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }

  async terminateAndWaitEmpty(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }
}

class PassingRunner implements SandboxedCommandRunner {
  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    const containmentProof = proof(request.containmentBinding);
    await request.registerContainment(containmentProof);
    return {
      exitCode: 0,
      stdout: Buffer.from("passed\n"),
      stderr: Buffer.alloc(0),
      durationMs: 1,
      timedOut: false,
      outputLimitExceeded: false,
      attestation: {
        sandboxEnforced: true,
        writableRoot: request.sandbox.writableRoot,
        deniedPaths: [...request.sandbox.deniedPaths],
        network: "deny",
        processIsolated: true,
        processTreeReaped: true,
        containmentProof,
      },
    };
  }
}

type AgentDecision = "complete" | "fail";

interface PendingAgentRun {
  request: AgentRunRequest;
  resolve(decision: AgentDecision): void;
}

class DeferredAgent implements AgentRunPort {
  readonly startedWorkItems: string[] = [];
  private readonly pendingByWorkItem = new Map<string, PendingAgentRun>();
  private readonly pendingByRun = new Map<string, PendingAgentRun>();
  private fallback: AgentDecision | null = null;

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.registerContainment(proof(request.containmentBinding));
    this.startedWorkItems.push(request.workItemId);
    const decision = this.fallback ?? await new Promise<AgentDecision>((resolve) => {
      const pending = { request, resolve };
      this.pendingByWorkItem.set(request.workItemId, pending);
      this.pendingByRun.set(request.runId, pending);
    });
    this.pendingByWorkItem.delete(request.workItemId);
    this.pendingByRun.delete(request.runId);
    if (decision === "complete") writeFileSync(join(request.cwd, "src", "value.txt"), `${request.workItemId}\n`);
    return {
      threadId: request.threadId,
      turnId: request.turnId,
      status: decision === "complete" ? "completed" : "failed",
      message: decision === "complete" ? "done" : "controlled failure",
      sandboxEnforced: true,
      containmentProof: proof(request.containmentBinding),
    };
  }

  resolve(workItemId: string, decision: AgentDecision): void {
    const pending = this.pendingByWorkItem.get(workItemId);
    if (!pending) throw new Error(`No pending Agent run for ${workItemId}`);
    pending.resolve(decision);
  }

  async interrupt(runId: string): Promise<void> {
    this.pendingByRun.get(runId)?.resolve("fail");
  }

  releaseAll(): void {
    this.fallback = "fail";
    for (const pending of [...this.pendingByRun.values()]) pending.resolve("fail");
  }
}

interface SeededWorkItem {
  workItemId: string;
  conversationId: string;
}

interface RuntimeHarness {
  runtime: CollaborationHeadlessRuntime;
  agent: DeferredAgent;
  items: SeededWorkItem[];
  options: CollaborationHeadlessRuntimeOptions;
  databaseFile: string;
}

function inbound(input: {
  sourceEventId: string;
  conversationId: string;
  text: string;
}): DingTalkInboundMessage {
  return {
    sourceEventId: input.sourceEventId,
    transportMessageId: `transport-${input.sourceEventId}`,
    conversationId: input.conversationId,
    addressedToBot: true,
    text: input.text,
    sender: {
      senderCorpId: "corp",
      senderStaffId: "staff",
      senderId: "sender",
      displayName: "Contributor",
    },
    receivedAt: Date.now(),
  };
}

function createHarness(repositories: Array<{ path: string; baseSha: string }>): RuntimeHarness {
  const dataDirectory = temporaryDirectory();
  const planningPolicy = { ...policy, allowedRepositories: repositories.map((repository) => repository.path) };
  const planner = { propose: () => validProposal() };
  const service = startCollaborationService({
    dataDirectory,
    planning: { planner, policy: planningPolicy },
  });
  const items = repositories.map((repository, index) => {
    const conversationId = `repository-serialization-conversation-${index}`;
    const created = service.ingestDingTalkMessage(inbound({
      sourceEventId: `repository-serialization-create-${index}`,
      conversationId,
      text: `修改仓库 ${index + 1}`,
    }));
    if (!created.workItemId) throw new Error("Expected a Work Item");
    service.reviseWorkItemDefinition(created.workItemId, {
      goal: `完成仓库 ${index + 1} 的修改`,
      goalConfirmed: true,
      repository: repository.path,
      acceptanceConditions: [{ description: "修改已经完成", observation: "pnpm test target" }],
      blockingAmbiguities: [],
    }, 2_000 + index);
    return { workItemId: created.workItemId, conversationId };
  });
  service.close();

  const agent = new DeferredAgent();
  const targetCommand: TargetCommandSpec = {
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
  };
  const options: CollaborationHeadlessRuntimeOptions = {
    dataDirectory,
    ownerId: "repository-serialization-runtime",
    platform: "linux",
    autoExecuteReady: true,
    planner,
    planningPolicy,
    agent,
    containment: new FakeContainment(),
    commandRunner: new PassingRunner(),
    execution: {
      managedWorktreeRoot: join(dataDirectory, "managed-worktrees"),
      repositories: Object.fromEntries(repositories.map((repository) => [
        repository.path,
        { baseSha: repository.baseSha, targetCommands: { "pnpm test target": targetCommand } },
      ])),
      limits: { maxAttempts: 1, agentTimeoutMs: 5_000, maxAgentEventBytes: 16_000, interruptGraceMs: 100 },
    },
  };
  const runtime = new CollaborationHeadlessRuntime(options);
  return { runtime, agent, items, options, databaseFile: join(dataDirectory, "collaboration", "collaboration.sqlite") };
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectNotStarted(agent: DeferredAgent, workItemId: string): Promise<void> {
  const deadline = Date.now() + 100;
  while (Date.now() < deadline) {
    expect(agent.startedWorkItems).not.toContain(workItemId);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function stopHarness(harness: RuntimeHarness): Promise<void> {
  harness.agent.releaseAll();
  await harness.runtime.stop();
}

describe("runtime repository single-writer scheduling", () => {
  it("recovers old occupancy and starts waiting work, never relaunching an orphan execution as new", async () => {
    const repo = createRepository(temporaryDirectory(), "recovery-queue");
    const h = createHarness([repo, repo]);
    h.options.execution!.limits.maxAttempts = 3;
    const db = new DatabaseSync(h.databaseFile);
    const leases = new InstanceLeaseCoordinator(db, "old");
    const lease = leases.acquire(Date.now(), 60000)!;
    const old = new ExecutionLifecycle(db, "orphan-execution", lease);
    old.reserve({ workItemId: h.items[0].workItemId, planRevision: 1, repository: repo.path, baseSha: repo.baseSha, attempt: 1 });
    const binding = { runId: old.id, canonicalWorktreePath: repo.path, instanceOwner: lease.ownerId, instanceFence: lease.fence, nonce: "a".repeat(64) };
    old.command(1, binding); old.proof(1, proof(binding));
    await old.settle({ ...new FakeContainment(), verifyProof: new FakeContainment().verifyProof,
      inspect: async identity => ({ state: "active", fingerprint: runtimeIdentityFingerprint(identity) }),
      terminateAndWaitEmpty: new FakeContainment().terminateAndWaitEmpty });
    leases.release(lease, Date.now());
    try {
      await h.runtime.start();
      await waitFor(() => h.agent.startedWorkItems.includes(h.items[1].workItemId), "Waiting repository was not released");
      expect(h.agent.startedWorkItems).not.toContain(h.items[0].workItemId);
      expect(db.prepare("SELECT 1 FROM collaboration_execution_dispatches WHERE work_item_id=?").get(h.items[0].workItemId)).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_sessions WHERE work_item_id=?").get(h.items[0].workItemId)).toEqual({ n: 1 });
    } finally { await stopHarness(h); db.close(); }
  });

  it("rejects direct execution while scheduled work is still preparing the same repository", async () => {
    const repo = createRepository(temporaryDirectory(), "direct-during-preparation");
    const h = createHarness([repo, repo]);
    let release!: () => void;
    const original = WorktreeManager.prototype.prepare;
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockImplementationOnce(async function (this: WorktreeManager, ...args) {
      await new Promise<void>(resolve => { release = resolve; });
      return original.apply(this, args);
    });
    try {
      await h.runtime.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await expect(h.runtime.executeCurrentPlan(h.items[1].workItemId)).rejects.toThrow("collaboration_repository_busy");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(h.agent.startedWorkItems).toEqual([]);
    } finally {
      release?.(); h.agent.releaseAll(); await h.runtime.stop(); prepare.mockRestore();
    }
  });

  it("holds a direct execution repository through preparation and lets its queued sibling proceed afterwards", async () => {
    const repo = createRepository(temporaryDirectory(), "direct-before-scheduled");
    const h = createHarness([repo, repo]);
    h.options.autoExecuteReady = false;
    let release!: () => void;
    const original = WorktreeManager.prototype.prepare;
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockImplementationOnce(async function (this: WorktreeManager, ...args) {
      await new Promise<void>(resolve => { release = resolve; });
      return original.apply(this, args);
    });
    let execution: Promise<unknown> | undefined;
    try {
      await h.runtime.start();
      execution = h.runtime.executeCurrentPlan(h.items[0].workItemId);
      void execution.catch(() => undefined);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      h.options.autoExecuteReady = true;
      await h.runtime.drainOnce();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(h.agent.startedWorkItems).toEqual([]);
      release();
      await vi.waitFor(() => expect(h.agent.startedWorkItems).toContain(h.items[0].workItemId));
      h.agent.resolve(h.items[0].workItemId, "fail");
      await execution;
      await vi.waitFor(() => expect(h.agent.startedWorkItems).toContain(h.items[1].workItemId));
    } finally {
      release?.(); h.agent.releaseAll(); await execution?.catch(() => undefined); await h.runtime.stop(); prepare.mockRestore();
    }
  });

  it.each(["cancel", "new_plan"] as const)("does not publish an old preparation failure after %s", async (change) => {
    const root = temporaryDirectory();
    const repo = createRepository(root, `late-failure-${change}`);
    const h = createHarness([repo]);
    let fail: ((error: Error) => void) | undefined;
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const service = startCollaborationService({ dataDirectory: h.options.dataDirectory,
      planning: { planner: h.options.planner!, policy: h.options.planningPolicy! } });
    const db = new DatabaseSync(h.databaseFile);
    await h.runtime.start();
    try {
      await waitFor(() => Boolean(fail), "preparation did not start");
      if (change === "cancel") {
        service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: Date.now() });
        expect(service.performDirectOwnerAction({ sourceEventId: "cancel-pending", action: "cancel", workItemId: h.items[0].workItemId,
          sender: inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender, now: Date.now() }).allowed).toBe(true);
      } else {
        service.reviseWorkItemDefinition(h.items[0].workItemId, { goal: "按更新后的需求修改", goalConfirmed: true,
          repository: repo.path, acceptanceConditions: [{ description: "新需求完成", observation: "pnpm test target" }], blockingAmbiguities: [] }, Date.now());
        expect(db.prepare("SELECT current_plan_revision FROM collaboration_work_items WHERE id=?").get(h.items[0].workItemId)).toEqual({ current_plan_revision: 2 });
      }
      fail!(new Error("late preparation failure"));
      await expectNotStarted(h.agent, h.items[0].workItemId);
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_outbox WHERE source_event_id=?").get(`execution:${h.items[0].workItemId}:plan:1:failed`)).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_preparation_results").get()).toEqual({ count: 0 });
    } finally { fail?.(new Error("fixture cleanup")); prepare.mockRestore(); service.close(); db.close(); await stopHarness(h); }
  });
  it("refuses Owner retry when preparation process cleanup could not be confirmed", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "unsettled-preparation")]);
    h.options.execution!.limits.maxAttempts = 3;
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockRejectedValue(new CommandCleanupError(new Error("fixture")));
    const db = new DatabaseSync(h.databaseFile);
    await h.runtime.start();
    try {
      await waitFor(() => Boolean(db.prepare("SELECT 1 FROM collaboration_execution_preparation_results").get()), "missing unsettled result");
      expect(db.prepare("SELECT state FROM collaboration_execution_preparation_results").get()).toEqual({ state: "unsettled" });
      const service = startCollaborationService({ dataDirectory: h.options.dataDirectory });
      service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: Date.now() });
      expect(service.performDirectOwnerAction({ sourceEventId: "unsafe-cleanup-retry", action: "retry", workItemId: h.items[0].workItemId,
        sender: inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender, now: Date.now() }).allowed).toBe(false);
      service.close();
      expect(h.agent.startedWorkItems).toEqual([]);
    } finally { prepare.mockRestore(); db.close(); await stopHarness(h); }
  });
  it("does not publish an interrupted-preparation notice over a cancelled task", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "cancelled-preparation")]);
    const db = new DatabaseSync(h.databaseFile);
    db.prepare("INSERT INTO collaboration_execution_dispatches (work_item_id,plan_revision,attempt,instance_owner,instance_fence,created_at) VALUES (?,1,1,'dead-instance',1,1)").run(h.items[0].workItemId);
    db.prepare("UPDATE collaboration_work_items SET status='cancelled',control_state='cancelled' WHERE id=?").run(h.items[0].workItemId);
    await h.runtime.start();
    try {
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_preparation_results").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_outbox WHERE source_event_id LIKE 'execution-preparation:%'").get()).toEqual({ count: 0 });
    } finally { db.close(); await stopHarness(h); }
  });
  it("consumes each Owner retry once and stops after three preparation failures", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "three-preparation-failures");
    const h = createHarness([repo]);
    h.options.execution!.limits.maxAttempts = 3;
    h.options.execution!.repositories = { [repo.path]: { ...h.options.execution!.repositories[repo.path], baseSha: "0".repeat(40) } };
    const service = startCollaborationService({ dataDirectory: h.options.dataDirectory });
    service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: Date.now() });
    service.close();
    const db = new DatabaseSync(h.databaseFile);
    await h.runtime.start();
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await waitFor(() => Number((db.prepare("SELECT count(*) AS count FROM collaboration_execution_preparation_results").get() as { count: number }).count) === attempt, "preparation did not settle");
        await h.runtime.drainOnce(); await h.runtime.drainOnce();
        expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get()).toEqual({ count: attempt });
        const command = { transportEventId: `retry-${attempt}`, transportMessageId: `transport-retry-${attempt}`,
          command: "retry" as const, workItemId: h.items[0].workItemId,
          sender: inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender, receivedAt: Date.now() };
        expect(h.runtime.performDingTalkOwnerTextCommand(command).allowed).toBe(attempt < 3);
        expect(h.runtime.performDingTalkOwnerTextCommand(command)).toMatchObject({ allowed: attempt < 3, duplicate: true });
      }
      expect(h.agent.startedWorkItems).toEqual([]);
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_outbox WHERE source_event_id LIKE 'execution-preparation:%'").get()).toEqual({ count: 3 });
      expect(() => db.prepare("UPDATE collaboration_execution_preparation_results SET state='interrupted'").run()).toThrow("immutable");
    } finally { db.close(); await stopHarness(h); }
  });

  it("will not turn a running Agent into a retryable preparation failure", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "running-is-not-preparation")]);
    const db = new DatabaseSync(h.databaseFile);
    await h.runtime.start();
    try {
      await waitFor(() => h.agent.startedWorkItems.length === 1, "agent not started");
      const lease = currentInstanceLease(db)!;
      expect(recordPreparationResult(db, { workItemId: h.items[0].workItemId, planRevision: 1, attempt: 1,
        state: "failed", lease, maxAttempts: 3, now: Date.now() })).toBe(false);
      expect(() => recordPreparationResult(db, { workItemId: h.items[0].workItemId, planRevision: 1, attempt: 1,
        state: "failed", lease: { ...lease, fence: lease.fence + 1 }, maxAttempts: 3, now: Date.now() })).toThrow("stale");
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_preparation_results").get()).toEqual({ count: 0 });
    } finally { db.close(); await stopHarness(h); }
  });

  it("upgrades the previous dispatch schema without losing a waiting preparation", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "schema-15-preparation")]);
    const db = new DatabaseSync(h.databaseFile);
    // Reconstruct the exact v15 delta in this disposable fixture only.
    for (const kind of ["execution", "verification"]) {
      for (const table of ["commands", "proofs"]) db.exec(`DROP TRIGGER ${kind}_${table}_finalizing`);
      db.exec(`DROP TABLE collaboration_${kind}_finalization_intents`);
    }
    for(const table of ["proofs","commands","settlements","sessions"]) db.exec(`DROP TABLE collaboration_execution_${table}`);
    for(const table of ["proofs","commands","settlements","sessions"]) db.exec(`DROP TABLE collaboration_verification_${table}`);
    db.exec("DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DROP TABLE collaboration_acceptance_mapping_results; DROP TABLE collaboration_acceptance_mapping_attempts; DROP INDEX collaboration_outbox_delivery_sequence; ALTER TABLE collaboration_outbox DROP COLUMN delivery_sequence; DROP TABLE collaboration_sent_association_choices; DROP TABLE collaboration_execution_preparation_results; DELETE FROM collaboration_schema_migrations WHERE version>=16; PRAGMA user_version=15");
    db.prepare("INSERT INTO collaboration_execution_dispatches (work_item_id,plan_revision,attempt,instance_owner,instance_fence,created_at) VALUES (?,1,1,'dead-instance',1,1)").run(h.items[0].workItemId);
    const original = db.prepare("SELECT * FROM collaboration_execution_dispatches").get();
    await h.runtime.start();
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 31 });
      expect(db.prepare("SELECT * FROM collaboration_execution_dispatches").get()).toEqual(original);
      expect(db.prepare("SELECT state FROM collaboration_execution_preparation_results").get()).toEqual({ state: "interrupted" });
    } finally { db.close(); await stopHarness(h); }
  });
  it("notifies once about an orphan preparation without silently retrying it", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "orphan-dispatch")]);
    const db = new DatabaseSync(h.databaseFile);
    db.prepare("INSERT INTO collaboration_execution_dispatches (work_item_id,plan_revision,attempt,instance_owner,instance_fence,created_at) VALUES (?,1,1,'dead-instance',1,1)").run(h.items[0].workItemId);
    for (let i = 0; i < 2; i++) {
      const runtime = new CollaborationHeadlessRuntime(h.options);
      try { await runtime.start(); await runtime.drainOnce(); } finally { await runtime.stop(); }
    }
    expect(h.agent.startedWorkItems).toEqual([]);
    const messages = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE 'execution-preparation:%'").all() as Array<{ payload_json: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].payload_json).toContain("中断");
    expect(db.prepare("SELECT state FROM collaboration_execution_preparation_results").get()).toEqual({ state: "interrupted" });
    const service = startCollaborationService({ dataDirectory: h.options.dataDirectory });
    service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: Date.now() });
    expect(service.performDirectOwnerAction({ sourceEventId: "unsafe-orphan-retry", action: "retry", workItemId: h.items[0].workItemId,
      sender: inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender, now: Date.now() }).allowed).toBe(false);
    service.close();
    db.close();
  });

  it("requires a fresh Owner retry after a settled preparation failure and recovers that authorization after restart", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "owner-preparation-retry");
    const h = createHarness([repo]);
    h.options.execution!.limits.maxAttempts = 3;
    const repositories = h.options.execution!.repositories;
    h.options.execution!.repositories = { [repo.path]: { ...repositories[repo.path], baseSha: "0".repeat(40) } };
    const db = new DatabaseSync(h.databaseFile);
    await h.runtime.start();
    const service = startCollaborationService({ dataDirectory: h.options.dataDirectory });
    try {
      await waitFor(() => Boolean(db.prepare("SELECT 1 FROM collaboration_execution_preparation_results WHERE state='failed'").get()), "failure not recorded");
      await h.runtime.drainOnce(); await h.runtime.drainOnce();
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get()).toEqual({ count: 1 });
      service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "owner", now: Date.now() });
      const sender = inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender;
      const command = { sourceEventId: "retry-preparation", action: "retry" as const, workItemId: h.items[0].workItemId, sender, now: Date.now() };
      expect(service.performDirectOwnerAction(command).allowed).toBe(false);
      const authorized = { ...command, sourceEventId: "owner-retry-preparation", sender: { ...sender, senderStaffId: "owner" } };
      expect(service.performDirectOwnerAction(authorized)).toMatchObject({ allowed: true, duplicate: false });
      expect(service.performDirectOwnerAction(authorized)).toMatchObject({ allowed: true, duplicate: true });
      // Crash boundary: the durable Owner decision exists but scheduling has not occurred.
      await stopHarness(h);
      const agent = new DeferredAgent();
      const runtime = new CollaborationHeadlessRuntime({ ...h.options, agent,
        execution: { ...h.options.execution!, repositories } });
      try {
        await runtime.start();
        await waitFor(() => agent.startedWorkItems.length === 1, "authorized retry was lost");
        await runtime.drainOnce();
        expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get()).toEqual({ count: 2 });
      } finally { agent.releaseAll(); await runtime.stop(); }
    } finally { service.close(); db.close(); await stopHarness(h); }
  });
  it("recovers work after genuine Owner pause and resume without accepting unprojected contributions", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "owner-resume");
    const h = createHarness([repo, repo]);
    const service = startCollaborationService({ dataDirectory: h.options.dataDirectory });
    service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: Date.now() });
    const sender = inbound({ sourceEventId: "sender", conversationId: "group", text: "" }).sender;
    for (const action of ["pause", "resume"] as const) {
      const result = service.performDirectOwnerAction({ sourceEventId: `owner-${action}`, action,
        workItemId: h.items[0].workItemId, sender, now: Date.now() });
      expect(result).toMatchObject({ allowed: true, reason: "owner_action_applied" });
    }
    service.close();
    const db = new DatabaseSync(h.databaseFile);
    // Models the durable contribution / Spec projection crash boundary.
    db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(h.items[1].workItemId);
    db.close();
    await h.runtime.start();
    try {
      await waitFor(() => h.agent.startedWorkItems.includes(h.items[0].workItemId), "Owner-resumed task was lost");
      h.agent.resolve(h.items[0].workItemId, "complete");
      await expectNotStarted(h.agent, h.items[1].workItemId);
    } finally { await stopHarness(h); }
  });
  it("honors disabled automatic execution and probe-only startup", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "no-auto")]);
    for (const extra of [{ autoExecuteReady: false }, { probeOnly: true }]) {
      const runtime = new CollaborationHeadlessRuntime({ ...h.options, ...extra });
      try {
        await runtime.start();
        if (!extra.probeOnly) await runtime.drainOnce();
        await expectNotStarted(h.agent, h.items[0].workItemId);
        const db = new DatabaseSync(h.databaseFile);
        expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get()).toEqual({ count: 0 });
        db.close();
      } finally { await runtime.stop(); }
    }
  });

  it("defers recovery while disk-gated and starts it after healthy maintenance", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "disk-gated")]);
    const db = new DatabaseSync(h.databaseFile);
    db.prepare("UPDATE collaboration_runtime_state SET low_disk=1 WHERE singleton=1").run();
    await h.runtime.start();
    try {
      await expectNotStarted(h.agent, h.items[0].workItemId);
      db.prepare("UPDATE collaboration_runtime_state SET low_disk=0 WHERE singleton=1").run();
      await h.runtime.drainOnce();
      await waitFor(() => h.agent.startedWorkItems.length === 1, "healthy maintenance did not restore work");
    } finally { db.close(); await stopHarness(h); }
  });
  it("restores ready never-started work at startup without a new group message", async () => {
    const root = temporaryDirectory();
    const h = createHarness([createRepository(root, "startup")]);
    await h.runtime.start();
    try {
      await waitFor(() => h.agent.startedWorkItems.includes(h.items[0].workItemId), "persisted ready task was lost");
      await h.runtime.drainOnce(); await h.runtime.drainOnce();
      expect(h.agent.startedWorkItems).toEqual([h.items[0].workItemId]);
    } finally { await stopHarness(h); }
  });

  it("recovers the waiting sibling after shutdown without retrying the interrupted task", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "restart-queue");
    const h = createHarness([repo, repo]);
    await h.runtime.start();
    try {
      await waitFor(() => h.agent.startedWorkItems.includes(h.items[0].workItemId), "first task did not start");
      await expectNotStarted(h.agent, h.items[1].workItemId);
      await stopHarness(h);
      const agent = new DeferredAgent();
      const runtime = new CollaborationHeadlessRuntime({ ...h.options, agent });
      try {
        await runtime.start();
        await waitFor(() => agent.startedWorkItems.includes(h.items[1].workItemId), "waiting sibling was not recovered");
        expect(agent.startedWorkItems).toEqual([h.items[1].workItemId]);
      } finally { agent.releaseAll(); await runtime.stop(); }
    } finally { await stopHarness(h); }
  });

  it("does not restart paused work or a paused modify node", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "paused-queue");
    const h = createHarness([repo, repo, repo]);
    const db = new DatabaseSync(h.databaseFile);
    db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(h.items[0].workItemId);
    db.prepare("UPDATE collaboration_work_nodes SET control_state='paused' WHERE work_item_id=? AND node_type='modify'").run(h.items[1].workItemId);
    db.close();
    await h.runtime.start();
    try {
      await waitFor(() => h.agent.startedWorkItems.includes(h.items[2].workItemId), "eligible task behind paused work did not start");
      expect(h.agent.startedWorkItems).toEqual([h.items[2].workItemId]);
    } finally { await stopHarness(h); }
  });

  it("persists a pre-run dispatch attempt so preparation failures do not repeat on every drain or restart", async () => {
    const root = temporaryDirectory();
    const repo = createRepository(root, "preparation-failure");
    const h = createHarness([repo]);
    // A wrong trusted base SHA fails preparation before an Agent or collaboration_run can start.
    h.options.execution!.repositories = { ...h.options.execution!.repositories,
      [repo.path]: { ...h.options.execution!.repositories[repo.path], baseSha: "0".repeat(40) } };
    await h.runtime.start();
    const db = new DatabaseSync(h.databaseFile);
    try {
      await waitFor(() => Number((db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get() as { count: number }).count) === 1, "dispatch was not durably reserved");
      await h.runtime.drainOnce(); await h.runtime.drainOnce();
      await stopHarness(h);
      const next = new CollaborationHeadlessRuntime(h.options);
      try { await next.start(); await next.drainOnce(); } finally { await next.stop(); }
      expect(h.agent.startedWorkItems).toEqual([]);
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_execution_dispatches").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM collaboration_runs").get()).toEqual({ count: 0 });
      expect(() => db.prepare("DELETE FROM collaboration_execution_dispatches").run()).toThrow("immutable");
    } finally { db.close(); await stopHarness(h); }
  });
  it("does not start a second ready Work Item until the first execution for the same repository ends", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root, "shared-repository");
    const harness = createHarness([repository, repository]);
    const [first, second] = harness.items;
    await harness.runtime.start();
    try {
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first Work Item did not start");

      await expectNotStarted(harness.agent, second.workItemId);

      harness.agent.resolve(first.workItemId, "complete");
      await waitFor(() => harness.agent.startedWorkItems.includes(second.workItemId), "queued Work Item did not start");
      expect(harness.agent.startedWorkItems).toEqual([first.workItemId, second.workItemId]);
      harness.agent.resolve(second.workItemId, "complete");
    } finally {
      await stopHarness(harness);
    }
  });

  it("allows ready Work Items for different repositories to execute concurrently", async () => {
    const root = temporaryDirectory();
    const firstRepository = createRepository(root, "repository-a");
    const secondRepository = createRepository(root, "repository-b");
    const harness = createHarness([firstRepository, secondRepository]);
    const [first, second] = harness.items;
    await harness.runtime.start();
    try {
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first repository did not start");

      await waitFor(
        () => harness.agent.startedWorkItems.includes(second.workItemId),
        "different repository was incorrectly serialized",
      );
      // Different repositories prepare concurrently; neither start order is
      // guaranteed. Both must start exactly once before either is released.
      expect([...harness.agent.startedWorkItems].sort()).toEqual([first.workItemId, second.workItemId].sort());
      harness.agent.resolve(first.workItemId, "complete");
      harness.agent.resolve(second.workItemId, "complete");
    } finally {
      await stopHarness(harness);
    }
  });

  it("releases the repository queue when the preceding execution fails", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root, "failure-repository");
    const harness = createHarness([repository, repository]);
    const [first, second] = harness.items;
    await harness.runtime.start();
    try {
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first Work Item did not start");

      await expectNotStarted(harness.agent, second.workItemId);

      harness.agent.resolve(first.workItemId, "fail");
      await waitFor(() => harness.agent.startedWorkItems.includes(second.workItemId), "failure did not release queue");
      expect(harness.agent.startedWorkItems).toEqual([first.workItemId, second.workItemId]);
      harness.agent.resolve(second.workItemId, "complete");
    } finally {
      await stopHarness(harness);
    }
  });
});
