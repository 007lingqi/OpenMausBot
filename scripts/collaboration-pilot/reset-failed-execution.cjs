#!/usr/bin/env node
'use strict';

// One-off, offline maintenance. The caller must stop the coordinator and prove
// its containers empty before apply. This tool never operates Docker or Git.
// Dry-run opens an existing database read-only; neither mode migrates it.
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, lstatSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const ACTION = 'execution.reset.completed';
const POLICY = 'offline-failed-execution-reset-v1';
const failed = new Set(['failed', 'invalid', 'timed_out', 'needs_configuration']);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error(`failed_execution_reset_${reason}`); };
const check = (condition, reason) => { if (!condition) fail(reason); };
const normalizeSql = sql => sql.replace(/\s+/gu, ' ').trim().replace(/;$/u, '');

function parseScope(value) {
  const keys = ['operationId', 'workItemId', 'expectedWorkItemVersion', 'expectedPlanRevision', 'expectedSnapshotRevision', 'expectedOwnerGeneration', 'expectedBaseSha', 'expectedRepository', 'expectedRuns'];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: enforce the complete exact-key scope contract before accessing fields.
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'scope_invalid');
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: IDs must satisfy the bounded identifier grammar, without coercion.
  for (const key of ['operationId', 'workItemId']) check(typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value[key]), 'scope_invalid');
  for (const key of ['expectedWorkItemVersion', 'expectedPlanRevision', 'expectedSnapshotRevision', 'expectedOwnerGeneration']) check(Number.isSafeInteger(value[key]) && value[key] > 0, 'scope_invalid');
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: parse a full commit SHA rather than coercing other JSON values.
  check(typeof value.expectedBaseSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.expectedBaseSha), 'scope_invalid');
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: validate an absolute repository path with no control characters.
  check(typeof value.expectedRepository === 'string' && isAbsolute(value.expectedRepository) && !/[\0\r\n]/u.test(value.expectedRepository), 'scope_invalid');
  check(Array.isArray(value.expectedRuns) && value.expectedRuns.length === 4, 'scope_invalid');
  const runs = value.expectedRuns.map(run => {
    check(run && Object.keys(run).length === 4 && ['id', 'attempt', 'status', 'planRevision'].every(key => Object.hasOwn(run, key)), 'scope_invalid');
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Nested JSON boundary: validate the complete fixed-run identity, status and revision contract.
    check(typeof run.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(run.id) && failed.has(run.status) && Number.isSafeInteger(run.planRevision) && run.planRevision > 0, 'scope_invalid');
    return { id: run.id, attempt: run.attempt, status: run.status, planRevision: run.planRevision };
  }).sort((a, b) => a.attempt - b.attempt);
  check(runs.every((run, index) => run.attempt === index + 1) && new Set(runs.map(run => run.id)).size === 4, 'scope_invalid');
  return Object.fromEntries(keys.map(key => [key, key === 'expectedRuns' ? runs : value[key]]));
}

const deletionOrder = [
  'collaboration_delivery_queries', 'collaboration_outbox',
  'collaboration_execution_proofs', 'collaboration_execution_commands',
  'collaboration_execution_settlements', 'collaboration_execution_finalization_intents', 'collaboration_execution_sessions',
  'collaboration_execution_preparation_results', 'collaboration_execution_dispatches',
  'collaboration_test_evidence', 'collaboration_candidates', 'collaboration_run_events', 'collaboration_audit_events', 'collaboration_runs',
];
const deletionTriggers = {
  collaboration_delivery_queries: ['delivery_queries_no_delete', 'delivery query evidence cannot be deleted'],
  collaboration_execution_proofs: ['execution_proofs_no_delete', 'execution lifecycle is immutable'],
  collaboration_execution_commands: ['execution_commands_no_delete', 'execution lifecycle is immutable'],
  collaboration_execution_settlements: ['execution_settlements_no_delete', 'execution lifecycle is immutable'],
  collaboration_execution_finalization_intents: ['execution_finalization_no_delete', 'execution finalization is immutable'],
  collaboration_execution_sessions: ['execution_sessions_no_delete', 'execution lifecycle is immutable'],
  collaboration_execution_preparation_results: ['collaboration_preparation_no_delete', 'preparation result is immutable'],
  collaboration_execution_dispatches: ['collaboration_execution_dispatch_no_delete', 'execution dispatch is immutable'],
  collaboration_test_evidence: ['collaboration_test_evidence_no_delete', 'test evidence is immutable'],
  collaboration_candidates: ['collaboration_candidates_no_delete', 'candidate attempts are immutable'],
};
const knownRelations = new Set([
  'collaboration_delivery_queries:collaboration_outbox', 'collaboration_sent_association_choices:collaboration_outbox', 'collaboration_approval_presentations:collaboration_outbox',
  'collaboration_execution_proofs:collaboration_execution_commands', 'collaboration_execution_commands:collaboration_execution_sessions',
  'collaboration_execution_settlements:collaboration_execution_sessions', 'collaboration_execution_finalization_intents:collaboration_execution_sessions',
  'collaboration_execution_preparation_results:collaboration_execution_dispatches',
  ...['collaboration_run_events', 'collaboration_candidates', 'collaboration_test_evidence', 'collaboration_audit_events', 'collaboration_candidate_reviews', 'collaboration_verification_sessions', 'collaboration_approval_presentations'].map(table => `${table}:collaboration_runs`),
]);

