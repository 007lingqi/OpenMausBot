import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
import { CollaborationHeadlessRuntime } from "./runtime.ts";

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
  const runtime = new CollaborationHeadlessRuntime({
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
  });
  return { runtime, agent, items };
}

function trigger(runtime: CollaborationHeadlessRuntime, item: SeededWorkItem, index: number): void {
  runtime.ingestDingTalkMessage(inbound({
    sourceEventId: `repository-serialization-run-${index}`,
    conversationId: item.conversationId,
    text: `${item.workItemId} 现在执行`,
  }));
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
  it("does not start a second ready Work Item until the first execution for the same repository ends", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root, "shared-repository");
    const harness = createHarness([repository, repository]);
    const [first, second] = harness.items;
    await harness.runtime.start();
    try {
      trigger(harness.runtime, first, 1);
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first Work Item did not start");

      trigger(harness.runtime, second, 2);
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
      trigger(harness.runtime, first, 3);
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first repository did not start");

      trigger(harness.runtime, second, 4);
      await waitFor(
        () => harness.agent.startedWorkItems.includes(second.workItemId),
        "different repository was incorrectly serialized",
      );
      expect(harness.agent.startedWorkItems).toEqual([first.workItemId, second.workItemId]);
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
      trigger(harness.runtime, first, 5);
      await waitFor(() => harness.agent.startedWorkItems.includes(first.workItemId), "first Work Item did not start");

      trigger(harness.runtime, second, 6);
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
