const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const script = resolve(__dirname, 'reset-failed-execution.cjs');
const moduleUnderTest = () => require(script);
const baseSha = 'a'.repeat(40);
const now = 10_000;
function insert(db, table, row) {
  const fields = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
}
async function fixture(fn, file = ':memory:') {
  const { applyCollaborationMigrations } = await import('../../server/collaboration/migrations.ts');
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); applyCollaborationMigrations(db);
  insert(db, 'collaboration_principals', { id: 'principal', source: 'dingtalk', resolution: 'resolved', display_name: 'Owner', created_at: 1, updated_at: 1 });
  insert(db, 'collaboration_owner_bindings', { id: 'owner', source: 'dingtalk', sender_corp_id: 'fixture-corp', sender_staff_id: 'fixture-owner', generation: 1, active: 1, created_at: 1 });
  insert(db, 'collaboration_conversations', { id: 'conversation', created_at: 1 });
  for (const wi of ['WI-target', 'WI-other']) {
    insert(db, 'collaboration_work_items', { id: wi, conversation_id: 'conversation', title: wi, status: 'collecting', version: 3, created_by: 'principal', created_at: 1, updated_at: 3, definition_status: 'ready_for_execution', current_plan_revision: 2 });
    insert(db, 'collaboration_work_item_snapshots', { work_item_id: wi, revision: 4, source_work_item_version: 3, goal: 'Add priority filter', goal_confirmed: 1, repository: '/fixture/repository', facts_json: '[]', assumptions_json: '[]', acceptance_json: '[{"description":"filters priority","observation":"test"}]', blocking_ambiguities_json: '[]', created_at: 3 });
    insert(db, 'collaboration_plan_revisions', { id: `${wi}-plan`, work_item_id: wi, revision: 2, snapshot_revision: 4, status: 'published', summary: 'fixed plan', proposal_hash: 'b'.repeat(64), created_at: 3 });
    for (const kind of ['analyze', 'modify', 'validate', 'report']) insert(db, 'collaboration_work_nodes', { work_item_id: wi, plan_revision: 2, node_id: kind, node_type: kind, status: 'ready', assigned_agent_id: kind, objective: 'objective', input_evidence_json: '[]', instructions: 'instructions', read_scope_json: '["src/**"]', write_scope_json: kind === 'modify' ? '["src/**"]' : '[]', deny_scope_json: '[".git/**"]', commands_json: '[]', expected_artifacts_json: '[]', completion_definition: 'done', risk: 'low', budget_json: '{"maxAttempts":3}', created_at: 3, execution_status: 'failed', runtime_state: 'failed', lease_fence: 7 });
    insert(db, 'collaboration_external_events', { id: `${wi}-input`, source: 'dingtalk', source_event_id: `${wi}-input`, transport_message_id: `${wi}-input`, conversation_id: 'conversation', principal_id: 'principal', kind: 'message', normalized_json: '{"text":"preserve user input"}', raw_hash: 'd'.repeat(64), association_state: 'created', work_item_id: wi, received_at: 1 });
    insert(db, 'collaboration_work_item_events', { id: `${wi}-event`, work_item_id: wi, external_event_id: `${wi}-input`, event_type: 'problem.reported', payload_json: '{"text":"preserve"}', principal_id: 'principal', created_at: 1 });
    outbox(db, `${wi}-ack`, `${wi}-input`, wi);
    for (let attempt = 1; attempt <= (wi === 'WI-target' ? 4 : 1); attempt++) {
      const id = `${wi}-run-${attempt}`;
      insert(db, 'collaboration_execution_dispatches', { work_item_id: wi, plan_revision: 2, attempt, instance_owner: 'stopped', instance_fence: 1, created_at: 100 + attempt });
      insert(db, 'collaboration_execution_sessions', { id, work_item_id: wi, plan_revision: 2, repository_path: '/fixture/repository', base_sha: baseSha, attempt, instance_owner: 'stopped', instance_fence: 1, created_at: 100 + attempt });
      insert(db, 'collaboration_execution_commands', { session_id: id, ordinal: 1, binding_json: '{}', created_at: 110 + attempt });
      insert(db, 'collaboration_execution_proofs', { session_id: id, ordinal: 1, proof_json: '{}', created_at: 120 + attempt });
      insert(db, 'collaboration_execution_finalization_intents', { session_id: id, command_count: 1, created_at: 130 + attempt });
      insert(db, 'collaboration_execution_settlements', { session_id: id, evidence_json: '{"evidence":[]}', created_at: 140 + attempt });
      insert(db, 'collaboration_runs', { id, work_item_id: wi, plan_revision: 2, node_id: 'modify', attempt, agent_id: 'modify', thread_id: 'thread', turn_id: `turn-${attempt}`, status: attempt < 3 ? 'needs_configuration' : 'failed', repository_path: '/fixture/repository', worktree_path: `/fixture/worktrees/${wi}/a${attempt}`, branch: `ai/${wi}/modify/a${attempt}`, base_sha: baseSha, started_at: 100 + attempt, finished_at: 140 + attempt, containment_state: 'empty' });
      insert(db, 'collaboration_candidates', { id: `${id}-candidate`, run_id: id, state: 'needs_configuration', base_sha: baseSha, changed_paths_json: '[]', violations_json: '[]', quality_json: '{"message":"private old failure"}', created_at: 140 + attempt });
      insert(db, 'collaboration_run_events', { run_id: id, sequence: 1, event_type: 'warning', message: 'private old failure', created_at: 120 + attempt });
      insert(db, 'collaboration_audit_events', { id: `${id}-audit`, run_id: id, action: 'run.failed', outcome: 'failed', resource_json: '{"message":"private old failure"}', created_at: 140 + attempt });
      outbox(db, `${id}-outbox`, `candidate:${id}`, wi);
    }
  }
  insert(db, 'collaboration_audit_events', { id: 'recovery-old', work_item_id: 'WI-target', action: 'execution.recovery.started', outcome: 'allow', resource_json: '{}', policy_rule: 'local-execution-recovery-v1', created_at: 500 });
  insert(db, 'collaboration_audit_events', { id: 'owner-history', work_item_id: 'WI-target', action: 'work.retry', outcome: 'allow', resource_json: '{}', created_at: 501 });
  outbox(db, 'preparation-old', 'execution-preparation:WI-target:1', 'WI-target');
  outbox(db, 'plan-failure-old', 'execution:WI-target:plan:2:failed', 'WI-target', 'superseded');
  insert(db, 'collaboration_delivery_queries', { outbox_id: 'WI-target-run-1-outbox', attempt: 1, snapshot_hash: 'e'.repeat(64), instance_owner: 'stopped', instance_fence: 1, started_at: 160, expires_at: 200, next_attempt_at: 201, completed_at: 180, outcome: 'confirmed' });
  const scope = { operationId: 'reset-fixture-1', workItemId: 'WI-target', expectedWorkItemVersion: 3, expectedPlanRevision: 2, expectedSnapshotRevision: 4, expectedOwnerGeneration: 1, expectedBaseSha: baseSha, expectedRepository: '/fixture/repository', expectedRuns: [1, 2, 3, 4].map(attempt => ({ id: `WI-target-run-${attempt}`, attempt, planRevision: 2, status: attempt < 3 ? 'needs_configuration' : 'failed' })) };
  try { return await fn({ db, scope }); } finally { db.close(); }
}
function outbox(db, id, sourceEventId, wi, state = 'sent') {
  insert(db, 'collaboration_outbox', { id, source: 'dingtalk', source_event_id: sourceEventId, aggregate_type: 'plan', aggregate_id: wi, aggregate_version: 2, kind: 'plan_status_card', dedupe_key: `dingtalk:event:${sourceEventId}:ack`, payload_json: JSON.stringify({ type: 'plan_status_card', workItemId: wi, planRevision: 2, status: 'execution_failed' }), created_at: 150, sent_at: state === 'sent' ? 151 : null, superseded_at: state === 'superseded' ? 152 : null, delivery_state: state });
}
function dump(db) {
  return JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('table','trigger','index','view') ORDER BY name").all().map(row => [row, row.sql?.startsWith('CREATE TABLE') ? db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() : null]));
}
function apply(db, scope) { return moduleUnderTest().resetFailedExecution(db, scope, { mode: 'apply', now }); }

