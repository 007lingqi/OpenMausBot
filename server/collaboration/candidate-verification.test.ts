import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import {
  CandidateVerificationCoordinator,
  candidateHasPassedMetaReview,
} from "./candidate-verification.ts";
import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "./containment.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
  TargetCommandSpec,
} from "./quality-gate.ts";
import { startCollaborationService, type CollaborationService } from "./service.ts";
import { acceptanceConditionHash } from "./acceptance-assertions.ts";

const scratch: string[] = [];
const resources: Array<{ close(): void }> = [];
let sequence = 0;

afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.close();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function inbound(id: number): DingTalkInboundMessage {
  return {
    sourceEventId: `verification-source-${id}`,
    transportMessageId: `verification-transport-${id}`,
    conversationId: "verification-conversation",
    addressedToBot: true,
    text: "更新候选值",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "staff-1",
      senderId: "sender-1",
      displayName: "Contributor",
    },
    receivedAt: 1_000,
  };
}

const proofIdentity: ContainmentProof["identity"] = {
  backend: "test_verified_runtime",
  opaqueId: "candidate-verifier-runtime-0001",
  hostGeneration: "host-generation-1",
  verifierVersion: "verifier-v1",
};

function proof(binding: ContainmentBinding): ContainmentProof {
  return { identity: proofIdentity, receipt: containmentBindingHash(binding) };
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

class FakeRunner implements SandboxedCommandRunner {
  readonly requests: SandboxedCommandRequest[] = [];

  constructor(
    private readonly operation: (request: SandboxedCommandRequest) => Partial<SandboxedCommandResult> | void = () => {},
  ) {}

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    this.requests.push(request);
    const containmentProof = proof(request.containmentBinding);
    await request.registerContainment(containmentProof);
    const override = this.operation(request) ?? {};
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ version: 1, runId: request.containmentBinding.runId,
        nonce: request.containmentBinding.nonce, assertions: [{ id: "value-updated", state: "passed" }] })),
      stderr: Buffer.alloc(0),
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
      ...override,
    };
  }
}

interface Fixture {
  root: string;
  dataDirectory: string;
  repository: string;
  worktree: string;
  workItemId: string;
  runId: string;
  candidateSha: string;
  database: DatabaseSync;
  service: CollaborationService;
  commands: Record<string, TargetCommandSpec>;
}

function fixture(observation = "pnpm test target 验证候选结果", selfReport = true): Fixture {
  const id = ++sequence;
  const root = mkdtempSync(join(tmpdir(), "openmausbot-verification-"));
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
  resources.push(service);
  const accepted = new FakeDingTalkAdapter((message) => service.ingestDingTalkMessage(message)).receive(inbound(id));
  if (!accepted.accepted || !accepted.workItemId) throw new Error("Expected Work Item");
  service.reviseWorkItemDefinition(accepted.workItemId, {
    goal: "将候选值更新为 after",
    goalConfirmed: true,
    repository,
    acceptanceConditions: [{ description: "候选值已经更新", observation }],
    blockingAmbiguities: [],
  }, 2_000);

  const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  resources.push(database);
  // SAFETY: The published sequential plan always contains exactly one active modify node with these selected fields.
  const modify = database.prepare(
    "SELECT node_id,assigned_agent_id FROM collaboration_work_nodes " +
      "WHERE work_item_id = ? AND plan_revision = 1 AND node_type = 'modify'",
  ).get(accepted.workItemId) as { node_id: string; assigned_agent_id: string };
  const runId = `candidate-run-${id}`;
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
      "(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at,containment_binding_json) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    `evidence-${id}`, runId, "pnpm test target", JSON.stringify(["node", "test"]), worktree,
    0, 5, selfReport ? JSON.stringify({ version: 1, runId, nonce: "fixture-self-test-nonce", assertions: [{ id: "value-updated", state: "passed" }] }) : "command passed", "", "target_passed", 3_100,
    JSON.stringify({ runId, nonce: "fixture-self-test-nonce", commandId: "pnpm test target" }),
  );
  return {
    root,
    dataDirectory,
    repository,
    worktree,
    workItemId: accepted.workItemId,
    runId,
    candidateSha,
    database,
    service,
    commands: {
      "pnpm test target": { argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000, maxOutputBytes: 32_000,
        assertionContract: { format: "omb-assertions-v1", bindings: [{ conditionHash: acceptanceConditionHash({ description: "候选值已经更新", observation: "pnpm test target 验证候选结果" }), assertionIds: ["value-updated"] }] } },
    },
  };
}

function coordinator(item: Fixture, runner: SandboxedCommandRunner, maxAttempts = 3) {
  return new CandidateVerificationCoordinator(item.database, {
    commandRunner: runner,
    containment: new FakeContainment(),
    commands: item.commands,
    dataDirectory: item.dataDirectory,
    maxAttempts,
  });
}

