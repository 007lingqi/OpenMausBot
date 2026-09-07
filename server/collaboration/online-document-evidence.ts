import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OnlineBodyReceipt, OnlineReadSource } from "./operations/dws-online-reader.ts";

export const onlineHash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Detect exact references; never fetch or infer an identity here. */
export function onlineDocumentLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const link = match[0].replace(/[)\]。，；！、]+$/u, "");
    try { if (new URL(link).hostname.toLowerCase().replace(/\.$/u, "") === "alidocs.dingtalk.com") links.add(link); }
    catch { /* Invalid input is not a readable reference. */ }
  }
  return [...links];
}
export interface DurableOnlineSource extends OnlineReadSource { id: string; workItemId: string; referenceHash: string }
export function* durableOnlineSources(db: DatabaseSync, workItemId?: string): Generator<DurableOnlineSource> {
  const hasAliases = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_conversation_aliases'").get();
  const identity = hasAliases ? "CASE WHEN (SELECT count(*) FROM collaboration_conversation_aliases a WHERE a.conversation_id=e.conversation_id AND a.source='dingtalk')=1 " +
    "THEN (SELECT external_id FROM collaboration_conversation_aliases a WHERE a.conversation_id=e.conversation_id AND a.source='dingtalk') ELSE '' END" : "''";
  const query = db.prepare("SELECT source_event_id,work_item_id,normalized_json," + identity + " AS external_conversation_id FROM collaboration_external_events e " +
    "WHERE source='dingtalk' AND work_item_id IS NOT NULL " + (workItemId !== undefined ? "AND work_item_id=? " : "") + "ORDER BY received_at,rowid");
  for (const value of workItemId !== undefined ? query.iterate(workItemId) : query.iterate()) {
    const row = value as { source_event_id: string; work_item_id: string; normalized_json: string; external_conversation_id: string };
    const event = JSON.parse(row.normalized_json) as { text?: string; conversationId?: string };
    if (typeof event?.text !== "string") continue;
    for (const node of onlineDocumentLinks(event.text)) {
      const referenceHash = onlineHash(node);
      yield { id: onlineHash(JSON.stringify([row.source_event_id, referenceHash])), workItemId: row.work_item_id,
        sourceEventId: row.source_event_id, normalizedHash: onlineHash(row.normalized_json), referenceHash,
        conversationId: row.external_conversation_id, node };
    }
  }
}
/** The reader receives only its strict source schema, never database/control fields. */
export function onlineReadSource(source: DurableOnlineSource): OnlineReadSource {
  const { conversationId, sourceEventId, normalizedHash, node } = source;
  return { conversationId, sourceEventId, normalizedHash, node };
}
/** Recheck immutable receipts against the original source before any projection or model use. */
export function readOnlineBody(db: DatabaseSync, source: DurableOnlineSource): OnlineBodyReceipt | null {
  const row = db.prepare("SELECT r.receipt_json,r.receipt_hash,j.grant_fingerprint,j.normalized_hash,j.work_item_id FROM collaboration_online_read_receipts r " +
    "JOIN collaboration_online_read_jobs j ON j.id=r.job_id WHERE j.id=? AND j.status='ready'").get(source.id) as
    { receipt_json: string; receipt_hash: string; grant_fingerprint: string; normalized_hash: string; work_item_id: string } | undefined;
  if (!row || row.normalized_hash !== source.normalizedHash || row.work_item_id !== source.workItemId || onlineHash(row.receipt_json) !== row.receipt_hash) return null;
  const receipt = JSON.parse(row.receipt_json) as OnlineBodyReceipt;
  if (receipt.sourceEventId !== source.sourceEventId || receipt.normalizedHash !== source.normalizedHash ||
    receipt.grantFingerprint !== row.grant_fingerprint || receipt.complete !== true ||
    !Array.isArray(receipt.records) || !receipt.records.length || receipt.records.some(r => r.untrusted !== true || typeof r.text !== "string" || typeof r.location !== "string") ||
    onlineHash(JSON.stringify({ records: receipt.records, worksheets: receipt.worksheets })) !== receipt.contentHash) return null;
  return receipt;
}
export function onlineBodyExcerpts(source: Pick<DurableOnlineSource, "id">, receipt: OnlineBodyReceipt): string[] {
  return receipt.records.flatMap((record, index) => {
    const result: string[] = [];
    for (let offset = 0; offset < record.text.length;) {
      const prefix = `[在线材料 ${source.id} 正文 ${index + 1}.${result.length + 1}] `;
      let end = Math.min(record.text.length, offset + 1800);
      const last = record.text.charCodeAt(end - 1);
      if (end < record.text.length && last >= 0xd800 && last <= 0xdbff) end--;
      result.push(`${prefix}${record.text.slice(offset, end)}\n[片段结束]`); offset = end;
    }
    return result;
  });
}
