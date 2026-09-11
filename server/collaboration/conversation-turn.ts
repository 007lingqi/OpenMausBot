import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ConversationIntentRequest, ConversationTurnDecision } from "./conversation-intent.ts";
import { conversationTurnReply, type ConversationJob } from "./conversation-context.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { turnSourceOrigin } from "./turn-sources.ts";

/** Caller owns the parent claim and transaction. Validate every referenced
 * version before any write; no network or control operation occurs here. */
export function routeConversationTurn(db: DatabaseSync, job: ConversationJob, request: ConversationIntentRequest,
  turn: ConversationTurnDecision, now: number): string {
  for (const { decision } of turn.parts) if (decision.target) {
    const row = z.object({ version: z.number(), status: z.string() }).parse(db.prepare("SELECT version,status FROM collaboration_work_items WHERE id=? AND conversation_id=?")
      .get(decision.target.id, job.conversation_id));
    if (row.version !== decision.target.version || (readLatestWorkItemSnapshot(db, decision.target.id)?.revision ?? 0) !== decision.target.snapshotRevision ||
      decision.action === "contribute" && ["cancelled", "accepted"].includes(row.status)) throw new Error("conversation_turn_target_stale");
  }
  for (const [ordinal, part] of turn.parts.entries()) {
    const decision = part.decision, modifies = ["create_work", "contribute"].includes(decision.action);
    let target = decision.target?.id ?? null, childId: string | null = null;
    if (modifies) {
      if (!target) {
        target = `WI-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
        db.prepare("INSERT INTO collaboration_work_items (id,conversation_id,title,status,version,created_by,created_at,updated_at) VALUES (?,?,?,'collecting',1,?,?,?)")
          .run(target, job.conversation_id, part.text.replace(/\s+/gu, " ").slice(0, 120), job.principal_id, now, now);
      } else db.prepare("UPDATE collaboration_work_items SET version=version+1,updated_at=? WHERE id=?").run(now, target);
      childId = randomUUID();
      const sourceEventId = `turn:${createHash("sha256").update(job.source_event_id).digest("hex")}:${ordinal}`;
      const original = z.object({ text: z.string() }).passthrough().parse(JSON.parse(job.normalized_json));
      const normalized = JSON.stringify({ ...original, text: part.text, sourceEventId, attachments: [],
        turnOrigin: { sourceEventId: job.source_event_id, ordinal, sourceHash: job.source_hash } });
      db.prepare("INSERT INTO collaboration_external_events (id,source,source_event_id,transport_message_id,conversation_id,principal_id,kind,normalized_json,raw_hash,association_state,work_item_id,received_at) " +
        "VALUES (?,'dingtalk',?,?,?,?,'message',?,?,?,?,?)").run(childId, sourceEventId, sourceEventId, job.conversation_id, job.principal_id,
      normalized, createHash("sha256").update(normalized).digest("hex"), decision.action === "create_work" ? "created" : "associated", target, now);
      db.prepare("INSERT INTO collaboration_work_item_events (id,work_item_id,external_event_id,event_type,payload_json,principal_id,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), target, childId, decision.action === "create_work" ? "problem.reported" : "contribution.added",
          JSON.stringify({ text: part.text, parentSourceEventId: job.source_event_id, ordinal }), job.principal_id, now);
    }
    db.prepare("INSERT INTO collaboration_turn_parts (parent_event_id,ordinal,source_hash,part_text,decision_json,reply_text,child_event_id,target_work_item_id,status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(job.id, ordinal, job.source_hash, part.text, JSON.stringify(decision), conversationTurnReply(db, { ...turn, parts: [part] }, request), childId, target, modifies ? "routed" : "applied");
  }
  return conversationTurnReply(db, turn, request);
}

export function projectConversationTurn(db: DatabaseSync, job: ConversationJob, now: number,
  project: (workItemId: string, sourceEventId: string, now: number) => void): void {
  if (db.prepare("SELECT 1 FROM collaboration_turn_parts WHERE parent_event_id=? AND status='failed'").get(job.id)) throw new Error("conversation_turn_projection_exhausted");
  const rows = z.array(z.object({ ordinal: z.number(), target_work_item_id: z.string(), source_event_id: z.string() })).parse(db.prepare(
    "SELECT p.ordinal,p.target_work_item_id,e.source_event_id FROM collaboration_turn_parts p JOIN collaboration_external_events e ON e.id=p.child_event_id " +
    "WHERE p.parent_event_id=? AND p.status='routed' ORDER BY p.ordinal").all(job.id));
  for (const row of rows) {
    turnSourceOrigin(db, row.source_event_id);
    const claimed = db.prepare("UPDATE collaboration_turn_parts SET attempts=attempts+1 WHERE parent_event_id=? AND ordinal=? AND status='routed' AND attempts<3").run(job.id, row.ordinal);
    if (!claimed.changes) {
      db.prepare("UPDATE collaboration_turn_parts SET status='failed' WHERE parent_event_id=? AND ordinal=? AND status='routed' AND attempts>=3").run(job.id, row.ordinal);
      throw new Error("conversation_turn_projection_exhausted");
    }
    project(row.target_work_item_id, row.source_event_id, now);
    db.prepare("UPDATE collaboration_turn_parts SET status='applied' WHERE parent_event_id=? AND ordinal=? AND status='routed'").run(job.id, row.ordinal);
  }
}
