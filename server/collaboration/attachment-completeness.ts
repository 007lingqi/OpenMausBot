import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readAttachmentEvidenceNotification, type AttachmentEvidenceNotification } from "./attachment-ingestion.ts";
import type { BlockingAmbiguity } from "./snapshot.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

export const ATTACHMENT_GATE_IDS = new Set(["attachment-content-pending", "attachment-content-incomplete", "attachment-context-incomplete"]);

export function attachmentReceipt(evidence: AttachmentEvidenceNotification) {
  return { source: evidence.source, format: evidence.format, chunks: evidence.chunks.map(({ text: _text, ...chunk }) => chunk) };
}

/** Bounded, source-checked model input; omitted documents remain explicitly incomplete. */
export function readNaturalAttachmentContext(database: DatabaseSync, workItemId: string) {
  const rows = database.prepare("SELECT a.id,a.ingest_state,a.content_hash FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "WHERE e.work_item_id=? ORDER BY e.received_at,e.id,a.ordinal LIMIT 101").all(workItemId) as unknown as Array<{ id: string; ingest_state: string; content_hash: string | null }>;
  const attachments: AttachmentEvidenceNotification[] = [];
  const receipts: unknown[] = [];
  let incomplete = rows.length > 100, bytes = 0;
  for (const row of rows.slice(0, 100)) {
    if (row.ingest_state !== "ready") { incomplete = true; continue; }
    try {
      const value = readAttachmentEvidenceNotification(database, row.id);
      if (value.workItemId !== workItemId) throw new Error("source_mismatch");
      receipts.push(attachmentReceipt(value));
      const size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > 48 * 1024) { incomplete = true; continue; }
      bytes += size;
      attachments.push(value);
      if (value.chunks.some(c => c.truncated || c.warnings.some(w => !/^csv_formula_like_cells_present:\d+$/.test(w)))) incomplete = true;
    } catch { incomplete = true; }
  }
  return { attachments, incomplete, fingerprint: createHash("sha256").update(JSON.stringify({ rows, receipts })).digest("hex") };
}

/** Preserve every character within a chunk, with independently bounded, source-labelled Spec facts. */
export function attachmentExcerpts(displayName: string, chunk: { ordinal: number; text: string; lineStart: number; lineEnd: number }): string[] {
  const label = redactSensitiveText(displayName.trim()).slice(0, 120) || "附件";
  const prefix = `[附件“${label}” 第 ${chunk.lineStart}-${chunk.lineEnd} 行] `;
  const safe = redactSensitiveText(chunk.text).trim();
  if (!safe) return [];
  // Retain the representation of existing short-source facts.
  if (prefix.length + safe.length <= 2000) return [`${prefix}${safe}`];
  const excerpts: string[] = [];
  const suffix = "\n[片段结束]";
  for (let offset = 0; offset < safe.length;) {
    const source = `[附件“${label}” 第 ${chunk.lineStart}-${chunk.lineEnd} 行，片段 ${chunk.ordinal + 1}.${excerpts.length + 1}] `;
    let end = Math.min(safe.length, offset + 2000 - source.length - suffix.length);
    const last = safe.charCodeAt(end - 1);
    if (end < safe.length && last >= 0xd800 && last <= 0xdbff) end--;
    // A suffix preserves whitespace at segment boundaries when snapshot strings are trimmed.
    excerpts.push(`${source}${safe.slice(offset, end)}${suffix}`);
    offset = end;
  }
  return excerpts;
}

/** Recomputed from durable evidence, not from conversation claims or editable ambiguity lists. */
export function attachmentCompletenessGates(database: DatabaseSync, workItemId: string, facts: readonly string[]): BlockingAmbiguity[] {
  const rows = database.prepare("SELECT a.id,a.ingest_state FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "WHERE e.work_item_id=? ORDER BY e.received_at,e.id,a.ordinal LIMIT 101").all(workItemId) as unknown as Array<{ id: string; ingest_state: string }>;
  let pending = false, failed = false, incomplete = false, contextIncomplete = rows.length > 100;
  for (const row of rows.slice(0, 100)) {
    if (row.ingest_state !== "ready") {
      pending = true;
      if (row.ingest_state === "failed" || row.ingest_state === "unsupported") failed = true;
      continue;
    }
    try {
      const evidence = readAttachmentEvidenceNotification(database, row.id);
      if (evidence.workItemId !== workItemId) throw new Error("source_mismatch");
      // CSV formula-like strings are preserved verbatim as data, not missing evaluated content.
      if (evidence.chunks.some(chunk => chunk.truncated || chunk.warnings.some(w => !/^csv_formula_like_cells_present:\d+$/.test(w)))) incomplete = true;
      for (const chunk of evidence.chunks) {
        if (attachmentExcerpts(evidence.source.displayName ?? "附件", chunk).some(excerpt => !facts.includes(excerpt))) contextIncomplete = true;
      }
    } catch { incomplete = true; }
  }
  const gates: BlockingAmbiguity[] = [];
  if (pending) gates.push({ id: "attachment-content-pending", question: "仍有附件没有读到正文，暂时不能确认材料完整。", dependsOn: [],
    recommendedAnswer: failed ? "有附件未能读取，请提供可读版本；不需要重复发送已读成功的文件。" : "正在读取，暂时不用重复发送；读取失败时我会说明需要补充什么。" });
  if (incomplete) gates.push({ id: "attachment-content-incomplete", question: "附件有部分内容尚未读全或无法核实，暂时不能据此开始修改。", dependsOn: [],
    recommendedAnswer: "请补充可完整读取的材料；图片、扫描页或其他未读内容需要进一步核对。" });
  if (contextIncomplete) gates.push({ id: "attachment-context-incomplete", question: "附件只有部分内容进入当前需求记录，我还不能确认需求完整。", dependsOn: [],
    recommendedAnswer: "尚未开始修改，需要先完成正文核对；一句“已读完”不会跳过检查。" });
  return gates;
}
