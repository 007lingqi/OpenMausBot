import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discussionOptionSchema, discussionSelectionSchema, renderAdviceDiscussion, renderDiscussionSelection, type DiscussionSelection } from "./discussion-options.ts";

const MAX_SOURCES = 24;
const MAX_CHARACTERS = 24_000;
const MAX_VISITS = 64;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const eventSchema = z.object({ source_event_id: z.string(), principal_id: z.string(), normalized_json: z.string(),
  event_order: z.number(), context_outbox_sequence: z.number().nullable(), source_hash: z.string().nullable(),
  proposal_json: z.string().nullable() });
const replySchema = z.object({ payload_json: z.string(), source_event_id: z.string(), proposal_json: z.string(),
  context_outbox_sequence: z.number(), event_order: z.number() });
const adviceSchema = z.object({ action: z.literal("offer_advice"), advice: z.object({
  summary: z.string(), question: z.string().nullable(), options: z.array(discussionOptionSchema).min(1).max(3),
  basisSourceEventIds: z.array(z.string()).min(1).max(13),
}) });
const selectionSchema = z.object({ action: z.literal("select_option"), selection: discussionSelectionSchema });
const discussionSchema = z.discriminatedUnion("action", [adviceSchema, selectionSchema]);
export interface DiscussionSource {
  sourceEventId: string;
  role: "user" | "assistant";
  principalId: string | null;
  text: string;
  contentHash: string;
  eventOrder: number;
}
interface DiscussionSources { sources: DiscussionSource[]; incomplete: boolean }

/** Follow only persisted discussion provenance, never every message in the group.
 * Raw history remains in the ledger. A bounded projection must explicitly report
 * gaps; truncation is not evidence that the requirements are complete. */
export function readDiscussionSources(db: DatabaseSync, input: {
  conversationId: string; workItemId: string; selection: DiscussionSelection; beforeEventId: string; outboxSequence: number;
}): DiscussionSources {
  const sources: DiscussionSource[] = [], visited = new Set<string>();
  let incomplete = false, characters = 0, visits = 0;
  const before = z.object({ event_order: z.number() }).parse(db.prepare("SELECT rowid AS event_order FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? AND work_item_id=?")
    .get(input.beforeEventId, input.workItemId)).event_order;
  const reserve = (key: string): boolean => {
    if (visited.has(key)) return false;
    if (++visits > MAX_VISITS) { incomplete = true; return false; }
    visited.add(key); return true;
  };
  const add = (source: DiscussionSource): void => {
    if (sources.length >= MAX_SOURCES || characters + source.text.length > MAX_CHARACTERS) { incomplete = true; return; }
    sources.push(source); characters += source.text.length;
  };
  function visitEvent(id: string, beforeOrder: number): void {
    const raw = db.prepare("SELECT e.source_event_id,e.principal_id,e.normalized_json,e.rowid AS event_order,j.context_outbox_sequence,j.source_hash,j.proposal_json " +
      "FROM collaboration_external_events e LEFT JOIN collaboration_conversation_intents j ON j.event_id=e.id AND j.status='applied' " +
      "WHERE e.source='dingtalk' AND e.source_event_id=? AND e.conversation_id=? AND e.rowid<=? " +
      "AND (COALESCE(e.work_item_id,j.target_work_item_id) IS NULL OR COALESCE(e.work_item_id,j.target_work_item_id)=?)")
      .get(id, input.conversationId, beforeOrder, input.workItemId);
    if (!raw) { incomplete = true; return; }
    const row = eventSchema.parse(raw);
    if (row.source_hash !== null && hash(row.normalized_json) !== row.source_hash) throw new Error("discussion_history_source_changed");
    if (!reserve(`user:${id}`)) return;
    add({ sourceEventId: id, role: "user", principalId: row.principal_id,
      text: z.object({ text: z.string() }).parse(JSON.parse(row.normalized_json)).text, contentHash: hash(row.normalized_json), eventOrder: row.event_order });
    if (!row.proposal_json) return;
    const proposal = discussionSchema.safeParse(JSON.parse(row.proposal_json));
    if (!proposal.success) return;
    if (proposal.data.action === "select_option") {
      visitReply(proposal.data.selection.presentation.sourceEventId, row.context_outbox_sequence ?? 0,
        proposal.data.selection.presentation.presentationHash, row.event_order);
    } else for (const source of proposal.data.advice.basisSourceEventIds) {
      if (source === id) continue;
      if (source.startsWith("outbox:")) visitReply(source, row.context_outbox_sequence ?? 0, undefined, row.event_order);
      else visitEvent(source, row.event_order);
    }
  }
  function visitReply(id: string, sequence: number, expectedHash: string | undefined, beforeOrder: number): void {
    const raw = db.prepare("SELECT o.payload_json,e.source_event_id,j.proposal_json,j.context_outbox_sequence,e.rowid AS event_order " +
      "FROM collaboration_outbox o JOIN collaboration_external_events e ON o.aggregate_type='association' AND e.id=o.aggregate_id " +
      "JOIN collaboration_conversation_intents j ON j.event_id=e.id AND j.status='applied' " +
      "WHERE 'outbox:'||o.id=? AND o.delivery_state='sent' AND o.sent_at IS NOT NULL AND o.delivery_sequence<=? " +
      "AND e.conversation_id=? AND e.rowid<=? AND (j.target_work_item_id IS NULL OR j.target_work_item_id=?)")
      .get(id, sequence, input.conversationId, beforeOrder, input.workItemId);
    if (!raw) { incomplete = true; return; }
    const row = replySchema.parse(raw);
    if (expectedHash && hash(row.payload_json) !== expectedHash) throw new Error("discussion_history_presentation_changed");
    const proposal = discussionSchema.safeParse(JSON.parse(row.proposal_json));
    if (!proposal.success) { incomplete = true; return; }
    const expected = proposal.data.action === "offer_advice" ? renderAdviceDiscussion(proposal.data.advice) : renderDiscussionSelection(proposal.data.selection);
    const card = z.object({ type: z.literal("command_status_card"), command: z.literal("conversation"), summary: z.string() }).parse(JSON.parse(row.payload_json));
    if (card.summary !== expected) throw new Error("discussion_history_presentation_changed");
    if (!reserve(`assistant:${id}`)) return;
    // Do not pass unselected option descriptions as extra acceptance sources.
    add({ sourceEventId: id, role: "assistant", principalId: null,
      text: proposal.data.action === "offer_advice" ? proposal.data.advice.summary : expected,
      contentHash: hash(row.payload_json + "\0" + row.proposal_json), eventOrder: row.event_order });
    visitEvent(row.source_event_id, beforeOrder);
  }
  visitReply(input.selection.presentation.sourceEventId, input.outboxSequence, input.selection.presentation.presentationHash, before);
  return { sources: sources.sort((a, b) => a.eventOrder - b.eventOrder || Number(a.role === "assistant") - Number(b.role === "assistant")), incomplete };
}