test('dry-run is read-only; apply preserves input, plans, identity, other WI and triggers', async () => fixture(({ db, scope }) => {
  const before = dump(db);
  const preview = moduleUnderTest().resetFailedExecution(db, scope, { mode: 'dry-run', now });
  assert.equal(preview.status, 'ready'); assert.equal(preview.counts.collaboration_runs, 4); assert.equal(dump(db), before);
  const protectedTables = ['collaboration_work_items', 'collaboration_work_item_snapshots', 'collaboration_plan_revisions', 'collaboration_external_events', 'collaboration_work_item_events', 'collaboration_owner_bindings', 'collaboration_principals'];
  const preserved = protectedTables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
  const result = apply(db, scope); assert.equal(result.status, 'applied');
  assert.deepEqual(protectedTables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), preserved);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), schema);
  assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_runs WHERE work_item_id='WI-target'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_runs WHERE work_item_id='WI-other'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_outbox WHERE id IN ('WI-target-ack','WI-other-ack','WI-other-run-1-outbox')").get().n, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const nodes = db.prepare("SELECT execution_status,runtime_state,version,lease_fence FROM collaboration_work_nodes WHERE work_item_id='WI-target'").all();
  assert.ok(nodes.every(n => n.execution_status === 'not_started' && n.runtime_state === 'dormant' && n.version === 2 && n.lease_fence >= 7));
  const audit = db.prepare("SELECT resource_json FROM collaboration_audit_events WHERE request_id=?").get(scope.operationId);
  assert.ok(audit); assert.doesNotMatch(audit.resource_json, /private old failure|fixture-corp|fixture-owner/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_audit_events WHERE id='owner-history'").get().n, 1);
  assert.throws(() => db.exec('DELETE FROM collaboration_execution_sessions'), /immutable/);
}));

