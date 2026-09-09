import type { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { z } from "zod";
import { redactSensitiveText } from "./sensitive-text.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { assertLedgerArmed } from "./restore-guard.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";
import { matchesPathScope } from "./worktree-manager.ts";
import { appendControlAudit } from "./audit.ts";

export interface CandidateRevisionChange {
  path: string;
  operation: "add" | "modify";
  parentBlobSha: string | null;
  resultBlobSha?: string;
}
export interface CandidateRevisionRequest {
  requestId: string;
  workItemId: string;
  expectedOwnerGeneration: number;
  expectedWorkItemVersion: number;
  expectedPlanRevision: number;
  expectedSnapshotRevision: number;
  expectedParentRunId: string;
  expectedParentSha: string;
  expectedBaseSha: string;
  authorizationReferenceHash: string;
  allowedChanges: CandidateRevisionChange[];
  instructions: string;
}
export interface CandidateRevisionGrant {
  version: 1;
  requestId: string;
  requestHash: string;
  workItemId: string;
  workItemVersion: number;
  planRevision: number;
  snapshotRevision: number;
  snapshotHash: string;
  proposalHash: string;
  executionScopeHash: string;
  nodeId: string;
  parentRunId: string;
  parentSha: string;
  baseSha: string;
  buildParentSha: string;
  repository: string;
  attempt: number;
  maxAttempts: 3;
  ownerBindingId: string;
  ownerGeneration: number;
  ownerIdentityHash: string;
  authorizationReferenceHash: string;
  allowedChanges: CandidateRevisionChange[];
  instructions: string;
  issuedAt: number;
  expiresAt: number;
}
export type CandidateRevisionBinding = CandidateRevisionGrant & {
  stage: "issued" | "reserved" | "started";
  instanceOwner?: string;
  instanceFence?: number;
  sessionId?: string;
};
type Lease = Pick<InstanceLease, "ownerId" | "fence">;
type Admission = { workItemId: string; attempt: number; maxAttempts: number; now?: number };
const identifier = z.string().min(1).max(256).refine(value => value.trim() === value);
const integer = z.number().int().safe().positive();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.number().int().safe().nonnegative();
function testPath(path: string): boolean { return /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path); }
const pathSchema = z.string().min(1).max(500).refine(value => ![...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || "\\*?[]{}:".includes(character)) &&
  !value.startsWith("/") && value.split("/").every(part => !!part && part !== "." && part !== ".." &&
    !/^(?:\.git.*|\.ssh|\.env.*|node_modules|vendor|dist|build|coverage)$/iu.test(part)) && redactSensitiveText(value) === value);
const changeSchema = z.strictObject({ path: pathSchema, operation: z.enum(["add", "modify"]), parentBlobSha: sha.nullable(), resultBlobSha: sha.optional() })
  .refine(value => value.operation === "add" ? value.parentBlobSha === null && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(value.path) :
    value.parentBlobSha !== null && value.resultBlobSha !== undefined && value.parentBlobSha !== value.resultBlobSha &&
    !testPath(value.path) && /\.[jt]sx?$/u.test(value.path) && !/(?:^|\/)[^/]*(?:config|lock|package|vite|webpack|eslint|vitest|tsconfig)[^/]*$/iu.test(value.path));
const changesSchema = z.array(changeSchema).min(1).max(16).refine(values => new Set(values.map(value => value.path)).size === values.length &&
  values.some(value => value.operation === "add") && values.filter(value => value.operation === "modify").length <= 1);
const instructionsSchema = z.string().min(1).refine(value => value.trim() === value && Buffer.byteLength(value) <= 16_000 &&
  !value.includes("\0") && redactSensitiveText(value) === value);
const requestSchema = z.strictObject({ requestId: identifier, workItemId: identifier, expectedOwnerGeneration: integer,
  expectedWorkItemVersion: integer, expectedPlanRevision: integer, expectedSnapshotRevision: integer,
  expectedParentRunId: identifier, expectedParentSha: sha, expectedBaseSha: sha, authorizationReferenceHash: digest,
  allowedChanges: changesSchema, instructions: instructionsSchema });
