import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDingTalkAdapter } from "../../integrations/dingtalk/fake-adapter.ts";
import { parseDingTalkOwnerTextCommand } from "../../integrations/dingtalk/text-actions.ts";
import type { DingTalkInboundMessage, DingTalkOwnerTextCommand } from "../../integrations/dingtalk/types.ts";
import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "../containment.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import type { AgentRunPort } from "../provider-runner.ts";
import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
  TargetCommandSpec,
} from "../quality-gate.ts";
import { startCollaborationService } from "../service.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";

const scratch: string[] = [];
let sequence = 0;

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const identity: ContainmentProof["identity"] = {
  backend: "test_verified_runtime",
  opaqueId: "runtime-verification-retry-0001",
  hostGeneration: "test-host-generation-1",
  verifierVersion: "test-verifier-v1",
};

function proof(binding: ContainmentBinding): ContainmentProof {
  return { identity, receipt: containmentBindingHash(binding) };
}

class FakeContainment implements ContainmentPort {
  async verifyProof(candidate: ContainmentProof, expected: ContainmentBinding) {
    const bindingHash = containmentBindingHash(expected);
    return candidate.receipt === bindingHash
      ? { verified: true as const, fingerprint: runtimeIdentityFingerprint(candidate.identity), bindingHash }
      : { verified: false as const, reason: "unverified" };
  }

  async inspect(candidate: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(candidate) };
  }

  async terminateAndWaitEmpty(candidate: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(candidate) };
  }
}

class FailingVerifierRunner implements SandboxedCommandRunner {
  readonly requests: SandboxedCommandRequest[] = [];

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    this.requests.push(request);
    const containmentProof = proof(request.containmentBinding);
    await request.registerContainment(containmentProof);
    return {
      exitCode: 7,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("independent verification failed\n"),
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
        containmentProof,
      },
    };
  }
}

interface RetryFixture {
  dataDirectory: string;
  repository: string;
  worktree: string;
  workItemId: string;
  runId: string;
  baseSha: string;
  candidateSha: string;
  command: TargetCommandSpec;
  owner: DingTalkInboundMessage["sender"];
}

function seedRetryableCandidate(): RetryFixture {
  const id = ++sequence;
  const root = mkdtempSync(join(tmpdir(), "openmausbot-runtime-verification-retry-"));
  scratch.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "candidate-worktree");
  mkdirSync(join(repository, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "src", "value.txt"), "before\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["worktree", "add", "-b", `candidate-${id}`, worktree, baseSha]);
  writeFileSync(join(worktree, "src", "value.txt"), "after\n");
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", "candidate"]);
  const candidateSha = git(worktree, ["rev-parse", "HEAD"]);
  const dataDirectory = join(root, "data");
  const service = startCollaborationService({
    dataDirectory,
    planning: {
      planner: { propose: validProposal },
      policy: { ...policy, allowedRepositories: [repository] },
    },
  });
  const owner = {
    senderCorpId: "corp-1",
    senderStaffId: "owner-1",
    senderId: "owner-sender-1",
    displayName: "Owner",
  };
  service.bootstrapOwnerLocally({ senderCorpId: owner.senderCorpId, senderStaffId: owner.senderStaffId, now: 500 });
  const accepted = new FakeDingTalkAdapter((message) => service.ingestDingTalkMessage(message)).receive({
    sourceEventId: `seed-${id}`,
    transportMessageId: `seed-transport-${id}`,
    conversationId: "retry-conversation",
    addressedToBot: true,
    text: "更新候选值",
    sender: owner,
    receivedAt: 1_000,
  });
  if (!accepted.accepted || !accepted.workItemId) throw new Error("Expected Work Item");
  service.reviseWorkItemDefinition(accepted.workItemId, {
    goal: "将候选值更新为 after",
    goalConfirmed: true,
    repository,
    acceptanceConditions: [{ description: "候选值已更新", observation: "pnpm test target 验证候选结果" }],
    blockingAmbiguities: [],
  }, 2_000);
  service.close();

  const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  // SAFETY: The published strict plan contains exactly one modify node with the selected fields.
  const modify = database.prepare(
    "SELECT node_id,assigned_agent_id FROM collaboration_work_nodes " +
      "WHERE work_item_id = ? AND plan_revision = 1 AND node_type = 'modify'",
  ).get(accepted.workItemId) as { node_id: string; assigned_agent_id: string };
  const runId = `retry-run-${id}`;
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path," +
      "worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    runId, accepted.workItemId, 1, modify.node_id, 1, modify.assigned_agent_id, `thread-${id}`, `turn-${id}`,
    "succeeded", repository, worktree, `candidate-${id}`, baseSha, candidateSha, 3_000, 3_100,
  );
  database.prepare(
    "INSERT INTO collaboration_candidates " +
      "(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    `candidate-${id}`, runId, "target_tests_passed", baseSha, candidateSha,
    JSON.stringify(["src/value.txt"]), "[]", JSON.stringify({ state: "target_tests_passed" }), 3_100,
  );
  database.prepare(
    "INSERT INTO collaboration_test_evidence " +
      "(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    `evidence-${id}`, runId, "pnpm test target", JSON.stringify(["node", "test"]), worktree,
    0, 5, "passed", "", "target_passed", 3_100,
  );
  database.close();
  return {
    dataDirectory,
    repository,
    worktree,
    workItemId: accepted.workItemId,
    runId,
    baseSha,
    candidateSha,
    command: { argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000, maxOutputBytes: 32_000 },
    owner,
  };
}

