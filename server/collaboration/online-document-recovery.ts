import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { OnlineDocumentReader } from './operations/dws-online-reader.ts';
import { durableOnlineSources, onlineReadSource } from './online-document-evidence.ts';

export const RECOVERABLE_ONLINE_READ_SQL = "j.status='failed' AND ((j.error_code='online_document_not_authorized' AND j.attempts=0) OR " +
  "(j.error_code='online_document_read_unverified' AND j.attempts=3) OR j.error_code='online_document_source_or_grant_changed') " +
  "AND NOT EXISTS(SELECT 1 FROM collaboration_online_read_receipts r WHERE r.job_id=j.id)";

/** Only called inside the current Owner's guarded, idempotent recovery transaction.
 * Rechecks configured authority; never reads a document or selects a profile. */
export function recoverOnlineReads(db: DatabaseSync, input: { workItemId: string; requestId: string; actorId: string; ownerGeneration: number; now: number }, reader?: OnlineDocumentReader): number {
  if (!reader) return 0;
  const jobs = db.prepare('SELECT j.* FROM collaboration_online_read_jobs j WHERE j.work_item_id=? AND ' + RECOVERABLE_ONLINE_READ_SQL)
    .all(input.workItemId) as unknown as Array<{ id: string; source_event_id: string; normalized_hash: string; reference_hash: string;
      attempts: number; error_code: string; grant_fingerprint: string; recovery_generation: number }>;
  const sources = new Map([...durableOnlineSources(db, input.workItemId)].map(source => [source.id, source]));
  let recovered = 0;
  for (const job of jobs) {
    const source = sources.get(job.id);
    if (!source || source.sourceEventId !== job.source_event_id || source.normalizedHash !== job.normalized_hash || source.referenceHash !== job.reference_hash) continue;
    let fingerprint: string;
    try { fingerprint = reader.authorizationFingerprint(onlineReadSource(source)); } catch { continue; }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) continue;
    const generation = job.recovery_generation + 1;
    db.prepare('INSERT INTO collaboration_online_read_recoveries(id,request_source_event_id,job_id,work_item_id,generation,prior_attempts,prior_error_code,input_hash,reference_hash,prior_grant_fingerprint,grant_fingerprint,actor_principal_id,owner_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), input.requestId, job.id, input.workItemId, generation, job.attempts, job.error_code, job.normalized_hash,
        job.reference_hash, job.grant_fingerprint, fingerprint, input.actorId, input.ownerGeneration, input.now);
    const changed = db.prepare("UPDATE collaboration_online_read_jobs SET status='pending',attempts=0,recovery_generation=?,grant_fingerprint=?,error_code=NULL,claim_token=NULL,instance_owner=NULL,instance_fence=NULL " +
      "WHERE id=? AND status='failed' AND recovery_generation=?").run(generation, fingerprint, job.id, job.recovery_generation);
    if (changed.changes !== 1) throw new Error('online_read_recovery_claim_changed');
    recovered++;
  }
  return recovered;
}

export function onlineReadFailureEventId(jobId: string, generation: number, revision: number): string {
  return `online-read-failed:${jobId}:recovery:${generation}:snapshot:${revision}`;
}
export function isCurrentOnlineReadFailureNotice(db: DatabaseSync, row: { source_event_id: string; aggregate_id: string; aggregate_version: number }): boolean {
  if (!row.source_event_id.startsWith('online-read-failed:')) return true;
  const id = row.source_event_id.slice('online-read-failed:'.length).split(':', 1)[0];
  const job = db.prepare("SELECT j.recovery_generation FROM collaboration_online_read_jobs j JOIN collaboration_work_items w ON w.id=j.work_item_id " +
    "WHERE j.id=? AND j.work_item_id=? AND j.status='failed' AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
    "AND ?=(SELECT max(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id)")
    .get(id, row.aggregate_id, row.aggregate_version) as { recovery_generation: number } | undefined;
  return !!job && (row.source_event_id === onlineReadFailureEventId(id, job.recovery_generation, row.aggregate_version) ||
    (job.recovery_generation === 0 && row.source_event_id === `online-read-failed:${id}`));
}