const grantSchema = z.strictObject({ version: z.literal(1), requestId: identifier, requestHash: digest, workItemId: identifier,
  workItemVersion: integer, planRevision: integer, snapshotRevision: integer, snapshotHash: digest, proposalHash: digest,
  executionScopeHash: digest, nodeId: identifier, parentRunId: identifier, parentSha: sha, baseSha: sha, buildParentSha: sha,
  repository: z.string().min(1), attempt: z.number().int().min(1).max(3), maxAttempts: z.literal(3), ownerBindingId: identifier,
  ownerGeneration: integer, ownerIdentityHash: digest, authorizationReferenceHash: digest, allowedChanges: changesSchema,
  instructions: instructionsSchema, issuedAt: timestamp, expiresAt: timestamp });
const requestRowSchema = z.strictObject({ request_id: identifier, request_hash: digest, work_item_id: identifier,
  work_item_version: integer, plan_revision: integer, snapshot_revision: integer, node_id: identifier, parent_run_id: identifier,
  parent_sha: sha, base_sha: sha, build_parent_sha: sha, attempt: integer, grant_json: z.string(), issued_at: timestamp, expires_at: timestamp });
const stageRowSchema = z.strictObject({ request_id: identifier, stage: z.enum(["reserved", "started"]), work_item_id: identifier,
  attempt: integer, instance_owner: identifier, instance_fence: integer, session_id: identifier.nullable(), created_at: timestamp });
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fail(reason: string): never { throw new Error(`candidate_revision_${reason}`); }
function requestForGrant(grant: CandidateRevisionGrant): CandidateRevisionRequest {
  return parseCandidateRevisionRequest({ requestId: grant.requestId, workItemId: grant.workItemId,
    expectedOwnerGeneration: grant.ownerGeneration, expectedWorkItemVersion: grant.workItemVersion,
    expectedPlanRevision: grant.planRevision, expectedSnapshotRevision: grant.snapshotRevision,
    expectedParentRunId: grant.parentRunId, expectedParentSha: grant.parentSha, expectedBaseSha: grant.baseSha,
    authorizationReferenceHash: grant.authorizationReferenceHash, allowedChanges: grant.allowedChanges, instructions: grant.instructions });
}
function schemaAvailable(db: DatabaseSync): boolean {
  const value = z.object({ user_version: timestamp }).parse(db.prepare("PRAGMA user_version").get());
  return value.user_version >= 40;
}
function readStored(db: DatabaseSync, requestId: string) {
  const raw = db.prepare("SELECT * FROM collaboration_candidate_revision_requests WHERE request_id=?").get(requestId);
  if (!raw) fail("request_missing");
  try {
    const row = requestRowSchema.parse(raw), grant = grantSchema.parse(JSON.parse(row.grant_json));
    if (grant.requestId !== row.request_id || grant.requestHash !== row.request_hash || grant.workItemId !== row.work_item_id ||
      grant.workItemVersion !== row.work_item_version || grant.planRevision !== row.plan_revision || grant.snapshotRevision !== row.snapshot_revision ||
      grant.nodeId !== row.node_id || grant.parentRunId !== row.parent_run_id || grant.parentSha !== row.parent_sha || grant.baseSha !== row.base_sha ||
      grant.buildParentSha !== row.build_parent_sha || grant.buildParentSha !== grant.parentSha || grant.attempt !== row.attempt ||
      grant.issuedAt !== row.issued_at || grant.expiresAt !== row.expires_at || grant.expiresAt !== grant.issuedAt + 900_000 ||
      grant.requestHash !== hash(JSON.stringify(requestForGrant(grant)))) fail("stored_binding_invalid");
    const stages = z.array(stageRowSchema).parse(db.prepare("SELECT * FROM collaboration_candidate_revision_stages WHERE request_id=? ORDER BY created_at,stage").all(requestId));
    const reserved = stages.find(stage => stage.stage === "reserved"), started = stages.find(stage => stage.stage === "started");
    if (stages.length > 2 || (started && !reserved)) fail("stage_invalid");
    for (const stage of stages) {
      if (stage.request_id !== requestId || stage.work_item_id !== grant.workItemId || stage.attempt !== grant.attempt ||
        stage.created_at < grant.issuedAt || stage.created_at >= grant.expiresAt ||
        (stage.stage === "reserved" ? stage.session_id !== null : stage.session_id === null)) fail("stage_invalid");
      if (!db.prepare("SELECT 1 FROM collaboration_execution_dispatches WHERE work_item_id=? AND plan_revision=? AND attempt=? AND instance_owner=? AND instance_fence=? AND created_at>=? AND created_at<=?")
        .get(grant.workItemId, grant.planRevision, grant.attempt, stage.instance_owner, stage.instance_fence, grant.issuedAt, stage.created_at)) fail("dispatch_mismatch");
    }
    if (started && reserved && (started.instance_owner !== reserved.instance_owner || started.instance_fence !== reserved.instance_fence || started.created_at < reserved.created_at ||
      !db.prepare("SELECT 1 FROM collaboration_execution_sessions WHERE id=? AND work_item_id=? AND plan_revision=? AND attempt=? AND repository_path=? AND base_sha=? AND instance_owner=? AND instance_fence=? AND created_at>=? AND created_at<=?")
        .get(started.session_id, grant.workItemId, grant.planRevision, grant.attempt, grant.repository, grant.baseSha, started.instance_owner, started.instance_fence, reserved.created_at, started.created_at))) fail("session_mismatch");
    return { grant, reserved, started };
  } catch (error) {
    if (error instanceof Error && /^candidate_revision_[a-z_]+$/u.test(error.message)) throw error;
    return fail("stored_record_invalid");
  }
}
function nextAttempt(db: DatabaseSync, workItemId: string): number {
  const row = z.object({ n: timestamp }).parse(db.prepare("SELECT COALESCE(MAX(attempt),0) AS n FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_dispatches WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=?)").get(workItemId, workItemId, workItemId));
  return row.n + 1;
}
function failedAttempt(db: DatabaseSync, workItemId: string, attempt: number, now: number, expectedParentRunId: string): boolean {
  const session = z.object({ id: identifier, settled: z.number().int() }).optional().parse(db.prepare("SELECT s.id,EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=s.id AND f.created_at<=?) AS settled FROM collaboration_execution_sessions s WHERE s.work_item_id=? AND s.attempt=?").get(now, workItemId, attempt));
  if (session && session.settled !== 1) return false;
  const run = z.object({ id: identifier, status: z.string(), base_sha: z.string().nullable(), result_sha: z.string().nullable(), started_at: timestamp, finished_at: timestamp.nullable() }).optional().parse(db.prepare("SELECT id,status,base_sha,result_sha,started_at,finished_at FROM collaboration_runs WHERE work_item_id=? AND attempt=?").get(workItemId, attempt));
  if (!run) return !!db.prepare("SELECT 1 FROM collaboration_execution_preparation_results WHERE work_item_id=? AND attempt=? AND state='failed' AND created_at<=?").get(workItemId, attempt, now);
  if (!session || session.id !== run.id || !["failed", "invalid", "timed_out", "needs_configuration"].includes(run.status) ||
    run.finished_at === null || run.finished_at < run.started_at || run.finished_at > now) return false;
  if (run.result_sha === null) return !db.prepare("SELECT 1 FROM collaboration_candidates WHERE run_id=? AND result_sha IS NOT NULL").get(run.id);
  // A diagnostic commit is recoverable only when it belongs to this exact failed
  // revision. Never relabel or erase an arbitrary pre-existing candidate SHA.
  const stage = z.object({ request_id: identifier }).optional().parse(db.prepare("SELECT request_id FROM collaboration_candidate_revision_stages WHERE work_item_id=? AND attempt=? AND stage='started' AND session_id=?").get(workItemId, attempt, run.id));
  if (!stage) return false;
  const state = readStored(db, stage.request_id), grant = state.grant;
  if (!state.started || grant.parentRunId !== expectedParentRunId || run.base_sha !== grant.baseSha) return false;
  const candidate = z.object({ quality_json: z.string() }).optional().parse(db.prepare("SELECT quality_json FROM collaboration_candidates WHERE run_id=? AND result_sha=? AND base_sha=? AND state IN ('test_failed','invalid','needs_configuration','not_verified')").get(run.id, run.result_sha, grant.baseSha));
  if (!candidate) return false;
  const lineageSchema = z.strictObject({ version: z.literal(1), requestId: identifier, requestHash: digest, parentRunId: identifier,
    parentSha: sha, baseSha: sha, buildParentSha: sha, candidateSha: sha });
  try {
    const lineage = z.object({ lineage: lineageSchema }).parse(JSON.parse(candidate.quality_json)).lineage;
    return lineage.requestId === grant.requestId && lineage.requestHash === grant.requestHash && lineage.parentRunId === grant.parentRunId &&
      lineage.parentSha === grant.parentSha && lineage.baseSha === grant.baseSha && lineage.buildParentSha === grant.buildParentSha && lineage.candidateSha === run.result_sha;
  } catch { return false; }
}
function readBinding(db: DatabaseSync, workItemId: string, parentRunId: string, now: number, allowedSessionId?: string, allowedAttempt?: number) {
  assertLedgerArmed(db);
  const owners = z.array(z.object({ id: identifier, generation: integer, sender_corp_id: z.string(), sender_staff_id: z.string() })).parse(
    db.prepare("SELECT id,generation,sender_corp_id,sender_staff_id FROM collaboration_owner_bindings WHERE active=1 AND revoked_at IS NULL").all());
  if (owners.length !== 1) fail("owner_unavailable");
  const owner = owners[0];
  const item = z.object({ version: integer, current_plan_revision: integer }).optional().parse(db.prepare("SELECT version,current_plan_revision FROM collaboration_work_items WHERE id=? AND control_state='active' AND definition_status='ready_for_execution' AND status NOT IN ('accepted','cancelled') AND accepted_candidate_sha IS NULL").get(workItemId));
  if (!item) fail("target_unavailable");
  const plan = z.object({ snapshot_revision: integer, proposal_hash: digest }).optional().parse(db.prepare("SELECT snapshot_revision,proposal_hash FROM collaboration_plan_revisions WHERE work_item_id=? AND revision=? AND status='published'").get(workItemId, item.current_plan_revision));
  const snapshot = readLatestWorkItemSnapshot(db, workItemId);
  if (!plan || !snapshot || plan.snapshot_revision !== snapshot.revision || !snapshot.repository || !snapshot.goalConfirmed ||
    !snapshot.goal?.trim() || !snapshot.acceptanceConditions.length || snapshot.blockingAmbiguities.length ||
    !readPlanMaterialReadiness(db, workItemId, item.current_plan_revision).ready) fail("spec_unavailable");
  const controls = z.object({ n: timestamp }).parse(db.prepare("SELECT count(DISTINCT work_item_version) AS n FROM collaboration_control_events WHERE work_item_id=? AND work_item_version>? AND work_item_version<=? AND action IN ('pause','resume','retry')").get(workItemId, snapshot.sourceWorkItemVersion, item.version));
  if (item.version < snapshot.sourceWorkItemVersion || item.version - snapshot.sourceWorkItemVersion !== controls.n) fail("spec_stale");
  const nodes = z.array(z.object({ node_id: identifier, read_scope_json: z.string(), write_scope_json: z.string(), deny_scope_json: z.string() })).parse(
    db.prepare("SELECT node_id,read_scope_json,write_scope_json,deny_scope_json FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=? AND node_type='modify' AND active=1 AND control_state='active'").all(workItemId, item.current_plan_revision));
  if (nodes.length !== 1) fail("node_unavailable");
  const node = nodes[0];
  const run = z.object({ id: identifier, attempt: integer, base_sha: sha, result_sha: sha, repository_path: z.string(), started_at: timestamp, finished_at: timestamp }).optional().parse(
    db.prepare("SELECT r.id,r.attempt,r.base_sha,r.result_sha,r.repository_path,r.started_at,r.finished_at FROM collaboration_runs r JOIN collaboration_candidates c ON c.run_id=r.id WHERE r.id=? AND r.work_item_id=? AND r.plan_revision=? AND r.node_id=? AND r.status='succeeded' AND r.interrupt_requested_at IS NULL AND c.state='target_tests_passed' AND c.base_sha=r.base_sha AND c.result_sha=r.result_sha AND r.attempt=(SELECT MAX(latest.attempt) FROM collaboration_runs latest JOIN collaboration_candidates candidate ON candidate.run_id=latest.id WHERE latest.work_item_id=r.work_item_id AND latest.plan_revision=r.plan_revision AND latest.status='succeeded' AND candidate.state='target_tests_passed' AND candidate.result_sha IS NOT NULL)")
      .get(parentRunId, workItemId, item.current_plan_revision, node.node_id));
  if (!run || run.finished_at < run.started_at || run.finished_at > now) fail("parent_unavailable");
  let repository: string;
  try { repository = realpathSync(snapshot.repository); if (realpathSync(run.repository_path) !== repository) fail("repository_mismatch"); }
  catch { return fail("repository_unavailable"); }
  if (!db.prepare("SELECT 1 FROM collaboration_execution_sessions s JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.id=? AND s.work_item_id=? AND s.plan_revision=? AND s.attempt=? AND s.base_sha=? AND s.repository_path=? AND f.created_at<=?")
    .get(run.id, workItemId, item.current_plan_revision, run.attempt, run.base_sha, repository, now)) fail("parent_unsettled");
  if (db.prepare("SELECT 1 FROM collaboration_execution_sessions s WHERE s.repository_path=? AND s.id<>? AND NOT EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=s.id) UNION ALL SELECT 1 FROM collaboration_verification_sessions s WHERE s.repository_path=? AND NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=s.id) LIMIT 1")
    .get(repository, allowedSessionId ?? "", repository)) fail("repository_unsettled");
  if (db.prepare("SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=? AND r.id<>? AND (r.status='running' OR r.finished_at IS NULL OR NOT EXISTS(SELECT 1 FROM collaboration_execution_sessions s JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.id=r.id AND s.work_item_id=r.work_item_id AND s.plan_revision=r.plan_revision AND s.attempt=r.attempt)) LIMIT 1").get(workItemId, allowedSessionId ?? "")) fail("history_unsettled");
  const later = z.array(z.object({ attempt: integer })).parse(db.prepare("SELECT DISTINCT attempt FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_dispatches WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=?) WHERE attempt>? AND attempt<>?").all(workItemId, workItemId, workItemId, run.attempt, allowedAttempt ?? 0));
  if (later.some(row => !failedAttempt(db, workItemId, row.attempt, now, run.id))) fail("later_attempt_unsettled_or_has_candidate");
  const scope = db.prepare("SELECT node_id,node_type,assigned_agent_id,objective,input_evidence_json,instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json,completion_definition,risk,budget_json,active FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=? ORDER BY node_id").all(workItemId, item.current_plan_revision);
  return { workItemId, workItemVersion: item.version, planRevision: item.current_plan_revision, snapshotRevision: snapshot.revision,
    snapshotHash: hash(JSON.stringify(db.prepare("SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id=? AND revision=?").get(workItemId, snapshot.revision))),
    proposalHash: plan.proposal_hash, executionScopeHash: hash(JSON.stringify(scope)), nodeId: node.node_id, parentRunId: run.id, parentSha: run.result_sha,
    baseSha: run.base_sha, buildParentSha: run.result_sha, repository, ownerBindingId: owner.id, ownerGeneration: owner.generation,
    ownerIdentityHash: hash(JSON.stringify([owner.sender_corp_id, owner.sender_staff_id])), node };
}
function checkGitAndScope(binding: ReturnType<typeof readBinding>, changes: readonly CandidateRevisionChange[]): void {
  const read = z.array(z.string()).parse(JSON.parse(binding.node.read_scope_json));
  const write = z.array(z.string()).parse(JSON.parse(binding.node.write_scope_json));
  const deny = z.array(z.string()).parse(JSON.parse(binding.node.deny_scope_json));
  const git = (args: string[]) => execFileSync("git", ["--no-replace-objects", "--literal-pathspecs", "-C", binding.repository,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: binding.repository, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    for (const value of [binding.baseSha, binding.parentSha]) if (git(["cat-file", "-t", value]).trim() !== "commit") fail("git_binding_invalid");
    git(["merge-base", "--is-ancestor", binding.baseSha, binding.parentSha]);
    if (binding.baseSha === binding.parentSha) fail("parent_not_candidate");
    for (const change of changes) {
      const parts = change.path.split("/");
      if (!matchesPathScope(change.path, read) || !matchesPathScope(change.path, write) || parts.some((_, index) => matchesPathScope(parts.slice(0, index + 1).join("/"), deny))) fail("change_outside_original_scope");
      for (let index = 1; index <= parts.length; index++) {
        const path = parts.slice(0, index).join("/"), entry = git(["ls-tree", "-z", binding.parentSha, "--", path]);
        if (index < parts.length) { if (entry && !/^040000 tree [a-f0-9]+\t[^\0]+\0$/u.test(entry)) fail("change_parent_not_directory"); continue; }
        if (change.operation === "add") { if (entry) fail("add_path_already_exists"); }
        else {
          const match = /^100(?:644|755) blob ([a-f0-9]+)\t[^\0]+\0$/u.exec(entry);
          if (!match || match[1] !== change.parentBlobSha) fail("parent_blob_mismatch");
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && /^candidate_revision_[a-z_]+$/u.test(error.message)) throw error;
    fail("git_binding_unavailable");
  }
}
function assertBound(db: DatabaseSync, grant: CandidateRevisionGrant, now: number, allowedSessionId?: string, started = false): void {
  if (now < grant.issuedAt || (!started && now >= grant.expiresAt)) fail("expired");
  const { node: _node, ...current } = readBinding(db, grant.workItemId, grant.parentRunId, now, allowedSessionId, grant.attempt);
  if (Object.entries(current).some(([key, value]) => !Object.entries(grant).some(([grantKey, grantValue]) => grantKey === key && grantValue === value))) fail("binding_changed");
}
function appendStageAudit(db: DatabaseSync, grant: CandidateRevisionGrant, stage: "issued" | "reserved" | "started", now: number): void {
  appendControlAudit(db, { requestId: grant.requestId, workItemId: grant.workItemId, action: `candidate.revision.${stage}`,
    outcome: "allow", policyRule: "local-candidate-revision-v1", resource: { version: 1, stage, requestHash: grant.requestHash }, afterHash: hash(JSON.stringify(grant)), now });
}
export function parseCandidateRevisionRequest(value: Parameters<typeof requestSchema.safeParse>[0]): CandidateRevisionRequest {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new Error("candidate_revision_request_invalid");
  return { ...result.data, allowedChanges: [...result.data.allowedChanges].sort((left, right) => left.path.localeCompare(right.path)) };
}
/** Trusted private local headless entry only. The reference hash is provenance, never authentication. */
export function authorizeCandidateRevisionLocally(db: DatabaseSync, input: CandidateRevisionRequest & { now?: number }): CandidateRevisionGrant & { duplicate: boolean } {
  const { now: suppliedNow, ...raw } = input, now = timestamp.parse(suppliedNow ?? Date.now());
  const request = parseCandidateRevisionRequest(raw), requestHash = hash(JSON.stringify(request));
  if (!schemaAvailable(db)) fail("schema_unavailable");
  if (db.isTransaction) fail("transaction_already_open");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(db);
    if (db.prepare("SELECT 1 FROM collaboration_candidate_revision_requests WHERE request_id=?").get(request.requestId)) {
      const state = readStored(db, request.requestId);
      if (state.grant.requestHash !== requestHash) fail("request_conflict");
      db.exec("COMMIT"); return { ...state.grant, duplicate: true };
    }
    if (db.prepare("SELECT 1 FROM collaboration_audit_events WHERE request_id=? LIMIT 1").get(request.requestId)) fail("request_conflict");
    const prior = z.array(z.object({ request_id: identifier })).parse(db.prepare("SELECT request_id FROM collaboration_candidate_revision_requests WHERE work_item_id=?").all(request.workItemId));
    for (const row of prior) { const state = readStored(db, row.request_id);
      if (state.reserved ? !failedAttempt(db, state.grant.workItemId, state.grant.attempt, now, request.expectedParentRunId) : state.grant.expiresAt > now) fail("authorization_conflict"); }
    const binding = readBinding(db, request.workItemId, request.expectedParentRunId, now);
    if (binding.ownerGeneration !== request.expectedOwnerGeneration || binding.workItemVersion !== request.expectedWorkItemVersion ||
      binding.planRevision !== request.expectedPlanRevision || binding.snapshotRevision !== request.expectedSnapshotRevision ||
      binding.parentSha !== request.expectedParentSha || binding.baseSha !== request.expectedBaseSha) fail("expected_binding_mismatch");
    const attempt = nextAttempt(db, request.workItemId);
    if (attempt > 3) fail("attempt_limit_exhausted");
    checkGitAndScope(binding, request.allowedChanges);
    const { node: _node, ...identity } = binding;
    const grant = grantSchema.parse({ version: 1, requestId: request.requestId, requestHash, ...identity, attempt, maxAttempts: 3,
      allowedChanges: request.allowedChanges, instructions: request.instructions, authorizationReferenceHash: request.authorizationReferenceHash,
      issuedAt: now, expiresAt: now + 900_000 });
    db.prepare("INSERT INTO collaboration_candidate_revision_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(grant.requestId, grant.requestHash, grant.workItemId, grant.workItemVersion, grant.planRevision, grant.snapshotRevision, grant.nodeId,
        grant.parentRunId, grant.parentSha, grant.baseSha, grant.buildParentSha, grant.attempt, JSON.stringify(grant), grant.issuedAt, grant.expiresAt);
    appendStageAudit(db, grant, "issued", now);
    db.exec("COMMIT"); return { ...grant, duplicate: false };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function pendingCandidateRevisionWorkItems(db: DatabaseSync, now = Date.now()): string[] {
  if (!schemaAvailable(db)) return [];
  timestamp.parse(now);
  const rows = z.array(z.object({ request_id: identifier })).parse(db.prepare("SELECT request_id FROM collaboration_candidate_revision_requests WHERE issued_at<=? AND expires_at>? ORDER BY issued_at,request_id").all(now, now));
  const workItems: string[] = [];
  for (const row of rows) {
    const state = readStored(db, row.request_id);
    if (state.reserved || nextAttempt(db, state.grant.workItemId) !== state.grant.attempt) continue;
    try { assertBound(db, state.grant, now); } catch { continue; }
    workItems.push(state.grant.workItemId);
  }
  return [...new Set(workItems)];
}
function selectedState(db: DatabaseSync, workItemId: string, attempt: number) {
  if (!schemaAvailable(db)) return null;
  const rows = z.array(z.object({ request_id: identifier })).parse(db.prepare("SELECT request_id FROM collaboration_candidate_revision_requests WHERE work_item_id=? AND attempt=? ORDER BY issued_at DESC,request_id").all(workItemId, attempt));
  const states = rows.map(row => readStored(db, row.request_id)), consumed = states.filter(state => state.reserved);
  if (consumed.length > 1) fail("attempt_binding_ambiguous");
  return consumed[0] ?? states[0] ?? null;
}
function assertBudget(input: Admission): void {
  if (input.maxAttempts !== 3 || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 3) fail("attempt_forbidden");
}
function assertDispatch(db: DatabaseSync, grant: CandidateRevisionGrant, lease: Lease, now: number): void {
  if (!db.prepare("SELECT 1 FROM collaboration_execution_dispatches WHERE work_item_id=? AND attempt=? AND plan_revision=? AND instance_owner=? AND instance_fence=? AND created_at>=? AND created_at<=? AND created_at<?")
    .get(grant.workItemId, grant.attempt, grant.planRevision, lease.ownerId, lease.fence, grant.issuedAt, now, grant.expiresAt)) fail("dispatch_mismatch");
  if (nextAttempt(db, grant.workItemId) !== grant.attempt + 1) fail("attempt_changed");
}
/** Insert dispatch first in this transaction. A failure rolls back both dispatch and reservation. */
export function reserveCandidateRevision(db: DatabaseSync, input: Admission & { lease: Lease }): CandidateRevisionGrant {
  if (!db.isTransaction) fail("transaction_required");
  assertBudget(input); const now = timestamp.parse(input.now ?? Date.now());
  assertLedgerArmed(db); assertCurrentInstanceLease(db, input.lease, now);
  const state = selectedState(db, input.workItemId, input.attempt);
  if (!state || state.reserved) fail("reservation_unavailable");
  const grant = state.grant;
  assertBound(db, grant, now); assertDispatch(db, grant, input.lease, now);
  if (db.prepare("SELECT 1 FROM collaboration_execution_sessions WHERE work_item_id=? AND attempt=? UNION ALL SELECT 1 FROM collaboration_runs WHERE work_item_id=? AND attempt=? UNION ALL SELECT 1 FROM collaboration_execution_preparation_results WHERE work_item_id=? AND attempt=? LIMIT 1")
    .get(grant.workItemId, grant.attempt, grant.workItemId, grant.attempt, grant.workItemId, grant.attempt)) fail("already_started");
  db.prepare("INSERT INTO collaboration_candidate_revision_stages VALUES(?,'reserved',?,?,?,?,NULL,?)").run(grant.requestId, grant.workItemId, grant.attempt, input.lease.ownerId, input.lease.fence, now);
  appendStageAudit(db, grant, "reserved", now);
  return grant;
}
type StartAdmission = Admission & { lease?: Lease; baseSha?: string; buildParentSha?: string };
function canStart(db: DatabaseSync, input: StartAdmission, sessionId?: string): CandidateRevisionGrant {
  assertBudget(input); const now = timestamp.parse(input.now ?? Date.now());
  assertLedgerArmed(db);
  const state = selectedState(db, input.workItemId, input.attempt);
  if (!state?.reserved || state.started) fail("start_unavailable");
  const grant = state.grant, lease = { ownerId: state.reserved.instance_owner, fence: state.reserved.instance_fence };
  assertCurrentInstanceLease(db, lease, now);
  if (input.lease && (input.lease.ownerId !== lease.ownerId || input.lease.fence !== lease.fence)) fail("lease_mismatch");
  if ((input.baseSha !== undefined && input.baseSha !== grant.baseSha) || (input.buildParentSha !== undefined && input.buildParentSha !== grant.buildParentSha)) fail("base_changed");
  assertBound(db, grant, now, sessionId); assertDispatch(db, grant, lease, now);
  if (db.prepare("SELECT 1 FROM collaboration_runs WHERE work_item_id=? AND attempt=? UNION ALL SELECT 1 FROM collaboration_execution_preparation_results WHERE work_item_id=? AND attempt=? LIMIT 1").get(grant.workItemId, grant.attempt, grant.workItemId, grant.attempt)) fail("already_started");
  const session = z.object({ id: identifier }).optional().parse(db.prepare("SELECT id FROM collaboration_execution_sessions WHERE work_item_id=? AND attempt=?").get(grant.workItemId, grant.attempt));
  if (sessionId ? session?.id !== sessionId : session !== undefined) fail("session_mismatch");
  if (sessionId && !db.prepare("SELECT 1 FROM collaboration_execution_sessions WHERE id=? AND work_item_id=? AND plan_revision=? AND repository_path=? AND base_sha=? AND instance_owner=? AND instance_fence=? AND created_at>=? AND created_at<=?")
    .get(sessionId, grant.workItemId, grant.planRevision, grant.repository, grant.baseSha, lease.ownerId, lease.fence, state.reserved.created_at, now)) fail("session_mismatch");
  return grant;
}
export function assertCandidateRevisionCanStart(db: DatabaseSync, input: StartAdmission): CandidateRevisionGrant { return canStart(db, input); }
/** Insert execution session first in this transaction; started consumes authority before native Git I/O. */
export function markCandidateRevisionStarted(db: DatabaseSync, input: Admission & { lease: Lease; baseSha: string; buildParentSha?: string; sessionId: string }): CandidateRevisionGrant {
  if (!db.isTransaction) fail("transaction_required");
  if (!identifier.safeParse(input.sessionId).success) fail("session_invalid");
  const grant = canStart(db, input, input.sessionId), now = timestamp.parse(input.now ?? Date.now());
  db.prepare("INSERT INTO collaboration_candidate_revision_stages VALUES(?,'started',?,?,?,?,?,?)").run(grant.requestId, grant.workItemId, grant.attempt, input.lease.ownerId, input.lease.fence, input.sessionId, now);
  appendStageAudit(db, grant, "started", now);
  return grant;
}
export function readCandidateRevisionForAttempt(db: DatabaseSync, workItemId: string, attempt: number): CandidateRevisionBinding | null {
  const state = selectedState(db, workItemId, attempt);
  if (!state) return null;
  const stage = state.started ?? state.reserved;
  const result: CandidateRevisionBinding = { ...state.grant, stage: stage?.stage ?? "issued" };
  if (stage) { result.instanceOwner = stage.instance_owner; result.instanceFence = stage.instance_fence; }
  if (state.started) result.sessionId = state.started.session_id!;
  return result;
}
export function assertCandidateRevisionStillCurrent(db: DatabaseSync, input: { workItemId: string; attempt: number; sessionId: string; now?: number }): CandidateRevisionGrant {
  const now = timestamp.parse(input.now ?? Date.now()), state = selectedState(db, input.workItemId, input.attempt);
  if (!state?.started || state.started.session_id !== input.sessionId) fail("started_binding_mismatch");
  assertCurrentInstanceLease(db, { ownerId: state.started.instance_owner, fence: state.started.instance_fence }, now);
  assertBound(db, state.grant, now, input.sessionId, true);
  return state.grant;
}
export function candidateIsSupersededByRevision(db: DatabaseSync, runId: string, candidateSha: string, now = Date.now()): boolean {
  if (!schemaAvailable(db)) return false;
  timestamp.parse(now);
  const rows = z.array(z.object({ request_id: identifier })).parse(db.prepare("SELECT request_id FROM collaboration_candidate_revision_requests WHERE parent_run_id=? AND parent_sha=?").all(runId, candidateSha));
  let superseded = false;
  for (const row of rows) {
    const state = readStored(db, row.request_id);
    if (state.reserved || (state.grant.issuedAt <= now && now < state.grant.expiresAt)) superseded = true;
  }
  return superseded;
}