test('operation replay cannot purge newly created executions; changed request is rejected', async () => fixture(({ db, scope }) => {
  apply(db, scope);
  insert(db, 'collaboration_execution_dispatches', { work_item_id: 'WI-target', plan_revision: 2, attempt: 1, instance_owner: 'new', instance_fence: 2, created_at: now + 1 });
  const before = dump(db);
  assert.equal(apply(db, scope).status, 'already_applied'); assert.equal(dump(db), before);
  assert.throws(() => apply(db, { ...scope, expectedWorkItemVersion: 4 }), /operation_conflict/); assert.equal(dump(db), before);
}));

for (const [name, mutate, pattern] of [
  ['wrong version', (db, scope) => { scope.expectedWorkItemVersion = 4; }, /binding_changed/],
  ['wrong run', (db, scope) => { scope.expectedRuns[0].id = 'unknown'; }, /run_set_changed/],
  ['live lease', db => insert(db, 'collaboration_instance_lease', { singleton: 1, owner_id: 'live', fencing_token: 1, acquired_at: 1, heartbeat_at: 9999, expires_at: 20000, version: 1 }), /instance_live/],
  ['running attempt', db => db.exec("UPDATE collaboration_runs SET status='running' WHERE id='WI-target-run-1'"), /run_set_changed|run_not_failed/],
  ['successful candidate', db => { db.exec('DROP TRIGGER collaboration_candidates_no_update'); db.exec("UPDATE collaboration_candidates SET state='target_tests_passed',result_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE run_id='WI-target-run-1'"); }, /candidate_not_failed/],
  ['missing settlement', db => { db.exec('DROP TRIGGER execution_settlements_no_delete'); db.exec("DELETE FROM collaboration_execution_settlements WHERE session_id='WI-target-run-1'"); }, /unsettled|schema_changed/],
  ['pending outbound', db => db.exec("UPDATE collaboration_outbox SET sent_at=NULL,delivery_state='pending' WHERE id='WI-target-run-1-outbox'"), /outbox_unsettled/],
  ['outbound plan mismatch', db => db.exec("UPDATE collaboration_outbox SET aggregate_version=99 WHERE id='WI-target-run-1-outbox'"), /outbox_binding_changed/],
  ['unknown outbound state', db => db.exec("UPDATE collaboration_outbox SET sent_at=NULL,delivery_state='dead_letter' WHERE id='WI-target-run-1-outbox'"), /outbox_unsettled/],
  ['uncompleted delivery query', db => insert(db, 'collaboration_delivery_queries', { outbox_id: 'WI-target-run-2-outbox', attempt: 1, snapshot_hash: 'e'.repeat(64), instance_owner: 'old', instance_fence: 1, started_at: 100, expires_at: 200, next_attempt_at: 201 }), /delivery_query_unsettled/],
  ['synthetic-looking inbound source', db => insert(db, 'collaboration_external_events', { id: 'pretend', source: 'dingtalk', source_event_id: 'candidate:WI-target-run-1', transport_message_id: 'pretend', conversation_id: 'conversation', principal_id: 'principal', kind: 'message', normalized_json: '{}', raw_hash: 'x', association_state: 'associated', work_item_id: 'WI-target', received_at: 1 }), /outbox_is_input/],
  ['unexpected FK', db => db.exec('CREATE TABLE unknown_child (run_id TEXT REFERENCES collaboration_runs(id))'), /unknown_relation/],
  ['changed immutable trigger', db => db.exec("DROP TRIGGER collaboration_execution_dispatch_no_delete; CREATE TRIGGER collaboration_execution_dispatch_no_delete BEFORE DELETE ON collaboration_execution_dispatches BEGIN SELECT RAISE(ABORT,'different'); END"), /schema_changed/],
  ['existing review', db => insert(db, 'collaboration_candidate_reviews', { id: 'review', candidate_run_id: 'WI-target-run-1', stage: 'verifier', attempt: 1, status: 'failed', agent_id: 'reviewer', snapshot_revision: 4, spec_hash: 'x', candidate_sha: baseSha, verdict_json: '{}', created_at: 200 }), /review_or_verification/],
]) test(`rejects ${name} without any mutation`, async () => fixture(({ db, scope }) => {
  mutate(db, scope); const before = dump(db); assert.throws(() => apply(db, scope), pattern); assert.equal(dump(db), before);
}));

