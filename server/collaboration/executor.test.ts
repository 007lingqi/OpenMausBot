import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateExecutor, type CandidateExecutorOptions } from "./executor.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { currentInstanceLease } from "./leases.ts";
import { CommandCleanupError } from "./execution-limits.ts";
import { ExecutionLifecycle } from "./execution-lifecycle.ts";
import { reserveVerification, settleVerification } from "./verification-lifecycle.ts";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage, DingTalkSender } from "../integrations/dingtalk/types.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
  type ContainmentInspection,
} from "./containment.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "./provider-runner.ts";
import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
  TargetCommandSpec,
} from "./quality-gate.ts";
import { startCollaborationService } from "./service.ts";

const scratch: string[] = [];

const VERIFIED_PROOF: ContainmentProof = {
  identity: {
    backend: "test_verified_runtime",
    opaqueId: "opaque-runtime-identity-0001",
    hostGeneration: "test-host-generation-1",
    verifierVersion: "test-verifier-v1",
  },
  receipt: "independent-test-receipt",
};

class FakeContainment implements ContainmentPort {
  async verifyProof(proof: ContainmentProof, expectedBinding: ContainmentBinding) {
    const bindingHash = containmentBindingHash(expectedBinding);
    return proof.receipt === bindingHash
      ? { verified: true as const, fingerprint: runtimeIdentityFingerprint(proof.identity), bindingHash }
      : { verified: false as const, reason: "unverified" };
  }

  async inspect(identity: ContainmentProof["identity"]): Promise<ContainmentInspection> {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }

  async terminateAndWaitEmpty(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-candidate-"));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  writeFileSync(join(repo, "src", "value.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  return repo;
}

function inbound(): DingTalkInboundMessage {
  return {
    sourceEventId: "candidate-event-1",
    transportMessageId: "candidate-transport-1",
    conversationId: "candidate-conversation-1",
    addressedToBot: true,
    text: "更新 fixture value",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "staff-1",
      senderId: "sender-1",
      displayName: "Contributor",
    },
    receivedAt: 1_000,
  };
}

function ownerSender(): DingTalkSender {
  return {
    senderCorpId: "corp-1",
    senderStaffId: "owner-1",
    senderId: "owner-sender-1",
    displayName: "Owner",
  };
}

class FakeAgent implements AgentRunPort {
  interrupted: string[] = [];

  constructor(private readonly operation: (request: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.registerContainment(proofForBinding(request.containmentBinding));
    return await this.operation(request);
  }

  async interrupt(runId: string): Promise<void> {
    this.interrupted.push(runId);
  }
}

function sandboxedResult(request: SandboxedCommandRequest): SandboxedCommandResult {
  const explicitExit = request.argv.join("\0").match(/process\.exit\((\d+)\)/u);
  const exitCode = explicitExit ? Number(explicitExit[1]) : 0;
  return {
    exitCode,
    stdout: Buffer.from(exitCode === 0 ? "sandboxed target passed\n" : ""),
    stderr: Buffer.from(exitCode === 0 ? "" : `sandboxed target failed: ${exitCode}\n`),
    durationMs: 5,
    timedOut: false,
    outputLimitExceeded: false,
    attestation: {
      sandboxEnforced: true,
      writableRoot: request.sandbox.writableRoot,
      deniedPaths: [...request.sandbox.deniedPaths],
      network: "deny",
      processIsolated: true,
      processTreeReaped: true,
      containmentProof: proofForBinding(request.containmentBinding),
    },
  };
}

class FakeSandboxedCommandRunner implements SandboxedCommandRunner {
  readonly requests: SandboxedCommandRequest[] = [];

  constructor(
    private readonly operation: (request: SandboxedCommandRequest) => SandboxedCommandResult = sandboxedResult,
  ) {}

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    this.requests.push(request);
    await request.registerContainment(proofForBinding(request.containmentBinding));
    return this.operation(request);
  }
}

