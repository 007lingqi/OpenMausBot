import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyCollaborationMigrations } from "./migrations.ts";
import { appendWorkItemSnapshot } from "./snapshot.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { markRestoredLedgerForReview } from "./restore-guard.ts";
import { authorizeExecutionRecoveryLocally, executionRecoveryCanDispatch, pendingExecutionRecoveryWorkItems,
  reserveExecutionRecovery, assertExecutionRecoveryCanStart, consumeExecutionRecoveryStart, parseExecutionRecoveryRequest } from "./execution-recovery-authorization.ts";

const databases: DatabaseSync[] = [];
const now = 10_000;
const baseSha = "a".repeat(40);
const referenceHash = "b".repeat(64);
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(options: { attempts?: number[]; unsettledAttempt?: number; missingSessionAttempt?: number } = {}) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys=ON"); applyCollaborationMigrations(db);
  db.exec(`INSERT INTO collaboration_principals VALUES('requester','dingtalk','resolved','Requester',1,1);
    INSERT INTO collaboration_conversations VALUES('conversation',1);
    INSERT INTO collaboration_work_items(id,conversation_id,title,status,version,created_by,created_at,updated_at,definition_status,current_plan_revision)
      VALUES('WI-recovery','conversation','Original task','collecting',3,'requester',1,1,'ready_for_execution',1);
    INSERT INTO collaboration_owner_bindings(id,source,sender_corp_id,sender_staff_id,generation,active,created_at)
      VALUES('owner-binding','dingtalk','corp','owner',1,1,1);`);
  appendWorkItemSnapshot(db, "WI-recovery", { goal: "Original task", goalConfirmed: true, repository: "/test/repository",
    acceptanceConditions: [{ description: "Expected change", observation: "Target test" }] }, 2);
  db.prepare("INSERT INTO collaboration_plan_revisions(id,work_item_id,revision,snapshot_revision,status,proposal_hash,created_at) VALUES('plan','WI-recovery',1,1,'published',?,3)").run("c".repeat(64));
  db.exec(`INSERT INTO collaboration_work_nodes(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json,instructions,
    read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json,completion_definition,risk,budget_json,created_at,execution_status)
    VALUES('WI-recovery',1,'modify','modify','ready','developer','Change','[]','Implement','["src/**"]','["src/**"]','[".env*"]','[]','[]','Tests pass','low','{}',3,'failed');`);
  db.exec(`INSERT INTO collaboration_work_nodes(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json,instructions,
    read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json,completion_definition,risk,budget_json,created_at)
    VALUES('WI-recovery',1,'validate','validate','ready','tester','Validate','[]','Run tests','["src/**"]','[]','[".env*"]','["test-target"]','[]','Tests pass','low','{}',3);`);
  for (const attempt of options.attempts ?? [1, 2, 3]) {
    db.prepare("INSERT INTO collaboration_execution_dispatches VALUES('WI-recovery',1,?,'old-instance',1,?)").run(attempt, attempt * 100);
    db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,started_at,finished_at) VALUES(?,'WI-recovery',1,'modify',?,'developer',?,?,'failed','/test/repository',?, ?, ?,?,?)")
      .run(`run-${attempt}`, attempt, `thread-${attempt}`, `turn-${attempt}`, `/test/worktree-${attempt}`, `codex/attempt-${attempt}`, baseSha, attempt * 100, attempt * 100 + 1);
    if (options.missingSessionAttempt !== attempt) {
      db.prepare("INSERT INTO collaboration_execution_sessions VALUES(?,'WI-recovery',1,'/test/repository',?,?,'old-instance',1,?)").run(`run-${attempt}`, baseSha, attempt, attempt * 100);
      if (options.unsettledAttempt !== attempt) db.prepare("INSERT INTO collaboration_execution_settlements VALUES(?,'[]',?)").run(`run-${attempt}`, attempt * 100 + 2);
    }
  }
  const lease = new InstanceLeaseCoordinator(db, "current-instance").acquire(now, 2_000_000)!;
  const input = { requestId: "recovery-request", workItemId: "WI-recovery", expectedOwnerGeneration: 1,
    expectedWorkItemVersion: 3, expectedPlanRevision: 1, expectedSnapshotRevision: 1,
    expectedFailedRunId: "run-3", expectedBaseSha: baseSha, authorizationReferenceHash: referenceHash, now };
  return { db, lease, input };
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function dispatchFourth(db: DatabaseSync, lease: { ownerId: string; fence: number }, at = now) {
  transaction(db, () => {
    reserveExecutionRecovery(db, { workItemId: "WI-recovery", attempt: 4, maxAttempts: 3, lease, now: at });
    db.prepare("INSERT INTO collaboration_execution_dispatches VALUES('WI-recovery',1,4,?,?,?)").run(lease.ownerId, lease.fence, at);
  });
}

