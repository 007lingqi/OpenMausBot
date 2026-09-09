import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { nodeTestAssertionId } from "./node-test-reporter.ts";
import type { NaturalIntakeModelPort } from "./natural-intake.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { hasUnsettledVerification } from "./verification-lifecycle.ts";
import { CommandCleanupError } from "./execution-limits.ts";
import { completeVerifiedLowRiskCandidate } from "./candidate-approval.ts";
import { publishVerificationRuntimePolicy } from "./verification-runtime-policy.ts";
import { conversationStatus } from "./conversation-context.ts";
import { AcceptanceMappingCoordinator, type MappingResult } from "./acceptance-mapping.ts";

const scratch: string[] = [];
const resources: Array<{ close(): void }> = [];
let sequence = 0;

afterEach(() => {
  vi.restoreAllMocks();
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

function fixture(observation = "pnpm test target 验证候选结果", selfReport = true, mapping = false): Fixture {
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
  if (mapping) {
    writeFileSync(join(repository, "src", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('候选值更新',()=>assert.equal(readFileSync('src/value.txt','utf8'),'after\\n'));\n");
    writeFileSync(join(repository, "src", "value.mjs"), 'export function display(value) { return value; }\n');
  }
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
  new InstanceLeaseCoordinator(database, "instance-1").acquire(Date.now(), 600_000);
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
    0, 5, selfReport ? JSON.stringify({ version: 1, runId, nonce: "fixture-self-test-nonce", assertions: [{ id: mapping ? nodeTestAssertionId("src/value.test.mjs", "候选值更新") : "value-updated", state: "passed" }] }) : "command passed", "", "target_passed", 3_100,
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
      "pnpm test target": mapping ? { argv: ["node", "--test", "src/value.test.mjs"], timeoutMs: 5000, maxOutputBytes: 32000, assertionReporter: "node-test-v1" } : { argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000, maxOutputBytes: 32_000,
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

function legacyUnreadMaterial(item: Fixture): void {
  item.database.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE work_item_id=?")
    .run(JSON.stringify({ text: "按 https://alidocs.dingtalk.com/i/nodes/legacy 修复" }), item.workItemId);
}

describe("live material checks for legacy candidates", () => {
  it("does not run independent verification for unread source material", async () => {
    const item = fixture(); const runner = new FakeRunner(); legacyUnreadMaterial(item);
    await expect(verify(item, runner)).rejects.toThrow("candidate_verification_target_unavailable");
    expect(runner.requests).toHaveLength(0);
    expect(item.database.prepare("SELECT count(*) AS n FROM collaboration_verification_sessions").get()).toEqual({ n: 0 });
  });
  it("revokes cached Meta success and blocks automatic completion when material is no longer complete", async () => {
    const item = fixture(); expect((await verify(item, new FakeRunner())).passed).toBe(true);
    legacyUnreadMaterial(item);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "legacy-auto-complete", now: 5000 }).completed).toBe(false);
    expect(item.database.prepare("SELECT accepted_candidate_sha FROM collaboration_work_items WHERE id=?").get(item.workItemId)).toEqual({ accepted_candidate_sha: null });
  });
});

function mappingHarness(item: Fixture) {
    const proposer: NaturalIntakeModelPort = { async complete(input) {
      const value = JSON.parse(input.user);
      return { version: 1, requestHash: value.requestHash, bindings: [{ conditionHash: acceptanceConditionHash(value.conditions[0]),
        commandId: value.sources[0].commandId, file: value.sources[0].file, testName: "候选值更新", startLine: 1,
        endLine: value.sources[0].text.split("\n").length, quote: value.sources[0].text, rationale: "断言读取值为 after" }] };
    } };
    const verifier: NaturalIntakeModelPort = { async complete(input) {
      const value = JSON.parse(input.user);
      return { version: 1, requestHash: value.requestHash, proposalHash: value.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(value.request.conditions[0]), state: "covered", reason: "已核对读取断言" }] };
    } };
    const runner = new FakeRunner(request => ({ stdout: Buffer.from(JSON.stringify({version:1,runId:request.containmentBinding.runId,nonce:request.containmentBinding.nonce,
      assertions:[{id:nodeTestAssertionId("src/value.test.mjs", "候选值更新"),state:"passed"}]})),
      attestation: { sandboxEnforced:true,writableRoot:request.sandbox.writableRoot,deniedPaths:[...request.sandbox.deniedPaths],network:"deny",processIsolated:true,processTreeReaped:true,containmentProof:proof(request.containmentBinding),assertionReporter:"node-test-v1" } }));
    const coordinator = new CandidateVerificationCoordinator(item.database, { commandRunner: runner, containment: new FakeContainment(), commands:item.commands,
      dataDirectory:item.dataDirectory, acceptanceMapping: {proposer,verifier,policyId:"fixture-v1"} });
    return {proposer,verifier,runner,coordinator};
}

describe("independent candidate verification", () => {
  it.each([
    ["proposal_schema", "proposal_validation"], ["proposal_stale", "proposal_validation"],
    ["binding_invalid", "proposal_validation"], ["coverage_missing", "proposal_validation"],
    ["quote_invalid", "proposal_validation"], ["sensitive_output", "proposal_validation"],
    ["review_schema", "review_validation"], ["review_invalid", "review_validation"],
    ["review_missing", "review_validation"], ["review_uncertain", "review_validation"],
    ["timeout", "review_call"], ["upstream_call", "proposal_call"],
  ])("retains bounded mapping failure %s in the verifier review without approving the candidate", async (failureReason, failureStage) => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    // SAFETY: The mock has a valid status/hash; extra raw output deliberately exercises the diagnostic allowlist.
    vi.spyOn(AcceptanceMappingCoordinator.prototype, "map").mockResolvedValue({
      status: failureReason.startsWith("review_m") || failureReason === "review_uncertain" ? "rejected" : "failed",
      requestHash: "a".repeat(64), failureReason, failureStage, rawOutput: "untrusted-mapping-output",
    } as MappingResult);
    const result = await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(result).toMatchObject({ passed: false, status: "failed", reasons: [`acceptance_mapping_${failureReason}`] });
    // SAFETY: The completed verification just persisted one verifier review with non-null verdict_json for this seeded run.
    const row = item.database.prepare("SELECT verdict_json FROM collaboration_candidate_reviews WHERE candidate_run_id=? AND stage='verifier'")
      .get(item.runId) as { verdict_json: string };
    expect(JSON.parse(row.verdict_json).mappingFailure).toEqual({ reason: failureReason, stage: failureStage });
    expect(row.verdict_json).not.toContain("untrusted-mapping-output");
    expect(h.runner.requests).toHaveLength(0);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it.each(["missing", "unrecognized", "limit"])("keeps %s mapping diagnostics unknown instead of inferring missing tests", async mode => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    // SAFETY: Status/hash remain valid; unrecognized diagnostics are intentional boundary inputs that must be discarded.
    vi.spyOn(AcceptanceMappingCoordinator.prototype, "map").mockResolvedValue({
      status: mode === "limit" ? "limit" : "failed", requestHash: "a".repeat(64),
      failureReason: mode === "unrecognized" ? "untrusted-mapping-output" : undefined,
      failureStage: mode === "unrecognized" ? "untrusted-stage" : undefined,
    } as MappingResult);
    const result = await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(mode === "limit"
      ? ["acceptance_mapping_unknown", "acceptance_mapping_attempt_limit_exhausted"] : ["acceptance_mapping_unknown"]);
    // SAFETY: The completed verification just persisted one verifier review with non-null verdict_json for this seeded run.
    const row = item.database.prepare("SELECT verdict_json FROM collaboration_candidate_reviews WHERE candidate_run_id=? AND stage='verifier'")
      .get(item.runId) as { verdict_json: string };
    expect(JSON.parse(row.verdict_json).mappingFailure).toBeUndefined();
    expect(row.verdict_json).not.toMatch(/untrusted-mapping-output|untrusted-stage|acceptance_mapping_incomplete/);
    expect(h.runner.requests).toHaveLength(0);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("retains the last known mapping failure when the mapping attempt limit is reached", async () => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    vi.spyOn(AcceptanceMappingCoordinator.prototype, "map").mockResolvedValue({
      status: "limit", requestHash: "a".repeat(64), failureReason: "timeout", failureStage: "review_call",
    });
    const result = await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(result.reasons).toEqual(["acceptance_mapping_timeout", "acceptance_mapping_attempt_limit_exhausted"]);
    expect(result.passed).toBe(false);
    expect(h.runner.requests).toHaveLength(0);
  });
  it("reports completion only while the accepted fixed candidate still has current paired evidence", async () => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    item.database.prepare("UPDATE collaboration_work_nodes SET risk='low' WHERE work_item_id=?").run(item.workItemId);
    publishVerificationRuntimePolicy(item.database, { instance: { ownerId: "instance-1", fence: 1 }, now: Date.now(),
      repositories: { [item.repository]: { targetCommands: item.commands } }, mappingPolicy: "fixture-v1" });
    expect((await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 })).passed).toBe(true);
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "completion-query-proof", now: 5000 }).completed).toBe(true);
    expect(conversationStatus(item.database, item.workItemId)).toContain("修改完成，相关检查已通过");
    // Reading a completed result must not reopen the active execution/Owner gate.
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    item.database.prepare("UPDATE collaboration_work_nodes SET read_scope_json='[\"changed-scope\"]' WHERE work_item_id=? AND node_type='validate'").run(item.workItemId);
    expect(conversationStatus(item.database, item.workItemId)).toContain("不能据此确认修改完成");
  });
  it("verifies and reads both review stages under a matching published runtime policy", async () => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    publishVerificationRuntimePolicy(item.database, { instance: { ownerId: "instance-1", fence: 1 }, now: Date.now(),
      repositories: { [item.repository]: { targetCommands: item.commands } }, mappingPolicy: "fixture-v1" });
    expect((await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 })).passed).toBe(true);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(true);
  });
  it("revokes direct completion when the active runtime uses a different model policy, without re-running verification", async () => {
    const item = fixture(undefined, true, true); const h = mappingHarness(item);
    expect((await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 })).passed).toBe(true);
    publishVerificationRuntimePolicy(item.database, { instance: { ownerId: "instance-1", fence: 1 }, now: Date.now(),
      repositories: { [item.repository]: { targetCommands: item.commands } }, mappingPolicy: "different-model-policy" });
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "changed-model-completion", now: 5000 }).completed).toBe(false);
  });
  it.each(["read_scope_json", "deny_scope_json"] as const)("rejects a cached review through the completion gate when %s changes before another verification", async scope => {
    const item = fixture(undefined, true, true);
    item.commands["pnpm test target"].acceptanceSourceFiles = ["src/value.mjs"];
    const h = mappingHarness(item);
    const result = await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(result.passed).toBe(true);
    item.database.prepare(`UPDATE collaboration_work_nodes SET ${scope}=? WHERE work_item_id=? AND node_type='validate'`)
      .run(JSON.stringify(scope === "read_scope_json" ? ["src/value.test.mjs"] : ["src/value.mjs"]), item.workItemId);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "scope-changed-completion", now: 5000 }).completed).toBe(false);
  });
  it("provides configured implementation context to both roles and invalidates cached approval when it changes", async () => {
    const item = fixture(undefined, true, true);
    item.commands["pnpm test target"].acceptanceSourceFiles = ["src/value.mjs"];
    const h = mappingHarness(item); const seen: unknown[] = [];
    for (const role of ["proposer", "verifier"] as const) {
      const complete = h[role].complete.bind(h[role]);
      h[role].complete = async input => {
        const data = JSON.parse(input.user); const sources = (data.request ?? data).sources;
        seen.push(sources.find((source: {role?: string}) => source.role === "implementation"));
        return complete(input);
      };
    }
    const input = { candidateRunId: item.runId, worktreePath: item.worktree, instance: { ownerId: "instance-1", fence: 1 }, now: 4000 };
    const first = await h.coordinator.verify(input);
    expect(first.passed).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ file: "src/value.mjs" }), expect.objectContaining({ file: "src/value.mjs" })]);
    item.commands["pnpm test target"].acceptanceSourceFiles = ["src/missing.mjs"];
    const next = await h.coordinator.verify({ ...input, now: 5000 });
    expect(next.passed).toBe(false);
    expect(next.specHash).not.toBe(first.specHash);
    expect(next.reasons).toContain("acceptance_mapping_unavailable");
    expect(h.runner.requests).toHaveLength(1);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("blocks model calls and test execution for source outside the verifier's current read scope", async () => {
    const item = fixture(undefined, true, true); item.commands["pnpm test target"].acceptanceSourceFiles = ["src/value.mjs"];
    item.database.prepare("UPDATE collaboration_work_nodes SET read_scope_json=? WHERE work_item_id=? AND node_type='validate'")
      .run(JSON.stringify(["src/value.test.mjs"]), item.workItemId);
    const h = mappingHarness(item); h.proposer.complete = vi.fn(h.proposer.complete);
    const outcome = await h.coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("acceptance_mapping_unavailable");
    expect(h.proposer.complete).not.toHaveBeenCalled();
    expect(h.runner.requests).toHaveLength(0);
  });
  it("reserves direct verification before commands and rejects a second connection and independent process", async () => {
    const item = fixture();
    const other = new DatabaseSync(join(item.dataDirectory, "collaboration", "collaboration.sqlite"));
    resources.push(other);
    const runner = new FakeRunner();
    let release!: () => void;
    const original = runner.run.bind(runner);
    runner.run = async request => {
      await new Promise<void>(resolve => { release = resolve; });
      return original(request);
    };
    const running = verify(item, runner);
    void running.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(hasUnsettledVerification(other, item.repository)).toBe(true);
      expect(other.prepare("SELECT count(*) AS n FROM collaboration_verification_commands").get()).toEqual({ n: 1 });
      const secondRunner = new FakeRunner();
      await expect(coordinator({ ...item, database: other }, secondRunner).verify({
        candidateRunId: item.runId, worktreePath: item.worktree,
        instance: { ownerId: "instance-1", fence: 1 }, now: 4000,
      })).rejects.toThrow("verification_repository_unsettled");
      expect(secondRunner.requests).toHaveLength(0);
      const childResult = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        const { CandidateVerificationCoordinator } = await import(process.argv[1]);
        const db = new DatabaseSync(process.argv[2]);
        try {
          const fail = () => { throw new Error('child_must_not_run'); };
          const verifier = new CandidateVerificationCoordinator(db, {
            commandRunner: { run: fail }, containment: { verifyProof: fail, inspect: fail, terminateAndWaitEmpty: fail },
            commands: {}, dataDirectory: process.argv[3],
          });
          try {
            await verifier.verify({ candidateRunId: process.argv[4], worktreePath: process.argv[5],
              instance: { ownerId: 'instance-1', fence: 1 }, now: Date.now() });
            throw new Error('child_verification_was_not_blocked');
          } catch (error) {
            if (error.message !== 'verification_repository_unsettled') throw error;
            console.log('repository_blocked');
          }
        } finally { db.close(); }
      `, new URL("./candidate-verification.ts", import.meta.url).href,
      join(item.dataDirectory, "collaboration", "collaboration.sqlite"), item.dataDirectory, item.runId, item.worktree], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      expect(childResult.trim()).toBe("repository_blocked");
      release();
      expect((await running).passed).toBe(true);
      expect(hasUnsettledVerification(other, item.repository)).toBe(false);
    } finally { release?.(); await running.catch(() => undefined); }
  });

  it("retains direct verification with missing process proof even after lease takeover", async () => {
    const item = fixture();
    const runner: SandboxedCommandRunner = { async run() { throw new CommandCleanupError(new Error("unknown cleanup")); } };
    await expect(verify(item, runner)).rejects.toThrow();
    expect(hasUnsettledVerification(item.database, item.repository)).toBe(true);
    const replacement = new InstanceLeaseCoordinator(item.database, "replacement").acquire(Date.now() + 700_000, 600_000)!;
    const retry = new FakeRunner();
    await expect(coordinator(item, retry).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: replacement, now: Date.now() + 700_000 })).rejects.toThrow("verification_repository_unsettled");
    expect(retry.requests).toHaveLength(0);
  });

  it("does not write a direct verifier result after its lease has been replaced", async () => {
    const item = fixture();
    const runner = new FakeRunner(() => {
      item.database.exec("UPDATE collaboration_instance_lease SET fencing_token=fencing_token+1, version=version+1");
    });
    await expect(verify(item, runner)).rejects.toThrow(CommandCleanupError);
    expect(item.database.prepare("SELECT count(*) AS n FROM collaboration_candidate_reviews").get()).toEqual({ n: 0 });
    expect(hasUnsettledVerification(item.database, item.repository)).toBe(true);
  });

  it("does not record test results when cancelled by a late runner response", async () => {
    const item=fixture(); const controller=new AbortController();
    const runner=new FakeRunner(request => { expect(request.signal).toBe(controller.signal); controller.abort(); return {}; });
    await expect(coordinator(item,runner).verify({candidateRunId:item.runId,worktreePath:item.worktree,
      instance:{ownerId:"instance-1",fence:1},now:4000,signal:controller.signal})).rejects.toThrow();
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_reviews").get()).toEqual({count:0});
  });
  it("stops a pending mapping without test starts or review writes, even when the model ignores abort", async () => {
    const item=fixture(undefined,true,true); const h=mappingHarness(item); const controller=new AbortController();
    const original=h.proposer.complete.bind(h.proposer);
    let release!: () => void;
    h.proposer.complete=async input => { await new Promise<void>(resolve => { release=resolve; }); return original(input); };
    const pending=h.coordinator.verify({candidateRunId:item.runId,worktreePath:item.worktree,instance:{ownerId:"instance-1",fence:1},now:4000,signal:controller.signal});
    const settled=expect(pending).rejects.toThrow("acceptance_mapping_cancelled");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort();
    await settled;
    release();
    await new Promise(resolve => setTimeout(resolve,0));
    expect(h.runner.requests).toHaveLength(0);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_reviews").get()).toEqual({count:0});
  });
  it("rejects a completed-looking review pair that references a nonexistent mapping receipt", async () => {
    const item=fixture();
    expect((await verify(item,new FakeRunner())).passed).toBe(true);
    for(const stage of ["verifier","meta"]) {
      const row=item.database.prepare("SELECT * FROM collaboration_candidate_reviews WHERE candidate_run_id=? AND stage=? ORDER BY attempt DESC LIMIT 1").get(item.runId,stage) as Record<string,string|number>;
      const verdict=JSON.parse(String(row.verdict_json));
      if(stage==="verifier") verdict.mapping={requestHash:"0".repeat(64),policyId:"nonexistent"};
      else verdict.verifierAttempt=2;
      item.database.prepare("INSERT INTO collaboration_candidate_reviews(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) VALUES(?,?,?,2,'passed',?,?,?,?,?,5000)")
        .run(`unproven-${stage}`,item.runId,stage,row.agent_id,row.snapshot_revision,row.spec_hash,row.candidate_sha,JSON.stringify(verdict));
    }
    expect(candidateHasPassedMetaReview(item.database,item.runId,item.candidateSha)).toBe(false);
  });
  it.each(["pause","cancel","spec","candidate","dirty"])("does not run tests after %s changes while mapping is pending", async change => {
    const item=fixture(undefined,true,true); const h=mappingHarness(item);
    const complete=h.proposer.complete.bind(h.proposer);
    h.proposer.complete=async input => {
      if(change==="pause" || change==="cancel") item.database.prepare("UPDATE collaboration_work_items SET control_state=? WHERE id=?").run(change==="pause"?"paused":"cancelled",item.workItemId);
      if(change==="spec") item.service.reviseWorkItemDefinition(item.workItemId,{goal:"新的业务目标",goalConfirmed:true},4100);
      if(change==="candidate") git(item.worktree,["commit","--allow-empty","-m","changed after mapping"]);
      if(change==="dirty") writeFileSync(join(item.worktree,"src/value.txt"),"changed after mapping");
      return complete(input);
    };
    const result=await h.coordinator.verify({candidateRunId:item.runId,worktreePath:item.worktree,instance:{ownerId:"instance-1",fence:1},now:4000});
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("verification_target_changed");
    expect(h.runner.requests).toHaveLength(0);
    expect(candidateHasPassedMetaReview(item.database,item.runId,item.candidateSha)).toBe(false);
  });
  it("automatically binds current source-backed cases and still requires both test stages", async () => {
    const item=fixture(undefined,true,true); const {coordinator}=mappingHarness(item);
    const outcome = await coordinator.verify({candidateRunId:item.runId,worktreePath:item.worktree,instance:{ownerId:"instance-1",fence:1},now:4000});
    expect(outcome.passed).toBe(true);
    expect(candidateHasPassedMetaReview(item.database,item.runId,item.candidateSha)).toBe(true);
    expect(item.commands["pnpm test target"].assertionContract).toBeUndefined();
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_results").get()).toEqual({count:1});
  });
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
