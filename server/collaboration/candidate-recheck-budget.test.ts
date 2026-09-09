import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import { readCandidateRecheckBudget, reserveCandidateRecheck, type CandidateRecheckReservationInput } from "./candidate-recheck-budget.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { markRestoredLedgerForReview } from "./restore-guard.ts";
import { startCollaborationService } from "./service.ts";
import { reserveVerification } from "./verification-lifecycle.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-recheck-budget-")); roots.push(root);
  const repository = join(root, "repository"); mkdirSync(repository);
  const service = startCollaborationService({ dataDirectory: root,
    planning: { planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [repository] } } });
  const accepted = new FakeDingTalkAdapter(message => service.ingestDingTalkMessage(message)).receive({
    sourceEventId: "budget-seed", transportMessageId: "budget-transport", conversationId: "budget-conversation",
    addressedToBot: true, text: "创建新任务：更新测试页", receivedAt: 1000,
    sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1", displayName: "Contributor" },
  });
  if (!accepted.accepted || !accepted.workItemId) throw new Error("fixture_work_item_missing");
  service.reviseWorkItemDefinition(accepted.workItemId, { goal: "更新测试页", goalConfirmed: true, repository,
    acceptanceConditions: [{ description: "显示筛选结果", observation: "结果符合筛选条件" }], blockingAmbiguities: [] }, 2000);
  service.close();
  const path = join(root, "collaboration", "collaboration.sqlite");
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON"); databases.push(db);
  // SAFETY: The fixture publishes one modify node before creating its succeeded candidate.
  const modify = db.prepare("SELECT node_id,assigned_agent_id FROM collaboration_work_nodes WHERE work_item_id=? AND node_type='modify' AND active=1")
    .get(accepted.workItemId) as { node_id: string; assigned_agent_id: string };
  const runId = "budget-run", candidateSha = "b".repeat(40), contractHash = "c".repeat(64);
  db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES(?,?,1,?,1,?,'thread','turn','succeeded',?,?,'candidate',?,?,3000,3100)")
    .run(runId, accepted.workItemId, modify.node_id, modify.assigned_agent_id, repository, repository, "a".repeat(40), candidateSha);
  db.prepare("INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES('budget-candidate',?,'target_tests_passed',?,?,?,'[]','{}',3100)")
    .run(runId, "a".repeat(40), candidateSha, JSON.stringify(["app/page.tsx"]));
  const instance = new InstanceLeaseCoordinator(db, "budget-instance").acquire(4000, 100000)!;
  const sessionId = reserveVerification(db, runId, instance, 4001);
  const input: CandidateRecheckReservationInput = { sessionId, candidateRunId: runId, candidateSha, contractHash,
    verifierAttempt: 2, instance, now: 4002, readCurrentContractHash: () => contractHash };
  return { db, path, input, workItemId: accepted.workItemId };
}

function nextSession(item: ReturnType<typeof fixture>, previous: CandidateRecheckReservationInput, verifierAttempt: number, contractHash = previous.contractHash) {
  // This fixture settles a reservation with no command launches, not a successful test execution.
  item.db.prepare("INSERT INTO collaboration_verification_settlements(session_id,evidence_json,created_at) VALUES(?,'[]',?)")
    .run(previous.sessionId, previous.now + 1);
  const sessionId = reserveVerification(item.db, previous.candidateRunId, previous.instance, previous.now + 2);
  return { ...previous, sessionId, contractHash, verifierAttempt, now: previous.now + 3, readCurrentContractHash: () => contractHash };
}

