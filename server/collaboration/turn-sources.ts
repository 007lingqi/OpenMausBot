import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const binding = z.object({ source_hash: z.string(), part_text: z.string(), normalized_json: z.string(),
  child_json: z.string(), source_event_id: z.string(), child_source_event_id: z.string(), ordinal: z.number() });

/** Internal per-task projections retain a single real platform origin. They are
 * never re-ingested as platform messages or parsed as Owner controls. */
export function turnSourceOrigin(db: DatabaseSync, sourceEventId: string): string {
  const row = db.prepare("SELECT p.source_hash,p.part_text,p.ordinal,e.normalized_json,e.source_event_id,c.normalized_json AS child_json,c.source_event_id AS child_source_event_id " +
    "FROM collaboration_turn_parts p JOIN collaboration_external_events e ON e.id=p.parent_event_id " +
    "JOIN collaboration_external_events c ON c.id=p.child_event_id WHERE c.source_event_id=? AND c.source='dingtalk'").get(sourceEventId);
  if (!row) return sourceEventId;
  const value = binding.parse(row);
  const parent = z.object({ text: z.string() }).parse(JSON.parse(value.normalized_json));
  const child = z.object({ text: z.string(), turnOrigin: z.object({ sourceEventId: z.string(), ordinal: z.number(), sourceHash: z.string() }).strict() }).parse(JSON.parse(value.child_json));
  if (hash(value.normalized_json) !== value.source_hash || !parent.text.includes(value.part_text) || child.text !== value.part_text ||
    child.turnOrigin.sourceEventId !== value.source_event_id || child.turnOrigin.sourceHash !== value.source_hash || child.turnOrigin.ordinal !== value.ordinal) {
    throw new Error("conversation_turn_source_invalid");
  }
  return value.source_event_id;
}

export function applyTurnPartsMigration(db: DatabaseSync): void {
  db.exec(`CREATE TABLE collaboration_turn_parts (
    parent_event_id TEXT NOT NULL REFERENCES collaboration_external_events(id),
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3),
    source_hash TEXT NOT NULL CHECK(length(source_hash)=64), part_text TEXT NOT NULL,
    decision_json TEXT NOT NULL CHECK(json_valid(decision_json)), reply_text TEXT NOT NULL,
    child_event_id TEXT UNIQUE REFERENCES collaboration_external_events(id),
    target_work_item_id TEXT REFERENCES collaboration_work_items(id),
    status TEXT NOT NULL CHECK(status IN ('routed','applied','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
    PRIMARY KEY(parent_event_id,ordinal)
  ) STRICT;
  CREATE TRIGGER turn_part_source BEFORE INSERT ON collaboration_turn_parts
    WHEN NOT EXISTS(SELECT 1 FROM collaboration_external_events e JOIN collaboration_conversation_intents j ON j.event_id=e.id
      WHERE e.id=NEW.parent_event_id AND e.source='dingtalk' AND j.status='running' AND j.source_hash=NEW.source_hash
        AND instr(json_extract(e.normalized_json,'$.text'),NEW.part_text)>0
        AND NOT EXISTS(SELECT 1 FROM collaboration_turn_parts nested WHERE nested.child_event_id=e.id)
        AND (NEW.child_event_id IS NULL OR EXISTS(SELECT 1 FROM collaboration_external_events c WHERE c.id=NEW.child_event_id
          AND c.conversation_id=e.conversation_id AND c.principal_id=e.principal_id AND c.work_item_id=NEW.target_work_item_id
          AND json_extract(c.normalized_json,'$.text')=NEW.part_text
          AND json_extract(c.normalized_json,'$.turnOrigin.sourceEventId')=e.source_event_id
          AND json_extract(c.normalized_json,'$.turnOrigin.sourceHash')=NEW.source_hash
          AND json_extract(c.normalized_json,'$.turnOrigin.ordinal')=NEW.ordinal)))
    BEGIN SELECT RAISE(ABORT,'conversation turn source mismatch'); END;
  CREATE TRIGGER turn_part_binding BEFORE UPDATE ON collaboration_turn_parts
    WHEN OLD.status IN ('applied','failed') OR NEW.parent_event_id<>OLD.parent_event_id OR NEW.ordinal<>OLD.ordinal
      OR NEW.source_hash<>OLD.source_hash OR NEW.part_text<>OLD.part_text OR NEW.decision_json<>OLD.decision_json OR NEW.reply_text<>OLD.reply_text
      OR NEW.child_event_id IS NOT OLD.child_event_id OR NEW.target_work_item_id IS NOT OLD.target_work_item_id OR NEW.attempts<OLD.attempts
    BEGIN SELECT RAISE(ABORT,'conversation turn binding is immutable'); END;
  CREATE TRIGGER turn_part_no_delete BEFORE DELETE ON collaboration_turn_parts
    BEGIN SELECT RAISE(ABORT,'conversation turn history is immutable'); END;`);
}