function completed(request: AgentRunRequest): AgentRunResult {
  return {
    threadId: request.threadId,
    turnId: request.turnId,
    status: "completed",
    sandboxEnforced: true,
    containmentProof: proofForBinding(request.containmentBinding),
  };
}

function proofForBinding(binding: ContainmentBinding): ContainmentProof {
  return { ...VERIFIED_PROOF, receipt: containmentBindingHash(binding) };
}

function targetCommand(exitCode = 0): TargetCommandSpec {
  return {
    argv: [
      process.execPath,
      "-e",
      exitCode === 0
        ? "const fs=require('fs');process.exit(fs.readFileSync('src/value.txt','utf8')==='after\\n'?0:2)"
        : `process.exit(${exitCode})`,
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
  };
}

function setup(input: {
  agent: AgentRunPort;
  commands?: Record<string, TargetCommandSpec>;
  commandRunner?: SandboxedCommandRunner | null;
  containment?: ContainmentPort;
}) {
  const root = temp();
  const repo = repository(root);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "local-notes.txt"), "original untracked sentinel\n");
  const originalStatus = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo });
  const commandRunner =
    input.commandRunner === null
      ? (undefined as unknown as SandboxedCommandRunner)
      : (input.commandRunner ?? new FakeSandboxedCommandRunner());
  const execution: CandidateExecutorOptions = {
      agent: input.agent,
      containment: input.containment ?? new FakeContainment(),
      commandRunner,
      managedWorktreeRoot: join(root, "managed-worktrees"),
      repositories: {
        [repo]: { baseSha, targetCommands: input.commands ?? { "pnpm test target": targetCommand() } },
      },
      limits: { maxAttempts: 1, agentTimeoutMs: 2_000, maxAgentEventBytes: 16_000, interruptGraceMs: 500 },
    };
  const service = startCollaborationService({
    dataDirectory: join(root, "data"),
    planning: {
      planner: { propose: () => validProposal() },
      policy: { ...policy, allowedRepositories: [repo] },
    },
    execution,
  });
  service.bootstrapOwnerLocally({ senderCorpId: "corp-1", senderStaffId: "owner-1", now: 500 });
  const accepted = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event)).receive(inbound());
  if (!accepted.accepted || !accepted.workItemId) throw new Error("Expected Work Item");
  service.reviseWorkItemDefinition(
    accepted.workItemId,
    {
      goal: "将 fixture value 更新为 after",
      goalConfirmed: true,
      repository: repo,
      acceptanceConditions: [{ description: "value 已更新", observation: "target command 读取 after" }],
      blockingAmbiguities: [],
    },
    2_000,
  );
  return { root, repo, baseSha, originalStatus, service, commandRunner, execution, workItemId: accepted.workItemId };
}

function ledger(root: string): DatabaseSync {
  return new DatabaseSync(join(root, "data", "collaboration", "collaboration.sqlite"));
}