describe("durable supplemental self-check budget", () => {
  it("reserves the attempt before commands and retains its complete binding on another connection", () => {
    const { db, path, input } = fixture();
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash)).toEqual({ count: 0, maxVerifierAttempt: 0 });
    const receipt = reserveCandidateRecheck(db, input);
    expect(receipt).toEqual({ sessionId: input.sessionId, candidateRunId: input.candidateRunId, candidateSha: input.candidateSha,
      contractHash: input.contractHash, attempt: 1, verifierAttempt: 2, instanceOwner: input.instance.ownerId,
      instanceFence: input.instance.fence, createdAt: input.now });
    const reopened = new DatabaseSync(path); databases.push(reopened);
    expect(readCandidateRecheckBudget(reopened, input.candidateRunId, input.contractHash)).toEqual({ count: 1, maxVerifierAttempt: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_verification_commands").get()).toEqual({ n: 0 });
  });
  it("replays the exact open-session binding without charging twice, including after reconnect", () => {
    const { db, path, input } = fixture();
    const first = reserveCandidateRecheck(db, input);
    const reopened = new DatabaseSync(path); databases.push(reopened);
    expect(reserveCandidateRecheck(reopened, { ...input, now: input.now + 1 })).toEqual(first);
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash)).toEqual({ count: 1, maxVerifierAttempt: 2 });
  });

  it.each([
    { candidateRunId: "other-run" }, { candidateSha: "d".repeat(40) }, { contractHash: "d".repeat(64) }, { verifierAttempt: 3 },
  ])("rejects reusing a session for a different binding: %j", change => {
    const { db, input } = fixture(); reserveCandidateRecheck(db, input);
    expect(() => reserveCandidateRecheck(db, { ...input, ...change })).toThrow("candidate_recheck_binding_mismatch");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash)).toEqual({ count: 1, maxVerifierAttempt: 2 });
  });

  it("charges pre-command crashes/cancellations and refuses a fourth reservation across sessions", () => {
    const item = fixture(); let input = item.input;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(reserveCandidateRecheck(item.db, input).attempt).toBe(attempt);
      expect(reserveCandidateRecheck(item.db, input).attempt).toBe(attempt);
      input = nextSession(item, input, input.verifierAttempt + 1);
    }
    expect(() => reserveCandidateRecheck(item.db, input)).toThrow("candidate_recheck_attempt_limit_exhausted");
    expect(readCandidateRecheckBudget(item.db, input.candidateRunId, input.contractHash)).toEqual({ count: 3, maxVerifierAttempt: 4 });
    expect(item.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_reviews").get()).toEqual({ n: 0 });
  });

  it("keeps the verifier high-water mark run-wide without mixing genuine contract budgets", () => {
    const item = fixture(); reserveCandidateRecheck(item.db, item.input);
    const changed = nextSession(item, item.input, 9, "d".repeat(64));
    expect(reserveCandidateRecheck(item.db, changed).attempt).toBe(1);
    expect(readCandidateRecheckBudget(item.db, changed.candidateRunId, changed.contractHash)).toEqual({ count: 1, maxVerifierAttempt: 9 });
    expect(readCandidateRecheckBudget(item.db, changed.candidateRunId, item.input.contractHash)).toEqual({ count: 1, maxVerifierAttempt: 9 });
    expect(readCandidateRecheckBudget(item.db, "other-run", changed.contractHash)).toEqual({ count: 0, maxVerifierAttempt: 0 });
    const next = nextSession(item, changed, 2);
    expect(() => reserveCandidateRecheck(item.db, next)).toThrow("candidate_recheck_verifier_attempt_stale");
    expect(() => reserveCandidateRecheck(item.db, { ...next, verifierAttempt: 3 })).toThrow("candidate_recheck_verifier_attempt_stale");
  });

  it("cannot refund or rewrite a reservation through SQL", () => {
    const { db, input } = fixture(); reserveCandidateRecheck(db, input);
    expect(() => db.exec("DELETE FROM collaboration_candidate_recheck_attempts")).toThrow("immutable");
    expect(() => db.prepare("UPDATE collaboration_candidate_recheck_attempts SET contract_hash=?").run("d".repeat(64))).toThrow("immutable");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(1);
  });

  it.each(["sha", "owner", "fence", "settled", "finalizing", "commands"])("enforces immutable session binding even on SQL inserts: %s", mode => {
    const { db, input } = fixture();
    if (mode === "settled") db.prepare("INSERT INTO collaboration_verification_settlements VALUES(?,'[]',?)").run(input.sessionId, input.now);
    if (mode === "finalizing") db.prepare("INSERT INTO collaboration_verification_finalization_intents VALUES(?,0,?)").run(input.sessionId, input.now);
    if (mode === "commands") db.prepare("INSERT INTO collaboration_verification_commands VALUES(?,1,'{}',?)").run(input.sessionId, input.now);
    expect(() => db.prepare("INSERT INTO collaboration_candidate_recheck_attempts VALUES(?,?,?,?,1,?,?,?,?)")
      .run(input.sessionId, input.candidateRunId, mode === "sha" ? "d".repeat(40) : input.candidateSha, input.contractHash,
        input.verifierAttempt, mode === "owner" ? "different-owner" : input.instance.ownerId,
        mode === "fence" ? input.instance.fence + 1 : input.instance.fence, input.now)).toThrow("candidate recheck session binding mismatch");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it("does not expose callback errors or charge budget when the contract reader fails", () => {
    const { db, input } = fixture();
    expect(() => reserveCandidateRecheck(db, { ...input, readCurrentContractHash: () => { throw new Error("private-config-value"); } }))
      .toThrow(/^candidate_recheck_target_changed$/);
    expect(db.isTransaction).toBe(false);
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it.each([null, "d".repeat(64)])("rejects a missing or changed current contract inside the transaction: %s", currentHash => {
    const { db, input } = fixture(); let called = false;
    expect(() => reserveCandidateRecheck(db, { ...input, readCurrentContractHash: () => {
      called = true; expect(db.isTransaction).toBe(true); return currentHash;
    } })).toThrow("candidate_recheck_target_changed");
    expect(called).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it("does not replay a reservation after its live contract changes", () => {
    const { db, input } = fixture(); reserveCandidateRecheck(db, input);
    expect(() => reserveCandidateRecheck(db, { ...input, readCurrentContractHash: () => null })).toThrow("candidate_recheck_target_changed");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(1);
  });

  it.each([
    "UPDATE collaboration_work_items SET control_state='paused'",
    "UPDATE collaboration_work_items SET control_state='cancelled',status='cancelled'",
    "UPDATE collaboration_work_items SET definition_status='collecting'",
    "UPDATE collaboration_work_items SET current_plan_revision=NULL",
    "UPDATE collaboration_runs SET status='failed'",
  ])("refuses a stale session target without consuming budget: %s", sql => {
    const { db, input } = fixture(); db.exec(sql);
    expect(() => reserveCandidateRecheck(db, input)).toThrow("candidate_recheck_target_changed");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it.each([{ sessionId: "missing-session" }, { candidateRunId: "missing-run" }, { candidateSha: "d".repeat(40) }])(
    "refuses a new reservation not matching the immutable session target: %j", change => {
      const { db, input } = fixture();
      expect(() => reserveCandidateRecheck(db, { ...input, ...change })).toThrow("candidate_recheck_target_changed");
      expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
    });

  it("rejects a superseded run even if its old successful candidate remains", () => {
    const { db, input } = fixture();
    db.exec("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) SELECT 'newer-run',work_item_id,plan_revision,node_id,2,agent_id,'new-thread','new-turn','failed',repository_path,worktree_path,'new-candidate',base_sha,NULL,4000,4001 FROM collaboration_runs");
    expect(() => reserveCandidateRecheck(db, input)).toThrow("candidate_recheck_target_changed");
  });

  it.each(["settled", "finalizing"])("never reopens a %s verification session", state => {
    const { db, input } = fixture(); reserveCandidateRecheck(db, input);
    if (state === "settled") db.prepare("INSERT INTO collaboration_verification_settlements VALUES(?,'[]',?)").run(input.sessionId, input.now + 1);
    else db.prepare("INSERT INTO collaboration_verification_finalization_intents VALUES(?,0,?)").run(input.sessionId, input.now + 1);
    expect(() => reserveCandidateRecheck(db, input)).toThrow("candidate_recheck_target_changed");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(1);
  });

  it("requires budget before the first actual command rather than permitting retroactive reservations", () => {
    const { db, input } = fixture();
    db.prepare("INSERT INTO collaboration_verification_commands VALUES(?,1,'{}',?)").run(input.sessionId, input.now);
    expect(() => reserveCandidateRecheck(db, input)).toThrow("candidate_recheck_commands_started");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it.each(["wrong_owner", "wrong_fence", "expired", "restored"])("preserves existing authority gates: %s", mode => {
    const { db, input } = fixture();
    if (mode === "restored") markRestoredLedgerForReview(db, Buffer.from("synthetic backup"), input.now);
    const altered = { ...input, now: mode === "expired" ? 200000 : input.now,
      instance: { ownerId: mode === "wrong_owner" ? "another-instance" : input.instance.ownerId,
        fence: mode === "wrong_fence" ? 2 : input.instance.fence } };
    expect(() => reserveCandidateRecheck(db, altered)).toThrow();
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });

  it.each([
    { sessionId: "" }, { candidateRunId: "" }, { candidateSha: "not-a-sha" }, { contractHash: "not-a-digest" },
    { verifierAttempt: 0 }, { verifierAttempt: 1.5 }, { verifierAttempt: Number.MAX_SAFE_INTEGER + 1 }, { now: Number.NaN },
  ])("rejects malformed binding inputs before writes: %j", change => {
    const { db, input } = fixture();
    expect(() => reserveCandidateRecheck(db, { ...input, ...change })).toThrow("candidate_recheck_input_invalid");
    expect(readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash).count).toBe(0);
  });
});
