import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import {
  CandidateVerificationCoordinator,
  candidateHasPassedMetaReview,
  candidateHasPassedTechnicalReview,
  completedCandidateHasPassedMetaReview,
  readCandidateTechnicalAcceptance,
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
import { acceptanceEvidencePolicySchema, type AcceptanceEvidencePolicy } from "./acceptance-evidence.ts";
import { prepareVerifiedCandidateResult, isCurrentCandidateResultDelivery } from "./candidate-result-completion.ts";
import { candidateResultDeliveryProof, confirmCandidateResultDelivery } from "./candidate-result-evidence.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";

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

function fixture(observation = "pnpm test target 验证候选结果", selfReport = true, mapping = false, discovery = false,
  acceptanceConditions?: readonly { description: string; observation: string }[], outsideChange = false): Fixture {
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
  if(discovery) writeFileSync(join(repository,".gitignore"),".self-cache\n");
  if (mapping || discovery) {
    writeFileSync(join(repository, "src", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('候选值更新',()=>assert.equal(readFileSync('src/value.txt','utf8'),'after\\n'));\n");
    writeFileSync(join(repository, "src", "value.mjs"), 'export function display(value) { return value; }\n');
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["worktree", "add", "-b", `candidate-${id}`, worktree, baseSha]);
  writeFileSync(join(worktree, "src", "value.txt"), "after\n");
  if (outsideChange) writeFileSync(join(worktree, "other-page.html"), "forbidden page change\n");
  if (discovery) writeFileSync(join(worktree,"src","new.test.mjs"),"import test from 'node:test'; import assert from 'node:assert/strict'; test('new behavior',()=>assert.equal(1,1));\n");
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
    acceptanceConditions: acceptanceConditions ? [...acceptanceConditions] : [{ description: "候选值已经更新", observation }],
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
    `evidence-${id}`, runId, "pnpm test target", JSON.stringify(discovery ? ["node","--test","src/value.test.mjs"] : ["node", "test"]), worktree,
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
      "pnpm test target": discovery ? {argv:["node","--test","src/value.test.mjs"],timeoutMs:5000,maxOutputBytes:32000,assertionReporter:"node-test-v1",
        nodeTestDiscovery:{directories:["src"]},assertionContract:{format:"omb-assertions-v1",bindings:[{conditionHash:acceptanceConditionHash({description:"候选值已经更新",observation}),assertionIds:["value-updated","new-behavior"]}]}}
      : mapping ? { argv: ["node", "--test", "src/value.test.mjs"], timeoutMs: 5000, maxOutputBytes: 32000, assertionReporter: "node-test-v1" } : { argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000, maxOutputBytes: 32_000,
        assertionContract: { format: "omb-assertions-v1", bindings: acceptanceConditions ? acceptanceConditions.slice(0, 3).map(condition => ({ conditionHash: acceptanceConditionHash(condition), assertionIds: ["value-updated"] }))
          : [{ conditionHash: acceptanceConditionHash({ description: "候选值已经更新", observation: "pnpm test target 验证候选结果" }), assertionIds: ["value-updated"] }] } },
    },
  };
}

const releaseConditions = [
  { description: "“发布验收室”的检查项列表支持全部、P0、P1、P2四个优先级筛选选项。", observation: "选择P0、P1或P2时只显示对应优先级的检查项；选择全部时不按优先级限制列表。" },
  { description: "优先级筛选与现有状态筛选、搜索共同生效。", observation: "同时设置优先级、状态和搜索条件后，列表只显示同时满足这些条件的检查项。" },
  { description: "没有匹配检查项时保留现有空结果提示。", observation: "筛选或搜索组合没有匹配项时，页面显示空结果提示。" },
  { description: "变更范围仅限该测试页面。", observation: "其他页面不发生本次需求引起的变更。" },
  { description: "完成后进行自动回归，并用两三句话反馈变更内容和验证结果。", observation: "交付反馈包含本次修改内容及自动回归是否通过的实际结果，长度为两三句话。" },
];
function fixtureSpec(item: Fixture, includeModifyScope = false) {
  // SAFETY: The fixture owns this single published plan and snapshot; these fields reconstruct the independent expected Spec identity.
  const row = item.database.prepare("SELECT p.snapshot_revision,p.proposal_hash,s.goal,s.facts_json,s.assumptions_json,s.acceptance_json,s.blocking_ambiguities_json," +
    "v.read_scope_json,v.deny_scope_json,m.write_scope_json,m.deny_scope_json AS modify_deny_scope_json " +
    "FROM collaboration_plan_revisions p JOIN collaboration_work_item_snapshots s ON s.work_item_id=p.work_item_id AND s.revision=p.snapshot_revision " +
    "JOIN collaboration_work_nodes v ON v.work_item_id=p.work_item_id AND v.plan_revision=p.revision AND v.node_type='validate' " +
    "JOIN collaboration_work_nodes m ON m.work_item_id=p.work_item_id AND m.plan_revision=p.revision AND m.node_type='modify' WHERE p.work_item_id=? AND p.revision=1")
    .get(item.workItemId) as { snapshot_revision: number; proposal_hash: string; goal: string; facts_json: string; assumptions_json: string;
      acceptance_json: string; blocking_ambiguities_json: string; read_scope_json: string; deny_scope_json: string; write_scope_json: string; modify_deny_scope_json: string };
  const spec = { workItemId: item.workItemId, planRevision: 1,
    snapshotRevision: row.snapshot_revision, proposalHash: row.proposal_hash, verifierReadScope: JSON.parse(row.read_scope_json), verifierDenyScope: JSON.parse(row.deny_scope_json),
    goal: row.goal, facts: JSON.parse(row.facts_json), assumptions: JSON.parse(row.assumptions_json), acceptance: JSON.parse(row.acceptance_json), blockingAmbiguities: JSON.parse(row.blocking_ambiguities_json),
  };
  return includeModifyScope ? { ...spec, modifyWriteScope: JSON.parse(row.write_scope_json), modifyDenyScope: JSON.parse(row.modify_deny_scope_json) } : spec;
}
function typedPolicy(item: Fixture): AcceptanceEvidencePolicy {
  const specIdentityHash = createHash("sha256").update(JSON.stringify(fixtureSpec(item, true))).digest("hex");
  return acceptanceEvidencePolicySchema.parse({ version: 1, policyId: "release-board-test", specIdentityHash,
    conditions: releaseConditions.map((condition, index) => ({ conditionHash: acceptanceConditionHash(condition), requirements: index < 3 ? [{ type: "assertions" }]
      : index === 3 ? [{ type: "git_scope", allowedPaths: ["src/**"], deniedPaths: [] }]
      : [{ type: "regression", commandIds: ["pnpm test target"] }, { type: "reply", minSentences: 2, maxSentences: 3 }] })),
  });
}
function typedCoordinator(item: Fixture, runner: SandboxedCommandRunner, policies: readonly AcceptanceEvidencePolicy[]) {
  return new CandidateVerificationCoordinator(item.database, { commandRunner: runner, containment: new FakeContainment(), commands: item.commands,
    dataDirectory: item.dataDirectory, acceptanceEvidencePolicies: policies });
}
function publishTyped(item: Fixture, policies: readonly AcceptanceEvidencePolicy[]) {
  publishVerificationRuntimePolicy(item.database, { instance: { ownerId: "instance-1", fence: 1 }, now: Date.now(),
    repositories: { [item.repository]: { targetCommands: item.commands } }, acceptanceEvidencePolicies: policies });
}

function preparedResult(item: Fixture) {
  // SAFETY: This test creates exactly one bound result for its sole candidate; the join supplies the real Outbox payload and dedupe identity.
  const outbox = item.database.prepare("SELECT o.id,o.payload_json,o.dedupe_key FROM collaboration_outbox o " +
    "JOIN collaboration_candidate_result_bindings b ON b.outbox_id=o.id WHERE b.candidate_run_id=?").get(item.runId) as
    { id: string; payload_json: string; dedupe_key: string } | undefined;
  if (!outbox) throw new Error("fixture result Outbox missing");
  // SAFETY: The fixture ingests one real normalized DingTalk source event associated with this Work Item.
  const source = item.database.prepare("SELECT source_event_id FROM collaboration_external_events WHERE work_item_id=? AND source='dingtalk' ORDER BY received_at LIMIT 1")
    .get(item.workItemId) as { source_event_id: string };
  const card = JSON.parse(outbox.payload_json);
  const proof = candidateResultDeliveryProof(card, source.source_event_id, { outboxId: outbox.id, idempotencyKey: JSON.stringify([outbox.id, outbox.dedupe_key]),
    channel: "session", destination: source.source_event_id, confirmationKind: "business_response" });
  if (!proof) throw new Error("fixture actual serialization proof missing");
  return { outbox, card, proof };
}

describe("typed evidence for the five unchanged release-room conditions", () => {
  it("prepares one real two-sentence result, completes only after bound delivery and does not enqueue another completion message", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)];
    item.database.prepare("UPDATE collaboration_work_nodes SET risk='low' WHERE work_item_id=?").run(item.workItemId);
    publishTyped(item, policies);
    expect((await typedCoordinator(item, new FakeRunner(), policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 })).passed).toBe(true);
    expect(prepareVerifiedCandidateResult(item.database, item.runId, 5000)).toBe("pending");
    const result = preparedResult(item);
    expect(prepareVerifiedCandidateResult(item.database, item.runId, 5001)).toBe("pending");
    expect(renderDingTalkSessionMessage(result.card)).toMatchObject({ markdown: { text: result.card.summary } });
    expect(result.card.summary.match(/[^。！？!?]+[。！？!?]/gu)).toHaveLength(2);
    expect(result.card.summary).not.toMatch(/修改(?:已)?完成|任务(?:已)?完成|已验收/u);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    item.database.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=6000,delivery_sequence=1 WHERE id=?").run(result.outbox.id);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    confirmCandidateResultDelivery(item.database, result.outbox.id, result.proof, 6000);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(true);
    expect(prepareVerifiedCandidateResult(item.database, item.runId, 6001)).toBe("delivered");
    const before = item.database.prepare("SELECT count(*) AS count FROM collaboration_outbox").get();
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "delivery-completion", now: 6002 }).completed).toBe(true);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_outbox").get()).toEqual(before);
    expect(completedCandidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(true);
    confirmCandidateResultDelivery(item.database, result.outbox.id, result.proof, 6000);
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "delivery-completion-replay", now: 6003 }).completed).toBe(false);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_result_deliveries").get()).toEqual({ count: 1 });
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_outbox").get()).toEqual(before);
  });
  it("retains a late delivery fact after cancellation without reopening or completing the candidate on replay", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)];
    publishTyped(item, policies);
    await typedCoordinator(item, new FakeRunner(), policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(prepareVerifiedCandidateResult(item.database, item.runId, 5000)).toBe("pending");
    const result = preparedResult(item);
    expect(isCurrentCandidateResultDelivery(item.database, result.outbox)).toBe(true);
    item.database.prepare("UPDATE collaboration_work_items SET control_state='cancelled',version=version+1 WHERE id=?").run(item.workItemId);
    expect(isCurrentCandidateResultDelivery(item.database, result.outbox)).toBe(false);
    const before = item.database.prepare("SELECT count(*) AS count FROM collaboration_outbox").get();
    item.database.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=6000,delivery_sequence=1 WHERE id=?").run(result.outbox.id);
    confirmCandidateResultDelivery(item.database, result.outbox.id, result.proof, 6000);
    confirmCandidateResultDelivery(item.database, result.outbox.id, result.proof, 6000);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(prepareVerifiedCandidateResult(item.database, item.runId, 6001)).toBe("not_required");
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId,
      sourceEventId: "cancelled-delivery-replay", now: 6002 }).completed).toBe(false);
    expect(item.database.prepare("SELECT control_state,accepted_candidate_sha FROM collaboration_work_items WHERE id=?").get(item.workItemId))
      .toEqual({ control_state: "cancelled", accepted_candidate_sha: null });
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_result_deliveries").get()).toEqual({ count: 1 });
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_outbox").get()).toEqual(before);
  });
  it("passes technical readiness but blocks every final gate until the actual reply is verified", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)], runner = new FakeRunner();
    publishTyped(item, policies);
    const coordinator = typedCoordinator(item, runner, policies);
    const input = { candidateRunId: item.runId, worktreePath: item.worktree, instance: { ownerId: "instance-1", fence: 1 }, now: 4000 };
    const outcome = await coordinator.verify(input);
    expect(outcome.passed).toBe(true);
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(true);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(readCandidateTechnicalAcceptance(item.database, item.runId, item.candidateSha)).toMatchObject({ specHash: outcome.specHash,
      specIdentityHash: policies[0].specIdentityHash, policy: policies[0], workItemId: item.workItemId, planRevision: 1 });
    expect(completeVerifiedLowRiskCandidate(item.database, { workItemId: item.workItemId, runId: item.runId, sourceEventId: "before-real-reply", now: 5000 }).completed).toBe(false);
    expect((await coordinator.verify(input)).verifierAttempt).toBe(outcome.verifierAttempt);
    expect(runner.requests).toHaveLength(1);
    // SAFETY: The fixture produced exactly one Meta receipt; inspect its original-condition evidence, not any model interpretation.
    const saved = item.database.prepare("SELECT verdict_json FROM collaboration_candidate_reviews WHERE candidate_run_id=? AND stage='meta'").get(item.runId) as { verdict_json: string };
    expect(JSON.parse(saved.verdict_json).coverage.map((entry: { conditionHash: string; state: string }) => [entry.conditionHash, entry.state]))
      .toEqual(releaseConditions.map((condition, index) => [acceptanceConditionHash(condition), index === 4 ? "missing" : "passed"]));
  });
  it("requires a published current policy and does not treat an unrelated Spec policy as classification authority", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions), selected = typedPolicy(item), runner = new FakeRunner();
    const input = { candidateRunId: item.runId, worktreePath: item.worktree, instance: { ownerId: "instance-1", fence: 1 }, now: 4000 };
    expect((await typedCoordinator(item, runner, [selected]).verify(input)).passed).toBe(false);
    expect(runner.requests).toHaveLength(0);
    const unrelated = { ...selected, specIdentityHash: "f".repeat(64) };
    publishTyped(item, [unrelated]);
    expect((await typedCoordinator(item, runner, [unrelated]).verify(input)).passed).toBe(false);
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("rejects a real out-of-scope candidate even when the candidate path summary claims only allowed changes", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions, true), policies = [typedPolicy(item)], runner = new FakeRunner();
    publishTyped(item, policies);
    const result = await typedCoordinator(item, runner, policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("acceptance_git_scope_incomplete");
    expect(runner.requests).toHaveLength(0);
  });
  it.each(["base", "candidate"] as const)("reconstructs the Git proof at read time and rejects a removed %s object", async object => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)];
    publishTyped(item, policies);
    expect((await typedCoordinator(item, new FakeRunner(), policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 })).passed).toBe(true);
    const identity = readCandidateTechnicalAcceptance(item.database, item.runId, item.candidateSha);
    expect(identity).not.toBeNull();
    const sha = object === "candidate" ? item.candidateSha : identity!.baseSha;
    rmSync(join(item.repository, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(readCandidateTechnicalAcceptance(item.database, item.runId, item.candidateSha)).toBeNull();
  });
  it("rejects removal of typed fields from otherwise passed review receipts instead of falling back to legacy assertions", async () => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)];
    publishTyped(item, policies);
    await typedCoordinator(item, new FakeRunner(), policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    item.database.prepare("INSERT INTO collaboration_candidate_reviews(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
      "SELECT id||'-stripped',candidate_run_id,stage,2,status,agent_id,snapshot_revision,spec_hash,candidate_sha," +
      "json_set(json_remove(verdict_json,'$.acceptanceEvidencePolicies','$.acceptanceEvidencePolicyHash','$.configuredCommands'),'$.verifierAttempt',2),5000 " +
      "FROM collaboration_candidate_reviews WHERE candidate_run_id=?").run(item.runId);
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it.each(["remove", "unrelated-addition", "change-classification"] as const)("revokes cached technical readiness after trusted policy %s", async change => {
    const item = fixture(undefined, true, false, false, releaseConditions), policies = [typedPolicy(item)];
    publishTyped(item, policies);
    await typedCoordinator(item, new FakeRunner(), policies).verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(true);
    const changed = structuredClone(policies);
    if (change === "remove") changed.splice(0);
    else if (change === "unrelated-addition") changed.push({ ...changed[0], specIdentityHash: "f".repeat(64), policyId: "another-spec" });
    else changed[0].conditions[3].requirements = [{ type: "assertions" }];
    const now = Date.now() + 700_000;
    const instance = new InstanceLeaseCoordinator(item.database, "replacement").acquire(now, 600_000);
    if (!instance) throw new Error("fixture replacement lease missing");
    publishVerificationRuntimePolicy(item.database, { instance, now, repositories: { [item.repository]: { targetCommands: item.commands } }, acceptanceEvidencePolicies: changed });
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(false);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
  it("maps only the original assertion conditions and accepts independently run ordinary regression commands", async () => {
    const item = fixture(undefined, true, true, false, releaseConditions), harness = mappingHarness(item);
    item.commands["pnpm check"] = { argv: ["node", "-e", "process.exit(0)"], timeoutMs: 5000, maxOutputBytes: 32000 };
    item.database.prepare("UPDATE collaboration_work_nodes SET commands_json=? WHERE work_item_id=? AND node_type='validate'")
      .run(JSON.stringify(["pnpm test target", "pnpm check"]), item.workItemId);
    item.database.prepare("INSERT INTO collaboration_test_evidence(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at,containment_binding_json) " +
      "SELECT id||'-ordinary',run_id,'pnpm check',?,cwd,0,5,'ordinary regression passed','',state,created_at," +
      "json_set(containment_binding_json,'$.commandId','pnpm check') FROM collaboration_test_evidence WHERE run_id=?")
      .run(JSON.stringify(item.commands["pnpm check"].argv), item.runId);
    const selected = typedPolicy(item);
    selected.conditions[4].requirements = [{ type: "regression", commandIds: ["pnpm check"] }, { type: "reply", minSentences: 2, maxSentences: 3 }];
    const seen: string[][] = [];
    harness.proposer.complete = async input => {
      const request = JSON.parse(input.user);
      seen.push(request.conditions.map(acceptanceConditionHash));
      expect(request.sources.every((source: { commandId: string }) => source.commandId === "pnpm test target")).toBe(true);
      return { version: 2, requestHash: request.requestHash, bindings: request.conditions.map((condition: { description: string; observation: string }) => ({
        conditionHash: acceptanceConditionHash(condition), commandId: request.sources[0].commandId, file: request.sources[0].file, testName: "候选值更新",
        startLine: 1, endLine: request.sources[0].numberedLines.length, rationale: "fixture assertion mapping",
      })) };
    };
    harness.verifier.complete = async input => {
      const request = JSON.parse(input.user);
      expect(request.request.conditions.map((condition: { description: string; observation: string }) => ({ description: condition.description, observation: condition.observation })))
        .toEqual(releaseConditions.slice(0, 3));
      return { version: 1, requestHash: request.requestHash, proposalHash: request.proposalHash,
        findings: request.request.conditions.map((condition: { description: string; observation: string }) => ({ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "fixture review" })) };
    };
    const runner = new FakeRunner(request => ({ stdout: request.containmentBinding.commandId === "pnpm check" ? Buffer.from("ordinary regression passed")
      : Buffer.from(JSON.stringify({ version: 1, runId: request.containmentBinding.runId, nonce: request.containmentBinding.nonce,
        assertions: [{ id: nodeTestAssertionId("src/value.test.mjs", "候选值更新"), state: "passed" }] })),
      attestation: { sandboxEnforced: true, writableRoot: request.sandbox.writableRoot, deniedPaths: [...request.sandbox.deniedPaths], network: "deny",
        processIsolated: true, processTreeReaped: true, containmentProof: proof(request.containmentBinding), assertionReporter: "node-test-v1" } }));
    const acceptanceMapping = { proposer: harness.proposer, verifier: harness.verifier, policyId: "fixture-v1" };
    publishVerificationRuntimePolicy(item.database, { instance: { ownerId: "instance-1", fence: 1 }, now: Date.now(),
      repositories: { [item.repository]: { targetCommands: item.commands } }, mappingPolicy: acceptanceMapping.policyId, acceptanceEvidencePolicies: [selected] });
    const coordinator = new CandidateVerificationCoordinator(item.database, { commandRunner: runner, containment: new FakeContainment(), commands: item.commands,
      dataDirectory: item.dataDirectory, acceptanceEvidencePolicies: [selected], acceptanceMapping });
    const outcome = await coordinator.verify({ candidateRunId: item.runId, worktreePath: item.worktree, instance: { ownerId: "instance-1", fence: 1 }, now: 4000 });
    expect(outcome).toMatchObject({ passed: true, reasons: [] });
    expect(seen).toEqual([releaseConditions.slice(0, 3).map(acceptanceConditionHash)]);
    expect(runner.requests.map(request => request.containmentBinding.commandId)).toEqual(["pnpm test target", "pnpm check"]);
    expect(candidateHasPassedTechnicalReview(item.database, item.runId, item.candidateSha)).toBe(true);
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(false);
  });
});

class IsolatedRecheckRunner implements SandboxedCommandRunner {
  readonly requests:SandboxedCommandRequest[]=[];
  constructor(private readonly operation:(request:SandboxedCommandRequest,index:number)=>void=()=>{}) {}
  async run(request:SandboxedCommandRequest):Promise<SandboxedCommandResult> {
    this.requests.push(request);
    const containmentProof={identity:{...proofIdentity,opaqueId:`isolated-${request.containmentBinding.nonce}`},receipt:containmentBindingHash(request.containmentBinding)};
    await request.registerContainment(containmentProof);
    this.operation(request,this.requests.length);
    return {exitCode:0,stdout:Buffer.from(JSON.stringify({version:1,runId:request.containmentBinding.runId,nonce:request.containmentBinding.nonce,
      assertions:[{id:"value-updated",state:"passed"},{id:"new-behavior",state:"passed"}]})),stderr:Buffer.alloc(0),durationMs:3,timedOut:false,outputLimitExceeded:false,
      attestation:{sandboxEnforced:true,writableRoot:request.sandbox.writableRoot,deniedPaths:[...request.sandbox.deniedPaths],network:"deny",processIsolated:true,processTreeReaped:true,containmentProof,assertionReporter:"node-test-v1"}};
  }
}

describe("supplemental self-tests for a newly resolved test selection",()=>{
  it("runs missing self coverage and independent verification in separate clean candidate trees without rewriting history",async()=>{
    const item=fixture(undefined,true,false,true),runner=new IsolatedRecheckRunner();
    const original=item.database.prepare("SELECT * FROM collaboration_test_evidence WHERE run_id=?").all(item.runId);
    const result=await verify(item,runner);expect(result.reasons).toEqual([]);expect(result.passed).toBe(true);
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0].containmentBinding.runId).toMatch(/:self-recheck$/u);
    expect(runner.requests[1].sandbox.writableRoot).not.toBe(runner.requests[0].sandbox.writableRoot);
    for(const request of runner.requests) expect(request.argv).toEqual(["node","--test","src/value.test.mjs","src/new.test.mjs"]);
    expect(item.database.prepare("SELECT * FROM collaboration_test_evidence WHERE run_id=?").all(item.runId)).toEqual(original);
    expect(candidateHasPassedMetaReview(item.database,item.runId,item.candidateSha)).toBe(true);
    expect((await verify(item,runner)).passed).toBe(true);expect(runner.requests).toHaveLength(2);
  });
  it("rechecks active control state after self-tests before starting independent verification",async()=>{
    const item=fixture(undefined,true,false,true);
    const runner=new IsolatedRecheckRunner((_request,index)=>{if(index===1)item.database.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(item.workItemId);});
    const result=await verify(item,runner);expect(result.passed).toBe(false);expect(runner.requests).toHaveLength(1);
    expect(candidateHasPassedMetaReview(item.database,item.runId,item.candidateSha)).toBe(false);
  });
  it("does not use a generic stdout success message as permission to replace original self-test evidence",async()=>{
    const item=fixture(undefined,false,false,true),runner=new IsolatedRecheckRunner();
    const result=await verify(item,runner);expect(result.passed).toBe(false);expect(runner.requests).toHaveLength(0);
  });
  it("does not share ignored self-test output with independent verification",async()=>{
    const item=fixture(undefined,true,false,true);
    const runner=new IsolatedRecheckRunner((request,index)=>{
      const cache=join(request.sandbox.writableRoot,".self-cache");
      if(index===1) writeFileSync(cache,"must not enter verifier\n"); else expect(existsSync(cache)).toBe(false);
    });
    expect((await verify(item,runner)).passed).toBe(true);expect(runner.requests).toHaveLength(2);
  });
  it("does not refund supplemental attempts when execution throws before the verifier receipt is saved",async()=>{
    const item=fixture(undefined,true,false,true);
    const runner=new IsolatedRecheckRunner(()=>{throw new Error("injected interruption after registration");});
    for(let index=0;index<3;index++) await expect(verify(item,runner)).rejects.toThrow("injected interruption");
    const outcome=await verify(item,runner);expect(outcome.passed).toBe(false);expect(outcome.reasons).toContain("verification_attempt_limit_exhausted");
    expect(runner.requests).toHaveLength(3);
    expect(new Set(runner.requests.map(request=>request.containmentBinding.runId)).size).toBe(3);
    expect(coordinator(item, runner).isCurrentNotification(item.runId, outcome)).toBe(true);
    expect(coordinator(item, runner).isCurrentNotification(item.runId, { ...outcome, verifierAttempt: 2 })).toBe(false);
  });
  it.each(["abort", "pause"] as const)("persists a known registration proof and blocks process start when %s occurs during proof verification", async mode => {
    const item = fixture(), controller = new AbortController(), containment = new FakeContainment();
    const verifyProof = containment.verifyProof.bind(containment);
    containment.verifyProof = async (proof, binding) => {
      const result = await verifyProof(proof, binding);
      if (mode === "abort") controller.abort();
      else item.database.prepare("UPDATE collaboration_work_items SET control_state='paused',version=version+1 WHERE id=?").run(item.workItemId);
      return result;
    };
    let started = false;
    const runner = new FakeRunner(() => { started = true; });
    const verifier = new CandidateVerificationCoordinator(item.database, { commandRunner: runner, containment, commands: item.commands, dataDirectory: item.dataDirectory });
    await expect(verifier.verify({ candidateRunId: item.runId, worktreePath: item.worktree,
      instance: { ownerId: "instance-1", fence: 1 }, now: 4000, signal: controller.signal })).rejects.toThrow();
    expect(started).toBe(false);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_verification_proofs").get()).toEqual({ count: 1 });
    expect(hasUnsettledVerification(item.database, item.repository)).toBe(false);
    expect(item.database.prepare("SELECT count(*) AS count FROM collaboration_candidate_reviews").get()).toEqual({ count: 0 });
  });
});

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
      return { version: 2, requestHash: value.requestHash, bindings: [{ conditionHash: acceptanceConditionHash(value.conditions[0]),
        commandId: value.sources[0].commandId, file: value.sources[0].file, testName: "候选值更新", startLine: 1,
        endLine: value.sources[0].numberedLines.length, rationale: "断言读取值为 after" }] };
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
  it("preserves the legacy contract hash when discovery and typed policies are not configured", async () => {
    const item = fixture();
    const command = item.commands["pnpm test target"];
    const expected = createHash("sha256").update(JSON.stringify({ schemaVersion: 3, mappingPolicy: null, spec: fixtureSpec(item),
      selectedCommands: [{ commandId: "pnpm test target", command: { argv: [...command.argv], cwd: command.cwd ?? null, timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes, assertionContract: command.assertionContract ?? null, assertionReporter: command.assertionReporter ?? null,
        acceptanceSourceFiles: command.acceptanceSourceFiles ?? null } }],
    })).digest("hex");
    const outcome = await verify(item, new FakeRunner());
    expect(outcome).toMatchObject({ passed: true, specHash: expected });
    expect(candidateHasPassedMetaReview(item.database, item.runId, item.candidateSha)).toBe(true);
  });
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
