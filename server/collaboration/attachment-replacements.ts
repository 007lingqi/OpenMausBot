import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readAttachmentEvidenceNotification } from "./attachment-ingestion.ts";

interface Material {
  id: string; ingest_state: string; source_event_id: string; principal_id: string;
  conversation_id: string; normalized_json: string; event_order: number; has_evidence: number;
}
export interface AttachmentReplacementReceipt {
  originalAttachmentId: string; replacementAttachmentId: string;
  originalSourceEventId: string; sourceEventId: string; principalId: string;
  normalizedHash: string; originalNormalizedHash: string; replacementContentHash: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function explicitReplacement(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return /^(?:请)?(?:用)?(?:这份|这个)(?:文件|附件)?(?:来)?(?:替换|代替)(?:之前的|原来的|原)(?:文件|附件)[。！!]?$/u.test(text.trim()) ||
    /^这份是可读版本[，,]请替换原附件[。！!]?$/u.test(text.trim());
}

/** Derived from saved group-message provenance, never from attachment text or filenames. */
export function readAttachmentReplacements(db: DatabaseSync, workItemId: string) {
  const rows = db.prepare("SELECT a.id,a.ingest_state,e.source_event_id,e.principal_id,e.conversation_id,e.normalized_json,e.rowid AS event_order," +
    "EXISTS(SELECT 1 FROM collaboration_attachment_extractions x WHERE x.attachment_id=a.id AND x.status='succeeded') AS has_evidence " +
    "FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "WHERE e.source='dingtalk' AND e.work_item_id=? ORDER BY e.rowid,a.ordinal LIMIT 101").all(workItemId) as unknown as Material[];
  const receipts: AttachmentReplacementReceipt[] = [];
  const replaced = new Set<string>();
  let needsClarification = false;
  if (rows.length > 100) return { receipts, replaced, needsClarification };
  for (const row of rows) {
    let message: { text?: unknown; replyToSourceEventId?: unknown };
    try { message = JSON.parse(row.normalized_json); } catch { continue; }
    if (!message || !explicitReplacement(message.text)) continue;
    const originals = rows.filter(old => old.source_event_id === message.replyToSourceEventId && old.event_order < row.event_order && old.conversation_id === row.conversation_id);
    const newFiles = rows.filter(other => other.source_event_id === row.source_event_id);
    const old = originals[0];
    if (originals.length !== 1 || newFiles.length !== 1 || !old || old.principal_id !== row.principal_id) {
      needsClarification = true; continue;
    }
    // Replacing unread material is not permission to discard already-used facts.
    if (!["failed", "unsupported"].includes(old.ingest_state) || old.has_evidence) { needsClarification = true; continue; }
    if (row.ingest_state !== "ready") continue;
    try {
      const evidence = readAttachmentEvidenceNotification(db, row.id);
      if (evidence.workItemId !== workItemId || evidence.source.sourceEventId !== row.source_event_id ||
        evidence.chunks.length === 0 || evidence.chunks.some(c => c.truncated || c.warnings.some(w => !/^csv_formula_like_cells_present:\d+$/.test(w)))) continue;
      receipts.push({ originalAttachmentId: old.id, replacementAttachmentId: row.id,
        originalSourceEventId: old.source_event_id, sourceEventId: row.source_event_id, principalId: row.principal_id,
        normalizedHash: hash(row.normalized_json), originalNormalizedHash: hash(old.normalized_json), replacementContentHash: evidence.source.contentHash });
      replaced.add(old.id);
    } catch { /* Missing or unverifiable source evidence never releases the old gate. */ }
  }
  const counts = new Map<string, number>();
  for (const receipt of receipts) counts.set(receipt.originalAttachmentId, (counts.get(receipt.originalAttachmentId) ?? 0) + 1);
  const unambiguous = receipts.filter(receipt => counts.get(receipt.originalAttachmentId) === 1);
  if (unambiguous.length !== receipts.length) needsClarification = true;
  replaced.clear();
  for (const receipt of unambiguous) replaced.add(receipt.originalAttachmentId);
  // A later valid correction may resolve an earlier ambiguous suggestion. The
  // replacement gate is about unread inputs, never a permanent historical flag.
  needsClarification &&= rows.some(row => ["failed", "unsupported"].includes(row.ingest_state) && !replaced.has(row.id));
  return { receipts: unambiguous, replaced, needsClarification };
}
