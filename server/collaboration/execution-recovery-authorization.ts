import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendControlAudit } from "./audit.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";
import { canonicalRepository, hasUnsettledRepositoryActivity } from "./repository-occupancy.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";

const POLICY = "local-execution-recovery-v1";
const ACTION = "execution.recovery.";
const TTL = 15 * 60_000;
const id = z.string().min(1).max(256).refine(value => value.trim() === value);
const integer = z.number().int().safe().positive();
const timestamp = z.number().int().safe().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const requestSchema = z.strictObject({ requestId: id, workItemId: id, expectedOwnerGeneration: integer,
  expectedWorkItemVersion: integer, expectedPlanRevision: integer, expectedSnapshotRevision: integer,
  expectedFailedRunId: id, expectedBaseSha: sha, authorizationReferenceHash: hash });
const grantSchema = z.strictObject({ version: z.literal(1), requestId: id, requestHash: hash, workItemId: id,
  workItemVersion: integer, planRevision: integer, snapshotRevision: integer, snapshotHash: hash,
  proposalHash: hash, executionScopeHash: hash, failedRunId: id, priorAttempt: z.literal(3), attempt: z.literal(4),
  repository: z.string().min(1), baseSha: sha, ownerBindingId: id, ownerGeneration: integer, ownerIdentityHash: hash,
  authorizationReferenceHash: hash, issuedAt: timestamp, expiresAt: timestamp });
type Grant = z.infer<typeof grantSchema>;
export type ExecutionRecoveryAuthorizationResult = Grant & { duplicate: boolean };
export type RecoveryLease = Pick<InstanceLease, "ownerId" | "fence">;
const auditRowsSchema = z.array(z.strictObject({ id: z.string(), run_id: z.string().nullable(), action: z.string(), outcome: z.string(), resource_json: z.string(),
  created_at: timestamp, actor_principal_id: z.string().nullable(), work_item_id: z.string().nullable(), request_id: z.string().nullable(),
  policy_rule: z.string().nullable(), before_hash: z.string().nullable(), after_hash: z.string().nullable(), error: z.string().nullable() }));
const issuedSchema = z.strictObject({ version: z.literal(1), stage: z.literal("issued"), grant: grantSchema });
const reservedSchema = z.strictObject({ version: z.literal(1), stage: z.literal("reserved"), grant: grantSchema,
  instanceOwner: id, instanceFence: integer, reservedAt: timestamp });
const startedSchema = z.strictObject({ version: z.literal(1), stage: z.literal("started"), grant: grantSchema,
  instanceOwner: id, instanceFence: integer, reservedAt: timestamp, startedAt: timestamp, sessionId: id });
const recordSchema = z.discriminatedUnion("stage", [issuedSchema, reservedSchema, startedSchema]);
type RecoveryRecord = z.infer<typeof recordSchema>;
type RecoveryState = { grant: Grant; reserved?: z.infer<typeof reservedSchema>; started?: z.infer<typeof startedSchema> };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fail(reason: string): never { throw new Error(`execution_recovery_${reason}`); }
function clock(now = Date.now()): number { return timestamp.parse(now); }

function requestForGrant(grant: Grant) {
  return requestSchema.parse({ requestId: grant.requestId, workItemId: grant.workItemId,
    expectedOwnerGeneration: grant.ownerGeneration, expectedWorkItemVersion: grant.workItemVersion,
    expectedPlanRevision: grant.planRevision, expectedSnapshotRevision: grant.snapshotRevision,
    expectedFailedRunId: grant.failedRunId, expectedBaseSha: grant.baseSha,
    authorizationReferenceHash: grant.authorizationReferenceHash });
}

