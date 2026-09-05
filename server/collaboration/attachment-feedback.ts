import type { DatabaseSync } from "node:sqlite";
import { enqueueInboundCard } from "./outbox.ts";

const PREFIX = "attachment-feedback:";

export function enqueueAttachmentFeedback(db: DatabaseSync, attachmentId: string, now: number): void {
  const row = db.prepare(
    "SELECT a.id,a.ordinal,a.attempt_count,a.ingest_state,w.id AS work_item_id,w.version," +
    "coalesce((SELECT max(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id),0) AS revision," +
    "(SELECT count(*) FROM collaboration_attachment_failures WHERE attachment_id=a.id) AS failure_count " +
    "FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "JOIN collaboration_work_items w ON w.id=e.work_item_id WHERE a.id=? AND w.control_state='active' " +
    "AND w.status NOT IN ('accepted','cancelled')",
  ).get(attachmentId) as { id: string; ordinal: number; attempt_count: number; ingest_state: string; work_item_id: string; version: number; revision: number; failure_count: number } | undefined;
  if (!row || !["pending", "failed", "unsupported"].includes(row.ingest_state)) return;
  if (row.ingest_state === "pending" && row.failure_count !== 1) return;
  const sourceEventId = `${PREFIX}${row.id}:${row.attempt_count}:${row.ingest_state}`;
  if (db.prepare("SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=?").get(sourceEventId)) return;
  const recent = db.prepare("SELECT error_code FROM collaboration_attachment_failures WHERE attachment_id=? ORDER BY attempt DESC LIMIT 3")
    .all(row.id) as Array<{ error_code: string }>;
  const exhausted = row.ingest_state === "failed" && recent.length === 3 && recent.every(x => x.error_code === recent[0]!.error_code);
  const subject = `这条消息的第 ${row.ordinal + 1} 份附件`;
  const summary = row.ingest_state === "pending"
    ? `${subject}暂时没有读取成功，正在重试。内容尚未读到，不能据此修改。`
    : exhausted
      ? `${subject}连续 3 次遇到同样的读取问题，已停止自动重试。内容尚未读到，不能据此修改。请重新上传这份附件，或直接补充问题现象和预期结果。`
      : row.ingest_state === "unsupported"
        ? `${subject}目前无法解析，未能读取完整内容，不能据此修改。请补充可读取的文本内容或 CSV 表格。`
        : `${subject}读取未完成，已停止处理，不能据此修改。请重新上传这份附件，或直接补充问题现象和预期结果。`;
  enqueueInboundCard(db, { sourceEventId, aggregateType: "plan", aggregateId: row.work_item_id, aggregateVersion: row.version,
    supersessionKey: `${PREFIX}${row.id}`, now,
    card: { type: "clarification_card", headline: row.ingest_state === "pending" ? "正在读取附件" : "附件读取未完成", workItemId: row.work_item_id, snapshotRevision: row.revision, questions: [], contextSummary: summary },
  });
}

export function isCurrentAttachmentFeedback(db: DatabaseSync, message: { source_event_id: string; aggregate_id: string; aggregate_version: number }): boolean {
  if (!message.source_event_id.startsWith(PREFIX)) return true;
  return !!db.prepare(
    "SELECT 1 FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "JOIN collaboration_work_items w ON w.id=e.work_item_id WHERE ?='attachment-feedback:'||a.id||':'||a.attempt_count||':'||a.ingest_state " +
    "AND w.id=? AND w.version=? AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
    "AND a.ingest_state IN ('pending','failed','unsupported')",
  ).get(message.source_event_id, message.aggregate_id, message.aggregate_version);
}

export function attachmentFeedbackSourceEvent(db: DatabaseSync, feedbackEventId: string): string | undefined {
  const row = db.prepare(
    "SELECT e.source_event_id FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "WHERE ? LIKE 'attachment-feedback:'||a.id||':%'",
  ).get(feedbackEventId) as { source_event_id: string } | undefined;
  return row?.source_event_id;
}
