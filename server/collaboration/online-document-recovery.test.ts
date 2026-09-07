import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { startCollaborationService } from './service.ts';
import { policy, validProposal } from './planner.test-fixtures.ts';
import { InstanceLeaseCoordinator } from './leases.ts';
import { LocalOwnerRegistry } from './owner.ts';
import { recoverNaturalIntake, isCurrentNaturalIntakeFailureNotice } from './natural-intake-recovery.ts';
import { DwsOnlineDocumentReader, type OnlineDocumentReader } from './operations/dws-online-reader.ts';
import { CommandCleanupError } from './execution-limits.ts';
import type { DingTalkInboundMessage } from '../integrations/dingtalk/types.ts';
import { CollaborationHeadlessRuntime, type RuntimeDingTalkSinks } from './operations/runtime.ts';
import { renderDingTalkSessionMessage } from '../integrations/dingtalk/session-message.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'online-owner-recovery-')); roots.push(root);
  const initial = startCollaborationService({ dataDirectory: root }); initial.close();
  const file = join(root, 'collaboration/collaboration.sqlite'), db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON');
  const now = Date.now(), lease = new InstanceLeaseCoordinator(db, 'reader').acquire(now, 120000)!;
  const registry = new LocalOwnerRegistry(file); registry.bootstrap({ senderCorpId: 'corp', senderStaffId: 'owner', now }); registry.close();
  const node = 'https://alidocs.dingtalk.com/i/nodes/fixture';
  let authorized = false, failure: 'none' | 'known' | 'unknown' = 'none', reads = 0;
  const underlying = new DwsOnlineDocumentReader([{ id: 'grant', profile: 'corp:user', conversationId: 'group', node, canonicalId: 'fixture', product: 'doc' }], {
    async run() { reads++; if (failure === 'known') throw new Error('fixture_failure');
      if (failure === 'unknown') throw new CommandCleanupError(new Error('fixture_unknown_cleanup'));
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ contractVersion: 'doc.content.v1', status: 'success', complete: true,
        target: { product: 'doc', canonicalId: 'fixture' }, content: '登录失败后保留用户名' })), stderr: Buffer.alloc(0), timedOut: false, outputLimitExceeded: false };
    },
  });
  const reader: OnlineDocumentReader = { authorizationFingerprint(input) { if (!authorized) throw new Error('online_document_not_authorized'); return underlying.authorizationFingerprint(input); },
    read(input, signal) { return underlying.read(input, signal); } };
  const options = { dataDirectory: root, planning: { policy, planner: { propose: validProposal },
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] } }, onlineDocuments: { reader, currentLease: () => lease } };
  const service = startCollaborationService(options);
  const message: DingTalkInboundMessage = { sourceEventId: 'source', transportMessageId: 'source', conversationId: 'group', addressedToBot: true,
    text: `请修复 ${node} 中的问题`, receivedAt: now, sender: { senderCorpId: 'corp', senderStaffId: 'owner', senderId: 'owner', displayName: '负责人' } };
  const id = service.ingestDingTalkMessage(message).workItemId!;
  const request = { ...message, sourceEventId: 'recover', transportMessageId: 'recover', text: '继续整理需求', replyToSourceEventId: 'source' };
  return { db, service, options, reader, now, id, request, reads: () => reads, authorize: () => { authorized = true; }, fail: (mode: typeof failure) => { failure = mode; },
    recover: (input = request) => recoverNaturalIntake(db, input, now, () => {}, reader), close: () => { service.close(); db.close(); } };
}
it('restores after configured authorization is repaired, only once, preserving the original failed budget', async () => {
  const h = fixture();
  try {
    await h.service.processOnlineDocuments(h.now);
    const original = h.db.prepare('SELECT * FROM collaboration_online_read_jobs').get()!;
    expect(original).toMatchObject({ status: 'failed', attempts: 0, error_code: 'online_document_not_authorized' });
    h.authorize(); expect(h.recover()).toMatchObject({ allowed: true, recoveredInputs: 1, workItemId: h.id });
    expect(h.recover()).toMatchObject({ duplicate: true, recoveredInputs: 1 });
    expect(h.db.prepare('SELECT prior_attempts,prior_error_code,prior_grant_fingerprint,generation FROM collaboration_online_read_recoveries').all())
      .toEqual([{ prior_attempts: 0, prior_error_code: 'online_document_not_authorized', prior_grant_fingerprint: '', generation: 1 }]);
    h.service.close(); const restarted = startCollaborationService(h.options);
    try { expect(await restarted.processOnlineDocuments(h.now)).toBe(h.id); await restarted.processOnlineDocuments(h.now); }
    finally { restarted.close(); }
    expect(h.reads()).toBe(1); expect(h.db.prepare('SELECT status,recovery_generation FROM collaboration_online_read_jobs').get()).toEqual({ status: 'ready', recovery_generation: 1 });
    expect(() => h.db.exec('UPDATE collaboration_online_read_recoveries SET prior_attempts=1')).toThrow('immutable');
    expect(() => h.db.exec('DELETE FROM collaboration_online_read_recoveries')).toThrow('immutable');
    const notices = h.db.prepare("SELECT source_event_id,aggregate_id,aggregate_version FROM collaboration_outbox WHERE source_event_id LIKE 'online-read-failed:%'").all();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.some(row => isCurrentNaturalIntakeFailureNotice(h.db, row as never))).toBe(false);
  } finally { h.close(); }
});
it.each(['not-authorized', 'not-owner', 'other-group', 'wrong-reply', 'paused', 'cancelled', 'unknown-cleanup'])('refuses unsafe read recovery: %s', async reason => {
  const h = fixture();
  try {
    if (reason !== 'not-authorized') h.authorize();
    if (reason === 'unknown-cleanup') { h.fail('unknown'); h.recover(); await h.service.processOnlineDocuments(h.now); }
    const input = { ...h.request, sourceEventId: 'new-request' };
    if (reason === 'not-owner') input.sender = { ...input.sender, senderStaffId: 'other', senderId: 'other' };
    if (reason === 'other-group') input.conversationId = 'other';
    if (reason === 'wrong-reply') input.replyToSourceEventId = 'unrelated';
    if (reason === 'paused') h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(h.id);
    if (reason === 'cancelled') h.db.prepare("UPDATE collaboration_work_items SET status='cancelled' WHERE id=?").run(h.id);
    const before = h.reads(); expect(h.recover(input).allowed).toBe(false); expect(h.reads()).toBe(before);
  } finally { h.close(); }
});
it('requires new Owner authorization after three fresh failures and cannot reuse the old authorization', async () => {
  const h = fixture();
  try {
    h.authorize(); h.fail('known'); expect(h.recover().allowed).toBe(true);
    for (let i = 0; i < 3; i++) await h.service.processOnlineDocuments(h.now);
    expect(h.reads()).toBe(3); expect(h.recover().duplicate).toBe(true);
    await h.service.processOnlineDocuments(h.now); expect(h.reads()).toBe(3);
    expect(() => h.db.exec("UPDATE collaboration_online_read_jobs SET status='pending',attempts=0")).toThrow('immutable');
    const next = { ...h.request, sourceEventId: 'recover-second' };
    expect(h.recover(next).allowed).toBe(true); h.fail('none'); await h.service.processOnlineDocuments(h.now); expect(h.reads()).toBe(4);
    expect(h.db.prepare('SELECT generation,prior_attempts FROM collaboration_online_read_recoveries ORDER BY generation').all())
      .toEqual([{ generation: 1, prior_attempts: 0 }, { generation: 2, prior_attempts: 3 }]);
  } finally { h.close(); }
});
it('connects the real runtime recovery sink to its configured reader and delivers one plain-language receipt', async () => {
  const h = fixture(); await h.service.processOnlineDocuments(h.now); h.service.close(); h.authorize();
  h.db.exec('UPDATE collaboration_instance_lease SET expires_at=1,heartbeat_at=0');
  let sinks!: RuntimeDingTalkSinks; const delivered: string[] = [];
  const runtime = new CollaborationHeadlessRuntime({ dataDirectory: h.options.dataDirectory, platform: 'linux', logger: { write() {} },
    planner: h.options.planning.planner, planningPolicy: policy, planningDefaultDefinition: h.options.planning.defaultDefinition,
    onlineDocuments: h.reader, outboxDelivery: { async deliver(message) { delivered.push(JSON.stringify(renderDingTalkSessionMessage(message.payload))); return { outcome: 'sent' }; } },
    dingTalk: { enabled: true, credentials: { load: () => ({ clientId: 'fixture', clientSecret: 'fixture' }) },
      createStream: (_credentials, captured) => { sinks = captured; return { start: async () => 'connected', stop() {}, state: () => 'connected' }; } } });
  try {
    await runtime.start();
    expect(sinks.recoverRequirements(h.request)).toMatchObject({ allowed: true, recoveredInputs: 1 });
    expect(sinks.recoverRequirements(h.request).duplicate).toBe(true);
    await runtime.drainOnce(); await vi.waitFor(() => expect(h.db.prepare('SELECT status FROM collaboration_online_read_jobs').get()).toEqual({ status: 'ready' }));
    for (let i = 0; i < 10; i++) await runtime.drainOnce();
    expect(h.reads()).toBe(1); expect(delivered.filter(text => text.includes('已恢复需求整理'))).toHaveLength(1);
    expect(delivered.some(text => text.includes('这份在线材料未能可靠读取'))).toBe(false);
    expect(h.db.prepare('SELECT count(*) n FROM collaboration_work_items').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT count(*) n FROM collaboration_runs').get()).toEqual({ n: 0 });
  } finally { await runtime.stop(); h.close(); }
});
it('preserves all schema34 failed-read fields and requires fresh Owner recovery after upgrade', async () => {
  const h = fixture(); h.service.close();
  try {
    const { recovery_generation: generation, ...original } = h.db.prepare('SELECT * FROM collaboration_online_read_jobs').get()!;
    expect(generation).toBe(0);
    h.db.exec(`DROP TABLE collaboration_online_read_recoveries; DROP TRIGGER online_read_jobs_binding;
      ALTER TABLE collaboration_online_read_jobs DROP COLUMN recovery_generation;
      CREATE TRIGGER online_read_jobs_binding BEFORE UPDATE ON collaboration_online_read_jobs
        WHEN NEW.id<>OLD.id OR NEW.work_item_id<>OLD.work_item_id OR NEW.source_event_id<>OLD.source_event_id
          OR NEW.normalized_hash<>OLD.normalized_hash OR NEW.reference_hash<>OLD.reference_hash
          OR NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.attempts<OLD.attempts OR NEW.projection_attempts<OLD.projection_attempts
        BEGIN SELECT RAISE(ABORT,'online source and budget are immutable'); END;
      DELETE FROM collaboration_schema_migrations WHERE version=35; PRAGMA user_version=34`);
    const upgraded = startCollaborationService(h.options);
    try {
      expect(h.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 35 });
      expect(h.db.prepare('SELECT * FROM collaboration_online_read_jobs').get()).toEqual({ ...original, recovery_generation: 0 });
      h.authorize(); await upgraded.processOnlineDocuments(h.now); expect(h.reads()).toBe(0);
      expect(h.recover().allowed).toBe(true); await upgraded.processOnlineDocuments(h.now); expect(h.reads()).toBe(1);
    } finally { upgraded.close(); }
  } finally { h.close(); }
});
it('requires a configured reader and the current runtime guard, without creating recovery authority', () => {
  const h = fixture(); h.authorize();
  try {
    expect(recoverNaturalIntake(h.db, h.request, h.now, () => {}).allowed).toBe(false);
    expect(() => recoverNaturalIntake(h.db, { ...h.request, sourceEventId: 'lost-lease' }, h.now, () => { throw new Error('fixture_lease_lost'); }, h.reader)).toThrow('fixture_lease_lost');
    expect(h.db.prepare('SELECT count(*) n FROM collaboration_online_read_recoveries').get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_recovery_requests WHERE source_event_id='lost-lease'").get()).toEqual({ n: 0 });
    expect(h.reads()).toBe(0);
  } finally { h.close(); }
});
it('rejects conflicting replay of a consumed Owner request without changing its generation', () => {
  const h = fixture(); h.authorize();
  try {
    expect(h.recover().allowed).toBe(true);
    const before = h.db.prepare('SELECT * FROM collaboration_online_read_jobs').get();
    expect(() => h.recover({ ...h.request, replyToSourceEventId: 'different-input' })).toThrow('natural_intake_recovery_event_conflict');
    expect(h.db.prepare('SELECT * FROM collaboration_online_read_jobs').get()).toEqual(before);
    expect(h.db.prepare('SELECT count(*) n FROM collaboration_online_read_recoveries').get()).toEqual({ n: 1 });
    expect(h.reads()).toBe(0);
  } finally { h.close(); }
});
it.each(['running', 'ready', 'projection-failed'])('never reissues a %s read via fresh Owner recovery', async mode => {
  const h = fixture(); h.authorize();
  try {
    h.recover();
    if (mode === 'running') h.db.exec("UPDATE collaboration_online_read_jobs SET status='running',attempts=1,claim_token='fixture-live'");
    else {
      await h.service.processOnlineDocuments(h.now);
      if (mode === 'projection-failed') h.db.exec("UPDATE collaboration_online_read_jobs SET status='failed',error_code='online_document_projection_failed'");
    }
    const jobs = h.db.prepare('SELECT * FROM collaboration_online_read_jobs').all(), receipts = h.db.prepare('SELECT * FROM collaboration_online_read_receipts').all(), reads = h.reads();
    expect(h.recover({ ...h.request, sourceEventId: 'new-recovery' }).allowed).toBe(false);
    expect(h.db.prepare('SELECT * FROM collaboration_online_read_jobs').all()).toEqual(jobs);
    expect(h.db.prepare('SELECT * FROM collaboration_online_read_receipts').all()).toEqual(receipts);
    expect(h.reads()).toBe(reads);
  } finally { h.close(); }
});
it('retains both failed generations while only the current failure notice remains eligible', async () => {
  const h = fixture(); h.authorize(); h.fail('known');
  try {
    h.recover(); for (let i = 0; i < 3; i++) await h.service.processOnlineDocuments(h.now);
    expect(h.recover({ ...h.request, sourceEventId: 'second-recovery' }).allowed).toBe(true);
    for (let i = 0; i < 3; i++) await h.service.processOnlineDocuments(h.now);
    const notices = h.db.prepare("SELECT source_event_id,aggregate_id,aggregate_version FROM collaboration_outbox WHERE source_event_id LIKE 'online-read-failed:%'")
      .all() as Array<{ source_event_id: string; aggregate_id: string; aggregate_version: number }>;
    expect(notices).toHaveLength(2);
    expect(notices.filter(row => isCurrentNaturalIntakeFailureNotice(h.db, row))).toHaveLength(1);
    expect(notices.filter(row => isCurrentNaturalIntakeFailureNotice(h.db, row))[0].source_event_id).toContain(':recovery:2:');
    expect(h.reads()).toBe(6); await h.service.processOnlineDocuments(h.now); expect(h.reads()).toBe(6);
  } finally { h.close(); }
});
