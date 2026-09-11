import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { NaturalIntakeRequest, NaturalIntakeProposal } from "./natural-intake.ts";
import type { BlockingAmbiguity } from "./snapshot.ts";

export const factProposalSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(500),
  kind: z.enum(["requirement", "assumption"]), quote: z.string().min(1).max(2000) }).strict();
export type FactProposal = z.infer<typeof factProposalSchema>;
const recordSchema = factProposalSchema.extend({ id: z.string(), sourceEventId: z.string(), principalId: z.string(), revision: z.number().int().positive() }).strict();
export type RecordedFact = z.infer<typeof recordSchema>;
export interface FactHistory { entries: RecordedFact[]; truncated: boolean }
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const factId = (sourceEventId: string, fact: FactProposal): string => hash(JSON.stringify([sourceEventId, fact.key, fact.kind, fact.value]));
const rowSchema = z.object({ value: z.string(), source_event_id: z.string(), principal_id: z.string(),
  normalized_json: z.string(), proposal_json: z.string(), result_revision: z.number() });

/** Reconstruct source-bound observations from immutable Spec receipts. This is a
 * read projection, not a competing mutable authority or a vote/approval system. */
export function readFactHistory(db: DatabaseSync, workItemId: string, revision: number): FactHistory {
  const entries: RecordedFact[] = [], seen = new Set<string>();
  let characters = 0, truncated = false;
  const rows = db.prepare("SELECT f.value,j.source_event_id,e.principal_id,e.normalized_json,j.proposal_json,j.result_revision " +
    "FROM collaboration_natural_all_jobs j JOIN collaboration_external_events e ON e.source='dingtalk' AND e.source_event_id=j.source_event_id AND e.work_item_id=j.work_item_id " +
    "JOIN json_each(j.proposal_json,'$.factRecords') f WHERE j.work_item_id=? AND j.status='applied' AND j.result_revision<=? ORDER BY j.result_revision DESC")
    .iterate(workItemId, revision);
  for (const raw of rows) {
    const row = rowSchema.parse(raw), fact = recordSchema.parse(JSON.parse(row.value));
    const evidence = z.object({ eventEvidence: z.object({ normalizedHash: z.string() }) }).parse(JSON.parse(row.proposal_json));
    const event = z.object({ text: z.string() }).parse(JSON.parse(row.normalized_json));
    if (fact.id !== factId(row.source_event_id, fact) || fact.sourceEventId !== row.source_event_id || fact.principalId !== row.principal_id ||
      fact.revision !== row.result_revision || evidence.eventEvidence.normalizedHash !== hash(row.normalized_json) || !event.text.includes(fact.quote)) {
      throw new Error("natural_fact_source_invalid");
    }
    const key = JSON.stringify([fact.key, fact.kind, fact.value, fact.principalId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const size = JSON.stringify(fact).length;
    if (entries.length >= 50 || characters + size > 12000) { truncated = true; continue; }
    characters += size; entries.push(fact);
  }
  return { entries: entries.reverse(), truncated };
}

export function recordFacts(request: NaturalIntakeRequest, facts: FactProposal[]): RecordedFact[] {
  return facts.map(fact => ({ ...fact, id: factId(request.event.sourceEventId, fact),
    sourceEventId: request.event.sourceEventId, principalId: request.event.principalId, revision: request.snapshot.revision + 1 }));
}

/** Conflicts and assumptions are program-owned readiness gates. The model can
 * report observations, but cannot erase a participant or clear these via answers. */
interface FactGate extends BlockingAmbiguity { replacesQuestionId?: string }
export function factGates(request: NaturalIntakeRequest, facts: FactProposal[], questions: NaturalIntakeProposal["questions"] = []): FactGate[] {
  const entries = [...(request.factHistory?.entries ?? []), ...recordFacts(request, facts)];
  const groups = new Map<string, RecordedFact[]>();
  for (const fact of entries) groups.set(fact.key, [...(groups.get(fact.key) ?? []), fact]);
  const gates: FactGate[] = [];
  for (const [key, group] of groups) {
    const values = [...new Set(group.map(fact => fact.value))];
    if (values.length > 1) gates.push({ id: `fact-conflict-${key}`, question: `关于“${group[0].label}”，目前有不同说法，需要先明确采用哪一种。`,
      dependsOn: [], recommendedAnswer: "请相关同事澄清分歧，原始说法和来源均会保留。", role: "product" });
    else if (group.some(fact => fact.kind === "assumption")) gates.push({ id: `fact-assumption-${key}`, question: `“${group[0].label}”还只是待确认的假设，需要核实后再修改。`,
      dependsOn: [], recommendedAnswer: "请掌握该情况的同事说明实际要求。", role: "product" });
    const question = questions.find(q => q.id === key || q.id === `${key}-resolution`);
    const gate = gates.find(gate => gate.id === `fact-conflict-${key}` || gate.id === `fact-assumption-${key}`);
    if (question && gate) {
      Object.assign(gate, { question: question.question, role: question.role, replacesQuestionId: `natural-${question.id}` });
      if (question.respondent) gate.respondent = question.respondent;
    }
  }
  return gates;
}