describe("trusted candidate executor", () => {
  it("rejects an old ready plan with unread online material before reserving or running work", async () => {
    const run = vi.fn((request: AgentRunRequest) => completed(request));
    const h = setup({ agent: new FakeAgent(run) }); const db = ledger(h.root);
    const executor = new CandidateExecutor(join(h.root, "data", "collaboration", "collaboration.sqlite"), h.execution);
    try {
      // Model a pre-reader ledger: source contains a document but its published snapshot has no gate.
      db.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE work_item_id=?")
        .run(JSON.stringify({ text: "按 https://alidocs.dingtalk.com/i/nodes/legacy 修复" }), h.workItemId);
      await expect(executor.executeCurrentPlan(h.workItemId)).rejects.toThrow("plan_materials_incomplete");
      expect(run).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_sessions").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_runs").get()).toEqual({ n: 0 });
    } finally { executor.close(); h.service.close(); db.close(); }
  });
  it("does not commit a late result when material becomes incomplete during execution", async () => {
    let db!: DatabaseSync; let id = "";
    const h = setup({ agent: new FakeAgent(request => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      db.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE work_item_id=?")
        .run(JSON.stringify({ text: "按 https://alidocs.dingtalk.com/i/nodes/late 修复" }), id);
      return completed(request);
    }) }); db = ledger(h.root); id = h.workItemId;
    try { const result = await h.service.executeCurrentPlan(id);
      expect(result.report.reasons).toContain("plan_materials_incomplete");
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_candidates WHERE result_sha IS NOT NULL").get()).toEqual({ n: 0 });
    } finally { h.service.close(); db.close(); }
  });
  it("persists repository ownership before preparation and blocks a second executor using the same lease", async () => {
    const h = setup({ agent: new FakeAgent(request => ({ ...completed(request), status: "failed" })) });
    const db = ledger(h.root);
    let release!: () => void;
    const original = WorktreeManager.prototype.prepare;
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockImplementationOnce(async function (this: WorktreeManager, ...args) {
      await new Promise<void>(resolve => { release = resolve; });
      return original.apply(this, args);
    });
    const pending = h.service.executeCurrentPlan(h.workItemId);
    void pending.catch(() => undefined);
    let other: CandidateExecutor | undefined;
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_sessions").get()).toEqual({ n: 1 });
      const lease = currentInstanceLease(db)!;
      const sibling = h.service.ingestDingTalkMessage({ ...inbound(), sourceEventId: "sibling-execution", transportMessageId: "sibling-transport", conversationId: "sibling-conversation" });
      if (!sibling.workItemId) throw new Error("Expected sibling Work Item");
      h.service.reviseWorkItemDefinition(sibling.workItemId, {
        goal: "同仓库的另一个修改", goalConfirmed: true, repository: h.repo,
        acceptanceConditions: [{ description: "另一个值已更新", observation: "pnpm test target" }], blockingAmbiguities: [],
      });
      other = new CandidateExecutor(join(h.root, "data", "collaboration", "collaboration.sqlite"), {
        ...h.execution, scheduler: { ownerId: lease.ownerId, leaseTtlMs: 60000 },
      });
      await expect(other.executeCurrentPlan(h.workItemId)).rejects.toThrow("execution_repository_unsettled");
      await expect(other.executeCurrentPlan(sibling.workItemId)).rejects.toThrow("execution_repository_unsettled");
      const childResult = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
        const { CandidateExecutor } = await import(process.argv[1]);
        const fail = () => { throw new Error('child_must_not_execute'); };
        const executor = new CandidateExecutor(process.argv[2], {
          ...JSON.parse(process.argv[3]), agent: {run:fail, interrupt:fail}, commandRunner:{run:fail},
          containment:{verifyProof:fail,inspect:fail,terminateAndWaitEmpty:fail},
        });
        try {
          await executor.executeCurrentPlan(process.argv[4]);
          throw new Error('child_execution_was_not_blocked');
        } catch(error) {
          if (error.message !== 'execution_repository_unsettled') throw error;
          console.log('repository_blocked');
        }
      `, new URL("./executor.ts", import.meta.url).href,
      join(h.root, "data", "collaboration", "collaboration.sqlite"), JSON.stringify({
        managedWorktreeRoot: h.execution.managedWorktreeRoot, repositories: h.execution.repositories,
        limits: h.execution.limits, scheduler: { ownerId: lease.ownerId, leaseTtlMs: 60000 },
      }), sibling.workItemId], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
      expect(childResult.trim()).toBe("repository_blocked");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(() => db.exec("DELETE FROM collaboration_execution_sessions")).toThrow("immutable");
      release(); await pending;
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 1 });
    } finally { release?.(); await pending.catch(() => undefined); other?.close(); h.service.close(); db.close(); prepare.mockRestore(); }
  });

  it("does not settle a failed Agent whose processes are still present", async () => {
    const containment = new FakeContainment();
    containment.inspect = async identity => ({ state: "active", fingerprint: runtimeIdentityFingerprint(identity) });
    const h = setup({ containment, agent: new FakeAgent(request => ({ ...completed(request), status: "failed" })) });
    try {
      await expect(h.service.executeCurrentPlan(h.workItemId)).rejects.toThrow(CommandCleanupError);
      const db = ledger(h.root);
      try {
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_proofs").get()).toEqual({ n: 1 });
        await expect(h.service.executeCurrentPlan(h.workItemId)).rejects.toThrow("execution_repository_unsettled");
      } finally { db.close(); }
    } finally { h.service.close(); }
  });

  it("makes durable modification and verification reservations mutually exclusive", async () => {
    const h = setup({ agent: new FakeAgent(request => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n"); return completed(request);
    }) });
    const db = ledger(h.root);
    try {
      const candidate = await h.service.executeCurrentPlan(h.workItemId);
      const lease = currentInstanceLease(db)!;
      const execution = new ExecutionLifecycle(db, "pending-modification", lease);
      execution.reserve({ workItemId: h.workItemId, planRevision: 1, repository: h.repo, baseSha: h.baseSha, attempt: 2 });
      expect(() => reserveVerification(db, candidate.runId, lease, Date.now())).toThrow("execution_repository_unsettled");
      expect(await execution.settle(new FakeContainment())).toBe(true);
      const verification = reserveVerification(db, candidate.runId, lease, Date.now());
      const prepare = vi.spyOn(WorktreeManager.prototype, "prepare");
      try {
        await expect(h.service.executeCurrentPlan(h.workItemId)).rejects.toThrow("execution_repository_unsettled");
        expect(prepare).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); }
      expect(await settleVerification(db, verification, lease, new FakeContainment(), Date.now, () => true)).toBe(true);
    } finally { h.service.close(); db.close(); }
  });

  it("retains repository ownership when developer self-test process cleanup is unknown", async () => {
    const h = setup({ agent: new FakeAgent(request => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n"); return completed(request);
    }), commandRunner: { async run() { throw new CommandCleanupError(new Error("self-test cleanup unknown")); } } });
    try {
      await expect(h.service.executeCurrentPlan(h.workItemId)).rejects.toThrow(CommandCleanupError);
      const db = ledger(h.root);
      try {
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_commands").get()).toEqual({ n: 2 });
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 0 });
        await expect(h.service.executeCurrentPlan(h.workItemId)).rejects.toThrow("execution_repository_unsettled");
      } finally { db.close(); }
      h.service.close();
      const replacement = new CandidateExecutor(join(h.root, "data", "collaboration", "collaboration.sqlite"), h.execution);
      try {
        await expect(replacement.executeCurrentPlan(h.workItemId)).rejects.toThrow("execution_repository_unsettled");
      } finally { replacement.close(); }
    } finally { h.service.close(); }
  });

  it("creates a traceable local candidate and exact target-test evidence without touching the original worktree", async () => {
    const agent = new FakeAgent((request) => {
      expect(request.capabilities).toEqual({
        network: false,
        dependencyInstallation: false,
        arbitraryCommands: false,
        gitCommit: false,
      });
      expect(request.sandbox).toMatchObject({ filesystemRoot: request.cwd, denyGitMetadata: true, network: "deny" });
      request.emit({ threadId: "late-thread", turnId: request.turnId, type: "progress", message: "ignore me" });
      request.emit({ threadId: request.threadId, turnId: request.turnId, type: "progress", message: "editing" });
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId, 1, 3_000);
    expect(result).toMatchObject({
      workItemId: harness.workItemId,
      baseSha: harness.baseSha,
      changedPaths: ["src/value.txt"],
      report: {
        state: "target_tests_passed",
        targetTestsPassed: true,
        fullGatePassed: false,
        label: "目标测试通过；完整门禁未执行",
      },
    });
    expect(result.resultSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(git(harness.repo, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
    expect(execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: harness.repo })).toEqual(
      harness.originalStatus,
    );
    expect(readFileSync(join(harness.repo, "local-notes.txt"), "utf8")).toBe("original untracked sentinel\n");
    expect(git(result.worktreePath, ["show", "-s", "--format=%an <%ae>", result.resultSha!])).toBe(
      "OpenMausBot <bot@local.invalid>",
    );
    const body = git(result.worktreePath, ["show", "-s", "--format=%B", result.resultSha!]);
    expect(body).toContain(`Work-Item: ${harness.workItemId}`);
    expect(body).toContain(`Base-SHA: ${harness.baseSha}`);
    expect(git(result.worktreePath, ["rev-parse", `${result.resultSha}^`])).toBe(harness.baseSha);
    expect(harness.commandRunner).toBeInstanceOf(FakeSandboxedCommandRunner);
    const requests = (harness.commandRunner as FakeSandboxedCommandRunner).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ commandId: "pnpm test target", cwd: result.worktreePath });
    expect(requests[0].sandbox).toEqual({
      writableRoot: result.worktreePath,
      deniedPaths: [
        realpathSync(join(harness.repo, ".git")),
        realpathSync(harness.repo),
        realpathSync(join(harness.root, "data", "collaboration")),
      ].sort(),
      network: "deny",
    });
    harness.service.close();

    const db = ledger(harness.root);
    expect(db.prepare("SELECT base_sha, result_sha, status FROM collaboration_runs").get()).toEqual({
      base_sha: harness.baseSha,
      result_sha: result.resultSha,
      status: "succeeded",
    });
    expect(db.prepare("SELECT state, exit_code FROM collaboration_test_evidence").get()).toEqual({
      state: "target_passed",
      exit_code: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_run_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_audit_events WHERE run_id IS NOT NULL").get()).toEqual({
      count: 3,
    });
    expect(() => db.prepare("UPDATE collaboration_candidates SET state = 'invalid'").run()).toThrow(
      "candidate attempts are immutable",
    );
    expect(() => db.prepare("DELETE FROM collaboration_test_evidence").run()).toThrow("test evidence is immutable");
    db.close();
  });

  it("rejects ignored denied files before creating a commit", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, ".env.secret"), "do-not-commit\n");
      return completed(request);
    });
    const harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result).toMatchObject({ resultSha: null, report: { state: "invalid" } });
    expect(result.report.reasons.join(" ")).toMatch(/denied_path|outside_claim/u);
    expect(git(result.worktreePath, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
    expect(readFileSync(join(result.worktreePath, ".env.secret"), "utf8")).toBe("do-not-commit\n");
    harness.service.close();
  });

  it("rejects out-of-claim changes and unexpected Agent commits", async () => {
    const outside = new FakeAgent((request) => {
      mkdirSync(join(request.cwd, "docs"));
      writeFileSync(join(request.cwd, "docs", "outside.md"), "outside\n");
      return completed(request);
    });
    const first = setup({ agent: outside });
    const rejected = await first.service.executeCurrentPlan(first.workItemId);
    expect(rejected.report.reasons).toContain("docs/outside.md: outside_claim");
    first.service.close();

    const committing = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      git(request.cwd, ["add", "."]);
      git(request.cwd, ["-c", "user.name=Bad", "-c", "user.email=bad@example.invalid", "commit", "-m", "agent commit"]);
      return completed(request);
    });
    const second = setup({ agent: committing });
    const unexpected = await second.service.executeCurrentPlan(second.workItemId);
    expect(unexpected).toMatchObject({ resultSha: null, report: { state: "invalid" } });
    expect(unexpected.report.reasons).toContain("unexpected_agent_commit");
    second.service.close();
  });

  it("preserves candidate but reports target failure without claiming a full gate", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const harness = setup({ agent, commands: { "pnpm test target": targetCommand(7) } });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result.resultSha).not.toBeNull();
    expect(result.report).toMatchObject({ state: "test_failed", targetTestsPassed: false, fullGatePassed: false });
    expect(result.evidence[0]).toMatchObject({ state: "failed", exitCode: 7 });
    harness.service.close();
  });

  it("stops for configuration when network, install, sandbox, or command configuration is unavailable", async () => {
    const network = new FakeAgent((request) => ({
      threadId: request.threadId,
      turnId: request.turnId,
      status: "needs_configuration",
      need: "network",
      sandboxEnforced: true,
    }));
    const first = setup({ agent: network });
    expect(await first.service.executeCurrentPlan(first.workItemId)).toMatchObject({
      resultSha: null,
      report: { state: "needs_configuration", reasons: ["network"] },
    });
    first.service.close();

    const edit = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const second = setup({ agent: edit, commands: {} });
    const missing = await second.service.executeCurrentPlan(second.workItemId);
    expect(missing.resultSha).not.toBeNull();
    expect(missing.report).toMatchObject({ state: "needs_configuration" });
    expect(missing.report.reasons).toContain("missing command: pnpm test target");
    second.service.close();
  });

  it("keeps a rejected Agent launch with no process proof fenced even when the Run is terminal", async () => {
    const agent: AgentRunPort = {
      run: async () => { throw new Error("setpriv failed"); },
      interrupt: async () => {},
    };
    const harness = setup({ agent });
    await expect(harness.service.executeCurrentPlan(harness.workItemId)).rejects.toThrow(CommandCleanupError);
    harness.service.close();
    const database = ledger(harness.root);
    expect(database.prepare("SELECT status FROM collaboration_runs").get()).toEqual({ status: "needs_configuration" });
    expect(database.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 0 });
    database.close();
  });

  it("requires a sandbox runner and rejects incomplete sandbox attestations", async () => {
    const edit = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const missingRunner = setup({ agent: edit, commandRunner: null });
    const unavailable = await missingRunner.service.executeCurrentPlan(missingRunner.workItemId);
    expect(unavailable).toMatchObject({
      report: { state: "needs_configuration", reasons: ["sandboxed command runner unavailable"] },
      evidence: [],
    });
    missingRunner.service.close();

    const rejectedRunner = new FakeSandboxedCommandRunner((request) => ({
      ...sandboxedResult(request),
      attestation: { ...sandboxedResult(request).attestation, network: "unknown" },
    }));
    const rejectedHarness = setup({ agent: edit, commandRunner: rejectedRunner });
    const rejected = await rejectedHarness.service.executeCurrentPlan(rejectedHarness.workItemId);
    expect(rejected).toMatchObject({
      report: {
        state: "needs_configuration",
        reasons: ["sandbox attestation rejected for command: pnpm test target"],
      },
      evidence: [],
    });
    rejectedHarness.service.close();
  });

  it("rejects process-group containment before creating a candidate or trusted evidence", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return {
        ...completed(request),
        containmentProof: {
          identity: {
            ...VERIFIED_PROOF.identity,
            backend: "process_group",
            opaqueId: "1234567890123456",
          },
          receipt: VERIFIED_PROOF.receipt,
        },
      };
    });
    const harness = setup({ agent });
    const outcome = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(outcome).toMatchObject({
      resultSha: null,
      evidence: [],
      report: { state: "needs_configuration", reasons: ["unsupported_process_identity"] },
    });
    const db = ledger(harness.root);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 0 });
    db.close();
    harness.service.close();
  });

  it("rejects an empty Agent containment proof replayed from another run binding", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return {
        ...completed(request),
        containmentProof: proofForBinding({ ...request.containmentBinding, runId: "replayed-run" }),
      };
    });
    const harness = setup({ agent });
    const outcome = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(outcome).toMatchObject({ resultSha: null, evidence: [], report: { state: "needs_configuration" } });
    expect(outcome.report.reasons).toContain("unverified");
    const db = ledger(harness.root);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 0 });
    db.close();
    harness.service.close();
  });

  it("rejects target-test containment proof replayed from another command binding", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const runner = new FakeSandboxedCommandRunner((request) => {
      const result = sandboxedResult(request);
      return {
        ...result,
        attestation: {
          ...result.attestation,
          containmentProof: proofForBinding({ ...request.containmentBinding, commandId: "replayed-command" }),
        },
      };
    });
    const harness = setup({ agent, commandRunner: runner });
    const outcome = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(outcome.resultSha).not.toBeNull();
    expect(outcome).toMatchObject({
      evidence: [],
      report: { state: "needs_configuration", reasons: ["containment proof rejected for command: pnpm test target"] },
    });
    const db = ledger(harness.root);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 0 });
    db.close();
    harness.service.close();
  });

  it("times out, interrupts, and does not inspect or commit a still-running Agent", async () => {
    let resolveRun: ((result: AgentRunResult) => void) | undefined;
    let captured: AgentRunRequest | undefined;
    const agent = new FakeAgent(
      (request) =>
        new Promise<AgentRunResult>((resolve) => {
          captured = request;
          resolveRun = resolve;
        }),
    );
    const harness = setup({ agent });
    const outcome = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(outcome).toMatchObject({ resultSha: null, report: { state: "invalid", reasons: ["agent_timeout"] } });
    expect(agent.interrupted).toEqual([outcome.runId]);
    if (captured && resolveRun) resolveRun(completed(captured));
    harness.service.close();
  }, 10_000);

  it("atomically fences paused acquisition and interrupts an active Agent without deleting its evidence", async () => {
    let captured: AgentRunRequest | undefined;
    let resolveRun: ((result: AgentRunResult) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const interrupted: string[] = [];
    const agent: AgentRunPort = {
      async run(request) {
        await request.registerContainment(proofForBinding(request.containmentBinding));
        captured = request;
        request.emit({ threadId: request.threadId, turnId: request.turnId, type: "progress", message: "before pause" });
        signalStarted?.();
        return new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
        });
      },
      async interrupt(runId) {
        interrupted.push(runId);
        if (captured && resolveRun) resolveRun(completed(captured));
      },
    };
    const harness = setup({ agent });
    const execution = harness.service.executeCurrentPlan(harness.workItemId, 1, 3_000);
    await started;
    if (!captured) throw new Error("Expected captured run");
    const pause = harness.service.issueOwnerAction({
      action: "pause",
      workItemId: harness.workItemId,
      expectedVersion: 1,
      now: 3_100,
    });
    const paused = harness.service.performOwnerAction({
      actionToken: pause.token,
      sender: ownerSender(),
      now: 3_200,
    });
    expect(paused).toMatchObject({ allowed: true, action: "pause", controlState: "paused" });
    expect(paused.interruptRequestedRunIds).toEqual([captured.runId]);
    const stopped = await execution;
    expect(stopped).toMatchObject({
      runId: captured.runId,
      resultSha: null,
      report: { state: "invalid", reasons: ["owner_interrupt"] },
    });
    expect(interrupted).toEqual([captured.runId]);

    const database = ledger(harness.root);
    expect(database.prepare("SELECT status, error, interrupt_requested_at FROM collaboration_runs WHERE id = ?").get(captured.runId)).toEqual({
      status: "failed",
      error: "owner_interrupt",
      interrupt_requested_at: 3_200,
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_run_events WHERE run_id = ?").get(captured.runId)).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT state, result_sha FROM collaboration_candidates WHERE run_id = ?").get(captured.runId)).toEqual({
      state: "invalid",
      result_sha: null,
    });
    database.close();

    const resume = harness.service.issueOwnerAction({
      action: "resume",
      workItemId: harness.workItemId,
      expectedVersion: 2,
      now: 3_300,
    });
    expect(harness.service.performOwnerAction({
      actionToken: resume.token,
      sender: ownerSender(),
      now: 3_400,
    })).toMatchObject({ allowed: true, controlState: "active", workItemVersion: 3 });
    harness.service.close();
    const afterResume = ledger(harness.root);
    expect(afterResume.prepare("SELECT execution_status, control_state FROM collaboration_work_nodes WHERE node_type = 'modify'").get()).toEqual({
      execution_status: "not_started",
      control_state: "active",
    });
    expect(afterResume.prepare("SELECT count(*) AS count FROM collaboration_run_events WHERE run_id = ?").get(captured.runId)).toEqual({
      count: 1,
    });
    afterResume.close();
  }, 10_000);

  it.each(["pause", "cancel"] as const)(
    "fences a completed Agent result when Owner %s commits during target-test finalization",
    async (action) => {
      const agent = new FakeAgent((request) => {
        writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
        return completed(request);
      });
      let harness: ReturnType<typeof setup>;
      const commandRunner = new FakeSandboxedCommandRunner((request) => {
        const issued = harness.service.issueOwnerAction({
          action,
          workItemId: harness.workItemId,
          expectedVersion: 1,
          now: 3_100,
        });
        expect(
          harness.service.performOwnerAction({
            actionToken: issued.token,
            sender: ownerSender(),
            now: 3_200,
          }),
        ).toMatchObject({ allowed: true, action });
        return sandboxedResult(request);
      });
      harness = setup({ agent, commandRunner });

      const outcome = await harness.service.executeCurrentPlan(harness.workItemId, 1, 3_000);
      expect(outcome).toMatchObject({
        resultSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        report: { state: "invalid", reasons: ["owner_interrupt"], targetTestsPassed: false },
      });
      harness.service.close();

      const database = ledger(harness.root);
      expect(database.prepare("SELECT status, error, interrupt_requested_at FROM collaboration_runs").get()).toEqual({
        status: "failed",
        error: "owner_interrupt",
        interrupt_requested_at: 3_200,
      });
      expect(database.prepare("SELECT state, result_sha FROM collaboration_candidates").get()).toEqual({
        state: "invalid",
        result_sha: outcome.resultSha,
      });
      expect(database.prepare("SELECT execution_status FROM collaboration_work_nodes WHERE node_type = 'modify'").get()).toEqual({
        execution_status: "invalid",
      });
      expect(database.prepare("SELECT count(*) AS count FROM collaboration_candidates WHERE state = 'target_tests_passed'").get()).toEqual({
        count: 0,
      });
      database.close();
    },
  );

  it("does not acquire a modify node while the Owner pause is active", async () => {
    let runs = 0;
    const agent = new FakeAgent((request) => {
      runs += 1;
      return completed(request);
    });
    const harness = setup({ agent });
    const pause = harness.service.issueOwnerAction({
      action: "pause",
      workItemId: harness.workItemId,
      expectedVersion: 1,
      now: 3_000,
    });
    harness.service.performOwnerAction({ actionToken: pause.token, sender: ownerSender(), now: 3_100 });
    await expect(harness.service.executeCurrentPlan(harness.workItemId)).rejects.toThrow(
      "no current executable modify node",
    );
    expect(runs).toBe(0);
    harness.service.close();
  });

  it("fences a candidate when a newer plan becomes current during the Agent run", async () => {
    let harness: ReturnType<typeof setup>;
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      harness.service.reviseWorkItemDefinition(
        harness.workItemId,
        { goal: "a newer incompatible goal", goalConfirmed: true },
        4_000,
      );
      return completed(request);
    });
    harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result).toMatchObject({ resultSha: null, report: { state: "invalid", reasons: ["plan_superseded"] } });
    harness.service.close();
    const db = ledger(harness.root);
    expect(db.prepare("SELECT current_plan_revision FROM collaboration_work_items").get()).toEqual({
      current_plan_revision: 2,
    });
    expect(db.prepare("SELECT status FROM collaboration_runs").get()).toEqual({ status: "invalid" });
    db.close();
  });
});
