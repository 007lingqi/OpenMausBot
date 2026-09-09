import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { authorizeCandidateRevisionLocally, parseCandidateRevisionRequest, candidateIsSupersededByRevision,
  pendingCandidateRevisionWorkItems, reserveCandidateRevision, assertCandidateRevisionCanStart,
  markCandidateRevisionStarted, readCandidateRevisionForAttempt, assertCandidateRevisionStillCurrent } from "./candidate-revision.ts";
import { markRestoredLedgerForReview } from "./restore-guard.ts";
import { createCandidateRevisionFixture, seedIssuedCandidateRevision, candidateRevisionTransaction } from "./candidate-revision.test-fixtures.ts";

const fixtures: ReturnType<typeof createCandidateRevisionFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture(options?: Parameters<typeof createCandidateRevisionFixture>[0]) { const value = createCandidateRevisionFixture(options); fixtures.push(value); return value; }
function reserve(f: ReturnType<typeof fixture>, at = f.now) {
  return candidateRevisionTransaction(f.db, () => {
    f.db.prepare("INSERT INTO collaboration_execution_dispatches VALUES(?,?,2,?,?,?)").run(f.input.workItemId, 1, f.lease.ownerId, f.lease.fence, at);
    return reserveCandidateRevision(f.db, { workItemId: f.input.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, now: at });
  });
}

const request = { requestId: "revision-1", workItemId: "WI-revision", expectedOwnerGeneration: 1,
  expectedWorkItemVersion: 3, expectedPlanRevision: 1, expectedSnapshotRevision: 1,
  expectedParentRunId: "parent-run", expectedParentSha: "b".repeat(40), expectedBaseSha: "a".repeat(40),
  authorizationReferenceHash: "c".repeat(64), instructions: "Add the real empty-state rendering test.",
  allowedChanges: [{ path: "tests/empty-state-render.test.mjs", operation: "add", parentBlobSha: null }] };

