import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { NaturalIntakeProposal, NaturalIntakeRequest } from "./natural-intake.ts";
import type { WorkItemSnapshot } from "./snapshot.ts";

export const isBusinessQuestion = (id: string): boolean => id.startsWith("natural-") &&
  !["natural-input-pending", "natural-context-incomplete"].includes(id);

const transitionSchema = z.object({ questionId: z.string(), status: z.enum(["open", "partial", "resolved", "superseded"]),
  question: z.string(), sourceEventId: z.string().nullable(), principalId: z.string().nullable(), quote: z.string().nullable(),
  replacementQuestionId: z.string().nullable() }).strict();
const rowSchema = z.object({ value: z.string(), source_event_id: z.string(), proposal_json: z.string(),
  principal_id: z.string(), normalized_json: z.string() });
const evidenceSchema = z.object({ eventEvidence: z.object({ normalizedHash: z.string() }) });
export type QuestionTransition = z.infer<typeof transitionSchema>;
export interface QuestionHistory { entries: QuestionTransition[]; truncated: boolean }

/** A projection of immutable applied receipts, not a second mutable source of truth.
 * Existing snapshots without lifecycle receipts remain open with unknown provenance.
 * Only recently closed gaps enter model context; explicit ID lookup is unbounded by
 * that presentation limit so an old resolved ID cannot be silently reused. */
export function readQuestionHistory(db: DatabaseSync, snapshot: Pick<WorkItemSnapshot, "workItemId" | "revision" | "blockingAmbiguities">,
  onlyIds?: string[]): QuestionHistory {
  const active = new Map(snapshot.blockingAmbiguities.filter(q => isBusinessQuestion(q.id)).map(q => [q.id, q]));
  const entries = new Map<string, QuestionTransition>();
  let closed = 0, truncated = false;
  const ids = onlyIds ? JSON.stringify(onlyIds) : null;
  const rows = db.prepare(`WITH history AS (
    SELECT t.value, j.source_event_id, j.proposal_json, e.principal_id, e.normalized_json,
      row_number() OVER (PARTITION BY json_extract(t.value,'$.questionId') ORDER BY j.result_revision DESC) AS position,
      j.result_revision
    FROM collaboration_natural_all_jobs j
    JOIN collaboration_external_events e ON e.source='dingtalk' AND e.source_event_id=j.source_event_id AND e.work_item_id=j.work_item_id
    JOIN json_each(j.proposal_json,'$.questionTransitions') t
    WHERE j.work_item_id=? AND j.status='applied' AND j.result_revision<=?
      AND (? IS NULL OR json_extract(t.value,'$.questionId') IN (SELECT value FROM json_each(?)))
  ) SELECT * FROM history WHERE position=1 ORDER BY result_revision DESC`).iterate(snapshot.workItemId, snapshot.revision, ids, ids);
  for (const raw of rows) {
    const row = rowSchema.parse(raw);
    const transition = transitionSchema.parse(JSON.parse(row.value));
    const receipt = evidenceSchema.parse(JSON.parse(row.proposal_json));
    if (transition.sourceEventId !== row.source_event_id || transition.principalId !== row.principal_id ||
      receipt.eventEvidence?.normalizedHash !== createHash("sha256").update(row.normalized_json).digest("hex")) {
      throw new Error("natural_question_history_source_invalid");
    }
    const current = active.get(transition.questionId);
    if (current) entries.set(current.id, { ...transition, question: current.question,
      status: transition.status === "partial" ? "partial" : "open", replacementQuestionId: null });
    else if (["resolved", "superseded"].includes(transition.status)) {
      if (!onlyIds && closed++ >= 25) { truncated = true; continue; }
      entries.set(transition.questionId, transition);
    }
  }
  for (const [id, q] of active) if (!entries.has(id) && (!onlyIds || onlyIds.includes(id))) entries.set(id, {
    questionId: id, status: "open", question: q.question, sourceEventId: null, principalId: null, quote: null, replacementQuestionId: null,
  });
  return { entries: [...entries.values()], truncated };
}

/** Called only after proposal validation. Persist in the same transaction and
 * receipt as the resulting Spec; stale/failed/replayed proposals create no history. */
export function questionTransitions(request: NaturalIntakeRequest, proposal: NaturalIntakeProposal): QuestionTransition[] {
  const changes = new Map<string, QuestionTransition>();
  const transition = (id: string, status: QuestionTransition["status"], question: string, quote: string | null,
    replacementQuestionId: string | null = null): QuestionTransition => ({ questionId: id, status, question, quote,
      sourceEventId: request.event.sourceEventId, principalId: request.event.principalId, replacementQuestionId });
  for (const question of proposal.questions) {
    const id = `natural-${question.id}`;
    const prior = request.questionHistory?.entries.find(q => q.questionId === id);
    // A wording update is not a new answer. Do not attach an earlier speaker's
    // quote to the current event; the earlier immutable transition retains it.
    changes.set(id, transition(id, prior?.status === "partial" ? "partial" : "open", question.question, null));
  }
  for (const answer of proposal.answers) changes.set(answer.questionId, transition(answer.questionId, "resolved",
    request.snapshot.blockingAmbiguities.find(q => q.id === answer.questionId)!.question, answer.quote));
  for (const update of proposal.questionUpdates ?? []) changes.set(update.questionId, transition(update.questionId, update.status,
    changes.get(update.questionId)?.question ?? request.snapshot.blockingAmbiguities.find(q => q.id === update.questionId)!.question,
    update.quote, update.replacementQuestionId));
  return [...changes.values()];
}