describe("one-time local execution recovery authorization", () => {
  it("issues one fixed fourth-attempt authorization and preserves all original execution and work-item history", () => {
    const { db, input } = fixture();
    const history = db.prepare("SELECT * FROM collaboration_runs ORDER BY attempt").all();
    const item = db.prepare("SELECT * FROM collaboration_work_items").get();
    const grant = authorizeExecutionRecoveryLocally(db, input);
    expect(grant).toMatchObject({ duplicate: false, workItemId: input.workItemId, workItemVersion: 3, planRevision: 1,
      snapshotRevision: 1, failedRunId: "run-3", baseSha, ownerBindingId: "owner-binding", ownerGeneration: 1,
      issuedAt: now, expiresAt: now + 15 * 60_000 });
    expect(grant.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(db.prepare("SELECT * FROM collaboration_runs ORDER BY attempt").all()).toEqual(history);
    expect(db.prepare("SELECT * FROM collaboration_work_items").get()).toEqual(item);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 1 });
  });

  it("returns an exact request replay without extending its expiration and refuses a second authorization", () => {
    const { db, input } = fixture();
    const first = authorizeExecutionRecoveryLocally(db, input);
    expect(authorizeExecutionRecoveryLocally(db, { ...input, now: now + 50 })).toEqual({ ...first, duplicate: true });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 1 });
    expect(() => authorizeExecutionRecoveryLocally(db, { ...input, requestId: "another-request" })).toThrow(/execution_recovery_/u);
    expect(() => authorizeExecutionRecoveryLocally(db, { ...input, authorizationReferenceHash: "e".repeat(64) })).toThrow(/execution_recovery_/u);
  });

  it("queues only an issued authorization and atomically reserves its fourth dispatch exactly once", () => {
    const { db, input, lease } = fixture();
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, now)).toBe(false);
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([]);
    authorizeExecutionRecoveryLocally(db, input);
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([input.workItemId]);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, now)).toBe(true);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 5, 3, now)).toBe(false);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 4, now)).toBe(false);
    expect(() => reserveExecutionRecovery(db, { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, now })).toThrow(/transaction/u);
    dispatchFourth(db, lease);
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([]);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, now)).toBe(false);
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_execution_dispatches WHERE attempt=4").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 2 });
  });

  it("requires the current matching dispatch before starting and consumes exactly one session before execution I/O", () => {
    const { db, input, lease } = fixture();
    const start = { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, baseSha, now, sessionId: "run-4" };
    authorizeExecutionRecoveryLocally(db, input);
    expect(() => assertExecutionRecoveryCanStart(db, start)).toThrow(/execution_recovery_/u);
    dispatchFourth(db, lease);
    expect(() => assertExecutionRecoveryCanStart(db, start)).not.toThrow();
    expect(() => assertExecutionRecoveryCanStart(db, start)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 2 });
    expect(() => consumeExecutionRecoveryStart(db, start)).toThrow(/transaction/u);
    transaction(db, () => {
      consumeExecutionRecoveryStart(db, start);
      db.prepare("INSERT INTO collaboration_execution_sessions VALUES('run-4','WI-recovery',1,'/test/repository',?,4,?,?,?)").run(baseSha, lease.ownerId, lease.fence, now);
    });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 3 });
    expect(() => assertExecutionRecoveryCanStart(db, start)).toThrow(/execution_recovery_/u);
    expect(() => transaction(db, () => consumeExecutionRecoveryStart(db, start))).toThrow(/execution_recovery_/u);
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
    expect(authorizeExecutionRecoveryLocally(db, { ...input, now: now + 1 })).toMatchObject({ duplicate: true, expiresAt: now + 15 * 60_000 });
  });

  it.each([
    ["owner generation", { expectedOwnerGeneration: 2 }], ["work-item version", { expectedWorkItemVersion: 2 }],
    ["plan revision", { expectedPlanRevision: 2 }], ["snapshot revision", { expectedSnapshotRevision: 2 }],
    ["failed run", { expectedFailedRunId: "run-2" }], ["base SHA", { expectedBaseSha: "f".repeat(40) }],
  ])("rejects a mismatched expected %s without writing authority", (_name, patch) => {
    const { db, input } = fixture();
    expect(() => authorizeExecutionRecoveryLocally(db, { ...input, ...patch })).toThrow(/execution_recovery_/u);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 0 });
  });

  it("strictly parses local request JSON and never permits caller-controlled CLI time or unknown privilege fields", () => {
    const { input } = fixture(); const { now: _now, ...request } = input;
    expect(parseExecutionRecoveryRequest(request)).toEqual(request);
    for (const invalid of [input, { ...request, allowExtraAttempt: true }, { ...request, authorizationReferenceHash: "raw authorization" },
      { ...request, expectedBaseSha: "HEAD" }, { ...request, expectedOwnerGeneration: 1.5 }, { ...request, requestId: " " }]) {
      expect(() => parseExecutionRecoveryRequest(invalid)).toThrow("execution_recovery_request_invalid");
    }
  });

  it.each([
    ["missing earlier attempt", { attempts: [2, 3] }], ["not yet third attempt", { attempts: [1, 2] }],
    ["fourth attempt already used", { attempts: [1, 2, 3, 4] }], ["unsettled previous run", { unsettledAttempt: 1 }],
    ["unsettled latest run", { unsettledAttempt: 3 }], ["missing latest session", { missingSessionAttempt: 3 }],
  ])("rejects %s without replacing or clearing history", (_name, options) => {
    const { db, input } = fixture(options); const before = db.prepare("SELECT * FROM collaboration_runs ORDER BY attempt").all();
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_/u);
    expect(db.prepare("SELECT * FROM collaboration_runs ORDER BY attempt").all()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 0 });
  });

  it.each(["succeeded", "running"])("rejects a latest %s run even when a settlement exists", status => {
    const { db, input } = fixture(); db.prepare("UPDATE collaboration_runs SET status=? WHERE id='run-3'").run(status);
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_/u);
  });

  it("rejects a failed run with a candidate result instead of converting verifier work to development", () => {
    const { db, input } = fixture(); db.prepare("UPDATE collaboration_runs SET result_sha=? WHERE id='run-3'").run("d".repeat(40));
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_/u);
  });

  it.each(["failed", "invalid", "timed_out", "needs_configuration"])("accepts the settled result-less %s terminal outcome", status => {
    const { db, input } = fixture(); db.prepare("UPDATE collaboration_runs SET status=? WHERE id='run-3'").run(status);
    expect(authorizeExecutionRecoveryLocally(db, input)).toMatchObject({ duplicate: false, failedRunId: "run-3" });
  });

  it.each(["paused", "cancelled", "version", "spec", "owner", "scope", "validate_commands", "restore", "verification"])("invalidates an issued grant after %s changes", change => {
    const { db, input } = fixture(); authorizeExecutionRecoveryLocally(db, input);
    if (change === "paused" || change === "cancelled") db.prepare("UPDATE collaboration_work_items SET control_state=?").run(change);
    if (change === "version") db.exec("UPDATE collaboration_work_items SET version=version+1");
    if (change === "spec") appendWorkItemSnapshot(db, input.workItemId, { facts: ["new requirement"] }, now + 1);
    if (change === "owner") db.exec("UPDATE collaboration_owner_bindings SET active=0,revoked_at=10001");
    if (change === "scope") db.exec("UPDATE collaboration_work_nodes SET write_scope_json='[\"**/*\"]'");
    if (change === "validate_commands") db.exec("UPDATE collaboration_work_nodes SET commands_json='[\"other-command\"]' WHERE node_id='validate'");
    if (change === "restore") markRestoredLedgerForReview(db, Buffer.from("test backup"), now + 1);
    if (change === "verification") db.prepare("INSERT INTO collaboration_verification_sessions VALUES('verification','run-1','/test/repository',1,1,?,'current-instance',1,?)").run("d".repeat(40), now + 1);
    expect(pendingExecutionRecoveryWorkItems(db, now + 1)).toEqual([]);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, now + 1)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 1 });
  });

  it("uses an exact fifteen-minute window without refunding or renewing an expired grant", () => {
    const { db, input, lease } = fixture(); const grant = authorizeExecutionRecoveryLocally(db, input);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, now - 1)).toBe(false);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, grant.expiresAt - 1)).toBe(true);
    expect(executionRecoveryCanDispatch(db, input.workItemId, 4, 3, grant.expiresAt)).toBe(false);
    expect(() => dispatchFourth(db, lease, grant.expiresAt)).toThrow(/execution_recovery_expired/u);
    expect(authorizeExecutionRecoveryLocally(db, { ...input, now: grant.expiresAt })).toMatchObject({ duplicate: true, expiresAt: grant.expiresAt });
    expect(() => authorizeExecutionRecoveryLocally(db, { ...input, now: grant.expiresAt, requestId: "new" })).toThrow(/execution_recovery_/u);
  });

  it("rolls back a dispatch reservation with its transaction and does not consume authority on stale fences", () => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input);
    expect(() => transaction(db, () => {
      reserveExecutionRecovery(db, { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, now });
      throw new Error("simulated transaction failure");
    })).toThrow("simulated transaction failure");
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([input.workItemId]);
    expect(() => transaction(db, () => reserveExecutionRecovery(db, { workItemId: input.workItemId, attempt: 4, maxAttempts: 3,
      lease: { ...lease, fence: lease.fence + 1 }, now }))).toThrow(/lease/i);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 1 });
  });

  it("rolls back start consumption with session failure but never refunds an already reserved dispatch", () => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input); dispatchFourth(db, lease);
    const start = { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, baseSha, now, sessionId: "run-4" };
    expect(() => transaction(db, () => { consumeExecutionRecoveryStart(db, start); throw new Error("session insert failed"); })).toThrow("session insert failed");
    expect(() => assertExecutionRecoveryCanStart(db, start)).not.toThrow();
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 2 });
  });

  it.each(["base", "lease", "expiry", "preparation", "dispatch_owner", "validate_commands"])("refuses to start a reserved dispatch after %s no longer matches", change => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input);
    if (change === "dispatch_owner") {
      transaction(db, () => {
        reserveExecutionRecovery(db, { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, now });
        db.prepare("INSERT INTO collaboration_execution_dispatches VALUES('WI-recovery',1,4,'wrong-instance',1,?)").run(now);
      });
    } else dispatchFourth(db, lease);
    if (change === "preparation") db.prepare("INSERT INTO collaboration_execution_preparation_results VALUES('WI-recovery',4,'interrupted',3,3,?)").run(now);
    if (change === "validate_commands") db.exec("UPDATE collaboration_work_nodes SET commands_json='[\"other-command\"]' WHERE node_id='validate'");
    const start = { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease: change === "lease" ? { ...lease, fence: 999 } : lease,
      baseSha: change === "base" ? "d".repeat(40) : baseSha, now: change === "expiry" ? now + 15 * 60_000 : now };
    expect(() => assertExecutionRecoveryCanStart(db, start)).toThrow();
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([]);
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
  });

  it.each(["duplicate", "malformed", "unknown_field", "wrong_outcome", "wrong_action", "wrong_policy", "wrong_hash", "wrong_owner_binding"])("fails closed on %s authorization audit records", damage => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input);
    const row = db.prepare("SELECT * FROM collaboration_audit_events").get()!;
    if (damage === "duplicate") db.prepare("INSERT INTO collaboration_audit_events(id,run_id,action,outcome,resource_json,created_at,actor_principal_id,work_item_id,request_id,policy_rule,before_hash,after_hash,error) SELECT 'duplicate',run_id,action,outcome,resource_json,created_at,actor_principal_id,work_item_id,request_id,policy_rule,before_hash,after_hash,error FROM collaboration_audit_events WHERE id=?").run(row.id);
    if (damage === "malformed") db.exec("UPDATE collaboration_audit_events SET resource_json='{broken'");
    if (damage === "unknown_field") db.exec("UPDATE collaboration_audit_events SET resource_json=json_set(resource_json,'$.allowExtraAttempt',1)");
    if (damage === "wrong_outcome") db.exec("UPDATE collaboration_audit_events SET outcome='deny'");
    if (damage === "wrong_action") db.exec("UPDATE collaboration_audit_events SET action='owner.retry'");
    if (damage === "wrong_policy") db.exec("UPDATE collaboration_audit_events SET policy_rule='local-other-policy'");
    if (damage === "wrong_hash") db.exec("UPDATE collaboration_audit_events SET after_hash='not-a-hash'");
    if (damage === "wrong_owner_binding") db.exec("UPDATE collaboration_audit_events SET resource_json=json_set(resource_json,'$.grant.ownerBindingId','different-owner')");
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([]);
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_/u);
  });

  it.each(["reserved", "started"])("requires exactly one %s audit stage and never spends a duplicated receipt twice", stage => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input); dispatchFourth(db, lease);
    const start = { workItemId: input.workItemId, attempt: 4, maxAttempts: 3, lease, baseSha, now, sessionId: "run-4" };
    if (stage === "started") transaction(db, () => consumeExecutionRecoveryStart(db, start));
    db.prepare("INSERT INTO collaboration_audit_events(id,run_id,action,outcome,resource_json,created_at,actor_principal_id,work_item_id,request_id,policy_rule,before_hash,after_hash,error) SELECT 'duplicate',run_id,action,outcome,resource_json,created_at,actor_principal_id,work_item_id,request_id,policy_rule,before_hash,after_hash,error FROM collaboration_audit_events WHERE action=?").run(`execution.recovery.${stage}`);
    expect(() => assertExecutionRecoveryCanStart(db, start)).toThrow(/execution_recovery_audit_invalid/u);
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_audit_invalid/u);
  });

  it.each(["dispatch", "session"])("never reauthorizes when audit rows disappear but immutable %s attempt 4 survives", anchor => {
    const { db, input, lease } = fixture(); authorizeExecutionRecoveryLocally(db, input);
    if (anchor === "dispatch") dispatchFourth(db, lease);
    else db.prepare("INSERT INTO collaboration_execution_sessions VALUES('run-4','WI-recovery',1,'/test/repository',?,4,?,?,?)").run(baseSha, lease.ownerId, lease.fence, now);
    // Audit tables intentionally have no immutable trigger; durable attempts remain the final safety anchor.
    db.exec("DELETE FROM collaboration_audit_events");
    expect(pendingExecutionRecoveryWorkItems(db, now)).toEqual([]);
    expect(() => authorizeExecutionRecoveryLocally(db, { ...input, requestId: "replacement" })).toThrow(/execution_recovery_/u);
    expect(() => dispatchFourth(db, lease)).toThrow(/execution_recovery_/u);
  });

  it("rejects another task's unsettled activity in the same canonical repository", () => {
    const { db, input } = fixture();
    db.exec("INSERT INTO collaboration_work_items(id,conversation_id,title,status,version,created_by,created_at,updated_at) VALUES('WI-other','conversation','Other task','collecting',1,'requester',1,1)");
    appendWorkItemSnapshot(db, "WI-other", { repository: "/test/repository" }, 1);
    db.prepare("INSERT INTO collaboration_plan_revisions(id,work_item_id,revision,snapshot_revision,status,proposal_hash,created_at) VALUES('plan-other','WI-other',1,1,'published',?,3)").run("c".repeat(64));
    db.prepare("INSERT INTO collaboration_execution_sessions VALUES('other-session','WI-other',1,'/test/repository',?,1,'other-instance',1,?)").run(baseSha, now);
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_repository_unsettled/u);
  });

  it("does not reuse a request ID already attached to another control action", () => {
    const { db, input } = fixture();
    db.prepare("INSERT INTO collaboration_audit_events(id,action,outcome,resource_json,created_at,work_item_id,request_id,policy_rule) VALUES('unrelated','retry','allow','{}',?,'WI-recovery',?,'owner-control-v1')").run(now, input.requestId);
    expect(() => authorizeExecutionRecoveryLocally(db, input)).toThrow(/execution_recovery_request_conflict/u);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events").get()).toEqual({ n: 1 });
  });
});