function ownerRetry(item: RetryFixture, eventId: string, receivedAt: number): DingTalkOwnerTextCommand {
  const parsed = parseDingTalkOwnerTextCommand({
    sourceEventId: eventId,
    transportMessageId: `transport-${eventId}`,
    conversationId: "retry-conversation",
    addressedToBot: true,
    text: `重试 ${item.workItemId}`,
    sender: item.owner,
    receivedAt,
  });
  if (!parsed) throw new Error("Expected retry command");
  return parsed;
}

function reviewCount(item: RetryFixture): number {
  const database = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"), {
    readOnly: true,
  });
  // SAFETY: SQLite count(*) always returns one row with an integer count for this fixed projection.
  const row = database.prepare(
    "SELECT count(*) AS count FROM collaboration_candidate_reviews WHERE candidate_run_id = ? AND stage = 'verifier'",
  ).get(item.runId) as { count: number };
  database.close();
  return row.count;
}

function runCount(item: RetryFixture): number {
  const database = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"), {
    readOnly: true,
  });
  // SAFETY: SQLite count(*) always returns one row with an integer count for this fixed projection.
  const row = database.prepare("SELECT count(*) AS count FROM collaboration_runs WHERE work_item_id = ?")
    .get(item.workItemId) as { count: number };
  database.close();
  return row.count;
}

async function runningRuntime(item: RetryFixture, runner: FailingVerifierRunner) {
  const agent: AgentRunPort = {
    run: vi.fn(async () => { throw new Error("modify_must_not_run_for_verification_retry"); }),
    interrupt: vi.fn(async () => undefined),
  };
  const runtime = new CollaborationHeadlessRuntime({
    dataDirectory: item.dataDirectory,
    ownerId: `runtime-${sequence}`,
    platform: "linux",
    clock: { now: () => 4_000 },
    agent,
    containment: new FakeContainment(),
    commandRunner: runner,
    execution: {
      managedWorktreeRoot: join(item.dataDirectory, "managed-worktrees"),
      repositories: {
        [item.repository]: { baseSha: item.baseSha, targetCommands: { "pnpm test target": item.command } },
      },
      limits: { maxAttempts: 3, agentTimeoutMs: 2_000, maxAgentEventBytes: 16_000, interruptGraceMs: 500 },
    },
  });
  await runtime.start();
  expect(reviewCount(item)).toBe(1);
  return { runtime, agent };
}

describe("runtime Owner verification retry", () => {
  it("re-runs the verifier for a succeeded candidate without re-running modify", async () => {
    const item = seedRetryableCandidate();
    const runner = new FailingVerifierRunner();
    const { runtime, agent } = await runningRuntime(item, runner);
    try {
      const outcome = runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "retry-once", 4_100));
      expect(outcome).toMatchObject({ allowed: true, duplicate: false, command: "retry" });
      await vi.waitFor(() => expect(reviewCount(item)).toBe(2));
      expect(runner.requests).toHaveLength(2);
      expect(agent.run).not.toHaveBeenCalled();
      expect(runCount(item)).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it("rejects further retries after three failed verifier attempts", async () => {
    const item = seedRetryableCandidate();
    const runner = new FailingVerifierRunner();
    const { runtime, agent } = await runningRuntime(item, runner);
    try {
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "retry-two", 4_100)).allowed).toBe(true);
      await vi.waitFor(() => expect(reviewCount(item)).toBe(2));
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "retry-three", 4_200)).allowed).toBe(true);
      await vi.waitFor(() => expect(reviewCount(item)).toBe(3));

      const denied = runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "retry-four", 4_300));
      expect(denied).toMatchObject({
        allowed: false,
        duplicate: false,
        command: "retry",
        reason: "verification_attempt_limit_exhausted",
      });
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "retry-four", 4_300))).toMatchObject({
        allowed: false,
        duplicate: true,
        reason: "verification_attempt_limit_exhausted",
      });
      expect(runner.requests).toHaveLength(3);
      expect(agent.run).not.toHaveBeenCalled();
      expect(runCount(item)).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it("replays the same text event with its original outcome and no new verification attempt", async () => {
    const item = seedRetryableCandidate();
    const runner = new FailingVerifierRunner();
    const { runtime, agent } = await runningRuntime(item, runner);
    try {
      const command = ownerRetry(item, "retry-replayed", 4_100);
      const first = runtime.performDingTalkOwnerTextCommand(command);
      expect(first).toMatchObject({ allowed: true, duplicate: false });
      await vi.waitFor(() => expect(reviewCount(item)).toBe(2));

      const replay = runtime.performDingTalkOwnerTextCommand(command);
      expect(replay).toMatchObject({ allowed: first.allowed, duplicate: true, reason: first.reason });
      expect(runner.requests).toHaveLength(2);
      expect(reviewCount(item)).toBe(2);
      expect(agent.run).not.toHaveBeenCalled();
      expect(runCount(item)).toBe(1);
    } finally {
      await runtime.stop();
    }
  });
});
