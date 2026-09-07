import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BlockingAmbiguity } from "./snapshot.ts";

export const ONLINE_DOCUMENT_GATE_ID = "online-document-content-unavailable";

/** Reference detection only. Never fetch a URL or infer its document type or access rights. */
function hasOnlineDocumentLink(text: string): boolean {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    try {
      if (new URL(match[0]).hostname.toLowerCase().replace(/\.$/u, "") === "alidocs.dingtalk.com") return true;
    } catch { /* A malformed URL is not evidence of a readable document. */ }
  }
  return false;
}

interface OnlineDocumentReference {
  sourceEventId: string;
  normalizedHash: string;
  bodyStatus: "unavailable";
}

/** Audit the durable ledger, not bounded model history, editable facts or redelivered text.
 * There is currently no online reader. These are unresolved references, never body receipts.
 * Keep URL capabilities out of this additional context and bound model-visible source records.
 */
export function readOnlineDocumentReferences(db: DatabaseSync, workItemId: string) {
  const sources: OnlineDocumentReference[] = [];
  let totalSources = 0;
  const hash = createHash("sha256");
  for (const value of db.prepare("SELECT source_event_id,normalized_json FROM collaboration_external_events " +
    "WHERE source='dingtalk' AND work_item_id=? ORDER BY received_at,rowid").iterate(workItemId)) {
    const row = value as { source_event_id: string; normalized_json: string };
    const event: unknown = JSON.parse(row.normalized_json);
    if (!event || typeof event !== "object" || !("text" in event) || typeof event.text !== "string" || !hasOnlineDocumentLink(event.text)) continue;
    const source: OnlineDocumentReference = { sourceEventId: row.source_event_id,
      normalizedHash: createHash("sha256").update(row.normalized_json).digest("hex"), bodyStatus: "unavailable" };
    hash.update(JSON.stringify(source)).update("\n");
    totalSources++;
    if (sources.length < 100) sources.push(source);
  }
  return { sources, totalSources, truncated: totalSources > sources.length, fingerprint: hash.digest("hex") };
}

export function onlineDocumentCompletenessGates(db: DatabaseSync, workItemId: string): BlockingAmbiguity[] {
  if (!readOnlineDocumentReferences(db, workItemId).totalSources) return [];
  return [{ id: ONLINE_DOCUMENT_GATE_ID, dependsOn: [], role: "requester",
    question: "收到文档链接，但还没有读取正文，不能据此开始修改。",
    recommendedAnswer: "目前尚未接通在线文档读取。可先把具体问题和预期结果用文字发成一条新需求，原记录会保留。" }];
}