/** Audit rows are not DB-immutable. Parse every matching row and fail closed on ambiguity. */
function readState(db: DatabaseSync, workItemId: string): RecoveryState | undefined {
  const rows = auditRowsSchema.parse(db.prepare("SELECT * FROM collaboration_audit_events WHERE work_item_id=? AND (action LIKE ? OR policy_rule=?)").all(workItemId, `${ACTION}%`, POLICY));
  if (!rows.length) return undefined;
  const records = new Map<RecoveryRecord["stage"], RecoveryRecord>();
  for (const row of rows) {
    let record: RecoveryRecord;
    try { record = recordSchema.parse(JSON.parse(row.resource_json)); } catch { fail("audit_invalid"); }
    const grant = record.grant;
    const createdAt = record.stage === "issued" ? grant.issuedAt : record.stage === "reserved" ? record.reservedAt : record.startedAt;
    if (records.has(record.stage) || row.action !== `${ACTION}${record.stage}` || row.policy_rule !== POLICY ||
      row.outcome !== "allow" || row.work_item_id !== grant.workItemId || grant.workItemId !== workItemId ||
      row.request_id !== grant.requestId || row.created_at !== createdAt || row.after_hash !== digest(JSON.stringify(grant)) ||
      row.before_hash !== null || row.actor_principal_id !== null || row.run_id !== null || row.error !== null ||
      grant.expiresAt !== grant.issuedAt + TTL || grant.requestHash !== digest(JSON.stringify(requestForGrant(grant))) ||
      createdAt < grant.issuedAt || createdAt >= grant.expiresAt) fail("audit_invalid");
    records.set(record.stage, record);
  }
  const issued = records.get("issued");
  if (!issued || issued.stage !== "issued") fail("audit_invalid");
  const reservation = records.get("reserved"); const start = records.get("started");
  const reserved = reservation?.stage === "reserved" ? reservation : undefined;
  const started = start?.stage === "started" ? start : undefined;
  for (const record of records.values()) if (digest(JSON.stringify(record.grant)) !== digest(JSON.stringify(issued.grant))) fail("audit_binding_mismatch");
  if (started && (!reserved || started.instanceOwner !== reserved.instanceOwner || started.instanceFence !== reserved.instanceFence ||
    started.reservedAt !== reserved.reservedAt || started.startedAt < reserved.reservedAt)) fail("audit_invalid");
  return { grant: issued.grant, reserved, started };
}

function appendRecord(db: DatabaseSync, record: RecoveryRecord, now: number): void {
  appendControlAudit(db, { requestId: record.grant.requestId, workItemId: record.grant.workItemId,
    action: `${ACTION}${record.stage}`, outcome: "allow", policyRule: POLICY,
    resource: record, afterHash: digest(JSON.stringify(record.grant)), now });
}

