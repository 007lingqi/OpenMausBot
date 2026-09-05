import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { enqueueInboundCard } from "./outbox.ts";

function retryState(db: DatabaseSync, attachmentId: string) {
  const rows = db.prepare("SELECT error_code,retry_after FROM collaboration_attachment_projection_failures WHERE attachment_id=? " +
    "AND sequence>coalesce((SELECT max(boundary_sequence) FROM collaboration_attachment_projection_recoveries WHERE attachment_id=?),0) ORDER BY sequence DESC LIMIT 3")
    .all(attachmentId, attachmentId) as Array<{ error_code: string; retry_after: number }>;
  return { count: rows.length, stopped: rows.length === 3 && rows.every(row => row.error_code === rows[0]!.error_code),
    nextAttemptAt: rows[0]?.retry_after ?? 0 };
}

export function claimAttachmentProjection(db: DatabaseSync, attachmentId: string, now: number, assertActive: () => void): string | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive();
    const state = retryState(db, attachmentId);
    let token: string | null = null;
    if (!state.stopped && state.nextAttemptAt <= now) {
      const candidate = randomUUID();
      const claimed = db.prepare("UPDATE collaboration_attachments SET evidence_projection_owner=?,evidence_projection_expires_at=? " +
        "WHERE id=? AND ingest_state='ready' AND evidence_projected_at IS NULL " +
        "AND (evidence_projection_expires_at IS NULL OR evidence_projection_expires_at<=?)")
        .run(candidate, now + 60000, attachmentId, now);
      if (claimed.changes === 1) token = candidate;
    }
    db.exec("COMMIT");
    return token;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function finishAttachmentProjection(db: DatabaseSync, input: {
  attachmentId: string; token: string; now: number; assertActive: () => void; failure?: unknown;
}): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    input.assertActive();
    if (!db.prepare("SELECT 1 FROM collaboration_attachments WHERE id=? AND ingest_state='ready' AND evidence_projected_at IS NULL AND evidence_projection_owner=?")
      .get(input.attachmentId, input.token)) throw new Error("attachment_projection_claim_superseded");
    if ("failure" in input) {
      const message = input.failure instanceof Error ? input.failure.message : "";
      const code = ["attachment_projection_evidence_invalid", "attachment_evidence_projection_mismatch", "attachment_evidence_source_invalid"].includes(message)
        ? message : "attachment_projection_unavailable";
      const retryAfter = input.now + 1000 * 2 ** Math.min(2, retryState(db, input.attachmentId).count);
      db.prepare("INSERT INTO collaboration_attachment_projection_failures(attachment_id,claim_token,error_code,created_at,retry_after) VALUES(?,?,?,?,?)")
        .run(input.attachmentId, input.token, code, input.now, retryAfter);
      const state = retryState(db, input.attachmentId);
      db.prepare("UPDATE collaboration_attachments SET evidence_projection_owner=NULL,evidence_projection_expires_at=NULL WHERE id=?")
        .run(input.attachmentId);
      const work = db.prepare("SELECT w.id,w.version,a.ordinal,coalesce((SELECT max(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id),0) AS revision " +
        "FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id JOIN collaboration_work_items w ON w.id=e.work_item_id " +
        "WHERE a.id=? AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled')")
        .get(input.attachmentId) as { id: string; version: number; ordinal: number; revision: number } | undefined;
      if (work && (state.count === 1 || state.stopped)) {
        const summary = `这条消息的第 ${work.ordinal + 1} 份附件文字提取记录已保留，但尚未确认需求整理结果。` +
          (state.stopped ? "连续 3 次遇到同样的问题，已停止这一步的自动重试，请负责人检查后再继续。原附件和来源记录仍保留。" : "稍后会自动重试，无需重复发送附件。");
        enqueueInboundCard(db, { sourceEventId: `attachment-feedback:${input.attachmentId}:projection:${input.token}`, aggregateType: "plan", aggregateId: work.id,
          aggregateVersion: work.version, supersessionKey: `attachment-projection:${input.attachmentId}`, now: input.now,
          card: { type: "clarification_card", headline: "需求整理未完成", workItemId: work.id, snapshotRevision: work.revision, questions: [], contextSummary: summary } });
      }
    } else {
      db.prepare("UPDATE collaboration_attachments SET evidence_projected_at=?,evidence_projection_owner=NULL,evidence_projection_expires_at=NULL WHERE id=?")
        .run(input.now, input.attachmentId);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function isCurrentProjectionFeedback(db: DatabaseSync, message: { source_event_id: string; aggregate_id: string; aggregate_version: number }): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_attachment_projection_failures f JOIN collaboration_attachments a ON a.id=f.attachment_id " +
    "JOIN collaboration_external_events e ON e.id=a.external_event_id JOIN collaboration_work_items w ON w.id=e.work_item_id " +
    "WHERE ?='attachment-feedback:'||a.id||':projection:'||f.claim_token AND w.id=? AND w.version=? AND w.control_state='active' " +
    "AND w.status NOT IN ('accepted','cancelled') AND a.ingest_state='ready' AND a.evidence_projected_at IS NULL " +
    "AND f.sequence>coalesce((SELECT max(boundary_sequence) FROM collaboration_attachment_projection_recoveries WHERE attachment_id=a.id),0) " +
    "AND NOT EXISTS(SELECT 1 FROM collaboration_attachment_projection_failures newer WHERE newer.attachment_id=a.id AND newer.sequence>f.sequence)")
    .get(message.source_event_id, message.aggregate_id, message.aggregate_version);
}