function verify(item: Fixture, runner: SandboxedCommandRunner, now = 4_000, maxAttempts = 3) {
  return coordinator(item, runner, maxAttempts).verify({
    candidateRunId: item.runId,
    worktreePath: item.worktree,
    instance: { ownerId: "instance-1", fence: 1 },
    now,
  });
}

describe("independent candidate verification", () => {
  it("rejects a runner that did not attest the configured trusted reporter", async () => {
    const item = fixture();
    item.commands["pnpm test target"].argv = ["node", "--test", "case.test.mjs"];
    item.commands["pnpm test target"].assertionReporter = "node-test-v1";
    const outcome = await verify(item, new FakeRunner());
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("sandbox attestation rejected for command: pnpm test target");
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("requires assertion evidence from the developer self-test as well as the independent rerun", async () => {
    const item = fixture(undefined, false);
    const outcome = await verify(item, new FakeRunner());
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("executor_self_test_incomplete");
  });
  it.each([1, 2])("does not accept schema %s review rows without recomputable assertion coverage", version => {
    const item = fixture();
    const insert = item.database.prepare("INSERT INTO collaboration_candidate_reviews (id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) VALUES (?,?,?,1,'passed',?,1,?,?,?,4000)");
    insert.run("legacy-verifier", item.runId, "verifier", "deterministic-verifier-v1", "a".repeat(64), item.candidateSha, JSON.stringify({ contractSchemaVersion: version }));
    insert.run("legacy-meta", item.runId, "meta", "meta-acceptance-gate-v1", "a".repeat(64), item.candidateSha, JSON.stringify({ contractSchemaVersion: version, verifierAttempt: 1 }));
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("runs a real local assertion against the fixed candidate and binds its result to this verification", async () => {
    const item = fixture();
    const runner = new FakeRunner(request => ({ stdout: execFileSync(process.execPath, ["-e",
      "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'after\\n'); process.stdout.write(JSON.stringify({version:1,runId:process.env.OMB_ASSERTION_RUN_ID,nonce:process.env.OMB_ASSERTION_NONCE,assertions:[{id:'value-updated',state:'passed'}]}))"],
      { cwd: request.cwd, env: request.environment }) }));
    expect((await verify(item, runner)).passed).toBe(true);
  });
  it("cannot reuse a previously successful assertion report from another verifier attempt", async () => {
    const item = fixture();
    const outcome = await verify(item, new FakeRunner(() => ({ stdout: Buffer.from(JSON.stringify({ version: 1, runId: "old", nonce: "old", assertions: [{ id: "value-updated", state: "passed" }] })) })));
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("acceptance_evidence_incomplete");
  });
  it("invalidates a cached pass when the trusted assertion binding changes", async () => {
    const item = fixture();
    expect((await verify(item, new FakeRunner())).passed).toBe(true);
    item.commands["pnpm test target"].assertionContract!.bindings[0].assertionIds = ["additional-required-case"];
    const next = await verify(item, new FakeRunner(), 5000);
    expect(next.passed).toBe(false);
    expect(next.verifierAttempt).toBe(2);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("cannot approve business acceptance from a zero-exit test with no assertion report", async () => {
    const item = fixture();
    const outcome = await verify(item, new FakeRunner(() => ({ stdout: Buffer.from("command succeeded\n") })));
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("acceptance_evidence_incomplete");
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("does not produce Meta approval when no verifier runner is available", async () => {
    const item = fixture();
    // SAFETY: This deliberate contract violation exercises the runtime's unavailable-runner fail-closed path.
    const unavailableRunner = undefined as unknown as SandboxedCommandRunner;
    const outcome = await verify(item, unavailableRunner);
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("sandboxed command runner unavailable");
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_reviews WHERE stage = 'meta'").get())
      .toEqual({ count: 0 });
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });

  it("does not trust a standalone Meta row without its independent verifier review", () => {
    const item = fixture();
    item.database.prepare(
      "INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "standalone-meta", item.runId, "meta", 1, "passed", "meta-acceptance-gate-v1", 1,
      "a".repeat(64), item.candidateSha, "{}", 4_000,
    );
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });

  it("rejects a verifier assigned to the same identity as the modifier", async () => {
    const item = fixture();
    item.database.prepare(
      "UPDATE collaboration_work_nodes SET assigned_agent_id = 'developer-1' " +
        "WHERE work_item_id = ? AND plan_revision = 1 AND node_type = 'validate'",
    ).run(item.workItemId);
    await expect(verify(item, new FakeRunner())).resolves.toMatchObject({
      passed: false,
      status: "needs_configuration",
      reasons: ["verifier_identity_not_independent"],
      metaAttempt: null,
    });
  });

  it("rejects an independently failing target test", async () => {
    const item = fixture();
    const runner = new FakeRunner(() => ({ exitCode: 7, stderr: Buffer.from("failed\n") }));
    await expect(verify(item, runner)).resolves.toMatchObject({
      passed: false,
      status: "failed",
      reasons: ["independent_target_verification_failed"],
      metaAttempt: null,
    });
  });

  it.each(["head", "status"] as const)("rejects a verifier that modifies candidate %s", async (kind) => {
    const item = fixture();
    const runner = new FakeRunner((request) => {
      if (kind === "status") {
        writeFileSync(join(request.cwd, "verifier-output.txt"), "unexpected\n");
      } else {
        writeFileSync(join(request.cwd, "src", "value.txt"), "verifier changed\n");
        git(request.cwd, ["add", "."]);
        git(request.cwd, ["commit", "-m", "verifier mutation"]);
      }
    });
    const outcome = await verify(item, runner);
    expect(outcome).toMatchObject({ passed: false, status: "failed", metaAttempt: null });
    expect(outcome.reasons).toContain("verifier_modified_candidate");
  });

  it("fails Meta review when an acceptance condition has no trusted command mapping", async () => {
    const item = fixture("由产品负责人肉眼确认界面颜色");
    const outcome = await verify(item, new FakeRunner());
    expect(outcome).toMatchObject({
      passed: false,
      status: "failed",
      reasons: ["executor_self_test_incomplete", "acceptance_evidence_incomplete"],
      verifierAttempt: 1,
      metaAttempt: 1,
    });
  });

  it("marks the review stale when its current Spec/candidate target is superseded during verification", async () => {
    const item = fixture();
    const runner = new FakeRunner(() => {
      item.service.reviseWorkItemDefinition(item.workItemId, { facts: ["目标已发生变化"] }, 4_100);
    });
    const outcome = await verify(item, runner);
    expect(outcome).toMatchObject({ passed: false, status: "stale", metaAttempt: null });
    expect(outcome.reasons).toContain("verification_target_changed");
  });

  it("passes only after independent verifier and Meta acceptance reviews both complete", async () => {
    const item = fixture();
    const outcome = await verify(item, new FakeRunner());
    expect(outcome).toMatchObject({
      passed: true,
      status: "passed",
      reasons: [],
      verifierAttempt: 1,
      metaAttempt: 1,
    });
    expect(
      item.database.prepare(
        "SELECT stage,status,agent_id FROM collaboration_candidate_reviews ORDER BY stage DESC",
      ).all(),
    ).toEqual([
      { stage: "verifier", status: "passed", agent_id: "deterministic-verifier-v1" },
      { stage: "meta", status: "passed", agent_id: "meta-acceptance-gate-v1" },
    ]);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(true);
  });

  it("keeps verifier and Meta review evidence immutable", async () => {
    const item = fixture();
    await verify(item, new FakeRunner());
    expect(() => item.database.prepare("UPDATE collaboration_candidate_reviews SET status = 'failed'").run())
      .toThrow("candidate reviews are immutable");
    expect(() => item.database.prepare("DELETE FROM collaboration_candidate_reviews").run())
      .toThrow("candidate reviews are immutable");
  });

  it("stops running the verifier after three consecutive failures", async () => {
    const item = fixture();
    const runner = new FakeRunner(() => ({ exitCode: 9 }));
    const verifier = coordinator(item, runner);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await verifier.verify({
        candidateRunId: item.runId,
        worktreePath: item.worktree,
        instance: { ownerId: "instance-1", fence: 1 },
        now: 4_000 + attempt,
      });
      expect(outcome.verifierAttempt).toBe(attempt);
      expect(outcome.passed).toBe(false);
    }
    await expect(verifier.verify({
      candidateRunId: item.runId,
      worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 },
      now: 5_000,
    })).resolves.toMatchObject({
      passed: false,
      reasons: ["verification_attempt_limit_exhausted"],
      verifierAttempt: 3,
      metaAttempt: null,
    });
    expect(runner.requests).toHaveLength(3);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_reviews").get())
      .toEqual({ count: 3 });
  });

  it("allows a fresh verification budget when the trusted command contract changes", async () => {
    const item = fixture();
    const failing = new FakeRunner(() => ({ exitCode: 9 }));
    const initial = coordinator(item, failing);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await initial.verify({
        candidateRunId: item.runId,
        worktreePath: item.worktree,
        instance: { ownerId: "instance-1", fence: 1 },
        now: 4_000 + attempt,
      });
    }
    const changedCommands = {
      ...item.commands,
      "pnpm test target": { ...item.commands["pnpm test target"], timeoutMs: 6_000 },
    };
    const runner = new FakeRunner();
    const changed = new CandidateVerificationCoordinator(item.database, {
      commandRunner: runner,
      containment: new FakeContainment(),
      commands: changedCommands,
      dataDirectory: item.dataDirectory,
      maxAttempts: 3,
    });
    await expect(changed.verify({
      candidateRunId: item.runId,
      worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 },
      now: 5_000,
    })).resolves.toMatchObject({ passed: true, verifierAttempt: 4, metaAttempt: 1 });
    expect(runner.requests).toHaveLength(1);
  });
});
