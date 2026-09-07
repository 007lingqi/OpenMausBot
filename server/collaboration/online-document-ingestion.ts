import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { CommandCleanupError } from "./execution-limits.ts";
import type { OnlineDocumentReader } from "./operations/dws-online-reader.ts";
import { durableOnlineSources, onlineHash, onlineReadSource, type DurableOnlineSource } from "./online-document-evidence.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderClarificationCard } from "./message-renderer.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { onlineReadFailureEventId } from './online-document-recovery.ts';

export interface OnlineDocumentIngestionOptions {
  reader: OnlineDocumentReader;
  currentLease(): Pick<InstanceLease, "ownerId" | "fence"> | null;
}
interface Job { id: string; work_item_id: string; normalized_hash: string; grant_fingerprint: string; status: string; attempts: number }
/** Read-only external calls; immutable receipts and atomic Spec projection are separate recovery stages. */
export class OnlineDocumentIngestion {
  private readonly db: DatabaseSync;
  private readonly options: OnlineDocumentIngestionOptions;
  private readonly project: (workItemId: string, jobId: string, now: number) => boolean;
  private stopped = false;
  private busy = false;
  private readonly abort = new AbortController();
  constructor(file: string, options: OnlineDocumentIngestionOptions, project: (workItemId: string, jobId: string, now: number) => boolean) {
    this.db = new DatabaseSync(file); this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.options = options; this.project = project;
  }
  enqueue(workItemId?: string, now = Date.now()): void {
    if (this.stopped) return;
    assertLedgerArmed(this.db);
    for (const source of durableOnlineSources(this.db, workItemId)) {
      if (!this.activeWork(source.workItemId)) continue;
      let fingerprint = "", status = "pending";
      try { fingerprint = this.options.reader.authorizationFingerprint(onlineReadSource(source)); } catch { status = "failed"; }
      this.db.prepare("INSERT OR IGNORE INTO collaboration_online_read_jobs " +
        "(id,work_item_id,source_event_id,normalized_hash,reference_hash,grant_fingerprint,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(source.id, source.workItemId, source.sourceEventId, source.normalizedHash, source.referenceHash, fingerprint, status,
          status === "failed" ? "online_document_not_authorized" : null, now);
    }
  }
  async processOne(now = Date.now()): Promise<string | null> {
    if (this.stopped || this.busy) return null;
    const lease = this.options.currentLease(); if (!lease) return null;
    const binding = { ...lease }; const started = Date.now();
    const time = () => now + Math.max(0, Date.now() - started);
    const active = () => {
      if (this.stopped || this.abort.signal.aborted) throw new Error("online_reader_stopped");
      const current = this.options.currentLease();
      if (!current || current.ownerId !== binding.ownerId || current.fence !== binding.fence) throw new Error("online_reader_stale");
      assertLedgerArmed(this.db); assertCurrentInstanceLease(this.db, binding, time());
    };
    active(); this.busy = true;
    try {
      this.enqueue(undefined, now);
      // Lease expiry is NOT proof that a prior subprocess stopped. Quarantine it, never reissue its read.
      this.db.prepare("UPDATE collaboration_online_read_jobs SET status='failed',error_code='online_read_cleanup_unconfirmed' " +
        "WHERE status='running' AND (instance_owner<>? OR instance_fence<>?)").run(binding.ownerId, binding.fence);
      this.failureNotices(now);
      const job = this.db.prepare("SELECT j.id,j.work_item_id,j.normalized_hash,j.grant_fingerprint,j.status,j.attempts FROM collaboration_online_read_jobs j " +
        "JOIN collaboration_work_items w ON w.id=j.work_item_id WHERE w.status NOT IN ('cancelled','accepted') " +
        "AND (j.status='pending' OR (j.status='ready' AND j.projected_revision IS NULL)) " +
        "AND NOT EXISTS(SELECT 1 FROM collaboration_online_read_jobs b WHERE b.work_item_id=j.work_item_id AND b.status='running') " +
        "ORDER BY j.created_at,j.rowid LIMIT 1").get() as Job | undefined;
      if (!job) return null;
      const source = [...durableOnlineSources(this.db, job.work_item_id)].find(s => s.id === job.id);
      if (!source || !this.sourceAuthorized(source, job)) {
        this.fail(job.id, "online_document_source_or_grant_changed"); this.failureNotices(now); return null;
      }
      if (job.status === "ready") { active(); return this.projectOne(job, time()); }
      const claim = randomUUID();
      const claimed = this.db.prepare("UPDATE collaboration_online_read_jobs SET status='running',attempts=attempts+1,claim_token=?,instance_owner=?,instance_fence=? " +
        "WHERE id=? AND status='pending' AND attempts<3").run(claim, binding.ownerId, binding.fence, job.id);
      if (!claimed.changes) return null;
      try {
        active();
        const receipt = await this.options.reader.read(onlineReadSource(source), this.abort.signal);
        active();
        const current = [...durableOnlineSources(this.db, job.work_item_id)].find(s => s.id === job.id);
        if (!current || current.normalizedHash !== source.normalizedHash || !this.sourceAuthorized(current, job) ||
          receipt.normalizedHash !== source.normalizedHash || receipt.sourceEventId !== source.sourceEventId || receipt.grantFingerprint !== job.grant_fingerprint) {
          this.fail(job.id, "online_document_source_or_grant_changed"); return null;
        }
        if (!this.activeWork(job.work_item_id)) { this.fail(job.id, "online_document_work_inactive"); return null; }
        this.db.exec("BEGIN IMMEDIATE");
        try {
          active();
          const updated = this.db.prepare("UPDATE collaboration_online_read_jobs SET status='ready',claim_token=NULL,error_code=NULL WHERE id=? AND status='running' AND claim_token=?")
            .run(job.id, claim);
          if (updated.changes !== 1) throw new Error("online_document_claim_lost");
          const json = JSON.stringify(receipt);
          this.db.prepare("INSERT INTO collaboration_online_read_receipts VALUES (?,?,?,?)").run(job.id, json, onlineHash(json), time());
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      } catch (error) {
        // If authority is gone, leave durable running state for conservative recovery. Do not publish a late result.
        try { active(); } catch { return null; }
        const terminal = error instanceof CommandCleanupError;
        this.db.prepare("UPDATE collaboration_online_read_jobs SET status=CASE WHEN attempts>=3 OR ? THEN 'failed' ELSE 'pending' END, " +
          "claim_token=NULL,error_code=? WHERE id=? AND status='running' AND claim_token=?")
          .run(terminal ? 1 : 0, terminal ? "online_read_cleanup_unconfirmed" : "online_document_read_unverified", job.id, claim);
        this.failureNotices(time()); return null;
      }
      active(); return this.projectOne(job, time());
    } finally { this.busy = false; if (this.stopped) this.db.close(); }
  }
  private projectOne(job: Job, now: number): string | null {
    const claimed = this.db.prepare("UPDATE collaboration_online_read_jobs SET projection_attempts=projection_attempts+1 " +
      "WHERE id=? AND status='ready' AND projected_revision IS NULL AND projection_attempts<3").run(job.id);
    if (!claimed.changes) {
      this.db.prepare("UPDATE collaboration_online_read_jobs SET status='failed',error_code='online_document_projection_failed' " +
        "WHERE id=? AND status='ready' AND projected_revision IS NULL AND projection_attempts>=3").run(job.id);
      this.failureNotices(now); return null;
    }
    try { return this.project(job.work_item_id, job.id, now) ? job.work_item_id : null; }
    catch (error) {
      this.db.prepare("UPDATE collaboration_online_read_jobs SET status=CASE WHEN projection_attempts>=3 THEN 'failed' ELSE 'ready' END, " +
        "error_code='online_document_projection_failed' WHERE id=? AND projected_revision IS NULL").run(job.id);
      this.failureNotices(now); throw error;
    }
  }
  private activeWork(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM collaboration_work_items WHERE id=? AND status NOT IN ('cancelled','accepted')").get(id);
  }
  private sourceAuthorized(source: DurableOnlineSource, job: Job): boolean {
    try { return source.normalizedHash === job.normalized_hash && this.options.reader.authorizationFingerprint(onlineReadSource(source)) === job.grant_fingerprint; } catch { return false; }
  }
  private fail(id: string, code: string): void {
    this.db.prepare("UPDATE collaboration_online_read_jobs SET status='failed',error_code=?,claim_token=NULL WHERE id=?").run(code, id);
  }
  private failureNotices(now: number): void {
    const rows = this.db.prepare("SELECT j.id,j.work_item_id,j.recovery_generation,j.error_code FROM collaboration_online_read_jobs j JOIN collaboration_work_items w ON w.id=j.work_item_id " +
      "WHERE j.status='failed' AND w.control_state='active' AND w.status NOT IN ('cancelled','accepted')").all() as unknown as Array<{ id: string; work_item_id: string; recovery_generation: number; error_code: string }>;
    for (const row of rows) {
      const snapshot = readLatestWorkItemSnapshot(this.db, row.work_item_id); if (!snapshot) continue;
      const sourceEventId = onlineReadFailureEventId(row.id, row.recovery_generation, snapshot.revision);
      if (this.db.prepare('SELECT 1 FROM collaboration_outbox WHERE source_event_id=? OR (source_event_id=? AND aggregate_version=? AND ?=0)')
        .get(sourceEventId, `online-read-failed:${row.id}`, snapshot.revision, row.recovery_generation)) continue;
      const recoverable = ['online_document_not_authorized','online_document_read_unverified','online_document_source_or_grant_changed'].includes(row.error_code);
      enqueueInboundCard(this.db, { sourceEventId, aggregateType: "plan", aggregateId: row.work_item_id,
        aggregateVersion: snapshot.revision, now,
        card: renderClarificationCard({ workItemId: row.work_item_id, snapshotRevision: snapshot.revision,
          contextSummary: "这份在线材料未能可靠读取，已停止自动尝试，尚未开始修改。",
          questions: [{ id: "online-material", title: "需要处理", question: "请负责人检查这份材料的读取授权和可读性。",
            recommendedAnswer: recoverable ? "负责人核对并修复读取授权或可读性后，可回复原需求消息说“继续整理需求”。只会恢复已确认可安全继续的部分；不需要重复发送材料。"
              : "上次读取或后续核对尚未安全收束，原记录已保留；重复发送不会重新开始尝试，请负责人先检查。" }] }) });
    }
  }
  close(): void { if (this.stopped) return; this.stopped = true; this.abort.abort(); if (!this.busy) this.db.close(); }
}
