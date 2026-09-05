import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { enqueueInboundCard } from "./outbox.ts";
import { renderPrimaryStatusCard } from "./message-renderer.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

const choiceCard = z.object({ type: z.literal("association_choice_card"),
  candidateWorkItems: z.array(z.object({ id: z.string().min(1), title: z.string().trim().min(1) })).min(1).max(3) });
const ordinal = /^(?:(?:就)?选(?:择)?|是)?第?([一二三123])(?:个|项)(?:[，,。.!！\s]|$)/u;
const ordinalLike = /^(?:(?:就)?选(?:择)?|是)?(?:第[一二三四五六七八九十\d]+(?:个|项)|[123](?:个|项)|前一个|后一个|上一个|下一个)/u;
interface ChoiceEvent { id: string; source_event_id: string; conversation_id: string; principal_id: string;
  normalized_json: string; received_at: number }

/** An ordinal is a selection only within one unresolved, actually delivered same-person question. */
export function routeDisplayedChoice(database: DatabaseSync, event: ChoiceEvent, claimToken: string, now: number): "routed" | "clarify" | null {
  const text = String(JSON.parse(event.normalized_json).text).trim();
  if (!ordinalLike.test(text)) return null;
  const match = ordinal.exec(text);
  if (!match) return "clarify";
  const index = { 一: 0, 二: 1, 三: 2, "1": 0, "2": 1, "3": 2 }[match[1]];
  if (index === undefined) return "clarify";
  database.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(database);
    const current = database.prepare("SELECT 1 FROM collaboration_natural_association_jobs j JOIN collaboration_external_events e ON e.id=j.event_id " +
      "WHERE j.event_id=? AND j.status='running' AND j.claim_token=? AND j.lease_until>? AND e.work_item_id IS NULL AND e.association_state='ambiguous'")
      .get(event.id, claimToken, now);
    if (!current) throw new Error("choice_claim_stale");
    const prompts = database.prepare("SELECT s.outbox_id,s.payload_json,s.sent_at,e.* FROM collaboration_sent_association_choices s " +
      "JOIN collaboration_external_events e ON e.id=s.external_event_id " +
      "WHERE e.conversation_id=? AND e.principal_id=? AND e.work_item_id IS NULL AND e.association_state='ambiguous' " +
      "AND e.id<>? AND s.sent_at<=? AND s.sent_at>=? ORDER BY s.sent_at DESC LIMIT 2")
      .all(event.conversation_id, event.principal_id, event.id, event.received_at, event.received_at - 30 * 60_000) as unknown as Array<ChoiceEvent & { outbox_id: string; payload_json: string; sent_at: number }>;
    if (prompts.length !== 1) { database.exec("COMMIT"); return "clarify"; }
    const prompt = prompts[0];
    // Another delivered question can change what "second" refers to. Use durable delivery order,
    // since multiple messages can be acknowledged in the same clock millisecond.
    const intervening = database.prepare("SELECT 1 FROM collaboration_outbox o " +
      "LEFT JOIN collaboration_work_items w ON w.id=o.aggregate_id AND o.aggregate_type IN ('work_item','plan') " +
      "LEFT JOIN collaboration_external_events e ON e.id=o.aggregate_id AND o.aggregate_type='association' " +
      "WHERE COALESCE(w.conversation_id,e.conversation_id)=? AND o.kind IN ('association_choice_card','clarification_card') " +
      "AND o.delivery_sequence>(SELECT delivery_sequence FROM collaboration_outbox WHERE id=?) " +
      "AND o.sent_at<=? AND o.source_event_id<>? LIMIT 1")
      .get(event.conversation_id, prompt.outbox_id, event.received_at, event.source_event_id);
    if (intervening) { database.exec("COMMIT"); return "clarify"; }
    const parsed = choiceCard.safeParse(JSON.parse(prompt.payload_json));
    const selected = parsed.success ? parsed.data.candidateWorkItems[index] : undefined;
    if (!selected) { database.exec("COMMIT"); return "clarify"; }
    const target = database.prepare("SELECT w.version FROM collaboration_work_items w JOIN collaboration_association_options a ON a.work_item_id=w.id " +
      "WHERE w.id=? AND w.conversation_id=? AND w.status NOT IN ('cancelled','accepted') AND a.external_event_id=?")
      .get(selected.id, event.conversation_id, prompt.id) as { version: number } | undefined;
    if (!target) { database.exec("COMMIT"); return "clarify"; }
    database.prepare("UPDATE collaboration_work_items SET version=version+2,updated_at=? WHERE id=?").run(now, selected.id);
    const proof = { outboxId: prompt.outbox_id, sourceEventId: prompt.source_event_id, selectionEventId: event.source_event_id, index: index + 1 };
    for (const source of [prompt, event]) {
      database.prepare("UPDATE collaboration_external_events SET association_state='associated',work_item_id=? WHERE id=?").run(selected.id, source.id);
      database.prepare("INSERT INTO collaboration_work_item_events (id,work_item_id,external_event_id,event_type,payload_json,principal_id,created_at) VALUES (?,?,?,'contribution.added',?,?,?)")
        .run(randomUUID(), selected.id, source.id, JSON.stringify({ text: String(JSON.parse(source.normalized_json).text), displayedChoice: proof }), source.principal_id, now);
      database.prepare("INSERT INTO collaboration_natural_association_jobs (event_id,status,proposal_json) VALUES (?,'routed',?) " +
        "ON CONFLICT(event_id) DO UPDATE SET status='routed',proposal_json=excluded.proposal_json,claim_token=NULL,lease_until=NULL")
        .run(source.id, JSON.stringify({ decision: "associate", workItemId: selected.id, displayedChoice: proof }));
      database.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE source_event_id=? AND delivery_state='pending'").run(now, source.source_event_id);
    }
    enqueueInboundCard(database, { sourceEventId: `association:${event.source_event_id}`, aggregateType: "plan", aggregateId: selected.id,
      aggregateVersion: target.version + 2, now, card: renderPrimaryStatusCard({ workItemId: selected.id, status: "collecting", version: target.version + 2, association: "associated" }) });
    database.exec("COMMIT");
    return "routed";
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
