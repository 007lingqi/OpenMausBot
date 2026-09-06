import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkOwnerTextCommand, DingTalkOwnerTextCommandOutcome } from "../integrations/dingtalk/types.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

export function isOwnerQueryEvent(db: DatabaseSync, sourceEventId: string): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=? AND json_extract(outcome_json,'$.kind')='owner_query'").get(sourceEventId);
}

/** Atomically preserve the original query result and reply; replay never re-runs an approval refresh. */
export function recordOwnerQuery(db: DatabaseSync, command: DingTalkOwnerTextCommand, now: number,
  assertActive: () => void, perform: () => DingTalkOwnerTextCommandOutcome): DingTalkOwnerTextCommandOutcome {
  if (command.command !== "status" && command.command !== "refresh_approval") throw new Error("owner_query_command_invalid");
  if (!command.transportEventId.trim() || command.transportEventId.length > 256 ||
      (command.conversationId !== undefined && (!command.conversationId.trim() || command.conversationId.length > 512 || /[\u0000-\u001f\u007f]/u.test(command.conversationId)))) {
    throw new Error("owner_query_origin_invalid");
  }
  const payloadHash = createHash("sha256").update(JSON.stringify({ kind: "owner_query", command: command.command,
    conversation: command.conversationId ?? null, workItemId: command.workItemId, reason: command.reason ?? null,
    corp: command.sender.senderCorpId ?? null, staff: command.sender.senderStaffId ?? null, sender: command.sender.senderId })).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive(); assertLedgerArmed(db);
    const previous = db.prepare("SELECT payload_hash,outcome_json FROM collaboration_owner_text_commands WHERE source_event_id=?")
      .get(command.transportEventId) as { payload_hash: string; outcome_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new Error("owner_query_event_conflict");
      const saved = JSON.parse(previous.outcome_json) as { outcome: DingTalkOwnerTextCommandOutcome };
      db.exec("COMMIT"); return { ...saved.outcome, duplicate: true };
    }
    if (db.prepare("SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_attachment_recovery_requests WHERE source_event_id=? UNION ALL SELECT 1 FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?")
      .get(command.transportEventId, command.transportEventId, command.transportEventId)) throw new Error("owner_query_event_conflict");
    if (db.prepare("SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=?").get(command.transportEventId)) {
      // Legacy replies lack an immutable outcome/request binding. Do not guess success or backfill authority.
      db.exec("COMMIT");
      return { allowed: false, duplicate: true, command: command.command, workItemId: command.workItemId, reason: "owner_query_legacy_outcome_unavailable" };
    }
    const outcome = perform();
    assertActive();
    db.prepare("INSERT INTO collaboration_owner_text_commands(source_event_id,payload_hash,outcome_json,processed_at) VALUES(?,?,?,?)")
      .run(command.transportEventId, payloadHash, JSON.stringify({ kind: "owner_query", conversationId: command.conversationId, outcome }), now);
    db.exec("COMMIT"); return outcome;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