function schemaState(db) {
  check(db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1, 'foreign_keys_required');
  check(db.prepare('PRAGMA user_version').get().user_version === 37 && db.prepare('SELECT count(*) AS n FROM collaboration_schema_migrations').get().n === 37, 'schema_changed');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  for (const table of tables) for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
    if (deletionOrder.includes(fk.table)) check(knownRelations.has(`${table}:${fk.table}`), 'unknown_relation');
  }
  const triggers = Object.entries(deletionTriggers).map(([table, [name, message]]) => {
    const trigger = schema.find(row => row.type === 'trigger' && row.name === name && row.tbl_name === table);
    const expected = `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`;
    check(trigger && normalizeSql(trigger.sql).replaceAll("ABORT,'", "ABORT, '") === expected, 'schema_changed');
    return trigger;
  });
  check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_violation');
  return { schema, tables, triggers };
}

function inspect(db, scope, now, tables) {
  check(db.prepare("SELECT state FROM collaboration_restore_guard WHERE singleton=1").get()?.state === 'live', 'restore_review_required');
  check(!db.prepare('SELECT 1 FROM collaboration_instance_lease WHERE expires_at>?').get(now), 'instance_live');
  check(!db.prepare("SELECT 1 FROM collaboration_runs WHERE status='running' LIMIT 1").get() && !db.prepare('SELECT 1 FROM collaboration_work_nodes WHERE lease_expires_at>? LIMIT 1').get(now), 'run_not_failed');
  const owners = db.prepare('SELECT generation FROM collaboration_owner_bindings WHERE active=1 AND revoked_at IS NULL').all();
  check(owners.length === 1 && owners[0].generation === scope.expectedOwnerGeneration, 'binding_changed');
  const wi = db.prepare('SELECT * FROM collaboration_work_items WHERE id=?').get(scope.workItemId);
  check(wi && wi.version === scope.expectedWorkItemVersion && wi.current_plan_revision === scope.expectedPlanRevision && wi.definition_status === 'ready_for_execution' && wi.control_state === 'active' && !['accepted', 'cancelled'].includes(wi.status) && wi.accepted_candidate_sha === null, 'binding_changed');
  const spec = db.prepare('SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id=? ORDER BY revision DESC LIMIT 1').get(scope.workItemId);
  const plan = db.prepare('SELECT * FROM collaboration_plan_revisions WHERE work_item_id=? AND revision=?').get(scope.workItemId, scope.expectedPlanRevision);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SQLite boundary: nullable persisted goal must be nonempty text within the full fixed Spec binding.
  check(spec && spec.revision === scope.expectedSnapshotRevision && spec.repository === scope.expectedRepository && spec.goal_confirmed === 1 && typeof spec.goal === 'string' && spec.goal.trim() && JSON.parse(spec.acceptance_json).length > 0 && JSON.parse(spec.blocking_ambiguities_json).length === 0 && plan?.status === 'published' && plan.snapshot_revision === spec.revision, 'binding_changed');
  const controlVersions = db.prepare("SELECT count(DISTINCT work_item_version) AS n FROM collaboration_control_events WHERE work_item_id=? AND work_item_version>? AND work_item_version<=? AND action IN ('pause','resume','retry')").get(scope.workItemId, spec.source_work_item_version, wi.version).n;
  check(wi.version >= spec.source_work_item_version && wi.version - spec.source_work_item_version === controlVersions, 'spec_stale');
  const nodes = db.prepare('SELECT rowid AS _reset_rowid,* FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=? AND active=1').all(scope.workItemId, scope.expectedPlanRevision);
  check(nodes.length > 0 && nodes.filter(node => node.node_type === 'modify').length === 1 && nodes.every(node => node.control_state === 'active' && !['leased', 'running', 'validating'].includes(node.runtime_state)), 'node_unavailable');
  const runs = db.prepare('SELECT * FROM collaboration_runs WHERE work_item_id=? ORDER BY attempt').all(scope.workItemId);
  check(runs.length === 4 && runs.every((run, index) => run.id === scope.expectedRuns[index].id && run.attempt === scope.expectedRuns[index].attempt && run.status === scope.expectedRuns[index].status && run.plan_revision === scope.expectedRuns[index].planRevision), 'run_set_changed');
  check(runs.every(run => failed.has(run.status) && run.result_sha === null && run.finished_at !== null && run.finished_at >= run.started_at && run.finished_at <= now && run.base_sha === scope.expectedBaseSha && run.repository_path === scope.expectedRepository), 'run_not_failed');
  const sessions = db.prepare('SELECT * FROM collaboration_execution_sessions WHERE work_item_id=? ORDER BY attempt').all(scope.workItemId);
  const dispatches = db.prepare('SELECT * FROM collaboration_execution_dispatches WHERE work_item_id=? ORDER BY attempt').all(scope.workItemId);
  check(sessions.length === 4 && dispatches.length === 4 && sessions.every((session, index) => {
    const run = runs[index], dispatch = dispatches[index];
    return session.id === run.id && session.attempt === run.attempt && session.plan_revision === run.plan_revision && session.repository_path === scope.expectedRepository && session.base_sha === scope.expectedBaseSha && dispatch.attempt === run.attempt && dispatch.plan_revision === run.plan_revision && dispatch.instance_owner === session.instance_owner && dispatch.instance_fence === session.instance_fence;
  }), 'execution_set_changed');
  for (const kind of ['execution', 'verification']) check(!db.prepare(`SELECT 1 FROM collaboration_${kind}_sessions s LEFT JOIN collaboration_${kind}_settlements f ON f.session_id=s.id WHERE s.repository_path=? AND f.session_id IS NULL LIMIT 1`).get(scope.expectedRepository), 'repository_unsettled');
  const runIds = new Set(runs.map(run => run.id)), sessionIds = new Set(sessions.map(session => session.id));
  check(!db.prepare('SELECT 1 FROM collaboration_candidate_reviews WHERE candidate_run_id IN (SELECT id FROM collaboration_runs WHERE work_item_id=?) UNION ALL SELECT 1 FROM collaboration_verification_sessions WHERE candidate_run_id IN (SELECT id FROM collaboration_runs WHERE work_item_id=?) UNION ALL SELECT 1 FROM collaboration_approval_presentations WHERE work_item_id=? LIMIT 1').get(scope.workItemId, scope.workItemId, scope.workItemId), 'review_or_verification');
  const candidateRows = db.prepare('SELECT * FROM collaboration_candidates WHERE run_id IN (SELECT id FROM collaboration_runs WHERE work_item_id=?)').all(scope.workItemId);
  check(candidateRows.every(row => ['needs_configuration', 'invalid', 'not_verified', 'test_failed'].includes(row.state) && row.result_sha === null), 'candidate_not_failed');
  const generated = new Set(runs.map(run => `candidate:${run.id}`));
  for (const run of runs) {
    generated.add(`execution-preparation:${scope.workItemId}:${run.attempt}`);
    generated.add(`execution:${scope.workItemId}:plan:${run.plan_revision}:failed`);
    generated.add(`lifecycle-recovery:execution:${run.id}:blocked`);
    generated.add(`lifecycle-recovery:execution:${run.id}:recovered`);
  }
  const outputs = db.prepare('SELECT * FROM collaboration_outbox WHERE aggregate_id=?').all(scope.workItemId).filter(row => generated.has(row.source_event_id));
  for (const output of outputs) {
    check(output.source === 'dingtalk' && output.aggregate_type === 'plan' && output.dedupe_key === `dingtalk:event:${output.source_event_id}:ack`, 'outbox_binding_changed');
    const payload = JSON.parse(output.payload_json);
    check(payload.workItemId === scope.workItemId && ['execution_failed', undefined].includes(payload.status), 'outbox_binding_changed');
    if (output.source_event_id.startsWith('candidate:')) {
      const run = runs.find(row => output.source_event_id === `candidate:${row.id}`);
      check(output.kind === 'plan_status_card' && payload.type === 'plan_status_card' && payload.status === 'execution_failed' && output.aggregate_version === run.plan_revision && payload.planRevision === run.plan_revision, 'outbox_binding_changed');
    }
    check((output.delivery_state === 'sent' && output.sent_at !== null && output.sent_at <= now) || (output.delivery_state === 'superseded' && output.superseded_at !== null && output.superseded_at <= now), 'outbox_unsettled');
    check(output.claim_expires_at === null || output.claim_expires_at <= now, 'outbox_unsettled');
    check(!db.prepare("SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=? LIMIT 1").get(output.source_event_id, output.source_event_id), 'outbox_is_input');
    check(!db.prepare('SELECT 1 FROM collaboration_sent_association_choices WHERE outbox_id=? UNION ALL SELECT 1 FROM collaboration_approval_presentations WHERE outbox_id=? LIMIT 1').get(output.id, output.id), 'outbox_relation_unavailable');
    check(!db.prepare('SELECT 1 FROM collaboration_delivery_queries WHERE outbox_id=? AND (completed_at IS NULL OR outcome IS NULL) LIMIT 1').get(output.id), 'delivery_query_unsettled');
  }
  const outputIds = new Set(outputs.map(row => row.id));
  const predicates = {
    collaboration_delivery_queries: row => outputIds.has(row.outbox_id),
    collaboration_outbox: row => outputIds.has(row.id),
    collaboration_execution_sessions: row => sessionIds.has(row.id),
    collaboration_execution_dispatches: row => row.work_item_id === scope.workItemId && runs.some(run => run.attempt === row.attempt && run.plan_revision === row.plan_revision),
    collaboration_execution_preparation_results: row => row.work_item_id === scope.workItemId && runs.some(run => run.attempt === row.attempt),
    collaboration_runs: row => runIds.has(row.id),
    collaboration_audit_events: row => runIds.has(row.run_id) || (row.work_item_id === scope.workItemId && row.policy_rule === 'local-execution-recovery-v1' && ['execution.recovery.issued', 'execution.recovery.reserved', 'execution.recovery.started'].includes(row.action)),
  };
  for (const table of ['proofs', 'commands', 'settlements', 'finalization_intents']) predicates[`collaboration_execution_${table}`] = row => sessionIds.has(row.session_id);
  for (const table of ['test_evidence', 'candidates', 'run_events']) predicates[`collaboration_${table}`] = row => runIds.has(row.run_id);
  const selected = Object.fromEntries(deletionOrder.map(table => [table, db.prepare(`SELECT rowid AS _reset_rowid,* FROM ${quote(table)} ORDER BY rowid`).all().filter(predicates[table])]));
  check(selected.collaboration_execution_preparation_results.every(row => row.state === 'failed'), 'preparation_unsettled');
  const selectedIds = Object.fromEntries(deletionOrder.map(table => [table, new Set(selected[table].map(row => row._reset_rowid))]));
  return { selected, selectedIds, nodes, counts: Object.fromEntries(deletionOrder.map(table => [table, selected[table].length])), tables };
}

