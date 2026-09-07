import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BlockingAmbiguity } from "./snapshot.ts";
import type { OnlineBodyReceipt } from "./operations/dws-online-reader.ts";
import { durableOnlineSources, readOnlineBody, onlineBodyExcerpts } from "./online-document-evidence.ts";

export const ONLINE_DOCUMENT_GATE_ID = "online-document-content-unavailable";
interface OnlineDocumentReference {
  sourceEventId: string; normalizedHash: string; referenceHash: string;
  bodyStatus: "unavailable" | "ready"; contentHash?: string;
  records?: OnlineBodyReceipt["records"];
}
/** Bound model context; hash all sources, including omitted bodies. Never expose URL capabilities. */
export function readOnlineDocumentReferences(db: DatabaseSync, workItemId: string) {
  const sources: OnlineDocumentReference[] = []; let totalSources = 0, incomplete = false, bytes = 0;
  const hash = createHash("sha256");
  const installed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_online_read_receipts'").get();
  for (const source of durableOnlineSources(db, workItemId ?? "")) {
    const receipt = installed ? readOnlineBody(db, source) : null;
    const ref: OnlineDocumentReference = { sourceEventId: source.sourceEventId, normalizedHash: source.normalizedHash,
      referenceHash: source.referenceHash, bodyStatus: receipt ? "ready" : "unavailable",
      ...(receipt ? { contentHash: receipt.contentHash } : {}) };
    hash.update(JSON.stringify(ref)).update("\n"); totalSources++;
    if (!receipt) incomplete = true;
    if (receipt && bytes + Buffer.byteLength(JSON.stringify(receipt.records)) <= 48 * 1024 && sources.length < 100) {
      ref.records = receipt.records; bytes += Buffer.byteLength(JSON.stringify(receipt.records));
    } else if (receipt) incomplete = true;
    if (sources.length < 100) sources.push(ref); else incomplete = true;
  }
  return { sources, totalSources, incomplete, truncated: totalSources > sources.length, fingerprint: hash.digest("hex") };
}
export function onlineDocumentCompletenessGates(db: DatabaseSync, workItemId: string, facts: readonly string[] = []): BlockingAmbiguity[] {
  const context = readOnlineDocumentReferences(db, workItemId);
  if (!context.totalSources) return [];
  const unread = context.sources.some(s => s.bodyStatus === "unavailable");
  const missingFacts = !unread && [...durableOnlineSources(db, workItemId)].some(source => {
    const body = readOnlineBody(db, source); return !body || onlineBodyExcerpts(source, body).some(fact => !facts.includes(fact));
  });
  if (!context.incomplete && !missingFacts) return [];
  return [{ id: ONLINE_DOCUMENT_GATE_ID, dependsOn: [], role: "requester",
    question: unread ? "收到文档链接，但还没有读取正文，不能据此开始修改。" : "在线材料尚未完整进入需求记录，不能据此开始修改。",
    recommendedAnswer: "需要核对材料的读取授权和完整正文；已保留原消息，尚未开始修改。" }];
}