describe("bounded local candidate revision", () => {
  it("does not use a future-dated preparation failure to grant another attempt", () => {
    const f = fixture(); authorizeCandidateRevisionLocally(f.db, f.input); reserve(f);
    f.db.prepare("INSERT INTO collaboration_execution_preparation_results VALUES(?,2,'failed',3,3,?)").run(f.workItemId, f.now + 1000);
    expect(() => authorizeCandidateRevisionLocally(f.db, { ...f.input, requestId: "future-failure", now: f.now + 1 })).toThrow(/candidate_revision_/u);
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 1 });
  });
  it("ignores a bare audit claim and cannot dispatch without the immutable request", () => {
    const f = fixture();
    f.db.prepare("INSERT INTO collaboration_audit_events(id,action,outcome,resource_json,created_at,request_id,work_item_id,policy_rule) VALUES('fake','candidate.revision.issued','allow',?, ?, ?, ?, 'local-candidate-revision-v1')")
      .run(JSON.stringify(f.request), f.now, f.request.requestId, f.workItemId);
    expect(readCandidateRevisionForAttempt(f.db, f.workItemId, 2)).toBeNull();
    expect(pendingCandidateRevisionWorkItems(f.db, f.now)).toEqual([]);
    expect(candidateIsSupersededByRevision(f.db, f.parentRunId, f.parentSha, f.now)).toBe(false);
    expect(() => authorizeCandidateRevisionLocally(f.db, f.input)).toThrow("candidate_revision_request_conflict");
  });
  it("reads the same durable reservation after restart and atomically rolls back a failed session transaction", () => {
    const f = fixture(); authorizeCandidateRevisionLocally(f.db, f.input); reserve(f);
    const before = readCandidateRevisionForAttempt(f.db, f.workItemId, 2);
    expect(() => candidateRevisionTransaction(f.db, () => {
      f.db.prepare("INSERT INTO collaboration_execution_sessions VALUES('rolled-back',?,1,?,?,2,?,?,?)").run(f.workItemId, f.repository, f.baseSha, f.lease.ownerId, f.lease.fence, f.now);
      markCandidateRevisionStarted(f.db, { workItemId: f.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, baseSha: f.baseSha, sessionId: "rolled-back", now: f.now });
      throw Error("interrupt transaction");
    })).toThrow("interrupt transaction");
    expect(f.db.prepare("SELECT 1 FROM collaboration_execution_sessions WHERE id='rolled-back'").get()).toBeUndefined();
    const restarted = new DatabaseSync(f.filePath);
    try {
      expect(readCandidateRevisionForAttempt(restarted, f.workItemId, 2)).toEqual(before);
      expect(pendingCandidateRevisionWorkItems(restarted, f.now)).toEqual([]);
      expect(candidateIsSupersededByRevision(restarted, f.parentRunId, f.parentSha, f.now + 900_001)).toBe(true);
    } finally { restarted.close(); }
  });
  it.each(["owner", "version", "scope", "restore"])("rejects a reserved start after %s changes without reviving its parent", change => {
    const f = fixture(); authorizeCandidateRevisionLocally(f.db, f.input); reserve(f);
    if (change === "owner") f.db.prepare("UPDATE collaboration_owner_bindings SET active=0,revoked_at=?").run(f.now + 1);
    if (change === "version") f.db.exec("UPDATE collaboration_work_items SET version=version+1");
    if (change === "scope") f.db.exec("UPDATE collaboration_work_nodes SET write_scope_json='[\"**/*\"]' WHERE node_type='modify'");
    if (change === "restore") markRestoredLedgerForReview(f.db, Buffer.from("restored fixture"), f.now + 1);
    expect(() => assertCandidateRevisionCanStart(f.db, { workItemId: f.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, now: f.now + 1 })).toThrow();
    expect(candidateIsSupersededByRevision(f.db, f.parentRunId, f.parentSha, f.now + 900_001)).toBe(true);
  });
  it("allows only its own started running session while rechecking current authority, even after admission TTL", () => {
    const f = fixture(); authorizeCandidateRevisionLocally(f.db, f.input); reserve(f);
    candidateRevisionTransaction(f.db, () => {
      f.db.prepare("INSERT INTO collaboration_execution_sessions VALUES('own-running',?,1,?,?,2,?,?,?)").run(f.workItemId, f.repository, f.baseSha, f.lease.ownerId, f.lease.fence, f.now);
      markCandidateRevisionStarted(f.db, { workItemId: f.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, baseSha: f.baseSha, sessionId: "own-running", now: f.now });
    });
    f.db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,started_at) VALUES('own-running',?,1,'modify',2,'developer','own-thread','own-turn','running',?,?,'codex/own',?,?)")
      .run(f.workItemId, f.repository, f.repository, f.baseSha, f.now);
    expect(assertCandidateRevisionStillCurrent(f.db, { workItemId: f.workItemId, attempt: 2, sessionId: "own-running", now: f.now + 900_001 })).toMatchObject({ baseSha: f.baseSha, buildParentSha: f.parentSha });
    expect(() => assertCandidateRevisionStillCurrent(f.db, { workItemId: f.workItemId, attempt: 2, sessionId: "other", now: f.now + 1 })).toThrow("candidate_revision_started_binding_mismatch");
    f.db.prepare("UPDATE collaboration_owner_bindings SET active=0,revoked_at=?").run(f.now + 1);
    expect(() => assertCandidateRevisionStillCurrent(f.db, { workItemId: f.workItemId, attempt: 2, sessionId: "own-running", now: f.now + 1 })).toThrow("candidate_revision_owner_unavailable");
  });
  it.each(["preparation", "started", "started-with-sha"])("allows one new explicit request after a settled %s failure, never refunding or replaying the consumed attempt", kind => {
    const f = fixture(), first = authorizeCandidateRevisionLocally(f.db, f.input); reserve(f);
    if (kind !== "preparation") {
      candidateRevisionTransaction(f.db, () => {
        f.db.prepare("INSERT INTO collaboration_execution_sessions VALUES('failed-revision',?,1,?,?,2,?,?,?)").run(f.input.workItemId, f.repository, f.baseSha, f.lease.ownerId, f.lease.fence, f.now);
        markCandidateRevisionStarted(f.db, { workItemId: f.input.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, baseSha: f.baseSha, sessionId: "failed-revision", now: f.now });
      });
      f.db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,started_at,finished_at) VALUES('failed-revision',?,1,'modify',2,'developer','revision-thread','revision-turn','failed',?,?,'codex/failed',?,?,?)")
        .run(f.input.workItemId, f.repository, f.repository, f.baseSha, f.now, f.now + 1);
      const resultSha = kind === "started-with-sha" ? "e".repeat(40) : null;
      if (resultSha) f.db.prepare("UPDATE collaboration_runs SET result_sha=? WHERE id='failed-revision'").run(resultSha);
      const quality = resultSha ? { lineage: { version: 1, requestId: first.requestId, requestHash: first.requestHash,
        parentRunId: first.parentRunId, parentSha: first.parentSha, baseSha: first.baseSha, buildParentSha: first.buildParentSha, candidateSha: resultSha } } : {};
      f.db.prepare("INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES('failed-diagnostic','failed-revision',?,?,?,'[]','[]',?,?)")
        .run(resultSha ? "test_failed" : "invalid", f.baseSha, resultSha, JSON.stringify(quality), f.now + 1);
      f.db.prepare("INSERT INTO collaboration_execution_settlements VALUES('failed-revision','[]',?)").run(f.now + 2);
    } else f.db.prepare("INSERT INTO collaboration_execution_preparation_results VALUES(?,2,'failed',3,3,?)").run(f.input.workItemId, f.now + 1);
    const next = authorizeCandidateRevisionLocally(f.db, { ...f.input, requestId: "explicit-after-failure", now: f.now + 3 });
    expect(next).toMatchObject({ attempt: 3, parentRunId: f.input.expectedParentRunId, buildParentSha: f.parentSha, duplicate: false });
    expect(authorizeCandidateRevisionLocally(f.db, { ...f.input, now: f.now + 4 })).toEqual({ ...first, duplicate: true });
    expect(readCandidateRevisionForAttempt(f.db, f.input.workItemId, 2)?.stage).toBe(kind !== "preparation" ? "started" : "reserved");
    expect(candidateIsSupersededByRevision(f.db, f.input.expectedParentRunId, f.parentSha, f.now + 1_000_000)).toBe(true);
    expect(f.db.prepare("SELECT attempt FROM collaboration_execution_dispatches ORDER BY attempt").all()).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });
  it.each(["wrong-lineage", "extra-lineage-field", "missing-lineage", "missing-candidate", "partial-lineage", "null-lineage-field", "non-revision", "succeeded", "future-settlement", "wrong-run-base", "wrong-candidate-base"])("refuses a new request after a %s attempt with a result SHA", kind => {
    const f = fixture(), first = authorizeCandidateRevisionLocally(f.db, f.input), resultSha = "e".repeat(40); reserve(f);
    candidateRevisionTransaction(f.db, () => {
      f.db.prepare("INSERT INTO collaboration_execution_sessions VALUES('failed-revision',?,1,?,?,2,?,?,?)").run(f.workItemId, f.repository, f.baseSha, f.lease.ownerId, f.lease.fence, f.now);
      if (kind !== "non-revision") markCandidateRevisionStarted(f.db, { workItemId: f.workItemId, attempt: 2, maxAttempts: 3, lease: f.lease, baseSha: f.baseSha, sessionId: "failed-revision", now: f.now });
    });
    f.db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES('failed-revision',?,1,'modify',2,'developer','revision-thread','revision-turn',?,?,?,'codex/failed',?,?,?,?)")
      .run(f.workItemId, kind === "succeeded" ? "succeeded" : "failed", f.repository, f.repository, kind === "wrong-run-base" ? f.parentSha : f.baseSha, resultSha, f.now, f.now + 1);
    const lineage = { version: 1, requestId: first.requestId, requestHash: first.requestHash,
      parentRunId: first.parentRunId, parentSha: kind === "wrong-lineage" ? "f".repeat(40) : first.parentSha,
      baseSha: first.baseSha, buildParentSha: first.buildParentSha, candidateSha: resultSha };
    if (kind === "extra-lineage-field") Object.assign(lineage, { approved: true });
    if (kind === "partial-lineage") Object.assign(lineage, { parentSha: undefined, unrelated: true });
    if (kind === "null-lineage-field") Object.assign(lineage, { parentSha: null });
    if (kind !== "missing-candidate") f.db.prepare("INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES('failed-diagnostic','failed-revision','test_failed',?,?,'[]','[]',?,?)")
      .run(kind === "wrong-candidate-base" ? f.parentSha : f.baseSha, resultSha, JSON.stringify({ lineage: kind === "missing-lineage" ? undefined : lineage }), f.now + 1);
    f.db.prepare("INSERT INTO collaboration_execution_settlements VALUES('failed-revision','[]',?)").run(f.now + (kind === "future-settlement" ? 1000 : 2));
    expect(() => authorizeCandidateRevisionLocally(f.db, { ...f.input, requestId: "explicit-after-unsafe-failure", now: f.now + 3 })).toThrow(/candidate_revision_/u);
    const next = { ...first, requestId: "direct-after-unsafe-failure", requestHash: "d".repeat(64), attempt: 3, issuedAt: f.now + 3, expiresAt: f.now + 900_003 };
    expect(() => f.db.prepare("INSERT INTO collaboration_candidate_revision_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(next.requestId, next.requestHash, next.workItemId, next.workItemVersion, next.planRevision, next.snapshotRevision, next.nodeId,
        next.parentRunId, next.parentSha, next.baseSha, next.buildParentSha, next.attempt, JSON.stringify(next), next.issuedAt, next.expiresAt)).toThrow("candidate revision request conflict");
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT result_sha FROM collaboration_runs WHERE id='failed-revision'").get()).toEqual({ result_sha: resultSha });
    expect(candidateIsSupersededByRevision(f.db, f.parentRunId, f.parentSha, f.now + 1_000_000)).toBe(true);
  });
  it("reserves one dispatch and binds started to an already inserted immutable execution session", () => {
    const f = fixture(), { db, input, lease, now, baseSha, parentSha } = f;
    authorizeCandidateRevisionLocally(db, input);
    expect(pendingCandidateRevisionWorkItems(db, now)).toEqual([input.workItemId]);
    reserve(f);
    expect(pendingCandidateRevisionWorkItems(db, now)).toEqual([]);
    const start = { workItemId: input.workItemId, attempt: 2, maxAttempts: 3, lease, baseSha, buildParentSha: parentSha, sessionId: "revision-run", now };
    expect(assertCandidateRevisionCanStart(db, start)).toMatchObject({ attempt: 2, buildParentSha: parentSha });
    expect(() => candidateRevisionTransaction(db, () => markCandidateRevisionStarted(db, start))).toThrow(/session/u);
    candidateRevisionTransaction(db, () => {
      db.prepare("INSERT INTO collaboration_execution_sessions VALUES('revision-run',?,1,?,?,2,?,?,?)").run(input.workItemId, f.repository, baseSha, lease.ownerId, lease.fence, now);
      markCandidateRevisionStarted(db, start);
    });
    expect(readCandidateRevisionForAttempt(db, input.workItemId, 2)).toMatchObject({ stage: "started", sessionId: "revision-run", baseSha, buildParentSha: parentSha });
    expect(() => assertCandidateRevisionCanStart(db, start)).toThrow("candidate_revision_start_unavailable");
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, now + 900_001)).toBe(true);
    expect(() => db.exec("DELETE FROM collaboration_candidate_revision_stages")).toThrow("immutable");
  });
  it("replays an exact request without renewal and rejects changed instructions or competing live authority", () => {
    const { db, input, now } = fixture(), first = authorizeCandidateRevisionLocally(db, input);
    expect(authorizeCandidateRevisionLocally(db, { ...input, now: now + 1 })).toEqual({ ...first, duplicate: true });
    expect(() => authorizeCandidateRevisionLocally(db, { ...input, instructions: "Different changes" })).toThrow("candidate_revision_request_conflict");
    expect(() => authorizeCandidateRevisionLocally(db, { ...input, requestId: "competing" })).toThrow("candidate_revision_authorization_conflict");
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 1 });
  });
  it("allows a new explicit request after unused authority expires without renewing the original", () => {
    const { db, input, now, parentSha } = fixture(), first = authorizeCandidateRevisionLocally(db, input);
    expect(pendingCandidateRevisionWorkItems(db, first.expiresAt)).toEqual([]);
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, first.expiresAt)).toBe(false);
    expect(authorizeCandidateRevisionLocally(db, { ...input, requestId: "renewed-explicitly", now: now + 900_000 })).toMatchObject({ duplicate: false, attempt: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 2 });
  });
  it.each([1, 2, 4])("does not enlarge a runtime maxAttempts of %s", maxAttempts => {
    const f = fixture(); authorizeCandidateRevisionLocally(f.db, f.input);
    expect(() => candidateRevisionTransaction(f.db, () => {
      f.db.prepare("INSERT INTO collaboration_execution_dispatches VALUES(?,?,2,?,?,?)").run(f.input.workItemId, 1, f.lease.ownerId, f.lease.fence, f.now);
      reserveCandidateRevision(f.db, { workItemId: f.input.workItemId, attempt: 2, maxAttempts, lease: f.lease, now: f.now });
    })).toThrow("candidate_revision_attempt_forbidden");
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_execution_dispatches WHERE attempt=2").get()).toEqual({ n: 0 });
  });
  it("rejects a fourth execution instead of resetting the original Work Item budget", () => {
    const { db, input } = fixture({ attempt: 3 });
    expect(() => authorizeCandidateRevisionLocally(db, input)).toThrow("candidate_revision_attempt_limit_exhausted");
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 0 });
  });
  it.each(["owner", "version", "parent", "base", "blob", "existing-test", "outside-scope"])("rejects stale or unsafe %s bindings without writing a request", kind => {
    const { db, input } = fixture();
    if (kind === "owner") input.expectedOwnerGeneration++;
    if (kind === "version") input.expectedWorkItemVersion++;
    if (kind === "parent") input.expectedParentSha = "f".repeat(40);
    if (kind === "base") input.expectedBaseSha = "f".repeat(40);
    if (kind === "blob") input.allowedChanges[0].parentBlobSha = "f".repeat(40);
    if (kind === "existing-test") input.allowedChanges[1].path = "tests/existing.test.mjs";
    if (kind === "outside-scope") input.allowedChanges[1].path = "private/new.test.mjs";
    expect(() => authorizeCandidateRevisionLocally(db, input)).toThrow(/candidate_revision_/u);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_candidate_revision_requests").get()).toEqual({ n: 0 });
  });
  it("reads immutable supersession and blocks direct old-candidate verification and acceptance", () => {
    const { db, input, now, parentSha } = fixture();
    const grant = seedIssuedCandidateRevision(db, { runId: input.expectedParentRunId, candidateSha: parentSha, now });
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, now)).toBe(true);
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, grant.expiresAt)).toBe(false);
    expect(candidateIsSupersededByRevision(db, "other-run", parentSha, now)).toBe(false);
    expect(() => db.prepare("INSERT INTO collaboration_verification_sessions VALUES('blocked','parent-run',?,1,1,?,'old-instance',1,?)").run(grant.repository, parentSha, now)).toThrow("candidate superseded by revision");
    expect(() => db.prepare("UPDATE collaboration_work_items SET status='accepted',control_state='accepted',accepted_candidate_sha=? WHERE id=?").run(parentSha, input.workItemId)).toThrow("candidate superseded by revision");
    expect(() => db.exec("DELETE FROM collaboration_candidate_revision_requests")).toThrow("immutable");
    expect(() => db.exec("UPDATE collaboration_candidate_revision_requests SET expires_at=expires_at+1")).toThrow("immutable");
  });
  it("authorizes a new bounded attempt, supersedes its parent, and leaves the original work item, Spec, run and candidate unchanged", () => {
    const { db, input, now, baseSha, parentSha } = fixture();
    const tables = ["work_items", "work_item_snapshots", "plan_revisions", "work_nodes", "runs", "candidates", "execution_sessions", "execution_settlements"];
    const before = tables.map(table => db.prepare(`SELECT * FROM collaboration_${table}`).all());
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, now)).toBe(false);
    const grant = authorizeCandidateRevisionLocally(db, input);
    expect(grant).toMatchObject({ duplicate: false, baseSha, buildParentSha: parentSha, parentSha, parentRunId: input.expectedParentRunId,
      nodeId: "modify", attempt: 2, maxAttempts: 3, workItemVersion: 3, snapshotRevision: 1, issuedAt: now, expiresAt: now + 900_000 });
    expect(candidateIsSupersededByRevision(db, input.expectedParentRunId, parentSha, now)).toBe(true);
    expect(tables.map(table => db.prepare(`SELECT * FROM collaboration_${table}`).all())).toEqual(before);
  });
  it("rejects caller time, privilege fields, broad paths, and rewriting existing tests", () => {
    expect(parseCandidateRevisionRequest(request)).toEqual(request);
    for (const invalid of [{ ...request, now: 100 }, { ...request, ownerAuthorized: true },
      { ...request, allowedChanges: [{ path: "src/**", operation: "add", parentBlobSha: null }] },
      { ...request, allowedChanges: [{ path: "tests/old.test.mjs", operation: "modify", parentBlobSha: "d".repeat(40), resultBlobSha: "e".repeat(40) }] }]) {
      expect(() => parseCandidateRevisionRequest(invalid)).toThrow("candidate_revision_request_invalid");
    }
  });
  it("binds bounded instructions and refuses secrets or unpinned implementation edits", () => {
    expect(parseCandidateRevisionRequest({ ...request, instructions: "x".repeat(16_000) }).instructions).toHaveLength(16_000);
    for (const invalid of [{ ...request, instructions: "x".repeat(16_001) }, { ...request, instructions: " " },
      { ...request, instructions: "api_key = fixture-secret" }, { ...request, instructions: "Bearer fixture-credential" },
      { ...request, allowedChanges: [...request.allowedChanges, { path: "app/release-board.tsx", operation: "modify", parentBlobSha: "d".repeat(40) }] }]) {
      expect(() => parseCandidateRevisionRequest(invalid)).toThrow("candidate_revision_request_invalid");
    }
  });
});
