import type { DatabaseSync } from "node:sqlite";

export interface DeliveryCounts {
  queued: number;
  sending: number;
  retrying: number;
  needsReview: number;
}

export type DeliveryHealth = {
  status: "clear" | "pending" | "needs_attention";
  counts: DeliveryCounts;
  summary: string;
} | {
  status: "unavailable";
  counts: null;
  summary: string;
};

/** A read-only operational summary; never include payloads, identities or raw errors. */
export function readDeliveryHealth(database: DatabaseSync | null, now: number): DeliveryHealth {
  const unavailable: DeliveryHealth = {
    status: "unavailable", counts: null,
    summary: "暂时无法读取回复投递状态，不能确认是否有待核查回复。",
  };
  if (!database || !Number.isSafeInteger(now) || now < 0) return unavailable;
  try {
    const rows = database.prepare(
      "SELECT CASE WHEN delivery_state='dead_letter' THEN 'needsReview' " +
      "WHEN delivery_state='claimed' THEN CASE WHEN claim_expires_at>? THEN 'sending' ELSE 'needsReview' END " +
      "WHEN attempt=0 THEN 'queued' " +
      "WHEN substr(COALESCE(last_error,''),1,length('delivery_confirmed_unsent:'))='delivery_confirmed_unsent:' THEN 'retrying' " +
      "ELSE 'needsReview' END AS bucket, COUNT(*) AS count FROM collaboration_outbox " +
      "WHERE source='dingtalk' AND sent_at IS NULL AND superseded_at IS NULL " +
      "AND delivery_state IN ('pending','claimed','dead_letter') GROUP BY bucket",
    ).all(now) as Array<{ bucket: keyof DeliveryCounts; count: number }>;
    const counts: DeliveryCounts = { queued: 0, sending: 0, retrying: 0, needsReview: 0 };
    for (const row of rows) {
      if (!Object.hasOwn(counts, row.bucket) || !Number.isSafeInteger(row.count) || row.count < 0) return unavailable;
      counts[row.bucket] = row.count;
    }
    if (counts.needsReview > 0) return {
      status: "needs_attention", counts,
      summary: `有 ${counts.needsReview} 条回复需要核查，尚不能确认全部送达；请先核实实际送达情况，避免重复发送。`,
    };
    if (counts.queued + counts.sending + counts.retrying > 0) return {
      status: "pending", counts, summary: "还有回复正在排队、发送或等待安全重试。",
    };
    return { status: "clear", counts, summary: "当前没有待发送或待核查的回复。" };
  } catch {
    return unavailable;
  }
}
