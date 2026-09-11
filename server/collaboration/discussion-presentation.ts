import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discussionOptionSchema, discussionSelectionSchema, renderAdviceDiscussion, renderDiscussionSelection } from "./discussion-options.ts";
import { DINGTALK_CONVERSATION_TEXT_LIMIT } from "../integrations/dingtalk/session-message.ts";

const target = z.object({ id: z.string(), title: z.string(), version: z.number(), snapshotRevision: z.number(),
  state: z.enum(["open", "completed", "cancelled"]) }).nullable().optional();
export const discussionDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("offer_advice"), target, advice: z.object({ summary: z.string(), question: z.string().nullable(),
    options: z.array(discussionOptionSchema).min(1).max(3), basisSourceEventIds: z.array(z.string()).min(1).max(13) }) }),
  z.object({ action: z.literal("select_option"), target, selection: discussionSelectionSchema }),
]);
export const discussionTurnSchema = z.object({ action: z.literal("route_turn"), parts: z.array(z.object({
  text: z.string(), decision: z.record(z.string(), z.unknown()),
})).min(2).max(4) });

/** One unambiguous scheme presentation per platform reply. A part is not a
 * second platform message. Validate its immutable binding and actual visibility
 * before allowing it to become conversational choice evidence. */
export function readDiscussionPresentation(db: DatabaseSync, outboxId: string, payloadJson: string, proposalJson: string) {
  const card = z.object({ type: z.literal("command_status_card"), command: z.literal("conversation"), summary: z.string() }).safeParse(JSON.parse(payloadJson));
  if (!card.success || card.data.summary.trim().length > DINGTALK_CONVERSATION_TEXT_LIMIT) return null;
  const raw = JSON.parse(proposalJson), turn = discussionTurnSchema.safeParse(raw);
  let partIndex: number | null = null, parsed = discussionDecisionSchema.safeParse(raw);
  if (turn.success) {
    const matches = turn.data.parts.flatMap((part, index) => {
      const decision = discussionDecisionSchema.safeParse(part.decision);
      return decision.success ? [{ decision: decision.data, index }] : [];
    });
    if (matches.length !== 1) return null;
    partIndex = matches[0].index; parsed = discussionDecisionSchema.safeParse(matches[0].decision);
    const rows = z.array(z.object({ ordinal: z.number(), decision_json: z.string(), reply_text: z.string() })).parse(db.prepare(
      "SELECT p.ordinal,p.decision_json,p.reply_text FROM collaboration_turn_parts p JOIN collaboration_outbox o ON o.aggregate_id=p.parent_event_id " +
      "WHERE o.id=? AND o.aggregate_type='association' ORDER BY p.ordinal").all(outboxId));
    if (rows.length !== turn.data.parts.length || rows.some((row, i) => row.ordinal !== i || row.decision_json !== JSON.stringify(turn.data.parts[i].decision))) return null;
    if (!parsed.success) return null;
    const expected = parsed.data.action === "offer_advice" ? renderAdviceDiscussion(parsed.data.advice) : renderDiscussionSelection(parsed.data.selection);
    if (rows[partIndex].reply_text !== expected || !card.data.summary.includes(expected)) return null;
  }
  if (!parsed.success) return null;
  const decision = parsed.data;
  const text = decision.action === "offer_advice" ? renderAdviceDiscussion(decision.advice) : renderDiscussionSelection(decision.selection);
  if (partIndex === null && card.data.summary !== text) return null;
  return { decision, text, partIndex };
}