// Hash all preserved rows in every table, including the unchanged parts of the
// target nodes. This also detects unexpected side effects of existing triggers.
function preservationHash(db, target, excludeDeleted = true, receiptId) {
  const nodeIds = new Set(target.nodes.map(node => node._reset_rowid));
  const rows = target.tables.map(table => [table, db.prepare(`SELECT rowid AS _reset_rowid,* FROM ${quote(table)} ORDER BY rowid`).all().filter(row => {
    if (table === 'collaboration_audit_events' && row.id === receiptId) return false;
    return !excludeDeleted || !target.selectedIds[table]?.has(row._reset_rowid);
  }).map(row => {
    if (table === 'collaboration_work_nodes' && nodeIds.has(row._reset_rowid)) {
      row = { ...row }; for (const key of ['execution_status', 'runtime_state', 'lease_owner', 'lease_expires_at', 'version']) delete row[key];
    }
    return row;
  })]);
  return hash(rows);
}

function resetFailedExecution(db, input, options = {}) {
  const scope = parseScope(input), mode = options.mode ?? 'dry-run', now = options.now ?? Date.now();
  check(['apply', 'dry-run'].includes(mode) && Number.isSafeInteger(now) && now >= 0 && !db.isTransaction, 'options_invalid');
  const scopeHash = hash(scope);
  db.exec(mode === 'apply' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
  try {
    const schema = schemaState(db);
    const previous = db.prepare('SELECT * FROM collaboration_audit_events WHERE request_id=?').all(scope.operationId);
    if (previous.length) {
      check(previous.length === 1 && previous[0].action === ACTION && previous[0].policy_rule === POLICY && previous[0].work_item_id === scope.workItemId && previous[0].outcome === 'allow' && previous[0].run_id === null, 'operation_conflict');
      const receipt = JSON.parse(previous[0].resource_json);
      check(receipt.version === 1 && receipt.operationId === scope.operationId && receipt.scopeHash === scopeHash && hash(receipt) === previous[0].after_hash, 'operation_conflict');
      db.exec('COMMIT'); return { status: 'already_applied', operationId: scope.operationId, counts: receipt.counts };
    }
    const target = inspect(db, scope, now, schema.tables);
    const result = { status: mode === 'apply' ? 'applied' : 'ready', operationId: scope.operationId, workItemId: scope.workItemId, counts: target.counts };
    if (mode === 'dry-run') { db.exec('COMMIT'); return result; }
    const before = preservationHash(db, target);
    for (const trigger of schema.triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    for (const table of deletionOrder) {
      const remove = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid=?`);
      for (const row of target.selected[table]) check(remove.run(row._reset_rowid).changes === 1, 'delete_conflict');
    }
    for (const node of target.nodes) check(db.prepare("UPDATE collaboration_work_nodes SET execution_status='not_started',runtime_state='dormant',lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE rowid=? AND version=?").run(node._reset_rowid, node.version).changes === 1, 'node_conflict');
    for (const node of target.nodes) {
      const current = db.prepare('SELECT execution_status,runtime_state,lease_owner,lease_expires_at,version FROM collaboration_work_nodes WHERE rowid=?').get(node._reset_rowid);
      check(current?.execution_status === 'not_started' && current.runtime_state === 'dormant' && current.lease_owner === null && current.lease_expires_at === null && current.version === node.version + 1, 'node_conflict');
    }
    for (const trigger of schema.triggers) db.exec(trigger.sql);
    const receipt = { version: 1, operationId: scope.operationId, scopeHash, counts: target.counts };
    const receiptId = randomUUID();
    db.prepare('INSERT INTO collaboration_audit_events(id,action,outcome,resource_json,created_at,work_item_id,request_id,policy_rule,after_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(receiptId, ACTION, 'allow', JSON.stringify(receipt), now, scope.workItemId, scope.operationId, POLICY, hash(receipt));
    check(hash(schemaState(db).schema) === hash(schema.schema), 'schema_changed');
    check(preservationHash(db, target, false, receiptId) === before, 'preservation_failed');
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { resetFailedExecution, parseScope };
if (require.main === module) {
  let db;
  try {
    const args = process.argv.slice(2); let file, scopeFile, mode;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--db' && !file) file = args[++index];
      else if (arg === '--scope' && !scopeFile) scopeFile = args[++index];
      else if (arg === '--dry-run' && !mode) mode = 'dry-run';
      else if (arg === '--apply' && !mode) mode = 'apply';
      else fail('arguments_invalid');
    }
    check(file && scopeFile && mode && isAbsolute(file) && isAbsolute(scopeFile), 'arguments_invalid');
    for (const path of [file, scopeFile]) check(lstatSync(path).isFile(), 'regular_file_required');
    check(lstatSync(scopeFile).size <= 64 * 1024, 'scope_invalid');
    const scope = parseScope(JSON.parse(readFileSync(scopeFile, 'utf8')));
    db = new DatabaseSync(file, { readOnly: mode === 'dry-run' }); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    process.stdout.write(`${JSON.stringify(resetFailedExecution(db, scope, { mode }))}\n`);
  } catch (error) {
    // Never echo SQL, source rows, paths or arbitrary exception payloads.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- CLI error boundary: emit only a string matching the complete public error-code grammar.
    const code = typeof error?.message === 'string' && /^failed_execution_reset_[a-z_]+$/u.test(error.message) ? error.message : 'failed_execution_reset_failed';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  } finally { db?.close(); }
}