function readBinding(db: DatabaseSync, workItemId: string, now: number) {
  assertLedgerArmed(db);
  const owners = z.array(z.object({ id, generation: integer, sender_corp_id: z.string(), sender_staff_id: z.string() })).parse(
    db.prepare("SELECT id,generation,sender_corp_id,sender_staff_id FROM collaboration_owner_bindings WHERE active=1 AND revoked_at IS NULL").all());
  if (owners.length !== 1) fail("owner_unavailable");
  const owner = owners[0];
  const item = z.object({ version: integer, current_plan_revision: integer }).optional().parse(
    db.prepare("SELECT version,current_plan_revision FROM collaboration_work_items WHERE id=? AND control_state='active' AND definition_status='ready_for_execution' AND status NOT IN ('accepted','cancelled')").get(workItemId));
  if (!item) fail("target_unavailable");
  const plan = z.object({ snapshot_revision: integer, proposal_hash: z.string() }).optional().parse(
    db.prepare("SELECT snapshot_revision,proposal_hash FROM collaboration_plan_revisions WHERE work_item_id=? AND revision=? AND status='published'").get(workItemId, item.current_plan_revision));
  const snapshot = readLatestWorkItemSnapshot(db, workItemId);
  if (!plan || !snapshot || plan.snapshot_revision !== snapshot.revision || !snapshot.repository || !snapshot.goalConfirmed ||
    !snapshot.goal?.trim() || !snapshot.acceptanceConditions.length || snapshot.blockingAmbiguities.length ||
    !hash.safeParse(plan.proposal_hash).success || !readPlanMaterialReadiness(db, workItemId, item.current_plan_revision).ready) fail("spec_unavailable");
  const controls = z.object({ n: timestamp }).parse(db.prepare("SELECT count(DISTINCT work_item_version) AS n FROM collaboration_control_events WHERE work_item_id=? AND work_item_version>? AND work_item_version<=? AND action IN ('pause','resume','retry')").get(workItemId, snapshot.sourceWorkItemVersion, item.version));
  if (item.version < snapshot.sourceWorkItemVersion || item.version - snapshot.sourceWorkItemVersion !== controls.n) fail("spec_stale");
  const nodes = z.array(z.object({ node_id: id })).parse(db.prepare("SELECT node_id FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=? AND node_type='modify' AND active=1 AND control_state='active'").all(workItemId, item.current_plan_revision));
  if (nodes.length !== 1) fail("node_unavailable");
  const executionScope = db.prepare("SELECT node_id,node_type,assigned_agent_id,objective,input_evidence_json,instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json,completion_definition,risk,budget_json,active FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=? ORDER BY node_id").all(workItemId, item.current_plan_revision);
  if (db.prepare("SELECT 1 FROM collaboration_runs WHERE work_item_id=? AND (status='running' OR (plan_revision=? AND status='succeeded')) LIMIT 1").get(workItemId, item.current_plan_revision)) fail("run_unavailable");
  const runs = z.array(z.object({ id, plan_revision: integer, node_id: id, status: z.string(), result_sha: z.string().nullable(), base_sha: sha,
    repository_path: z.string(), started_at: timestamp, finished_at: timestamp.nullable(), interrupt_requested_at: timestamp.nullable() })).parse(
    db.prepare("SELECT id,plan_revision,node_id,status,result_sha,base_sha,repository_path,started_at,finished_at,interrupt_requested_at FROM collaboration_runs WHERE work_item_id=? AND attempt=3").all(workItemId));
  const run = runs[0];
  if (runs.length !== 1 || run.plan_revision !== item.current_plan_revision || run.node_id !== nodes[0].node_id ||
    !["failed", "invalid", "timed_out", "needs_configuration"].includes(run.status) || run.result_sha !== null ||
    run.finished_at === null || run.finished_at < run.started_at || run.finished_at > now || run.interrupt_requested_at !== null) fail("failed_run_unavailable");
  const repository = canonicalRepository(snapshot.repository);
  if (canonicalRepository(run.repository_path) !== repository || hasUnsettledRepositoryActivity(db, repository)) fail("repository_unsettled");
  if (db.prepare("SELECT 1 FROM collaboration_execution_sessions s LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.work_item_id=? AND f.session_id IS NULL LIMIT 1").get(workItemId)) fail("execution_unsettled");
  const session = z.object({ base_sha: sha, repository_path: z.string() }).optional().parse(db.prepare("SELECT s.base_sha,s.repository_path FROM collaboration_execution_sessions s JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.id=? AND s.work_item_id=? AND s.plan_revision=? AND s.attempt=3").get(run.id, workItemId, item.current_plan_revision));
  if (!session || session.base_sha !== run.base_sha || canonicalRepository(session.repository_path) !== repository) fail("settlement_missing");
  const previous = z.array(z.object({ attempt: integer })).parse(db.prepare("SELECT DISTINCT attempt FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_dispatches WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=?) WHERE attempt<=3 ORDER BY attempt").all(workItemId, workItemId, workItemId));
  if (JSON.stringify(previous.map(row => row.attempt)) !== "[1,2,3]") fail("attempt_history_incomplete");
  if (db.prepare("SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=? AND (r.finished_at IS NULL OR r.status='running' OR NOT EXISTS(SELECT 1 FROM collaboration_execution_sessions s JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.id=r.id AND s.work_item_id=r.work_item_id AND s.attempt=r.attempt AND s.plan_revision=r.plan_revision)) LIMIT 1").get(workItemId)) fail("historical_run_unsettled");
  const snapshotRow = db.prepare("SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id=? AND revision=?").get(workItemId, snapshot.revision);
  return { workItemId, workItemVersion: item.version, planRevision: item.current_plan_revision,
    snapshotRevision: snapshot.revision, snapshotHash: digest(JSON.stringify(snapshotRow)), proposalHash: plan.proposal_hash,
    executionScopeHash: digest(JSON.stringify(executionScope)), failedRunId: run.id, repository, baseSha: run.base_sha,
    ownerBindingId: owner.id, ownerGeneration: owner.generation,
    ownerIdentityHash: digest(JSON.stringify([owner.sender_corp_id, owner.sender_staff_id])) };
}

