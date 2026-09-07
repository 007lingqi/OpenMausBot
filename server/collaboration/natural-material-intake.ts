import type { DatabaseSync } from "node:sqlite";
import type { BlockingAmbiguity } from "./snapshot.ts";
import { durableOnlineSources, readOnlineBody, onlineHash } from "./online-document-evidence.ts";

export const MATERIAL_INTAKE_GATE = "online-document-interpretation-pending";
export interface NaturalJob {
  job_key: string; job_kind: "event" | "material"; source_event_id: string;
  work_item_id: string; attempts: number; base_revision: number;
}
export function naturalJobStorage(job: Pick<NaturalJob, "job_kind">) {
  return job.job_kind === "material"
    ? { table: "collaboration_natural_material_jobs", key: "id" }
    : { table: "collaboration_natural_intake_jobs", key: "source_event_id" };
}

/** An earlier successful interpretation covers a body only when its immutable source receipt says so. */
function covered(proposal: string | null, source: { sourceEventId: string; normalizedHash: string; referenceHash: string }, contentHash: string): boolean {
  try {
    const value = JSON.parse(proposal ?? "null");
    return value?.sourceEventId === source.sourceEventId && value.eventEvidence?.normalizedHash === source.normalizedHash &&
      value.eventEvidence?.sourceEventId === source.sourceEventId && Array.isArray(value.onlineDocuments?.sources) &&
      value.onlineDocuments.sources.some((doc: Record<string, unknown>) => doc.sourceEventId === source.sourceEventId &&
        doc.normalizedHash === source.normalizedHash && doc.referenceHash === source.referenceHash &&
        doc.bodyStatus === "ready" && doc.contentHash === contentHash);
  } catch { return false; }
}

export function pendingOnlineMaterialSources(db: DatabaseSync, workItemId: string, completingJobId?: string) {
  const sources = [];
  for (const source of durableOnlineSources(db, workItemId)) {
    if (source.id === completingJobId) continue;
    const original = db.prepare("SELECT status,proposal_json FROM collaboration_natural_intake_jobs WHERE source_event_id=? AND work_item_id=?")
      .get(source.sourceEventId, workItemId) as { status: string; proposal_json: string | null } | undefined;
    // Pending/failed original inputs keep their original budgets and recovery authority.
    if (original?.status !== "applied") continue;
    const body = readOnlineBody(db, source);
    if (!body || covered(original.proposal_json, source, body.contentHash)) continue;
    const row = db.prepare("SELECT status,proposal_json,receipt_hash FROM collaboration_natural_material_jobs WHERE id=? AND work_item_id=?")
      .get(source.id, workItemId) as { status: string; proposal_json: string | null; receipt_hash: string } | undefined;
    const receipt = db.prepare("SELECT receipt_hash FROM collaboration_online_read_receipts WHERE job_id=?").get(source.id) as { receipt_hash: string };
    if (row?.status === "applied" && row.receipt_hash === receipt.receipt_hash && covered(row.proposal_json, source, body.contentHash)) continue;
    sources.push({ ...source, receiptHash: receipt.receipt_hash, status: row?.status ?? "missing" });
  }
  return sources;
}

export function enqueueMaterialInterpretation(db: DatabaseSync, workItemId: string, sourceId: string, baseRevision: number, now: number): boolean {
  const source = pendingOnlineMaterialSources(db, workItemId).find(value => value.id === sourceId && value.status === "missing");
  if (!source) return false;
  return db.prepare("INSERT OR IGNORE INTO collaboration_natural_material_jobs " +
    "(id,source_event_id,work_item_id,receipt_hash,status,base_revision,created_at) VALUES (?,?,?,?,'pending',?,?)")
    .run(source.id, source.sourceEventId, workItemId, source.receiptHash, baseRevision, now).changes === 1;
}

export function materialInterpretationSourceCurrent(db: DatabaseSync, workItemId: string, id: string): boolean {
  const source = pendingOnlineMaterialSources(db, workItemId).find(value => value.id === id);
  if (!source) return false;
  const row = db.prepare("SELECT receipt_hash FROM collaboration_natural_material_jobs WHERE id=? AND work_item_id=?")
    .get(id, workItemId) as { receipt_hash: string } | undefined;
  const receipt = db.prepare("SELECT receipt_json,receipt_hash FROM collaboration_online_read_receipts WHERE job_id=?")
    .get(id) as { receipt_json: string; receipt_hash: string } | undefined;
  return !!row && !!receipt && row.receipt_hash === source.receiptHash && onlineHash(receipt.receipt_json) === row.receipt_hash;
}

export function materialInterpretationGates(db: DatabaseSync, workItemId: string, completingJobId?: string): BlockingAmbiguity[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_natural_material_jobs'").get()) return [];
  const unresolved = db.prepare("SELECT 1 FROM collaboration_natural_material_jobs WHERE work_item_id=? AND status<>'applied' AND id<>? LIMIT 1")
    .get(workItemId, completingJobId ?? "");
  if (!unresolved && !pendingOnlineMaterialSources(db, workItemId, completingJobId).length) return [];
  return [{ id: MATERIAL_INTAKE_GATE, dependsOn: [], question: "文档正文已补充到记录，还需要重新核对其中的要求和验收条件，尚未开始修改。",
    recommendedAnswer: "不需要重复发送材料；核对遇到问题时会说明。" }];
}
