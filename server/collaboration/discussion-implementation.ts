import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discussionSelectionSchema } from "./discussion-options.ts";
import { readDiscussionSources, type DiscussionSource } from "./discussion-sources.ts";
import { turnSourceOrigin } from "./turn-sources.ts";

const receiptSchema = z.object({ sourceEventId: z.string(), quote: z.string(),
  action: z.enum(["create_work", "contribute"]), implementationSelection: discussionSelectionSchema });
const rowSchema = z.object({ proposal_json: z.string(), normalized_json: z.string(), source_hash: z.string(),
  principal_id: z.string(), conversation_id: z.string(), context_outbox_sequence: z.number() });
const presentationSchema = z.object({ payload_json: z.string() });
export interface DiscussionImplementationContext {
  requestSourceEventId: string;
  requestQuote: string;
  selection: z.infer<typeof discussionSelectionSchema>;
  discussionSources?: DiscussionSource[];
  discussionContextIncomplete?: boolean;
}
export const implementationContextHash = (context: DiscussionImplementationContext | null): string =>
  createHash("sha256").update(JSON.stringify(context)).digest("hex");

/** Re-read the routed, source-bound request and the actual delivered presentation.
 * This carries requirements only: it cannot grant execution or Owner authority. */
export function readDiscussionImplementation(db: DatabaseSync, workItemId: string, sourceEventId: string): DiscussionImplementationContext | null {
  const origin = turnSourceOrigin(db, sourceEventId);
  const raw = origin !== sourceEventId ? db.prepare("SELECT p.decision_json AS proposal_json,e.raw_hash AS source_hash,j.context_outbox_sequence,e.normalized_json,e.principal_id,e.conversation_id " +
    "FROM collaboration_turn_parts p JOIN collaboration_external_events e ON e.id=p.child_event_id " +
    "JOIN collaboration_conversation_intents j ON j.event_id=p.parent_event_id " +
    "WHERE e.source='dingtalk' AND e.source_event_id=? AND e.work_item_id=? AND p.target_work_item_id=e.work_item_id " +
    "AND j.source_hash=p.source_hash AND j.status IN ('routed','applied','failed') AND p.status IN ('routed','applied') " +
    "AND json_type(p.decision_json,'$.implementationSelection') IS NOT NULL").get(sourceEventId, workItemId)
    : db.prepare("SELECT j.proposal_json,j.source_hash,j.context_outbox_sequence,e.normalized_json,e.principal_id,e.conversation_id " +
    "FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id " +
    "WHERE e.source='dingtalk' AND e.source_event_id=? AND e.work_item_id=? AND j.target_work_item_id=? " +
    "AND j.status IN ('routed','applied') AND json_type(j.proposal_json,'$.implementationSelection') IS NOT NULL")
    .get(sourceEventId, workItemId, workItemId);
  if (!raw) return null;
  const row = rowSchema.parse(raw);
  const receipt = receiptSchema.parse(JSON.parse(row.proposal_json));
  const selection = receipt.implementationSelection;
  const event = z.object({ text: z.string() }).parse(JSON.parse(row.normalized_json));
  if (receipt.sourceEventId !== origin || !receipt.quote.trim() || !event.text.includes(receipt.quote) ||
    createHash("sha256").update(row.normalized_json).digest("hex") !== row.source_hash ||
    JSON.stringify(selection.option) !== JSON.stringify(selection.presentation.options[selection.optionIndex - 1])) {
    throw new Error("discussion_implementation_source_invalid");
  }
  const presented = db.prepare("SELECT o.payload_json FROM collaboration_outbox o " +
    "JOIN collaboration_external_events e ON o.aggregate_type='association' AND e.id=o.aggregate_id " +
    "WHERE 'outbox:'||o.id=? AND o.delivery_state='sent' AND o.sent_at IS NOT NULL AND o.delivery_sequence<=? " +
    "AND e.conversation_id=? AND e.principal_id=?")
    .get(selection.presentation.sourceEventId, row.context_outbox_sequence, row.conversation_id, row.principal_id);
  if (!presented || createHash("sha256").update(presentationSchema.parse(presented).payload_json).digest("hex") !== selection.presentation.presentationHash) {
    throw new Error("discussion_implementation_presentation_changed");
  }
  const discussion = readDiscussionSources(db, { conversationId: row.conversation_id, workItemId, selection,
    beforeEventId: sourceEventId, outboxSequence: row.context_outbox_sequence });
  return { requestSourceEventId: sourceEventId, requestQuote: receipt.quote, selection,
    discussionSources: discussion.sources, discussionContextIncomplete: discussion.incomplete };
}