test('transaction rollback restores previously dropped triggers and removed rows', async () => fixture(({ db, scope }) => {
  db.exec("CREATE TRIGGER reset_fault BEFORE DELETE ON collaboration_runs BEGIN SELECT RAISE(ABORT,'injected_reset_failure'); END");
  const before = dump(db); assert.throws(() => apply(db, scope), /injected_reset_failure/); assert.equal(dump(db), before);
}));

test('unknown trigger side effects rollback instead of changing unrelated data', async () => fixture(({ db, scope }) => {
  db.exec("CREATE TRIGGER reset_side_effect AFTER DELETE ON collaboration_runs BEGIN UPDATE collaboration_work_items SET title='changed' WHERE id='WI-other'; END");
  const before = dump(db); assert.throws(() => apply(db, scope), /preservation_failed/); assert.equal(dump(db), before);
}));

test('a trigger cannot hide new unrelated rows by reusing a deleted rowid', async () => fixture(({ db, scope }) => {
  db.exec("CREATE TRIGGER reset_reuse AFTER DELETE ON collaboration_run_events BEGIN INSERT INTO collaboration_run_events(rowid,run_id,sequence,event_type,message,created_at) VALUES(OLD.rowid,'WI-other-run-1',OLD.sequence+100+OLD.rowid,'warning','unexpected',1); END");
  const before = dump(db); assert.throws(() => apply(db, scope), /preservation_failed/); assert.equal(dump(db), before);
}));

test('a trigger cannot silently undo the requested node reset', async () => fixture(({ db, scope }) => {
  db.exec("CREATE TRIGGER reset_node_fault AFTER UPDATE ON collaboration_work_nodes WHEN NEW.work_item_id='WI-target' BEGIN UPDATE collaboration_work_nodes SET execution_status='failed' WHERE rowid=NEW.rowid; END");
  const before = dump(db); assert.throws(() => apply(db, scope), /node_conflict/); assert.equal(dump(db), before);
}));

test('CLI requires explicit absolute DB and scope file and dry-run does not edit database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'failed-reset-cli-'));
  try {
    const file = join(root, 'ledger.sqlite'); let scope;
    await fixture(f => { scope = f.scope; }, file);
    const scopeFile = join(root, 'scope.json'); writeFileSync(scopeFile, JSON.stringify(scope), { mode: 0o600 });
    const before = readFileSync(file);
    const result = spawnSync(process.execPath, [script, '--db', file, '--scope', scopeFile, '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'ready'); assert.deepEqual(readFileSync(file), before);
    const wrong = spawnSync(process.execPath, [script, '--db', 'relative.sqlite', '--scope', scopeFile, '--apply'], { encoding: 'utf8' });
    assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /arguments_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