function hasExtraAttempt(db: DatabaseSync, workItemId: string): boolean {
  return !!db.prepare("SELECT 1 FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_dispatches WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=?) WHERE attempt>=4 LIMIT 1").get(workItemId, workItemId, workItemId);
}

export interface ExecutionRecoveryAuthorizationInput {
  requestId: string;
  workItemId: string;
  expectedOwnerGeneration: number;
  expectedWorkItemVersion: number;
  expectedPlanRevision: number;
  expectedSnapshotRevision: number;
  expectedFailedRunId: string;
  expectedBaseSha: string;
  authorizationReferenceHash: string;
  now?: number;
}

export function parseExecutionRecoveryRequest(value: Parameters<typeof requestSchema.safeParse>[0]): Omit<ExecutionRecoveryAuthorizationInput, "now"> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) fail("request_invalid");
  return parsed.data;
}

/** Trusted local operator entry only. A reference hash is evidence, never authentication. */
export function authorizeExecutionRecoveryLocally(db: DatabaseSync, input: ExecutionRecoveryAuthorizationInput): ExecutionRecoveryAuthorizationResult {
  const { now: suppliedNow, ...raw } = input;
  const request = parseExecutionRecoveryRequest(raw); const now = clock(suppliedNow);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(db);
    const state = readState(db, request.workItemId);
    const sameRequest = z.array(z.object({ work_item_id: z.string().nullable(), action: z.string(), policy_rule: z.string().nullable() })).parse(
      db.prepare("SELECT work_item_id,action,policy_rule FROM collaboration_audit_events WHERE request_id=?").all(request.requestId));
    if (sameRequest.some(row => row.work_item_id !== request.workItemId || row.policy_rule !== POLICY ||
      ![`${ACTION}issued`, `${ACTION}reserved`, `${ACTION}started`].includes(row.action))) fail("request_conflict");
    if (state) {
      if (state.grant.requestId !== request.requestId || state.grant.requestHash !== digest(JSON.stringify(request))) fail("authorization_conflict");
      db.exec("COMMIT"); return { ...state.grant, duplicate: true };
    }
    const binding = readBinding(db, request.workItemId, now);
    if (binding.ownerGeneration !== request.expectedOwnerGeneration || binding.workItemVersion !== request.expectedWorkItemVersion ||
      binding.planRevision !== request.expectedPlanRevision || binding.snapshotRevision !== request.expectedSnapshotRevision ||
      binding.failedRunId !== request.expectedFailedRunId || binding.baseSha !== request.expectedBaseSha) fail("expected_binding_mismatch");
    if (hasExtraAttempt(db, request.workItemId)) fail("already_consumed");
    const grant = grantSchema.parse({ version: 1, ...binding, requestId: request.requestId, requestHash: digest(JSON.stringify(request)),
      authorizationReferenceHash: request.authorizationReferenceHash, priorAttempt: 3, attempt: 4, issuedAt: now, expiresAt: now + TTL });
    appendRecord(db, { version: 1, stage: "issued", grant }, now);
    db.exec("COMMIT"); return { ...grant, duplicate: false };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function assertBudget(attempt: number, maxAttempts: number): void {
  if (attempt !== 4 || maxAttempts !== 3) fail("attempt_forbidden");
}

function assertBound(db: DatabaseSync, grant: Grant, now: number): void {
  if (now < grant.issuedAt || now >= grant.expiresAt) fail("expired");
  const current = readBinding(db, grant.workItemId, now);
  if (Object.entries(current).some(([key, value]) => !Object.entries(grant).some(([grantKey, grantValue]) =>
    grantKey === key && grantValue === value))) fail("binding_changed");
}

function dispatchable(db: DatabaseSync, workItemId: string, attempt: number, maxAttempts: number, now: number): Grant {
  assertBudget(attempt, maxAttempts);
  const state = readState(db, workItemId);
  if (!state || state.reserved || state.started || hasExtraAttempt(db, workItemId)) fail("unavailable");
  assertBound(db, state.grant, now);
  return state.grant;
}

export function pendingExecutionRecoveryWorkItems(db: DatabaseSync, now = Date.now()): string[] {
  const rows = z.array(z.object({ work_item_id: z.string().nullable() })).parse(
    db.prepare("SELECT DISTINCT work_item_id FROM collaboration_audit_events WHERE action LIKE ? OR policy_rule=? ORDER BY work_item_id").all(`${ACTION}%`, POLICY));
  return rows.flatMap(row => row.work_item_id === null ? [] : [row.work_item_id])
    .filter(workItemId => executionRecoveryCanDispatch(db, workItemId, 4, 3, now));
}

export function executionRecoveryCanDispatch(db: DatabaseSync, workItemId: string, attempt: number, maxAttempts: number, now = Date.now()): boolean {
  try { dispatchable(db, workItemId, attempt, maxAttempts, clock(now)); return true; } catch { return false; }
}

/** The caller inserts dispatch 4 in this same transaction, before any execution I/O. */
export function reserveExecutionRecovery(db: DatabaseSync, input: { workItemId: string; attempt: number; maxAttempts: number; lease: RecoveryLease; now?: number }): void {
  if (!db.isTransaction) fail("transaction_required");
  const now = clock(input.now);
  assertLedgerArmed(db); assertCurrentInstanceLease(db, input.lease, now);
  const grant = dispatchable(db, input.workItemId, input.attempt, input.maxAttempts, now);
  appendRecord(db, reservedSchema.parse({ version: 1, stage: "reserved", grant,
    instanceOwner: input.lease.ownerId, instanceFence: input.lease.fence, reservedAt: now }), now);
}
export function assertExecutionRecoveryCanStart(db: DatabaseSync, input: { workItemId: string; attempt: number; maxAttempts: number; now?: number; lease?: RecoveryLease; baseSha?: string }): void {
  assertBudget(input.attempt, input.maxAttempts);
  const now = clock(input.now);
  assertLedgerArmed(db);
  const state = readState(db, input.workItemId);
  if (!state?.reserved || state.started) fail("start_unavailable");
  const reserved = state.reserved;
  const lease = { ownerId: reserved.instanceOwner, fence: reserved.instanceFence };
  assertCurrentInstanceLease(db, lease, now);
  if (input.lease && (input.lease.ownerId !== lease.ownerId || input.lease.fence !== lease.fence)) fail("lease_mismatch");
  if (input.baseSha !== undefined && input.baseSha !== state.grant.baseSha) fail("base_changed");
  assertBound(db, state.grant, now);
  const dispatches = z.array(z.object({ plan_revision: integer, attempt: integer, instance_owner: id, instance_fence: integer, created_at: timestamp })).parse(
    db.prepare("SELECT plan_revision,attempt,instance_owner,instance_fence,created_at FROM collaboration_execution_dispatches WHERE work_item_id=? AND attempt>=4").all(input.workItemId));
  const dispatch = dispatches[0];
  if (dispatches.length !== 1 || dispatch.attempt !== 4 || dispatch.plan_revision !== state.grant.planRevision ||
    dispatch.instance_owner !== lease.ownerId || dispatch.instance_fence !== lease.fence ||
    dispatch.created_at < reserved.reservedAt || dispatch.created_at > now || dispatch.created_at >= state.grant.expiresAt) fail("dispatch_mismatch");
  if (db.prepare("SELECT 1 FROM (SELECT attempt FROM collaboration_runs WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_sessions WHERE work_item_id=? UNION ALL SELECT attempt FROM collaboration_execution_preparation_results WHERE work_item_id=?) WHERE attempt>=4 LIMIT 1").get(input.workItemId, input.workItemId, input.workItemId)) fail("already_started");
}

/** The caller inserts this session in the same transaction; failures roll both writes back. */
export function consumeExecutionRecoveryStart(db: DatabaseSync, input: { workItemId: string; attempt: number; maxAttempts: number; lease: RecoveryLease; baseSha: string; sessionId: string; now?: number }): void {
  if (!db.isTransaction) fail("transaction_required");
  const now = clock(input.now);
  if (!id.safeParse(input.sessionId).success) fail("session_invalid");
  assertExecutionRecoveryCanStart(db, { ...input, now });
  const state = readState(db, input.workItemId)!;
  appendRecord(db, startedSchema.parse({ ...state.reserved, stage: "started", startedAt: now, sessionId: input.sessionId }), now);
}
