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
import { CommandCleanupError } from "../execution-limits.ts";
import { currentInstanceLease, InstanceLeaseCoordinator } from "../leases.ts";
import { reserveVerification, hasUnsettledVerification } from "../verification-lifecycle.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./runtime.ts";

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
  onRun?: () => void | Promise<void>;

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    this.requests.push(request);
    const containmentProof = proof(request.containmentBinding);
    await request.registerContainment(containmentProof);
    await this.onRun?.();
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

function seedRetryableCandidate(shared?: { dataDirectory: string; repository?: string; baseSha?: string }, withCandidate = true): RetryFixture {
  const id = ++sequence;
  const root = mkdtempSync(join(tmpdir(), "openmausbot-runtime-verification-retry-"));
  scratch.push(root);
  const repository = shared?.repository ?? join(root, "repository");
  const worktree = join(root, "candidate-worktree");
  if (!shared?.repository) {
  mkdirSync(join(repository, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "src", "value.txt"), "before\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "base"]);
  }
  const baseSha = shared?.baseSha ?? git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["worktree", "add", "-b", `candidate-${id}`, worktree, baseSha]);
  writeFileSync(join(worktree, "src", "value.txt"), "after\n");
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", "candidate"]);
  const candidateSha = git(worktree, ["rev-parse", "HEAD"]);
  const dataDirectory = shared?.dataDirectory ?? join(root, "data");
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
  if (!shared) service.bootstrapOwnerLocally({ senderCorpId: owner.senderCorpId, senderStaffId: owner.senderStaffId, now: 500 });
  const accepted = new FakeDingTalkAdapter((message) => service.ingestDingTalkMessage(message)).receive({
    sourceEventId: `seed-${id}`,
    transportMessageId: `seed-transport-${id}`,
    conversationId: shared ? `retry-conversation-${id}` : "retry-conversation",
    addressedToBot: true,
    text: `创建新任务：更新候选值 ${id}`,
    sender: owner,
    receivedAt: 1_000,
  });
  if (!accepted.accepted || !accepted.workItemId) throw new Error(`Expected Work Item: ${JSON.stringify(accepted)}`);
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
  if (withCandidate) {
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
  }
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

function configuredRuntime(item: RetryFixture, runner: FailingVerifierRunner, shutdownTimeoutMs = 10_000, now: number | (() => number) = 4_000,
  extra: Partial<CollaborationHeadlessRuntimeOptions> = {}) {
  const agent: AgentRunPort = {
    run: vi.fn(async () => { throw new Error("modify_must_not_run_for_verification_retry"); }),
    interrupt: vi.fn(async () => undefined),
  };
  const runtime = new CollaborationHeadlessRuntime({
    dataDirectory: item.dataDirectory,
    ownerId: `runtime-${sequence}`,
    shutdownTimeoutMs,
    platform: "linux",
    clock: { now: typeof now === "function" ? now : () => now },
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
    ...extra,
  });
  return {runtime,agent};
}

async function runningRuntime(item: RetryFixture, runner: FailingVerifierRunner, shutdownTimeoutMs = 10_000, now = 4_000) {
  const {runtime,agent}=configuredRuntime(item,runner,shutdownTimeoutMs,now);
  await runtime.start();
  await vi.waitFor(()=>{expect(reviewCount(item)).toBe(1);expect(runtime["scheduledWorkItems"].size).toBe(0);});
  return { runtime, agent };
}

describe("runtime Owner verification retry", () => {
  it("recovers an abandoned zero-command verifier and queues independent verification without modifying again", async () => {
    const item = seedRetryableCandidate(); const runner = new FailingVerifierRunner();
    const db = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
    const leases = new InstanceLeaseCoordinator(db, "old-verifier"); const lease = leases.acquire(3000, 500)!;
    const session = reserveVerification(db, item.runId, lease, 3100);
    leases.release(lease, 3200);
    const { runtime, agent } = configuredRuntime(item, runner);
    try {
      await runtime.start();
      await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM collaboration_verification_settlements WHERE session_id=?").get(session)).toBeDefined());
      await vi.waitFor(() => expect(runner.requests).toHaveLength(1));
      await vi.waitFor(() => expect(reviewCount(item)).toBe(1));
      expect(db.prepare("SELECT 1 FROM collaboration_verification_settlements WHERE session_id=?").get(session)).toBeDefined();
      expect(agent.run).not.toHaveBeenCalled();
      expect(runCount(item)).toBe(1);
    } finally { await runtime.stop(); db.close(); }
  });
  it.each(["same", "different"])("coordinates startup verification with a new modification in %s repositories", async mode => {
    const first = seedRetryableCandidate();
    const second = seedRetryableCandidate(mode === "same" ? first : { dataDirectory: first.dataDirectory }, false);
    const runner = new FailingVerifierRunner();
    let release!: () => void;
    runner.onRun = () => new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const agent: AgentRunPort = {
      async run(request) {
        await request.registerContainment(proof(request.containmentBinding));
        started.push(request.workItemId);
        return { threadId: request.threadId, turnId: request.turnId, status: "failed", message: "controlled failure",
          sandboxEnforced: true, containmentProof: proof(request.containmentBinding) };
      },
      async interrupt() {},
    };
    const { runtime } = configuredRuntime(first, runner, 10000, Date.now(), {
      agent, autoExecuteReady: true,
      execution: {
        managedWorktreeRoot: join(first.dataDirectory, "managed"),
        repositories: Object.fromEntries([first, second].map(item => [item.repository, {
          baseSha: item.baseSha, targetCommands: { "pnpm test target": item.command },
        }])),
        limits: { maxAttempts: 1, agentTimeoutMs: 2000, maxAgentEventBytes: 16000, interruptGraceMs: 500 },
      },
    });
    try {
      await runtime.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      for (let i = 0; i < 3; i++) await runtime.drainOnce();
      if (mode === "same") expect(started).toEqual([]);
      else await vi.waitFor(() => expect(started).toEqual([second.workItemId]));
      release();
      await vi.waitFor(() => expect(started).toEqual([second.workItemId]));
      await vi.waitFor(() => expect(runtime["scheduledWorkItems"].size).toBe(0));
      expect(reviewCount(first)).toBe(1);
    } finally { release?.(); await runtime.stop(); }
  });

  it("does not start queued startup verifications after shutdown begins", async () => {
    const first = seedRetryableCandidate();
    const second = seedRetryableCandidate(first);
    const runner = new FailingVerifierRunner();
    let release!: () => void;
    runner.onRun = () => new Promise<void>(resolve => { release = resolve; });
    const { runtime } = configuredRuntime(first, runner);
    try {
      await runtime.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const stopping = runtime.stop();
      release();
      await stopping;
      expect(runner.requests).toHaveLength(1);
      expect(reviewCount(second)).toBe(0);
      expect(runtime.health().state).toBe("stopped");
    } finally { release?.(); await runtime.stop(); }
  });

  it("queues an Owner verification retry behind a direct modification of the same repository", async () => {
    const first = seedRetryableCandidate();
    const second = seedRetryableCandidate(first, false);
    const runner = new FailingVerifierRunner();
    let release!: () => void;
    const agent: AgentRunPort = {
      async run(request) {
        await request.registerContainment(proof(request.containmentBinding));
        await new Promise<void>(resolve => { release = resolve; });
        return { threadId: request.threadId, turnId: request.turnId, status: "failed", message: "controlled failure",
          sandboxEnforced: true, containmentProof: proof(request.containmentBinding) };
      },
      async interrupt() { release?.(); },
    };
    const { runtime } = configuredRuntime(first, runner, 10000, Date.now(), { agent });
    let execution: Promise<unknown> | undefined;
    try {
      await runtime.start();
      await vi.waitFor(() => expect(runtime["scheduledWorkItems"].size).toBe(0));
      expect(reviewCount(first)).toBe(1);
      execution = runtime.executeCurrentPlan(second.workItemId);
      void execution.catch(() => undefined);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(first, "retry-behind-direct", Date.now())).allowed).toBe(true);
      for (let i = 0; i < 3; i++) await runtime.drainOnce();
      expect(runner.requests).toHaveLength(1);
      release();
      await execution;
      await vi.waitFor(() => expect(reviewCount(first)).toBe(2));
      await vi.waitFor(() => expect(runtime["scheduledWorkItems"].size).toBe(0));
      expect(runner.requests).toHaveLength(2);
    } finally { release?.(); await execution?.catch(() => undefined); await runtime.stop(); }
  });

  it("starts and accepts messages, delivers replies and renews its lease while startup verification waits", async () => {
    const item=seedRetryableCandidate(); const runner=new FailingVerifierRunner();
    let release!:()=>void; let now=4000; let deliveries=0;
    runner.onRun=()=>new Promise<void>(resolve=>{release=resolve;});
    const {runtime}=configuredRuntime(item,runner,10000,()=>now,{outboxDelivery:{async deliver(){deliveries++;return {outcome:"sent"};}}});
    let started=false; const starting=runtime.start().then(()=>{started=true;});
    try {
      await vi.waitFor(()=>expect(started).toBe(true));
      await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
      expect(reviewCount(item)).toBe(0);
      const received=runtime.ingestDingTalkMessage({sourceEventId:"while-verifying",transportMessageId:"while-verifying",conversationId:"retry-conversation",
        addressedToBot:true,text:"登录失败时的提示需要调整",sender:item.owner,receivedAt:20000});
      expect(received.accepted).toBe(true);
      now=25000;
      for(let i=0;i<8;i++) await runtime.drainOnce();
      expect(deliveries).toBeGreaterThan(0); expect(runtime.health().ready).toBe(true);
      const db=new DatabaseSync(join(item.dataDirectory,"collaboration","collaboration.sqlite"));
      try {
        expect(currentInstanceLease(db)?.expiresAt).toBe(55000);
        expect(db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE source_event_id='while-verifying'").get()).toEqual({delivery_state:"sent"});
      } finally {db.close();}
    } finally {release?.();await starting;await runtime.stop();}
  });
  it.each(["same","different"])("schedules startup verification for %s repositories with the correct concurrency", async mode=>{
    const first=seedRetryableCandidate();
    const second=seedRetryableCandidate(mode==="same"?first:{dataDirectory:first.dataDirectory});
    const runner=new FailingVerifierRunner(); const releases:Array<()=>void>=[];
    let closing = false;
    runner.onRun=()=>new Promise<void>(resolve=>{releases.push(resolve);if(closing) resolve();});
    const {runtime}=configuredRuntime(first,runner,10000,4000,{execution:{managedWorktreeRoot:join(first.dataDirectory,"managed"),
      repositories:Object.fromEntries([first,second].map(item=>[item.repository,{baseSha:item.baseSha,targetCommands:{"pnpm test target":item.command}}])),
      limits:{maxAttempts:3,agentTimeoutMs:2000,maxAgentEventBytes:16000,interruptGraceMs:500}}});
    let started=false;const starting=runtime.start().then(()=>{started=true;});
    try {
      await vi.waitFor(()=>expect(started).toBe(true));
      await vi.waitFor(()=>expect(releases).toHaveLength(mode==="same"?1:2));
      for(let i=0;i<3;i++) await runtime.drainOnce();
      expect(runner.requests).toHaveLength(mode==="same"?1:2);
      if(mode==="same") {
        releases[0]();
        await vi.waitFor(()=>expect(releases).toHaveLength(2));
      }
      for (const release of releases) release();
      await vi.waitFor(()=>expect(runtime["scheduledWorkItems"].size).toBe(0));
      for(let i=0;i<3;i++) await runtime.drainOnce();
      expect(runner.requests).toHaveLength(2);
      expect(reviewCount(first)).toBe(1);
      expect(reviewCount(second)).toBe(1);
    } finally {closing=true;for(const release of releases) release();await starting;await runtime.stop();}
  });
  it("keeps an unconfirmed verifier and its proof across lease expiry and a replacement runtime", async () => {
    const item=seedRetryableCandidate(); const runner=new FailingVerifierRunner();
    const {runtime}=await runningRuntime(item,runner);
    runner.onRun=()=>{
      const competing=new DatabaseSync(join(item.dataDirectory,"collaboration","collaboration.sqlite"));
      try {
        expect(()=>reserveVerification(competing,item.runId,currentInstanceLease(competing)!,4000)).toThrow("verification_repository_unsettled");
        expect(hasUnsettledVerification(competing,join(item.repository,"unrelated"))).toBe(false);
      } finally {competing.close();}
      throw new CommandCleanupError(new Error("cleanup unknown"));
    };
    try {
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item,"durable-unknown",4100)).allowed).toBe(true);
      await vi.waitFor(()=>expect(runtime.health().ready).toBe(false));
    } finally { await runtime.stop(); }
    const db=new DatabaseSync(join(item.dataDirectory,"collaboration","collaboration.sqlite"));
    try {
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_verification_sessions s LEFT JOIN collaboration_verification_settlements f ON f.session_id=s.id WHERE f.session_id IS NULL").get()).toEqual({n:1});
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_verification_proofs").get()).toEqual({n:2});
      expect(()=>db.exec("DELETE FROM collaboration_verification_proofs")).toThrow("immutable");
    } finally { db.close(); }
    const replacementRunner=new FailingVerifierRunner();
    const replacement=await runningRuntime(item,replacementRunner,10000,100000);
    try {
      expect(replacementRunner.requests).toHaveLength(0);
      await expect(replacement.runtime.executeCurrentPlan(item.workItemId)).rejects.toThrow("verification_repository_unsettled");
    } finally { await replacement.runtime.stop(); }
  });
  it("settles ordinary failed tests with empty containment, allowing an explicitly requested retry", async () => {
    const item=seedRetryableCandidate(); const {runtime}=await runningRuntime(item,new FailingVerifierRunner());
    try {
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item,"settled-retry",4100)).allowed).toBe(true);
      await vi.waitFor(()=>expect(runtime["scheduledWorkItems"].size).toBe(0));
      const db=new DatabaseSync(join(item.dataDirectory,"collaboration","collaboration.sqlite"));
      try {
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_verification_sessions").get()).toEqual({n:2});
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_verification_settlements").get()).toEqual({n:2});
      } finally {db.close();}
    } finally { await runtime.stop(); }
  });
  it("does not release or restart a runtime after verifier process cleanup is unconfirmed", async () => {
    const item=seedRetryableCandidate(); const runner=new FailingVerifierRunner();
    const {runtime}=await runningRuntime(item,runner);
    runner.onRun=()=>{throw new CommandCleanupError(new Error("test cleanup unknown"));};
    try {
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item,"cleanup-unconfirmed",4100)).allowed).toBe(true);
      await vi.waitFor(()=>expect(runtime.health()).toMatchObject({ready:false,reason:"verification_containment_unconfirmed"}));
      expect(await runtime.stop()).toMatchObject({reason:"verification_containment_unconfirmed"});
      await expect(runtime.start()).rejects.toThrow("verification_containment_unconfirmed");
      const db=new DatabaseSync(join(item.dataDirectory,"collaboration","collaboration.sqlite"));
      try { expect(db.prepare("SELECT 1 FROM collaboration_instance_lease WHERE expires_at>4000").get()).toBeDefined(); }
      finally { db.close(); }
    } finally { await runtime.stop(); }
  });
  it("does not persist or notify a retry that finishes after shutdown", async () => {
    const item = seedRetryableCandidate(); const runner = new FailingVerifierRunner();
    const { runtime } = await runningRuntime(item, runner, 50);
    let release!: () => void;
    runner.onRun = () => new Promise<void>(resolve => { release = resolve; });
    try {
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "shutdown-retry", 4100)).allowed).toBe(true);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(await runtime.stop()).toMatchObject({ reason: "shutdown_verification_unsettled" });
      await expect(runtime.start()).rejects.toThrow("collaboration_verification_still_settling");
      release();
      await vi.waitFor(() => expect(runtime["scheduledWorkItems"].size).toBe(0));
      expect(reviewCount(item)).toBe(1);
    } finally { release?.(); await runtime.stop(); }
  });
  it.each(["pause", "cancel", "new_plan", "new_contribution"])("does not announce a late verification failure after %s", async (change) => {
    const item = seedRetryableCandidate();
    const runner = new FailingVerifierRunner();
    runner.onRun = () => {
      const db = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
      try {
        if (change === "pause" || change === "cancel") {
          db.prepare("UPDATE collaboration_work_items SET control_state=? WHERE id=?")
            .run(change === "pause" ? "paused" : "cancelled", item.workItemId);
        } else if (change === "new_plan") {
          db.prepare("UPDATE collaboration_work_items SET current_plan_revision=NULL WHERE id=?").run(item.workItemId);
        } else {
          db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(item.workItemId);
        }
      } finally { db.close(); }
    };
    const { runtime } = await runningRuntime(item, runner);
    try {
      const db = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
      try {
        expect(db.prepare("SELECT source_event_id FROM collaboration_outbox WHERE source_event_id LIKE ?")
          .all(`verification:${item.runId}:%`)).toEqual([]);
      } finally { db.close(); }
    } finally { await runtime.stop(); }
  });

  it("distinguishes pending mapping from a failure and fences replayed or older results", async () => {
    const item = seedRetryableCandidate();
    const runner = new FailingVerifierRunner();
    const { runtime } = await runningRuntime(item, runner);
    const db = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      const row = db.prepare("SELECT spec_hash FROM collaboration_candidate_reviews WHERE candidate_run_id=? LIMIT 1")
        .get(item.runId) as { spec_hash: string };
      const target = { runId: item.runId, workItemId: item.workItemId, planRevision: 1 };
      const pending = { passed: false, status: "needs_configuration" as const, reasons: ["acceptance_mapping_pending"],
        specHash: row.spec_hash, verifierAttempt: 1, metaAttempt: null };
      runtime["enqueueVerificationFailure"](target, pending);
      runtime["enqueueVerificationFailure"](target, pending);
      const notices = () => db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE ?")
        .all(`verification:${item.runId}:%`).map(r => String(r.payload_json));
      expect(notices().filter(r => r.includes("verification_pending"))).toHaveLength(1);
      expect(notices().filter(r => r.includes("verification_blocked"))).toHaveLength(1);
      expect(notices().join(" ")).not.toContain("自动复核环境尚未配置完整");
      expect(runtime.performDingTalkOwnerTextCommand(ownerRetry(item, "new-verifier-attempt", 4_100)).allowed).toBe(true);
      await vi.waitFor(() => expect(reviewCount(item)).toBe(2));
      expect(runtime["verificationCoordinator"](item.runId).isCurrentNotification(item.runId, pending)).toBe(false);
      const count = notices().length;
      runtime["enqueueVerificationFailure"](target, { ...pending, reasons: ["acceptance_mapping_incomplete"] });
      expect(notices()).toHaveLength(count);
    } finally { db.close(); await runtime.stop(); }
  });

  it("silently drops a notification from a replaced instance and rejects a changed contract", async () => {
    const item = seedRetryableCandidate();
    const { runtime } = await runningRuntime(item, new FailingVerifierRunner());
    const db = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      const row = db.prepare("SELECT spec_hash FROM collaboration_candidate_reviews WHERE candidate_run_id=? LIMIT 1")
        .get(item.runId) as { spec_hash: string };
      const target = { runId: item.runId, workItemId: item.workItemId, planRevision: 1 };
      const pending = { passed: false, status: "needs_configuration" as const, reasons: ["acceptance_mapping_pending"],
        specHash: row.spec_hash, verifierAttempt: 1, metaAttempt: null };
      runtime["enqueueVerificationFailure"](target, { ...pending, specHash: "wrong-contract" });
      db.prepare("UPDATE collaboration_instance_lease SET fencing_token=fencing_token+1 WHERE singleton=1").run();
      expect(() => runtime["enqueueVerificationFailure"](target, pending)).not.toThrow();
      expect(db.prepare("SELECT 1 FROM collaboration_outbox WHERE source_event_id LIKE ?")
        .all(`verification:${item.runId}:attempt:1:pending:%`)).toEqual([]);
    } finally { db.close(); await runtime.stop(); }
  });
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
