import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { applyCollaborationMigrations } from "./migrations.ts";
import { appendWorkItemSnapshot } from "./snapshot.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { parseCandidateRevisionRequest, type CandidateRevisionGrant, type CandidateRevisionRequest } from "./candidate-revision.ts";

export function createCandidateRevisionFixture(options: { now?: number; attempt?: number; takeLease?: boolean } = {}) {
  const now = options.now ?? Date.now(), attempt = options.attempt ?? 1;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-revision-"))), repository = join(root, "repository");
  mkdirSync(join(repository, "app"), { recursive: true }); mkdirSync(join(repository, "tests"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Revision test"); git("config", "user.email", "revision@example.invalid");
  writeFileSync(join(repository, "app/release-board.tsx"), 'export default "original";\n');
  writeFileSync(join(repository, "tests/existing.test.mjs"), 'import assert from "node:assert/strict"; assert.ok(true);\n');
  git("add", "."); git("commit", "-qm", "Original base"); const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(repository, "app/release-board.tsx"), 'export default "verified functionality";\n');
  git("add", "."); git("commit", "-qm", "Parent candidate"); const parentSha = git("rev-parse", "HEAD");
  const parentBlobSha = git("rev-parse", `${parentSha}:app/release-board.tsx`);
  const resultBlobSha = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"],
    { input: 'export default "verified functionality with optional initial state";\n', encoding: "utf8" }).trim();
  git("checkout", "--detach", baseSha);
  mkdirSync(join(root, "collaboration"));
  const filePath = join(root, "collaboration", "collaboration.sqlite"), db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys=ON"); applyCollaborationMigrations(db);
  db.exec(`INSERT INTO collaboration_principals VALUES('requester','dingtalk','resolved','Requester',1,1);
    INSERT INTO collaboration_conversations VALUES('conversation',1);
    INSERT INTO collaboration_work_items(id,conversation_id,title,status,version,created_by,created_at,updated_at,definition_status,current_plan_revision)
      VALUES('WI-revision','conversation','Original task','collecting',3,'requester',1,1,'ready_for_execution',1);
    INSERT INTO collaboration_owner_bindings(id,source,sender_corp_id,sender_staff_id,generation,active,created_at)
      VALUES('owner-binding','dingtalk','corp','owner',1,1,1);`);
  appendWorkItemSnapshot(db, "WI-revision", { goal: "Original task", goalConfirmed: true, repository,
    acceptanceConditions: [{ description: "Expected rendering", observation: "Real render assertions" }] }, 2);
  db.prepare("INSERT INTO collaboration_plan_revisions(id,work_item_id,revision,snapshot_revision,status,proposal_hash,created_at) VALUES('plan','WI-revision',1,1,'published',?,3)").run("c".repeat(64));
  for (const kind of ["modify", "validate"]) db.prepare("INSERT INTO collaboration_work_nodes(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json,instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json,completion_definition,risk,budget_json,created_at,execution_status) VALUES('WI-revision',1,?,?,'ready',?,'Original objective','[]','Original instruction','[\"app/**\",\"tests/**\"]',?,'[\".env*\"]',?,'[]','Tests pass','low','{}',3,'candidate_ready')")
    .run(kind, kind, kind === "modify" ? "developer" : "tester", kind === "modify" ? '["app/**","tests/**"]' : '[]', kind === "validate" ? '["test-target"]' : '[]');
  db.prepare("INSERT INTO collaboration_execution_dispatches VALUES('WI-revision',1,?,'old-instance',1,?)").run(attempt, now - 20);
  db.prepare("INSERT INTO collaboration_execution_sessions VALUES('parent-run','WI-revision',1,?,?,?,'old-instance',1,?)").run(repository, baseSha, attempt, now - 20);
  db.prepare("INSERT INTO collaboration_execution_settlements VALUES('parent-run','[]',?)").run(now - 5);
  db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES('parent-run','WI-revision',1,'modify',?,'developer','thread','turn','succeeded',?,?,'codex/parent',?,?,?,?)")
    .run(attempt, repository, repository, baseSha, parentSha, now - 20, now - 10);
  db.prepare("INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES('parent-candidate','parent-run','target_tests_passed',?,?,'[\"app/release-board.tsx\"]','[]','{}',?)")
    .run(baseSha, parentSha, now - 10);
  const leases = new InstanceLeaseCoordinator(db, "current-instance"), lease = leases.acquire(now, 2_000_000)!;
  if (options.takeLease === false) leases.release(lease, now);
  const input: CandidateRevisionRequest & { now: number } = { requestId: "revision-request", workItemId: "WI-revision", expectedOwnerGeneration: 1,
    expectedWorkItemVersion: 3, expectedPlanRevision: 1, expectedSnapshotRevision: 1, expectedParentRunId: "parent-run",
    expectedParentSha: parentSha, expectedBaseSha: baseSha, authorizationReferenceHash: "b".repeat(64), now,
    instructions: "Keep functionality unchanged. Add an optional initial filter and the real empty-state render assertion.",
    allowedChanges: [{ path: "app/release-board.tsx", operation: "modify", parentBlobSha, resultBlobSha },
      { path: "tests/empty-state-render.test.mjs", operation: "add", parentBlobSha: null }] };
  const { now: _now, ...request } = input;
  const close = () => { db.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, dataDirectory: root, repository, filePath, db, git, lease, now, input, request,
    workItemId: input.workItemId, parentRunId: input.expectedParentRunId, baseSha, parentSha, parentBlobSha, resultBlobSha,
    close, dispose: close };
}

