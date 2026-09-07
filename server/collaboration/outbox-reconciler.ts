import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, StaleFenceError, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import type { OutboxDeliveryPort } from "./outbox.ts";
import type { DispatchOutcome, OutboxDispatcherOptions } from "./outbox-dispatcher.ts";
import { isCurrentRecoveryNotification } from "./recovery-notification.ts";
import { isCurrentAttachmentFeedback } from "./attachment-feedback.ts";
import { isCurrentNaturalIntakeFailureNotice } from "./natural-intake-recovery.ts";
import { isCurrentDeliveryReviewNotice } from "./delivery-review.ts";
import { isCurrentMaterialDelivery } from "./plan-material-readiness.ts";

type Query = NonNullable<OutboxDeliveryPort["reconcile"]>;
interface Row {
  id: string; source: string; source_event_id: string; dedupe_key: string; payload_json: string;
  aggregate_type: Parameters<Query>[0]["aggregateType"]; aggregate_id: string; aggregate_version: number;
  kind: Parameters<Query>[0]["kind"]; delivery_state: string; sent_at: number | null; superseded_at: number | null;
}
const fingerprint = (row: Row): string => createHash("sha256").update(JSON.stringify(row)).digest("hex");
function current(db: DatabaseSync, row: Row): boolean {
  return row.delivery_state === "dead_letter" && row.sent_at === null && row.superseded_at === null &&
    isCurrentRecoveryNotification(db, row) && isCurrentAttachmentFeedback(db, row) &&
    isCurrentNaturalIntakeFailureNotice(db, row) && isCurrentDeliveryReviewNotice(db, row) && isCurrentMaterialDelivery(db, row);
}

/** Uses only the transport's query method. Send attempts and uncertain replies remain untouched. */
export async function reconcileOutboxOne(db: DatabaseSync, query: Query, options: OutboxDispatcherOptions,
  instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<DispatchOutcome | null> {
  let row: Row; let attempt: number; let hash: string;
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCurrentInstanceLease(db, instance, now); assertLedgerArmed(db);
    const candidate = db.prepare("SELECT o.* FROM collaboration_outbox o LEFT JOIN collaboration_delivery_queries q ON q.outbox_id=o.id " +
      "AND q.attempt=(SELECT MAX(attempt) FROM collaboration_delivery_queries WHERE outbox_id=o.id) " +
      "WHERE o.source='dingtalk' AND o.delivery_state='dead_letter' AND o.sent_at IS NULL AND o.superseded_at IS NULL " +
      "AND (q.outbox_id IS NULL OR (q.attempt<3 AND (q.outcome='unconfirmed' OR (q.outcome IS NULL AND q.expires_at<=?)) AND q.next_attempt_at<=?)) " +
      "ORDER BY COALESCE(q.next_attempt_at,o.created_at),o.id LIMIT 1").get(now, now) as unknown as Row | undefined;
    if (!candidate) { db.exec("COMMIT"); return null; }
    row = candidate;
    const last = db.prepare("SELECT COALESCE(MAX(attempt),0) AS n FROM collaboration_delivery_queries WHERE outbox_id=?").get(row.id) as { n: number };
    attempt = last.n + 1; hash = fingerprint(row);
    const backoff = Math.min(options.maxBackoffMs, options.baseBackoffMs * 2 ** (attempt - 1));
    db.prepare("INSERT INTO collaboration_delivery_queries(outbox_id,attempt,snapshot_hash,instance_owner,instance_fence,started_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(row.id, attempt, hash, instance.ownerId, instance.fence, now, now + options.claimTtlMs, now + backoff);
    if (!current(db, row)) {
      db.prepare("UPDATE collaboration_delivery_queries SET completed_at=?,outcome='superseded' WHERE outbox_id=? AND attempt=?").run(now, row.id, attempt);
      db.exec("COMMIT"); return { id: row.id, state: "superseded", attempt, operation: "reconcile" };
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const wallStarted = Date.now();
  let result: Awaited<ReturnType<Query>>;
  try {
    result = await query({ id: row.id, source: row.source, dedupeKey: row.dedupe_key, aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, kind: row.kind, payload: JSON.parse(row.payload_json) as Parameters<Query>[0]["payload"] });
  } catch { result = { outcome: "unknown", error: "delivery_query_unavailable" }; }
  const finished = now + Math.max(0, Date.now() - wallStarted);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCurrentInstanceLease(db, instance, finished); assertLedgerArmed(db);
    if (!db.prepare("SELECT 1 FROM collaboration_delivery_queries WHERE outbox_id=? AND attempt=? AND instance_owner=? AND instance_fence=? AND expires_at>? AND completed_at IS NULL " +
      "AND attempt=(SELECT MAX(attempt) FROM collaboration_delivery_queries WHERE outbox_id=?)")
      .get(row.id, attempt, instance.ownerId, instance.fence, finished, row.id)) throw new StaleFenceError("Delivery query claim expired");
    const latest = db.prepare("SELECT * FROM collaboration_outbox WHERE id=?").get(row.id) as unknown as Row | undefined;
    const unchanged = latest && fingerprint(latest) === hash && current(db, latest);
    const outcome = !unchanged ? "superseded" : result === null ? "no_receipt" : result.outcome === "sent" ? "confirmed" : "unconfirmed";
    db.prepare("UPDATE collaboration_delivery_queries SET completed_at=?,outcome=? WHERE outbox_id=? AND attempt=?").run(finished, outcome, row.id, attempt);
    if (outcome === "confirmed") {
      db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=?,last_error=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL," +
        "delivery_sequence=(SELECT COALESCE(MAX(delivery_sequence),0)+1 FROM collaboration_outbox) WHERE id=?").run(finished, row.id);
      if (row.kind === "association_choice_card" && row.aggregate_type === "association") {
        db.prepare("INSERT INTO collaboration_sent_association_choices(outbox_id,external_event_id,payload_json,sent_at) VALUES(?,?,?,?)")
          .run(row.id, row.aggregate_id, row.payload_json, finished);
      }
    }
    db.exec("COMMIT");
    return { id: row.id, state: outcome === "confirmed" ? "sent" : outcome === "superseded" ? "superseded" :
      outcome === "no_receipt" || attempt === 3 ? "dead_letter" : "retry_scheduled", attempt, operation: "reconcile" };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