export function candidateRevisionTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Consumer-only fixture: seeds immutable supersession, not an authorization or real execution proof. */
export function seedIssuedCandidateRevision(db: DatabaseSync, input: { runId: string; candidateSha: string; now?: number; stage?: "issued" | "reserved" | "started" }) {
  const now = input.now ?? Date.now();
  const row = z.object({ work_item_id: z.string(), plan_revision: z.number(), node_id: z.string(), base_sha: z.string(), repository_path: z.string(),
    version: z.number(), snapshot_revision: z.number(), proposal_hash: z.string() }).parse(db.prepare("SELECT r.work_item_id,r.plan_revision,r.node_id,r.base_sha,r.repository_path,w.version,p.snapshot_revision,p.proposal_hash FROM collaboration_runs r JOIN collaboration_work_items w ON w.id=r.work_item_id JOIN collaboration_plan_revisions p ON p.work_item_id=r.work_item_id AND p.revision=r.plan_revision WHERE r.id=?").get(input.runId));
  const digest = (value: CandidateRevisionRequest) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const request = parseCandidateRevisionRequest({ requestId: `consumer-revision-${randomUUID()}`, workItemId: row.work_item_id,
    expectedOwnerGeneration: 1, expectedWorkItemVersion: row.version, expectedPlanRevision: row.plan_revision,
    expectedSnapshotRevision: row.snapshot_revision, expectedParentRunId: input.runId, expectedParentSha: input.candidateSha,
    expectedBaseSha: row.base_sha, authorizationReferenceHash: "b".repeat(64), instructions: "Add a real empty-state rendering assertion.",
    allowedChanges: [{ path: "tests/empty-state-render.test.mjs", operation: "add", parentBlobSha: null }] });
  const max = z.object({ n: z.number() }).parse(db.prepare("SELECT max(attempt) AS n FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_dispatches WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=?)").get(row.work_item_id, row.work_item_id, row.work_item_id));
  const grant: CandidateRevisionGrant = { version: 1, requestId: request.requestId, requestHash: digest(request), workItemId: row.work_item_id,
    workItemVersion: row.version, planRevision: row.plan_revision, snapshotRevision: row.snapshot_revision, snapshotHash: "c".repeat(64),
    proposalHash: /^[a-f0-9]{64}$/u.test(row.proposal_hash) ? row.proposal_hash : "d".repeat(64), executionScopeHash: "e".repeat(64),
    nodeId: row.node_id, parentRunId: input.runId, parentSha: input.candidateSha, baseSha: row.base_sha, buildParentSha: input.candidateSha,
    repository: row.repository_path, attempt: max.n + 1, maxAttempts: 3, ownerBindingId: "consumer-owner", ownerGeneration: 1,
    ownerIdentityHash: "f".repeat(64), authorizationReferenceHash: request.authorizationReferenceHash,
    allowedChanges: request.allowedChanges, instructions: request.instructions, issuedAt: now, expiresAt: now + 900_000 };
  db.prepare("INSERT INTO collaboration_candidate_revision_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(grant.requestId, grant.requestHash, grant.workItemId, grant.workItemVersion, grant.planRevision, grant.snapshotRevision, grant.nodeId,
      grant.parentRunId, grant.parentSha, grant.baseSha, grant.buildParentSha, grant.attempt, JSON.stringify(grant), grant.issuedAt, grant.expiresAt);
  if (input.stage && input.stage !== "issued") {
    db.prepare("INSERT INTO collaboration_execution_dispatches VALUES(?,?,?,'consumer-instance',1,?)").run(grant.workItemId, grant.planRevision, grant.attempt, now);
    db.prepare("INSERT INTO collaboration_candidate_revision_stages VALUES(?,'reserved',?,?,'consumer-instance',1,NULL,?)").run(grant.requestId, grant.workItemId, grant.attempt, now);
    if (input.stage === "started") {
      const sessionId = `consumer-session-${randomUUID()}`;
      db.prepare("INSERT INTO collaboration_execution_sessions VALUES(?,?,?,?,?,?,'consumer-instance',1,?)").run(sessionId, grant.workItemId, grant.planRevision, grant.repository, grant.baseSha, grant.attempt, now);
      db.prepare("INSERT INTO collaboration_candidate_revision_stages VALUES(?,'started',?,?,'consumer-instance',1,?,?)").run(grant.requestId, grant.workItemId, grant.attempt, sessionId, now);
    }
  }
  return grant;
}
