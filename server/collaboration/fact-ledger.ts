import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { NaturalIntakeRequest, NaturalIntakeProposal } from "./natural-intake.ts";
import type { BlockingAmbiguity, AcceptanceCondition } from "./snapshot.ts";
import { semanticReviewSchema, validateSemanticReview, type SharedRewriteContext, type RewriteFact, type SemanticRewriteReview } from "./fact-rewrite.ts";

export const factProposalSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(500),
  kind: z.enum(["requirement", "assumption"]), quote: z.string().min(1).max(2000) }).strict();
export type FactProposal = z.infer<typeof factProposalSchema>;
const recordSchema = factProposalSchema.extend({ id: z.string(), sourceEventId: z.string(), principalId: z.string(), revision: z.number().int().positive() }).strict();
export type RecordedFact = z.infer<typeof recordSchema>;
export const factCorrectionSchema = z.object({ factId: z.string().regex(/^[a-f0-9]{64}$/u), quote: z.string().min(1).max(2000) }).strict();
export type FactCorrection = z.infer<typeof factCorrectionSchema>;
const correctionRecordSchema = factCorrectionSchema.extend({ sourceEventId: z.string(), principalId: z.string(), revision: z.number().int().positive() }).strict();
interface BoundFact extends RecordedFact { bindings?: { acceptance: AcceptanceCondition[]; goal: string | null; ambiguous?: boolean;
  sharedAcceptance?: AcceptanceCondition[]; sharedGoal?: string | null } }
export interface FactHistory { entries: BoundFact[]; retired?: BoundFact[]; truncated: boolean }
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const factId = (sourceEventId: string, fact: FactProposal): string => hash(JSON.stringify([sourceEventId, fact.key, fact.kind, fact.value]));
const rowSchema = z.object({ source_event_id: z.string(), principal_id: z.string(), normalized_json: z.string(),
  proposal_json: z.string(), result_revision: z.number(), acceptance_json: z.string(), goal: z.string().nullable() });
const conditionSchema = z.object({ description: z.string(), observation: z.string() });
const sharedRewritesSchema = z.object({ acceptance: z.array(z.object({ before: conditionSchema, after: conditionSchema }).strict()),
  goal: z.object({ before: z.string(), after: z.string() }).strict().nullable() }).strict();
export type SharedSpecRewrites = z.infer<typeof sharedRewritesSchema>;
const receiptSchema = z.object({ factRecords: z.array(recordSchema).optional(), factCorrectionRecords: z.array(correctionRecordSchema).optional(),
  sharedSpecRewrites: sharedRewritesSchema.optional(),
  semanticFactReview: semanticReviewSchema.optional(),
  acceptance: z.array(conditionSchema.extend({ quote: z.string() })), goal: z.object({ text: z.string(), quote: z.string() }).nullable(),
  eventEvidence: z.object({ normalizedHash: z.string() }) });
const sameCondition = (a: AcceptanceCondition, b: AcceptanceCondition): boolean => a.description === b.description && a.observation === b.observation;

/** Literal, simultaneous edits only: every other character stays unchanged.
 * Paraphrases and overlapping/multiple occurrences need a separate clarification,
 * not a guessed rewrite of a compound acceptance condition. */
function rewriteSharedText(parts: string[], related: BoundFact[], active: BoundFact[], retired: BoundFact[]): string[] {
  const replacements = new Map<string,string>();
  for (const fact of related.filter(f => retired.includes(f))) {
    const latest = active.filter(f => f.principalId === fact.principalId && f.key === fact.key).sort((a,b)=>b.revision-a.revision)[0];
    if (!latest || latest.kind !== "requirement") throw Error("natural_fact_correction_scope_ambiguous");
    if (latest.value === fact.value) continue;
    if (replacements.has(fact.value) && replacements.get(fact.value) !== latest.value ||
      related.some(other => other.key !== fact.key && other.value.includes(fact.value))) throw Error("natural_fact_correction_scope_ambiguous");
    replacements.set(fact.value,latest.value);
  }
  const edits = parts.map(part => [...replacements].flatMap(([before,after]) => {
    const start=part.indexOf(before);if(start<0)return [];
    if(part.indexOf(before,start+before.length)>=0)throw Error("natural_fact_correction_scope_ambiguous");
    if(/[A-Za-z0-9_]/u.test(before[0])&&/[A-Za-z0-9_]/u.test(part[start-1]??"")||
      /[A-Za-z0-9_]/u.test(before.at(-1)??"")&&/[A-Za-z0-9_]/u.test(part[start+before.length]??""))throw Error("natural_fact_correction_scope_ambiguous");
    return [{start,end:start+before.length,before,after}];
  }).sort((a,b)=>a.start-b.start));
  for(const before of replacements.keys())if(!edits.some(list=>list.some(edit=>edit.before===before)))throw Error("natural_fact_correction_scope_ambiguous");
  return parts.map((part,index)=>{
    let result="",cursor=0;
    for(const edit of edits[index]){
      if(edit.start<cursor)throw Error("natural_fact_correction_scope_ambiguous");
      result+=part.slice(cursor,edit.start)+edit.after;cursor=edit.end;
    }
    result+=part.slice(cursor);
    if(result.length>2000)throw Error("natural_fact_correction_scope_ambiguous");
    return result;
  });
}

export function sharedFactSpecRewrites(request: NaturalIntakeRequest, proposal: NaturalIntakeProposal): SharedSpecRewrites {
  const history=correctedFactHistory(request,proposal.factCorrections??[]);
  const active:BoundFact[]=[...history.entries,...recordFacts(request,proposal.facts??[])];
  const retired=history.retired??[], all=[...active,...retired];
  const result:SharedSpecRewrites={acceptance:[],goal:null};
  for(const before of request.snapshot.acceptanceConditions){
    const related=all.filter(f=>f.bindings?.sharedAcceptance?.some(c=>sameCondition(c,before)));
    if(!related.some(f=>retired.includes(f)))continue;
    const [description,observation]=rewriteSharedText([before.description,before.observation],related,active,retired);
    if(description!==before.description||observation!==before.observation)result.acceptance.push({before,after:{description,observation}});
  }
  const before=request.snapshot.goal;
  if(before){
    const related=all.filter(f=>f.bindings?.sharedGoal===before);
    if(related.some(f=>retired.includes(f))){
      const [after]=rewriteSharedText([before],related,active,retired);
      if(after!==before)result.goal={before,after};
    }
  }
  return result;
}

function rewriteContext(snapshot: Pick<NaturalIntakeRequest["snapshot"], "workItemId" | "revision" | "acceptanceConditions" | "goal">,
  active: BoundFact[], retired: BoundFact[], event: NaturalIntakeRequest["event"]): SharedRewriteContext {
  const all = [...active, ...retired];
  const factsFor = (related: BoundFact[]): RewriteFact[] => {
    if (!related.some(f => retired.includes(f))) return [];
    const facts = new Map<string, RewriteFact>();
    for (const old of related) {
      const latest = active.filter(f => f.principalId === old.principalId && f.key === old.key).sort((a, b) => b.revision - a.revision)[0];
      if (!latest || latest.kind !== "requirement") throw new Error("natural_fact_rewrite_source_invalid");
      const value = { key: old.key, principalId: old.principalId, before: old.value, after: latest.value };
      facts.set(JSON.stringify(value), value);
    }
    return [...facts].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  };
  const acceptance = snapshot.acceptanceConditions.flatMap(before => {
    const facts = factsFor(all.filter(f => f.bindings?.sharedAcceptance?.some(c => sameCondition(c, before))));
    return facts.some(f => f.before !== f.after) ? [{ before, facts }] : [];
  });
  const goalFacts = snapshot.goal ? factsFor(all.filter(f => f.bindings?.sharedGoal === snapshot.goal)) : [];
  return { workItemId: snapshot.workItemId, baseRevision: snapshot.revision, sourceEventId: event.sourceEventId,
    clarification: { principalId: event.principalId, text: event.text }, acceptance,
    goal: snapshot.goal && goalFacts.some(f => f.before !== f.after) ? { before: snapshot.goal, facts: goalFacts } : null };
}

export function sharedFactRewriteContext(request: NaturalIntakeRequest, proposal: NaturalIntakeProposal): SharedRewriteContext {
  const history = correctedFactHistory(request, proposal.factCorrections ?? []);
  return rewriteContext(request.snapshot, [...history.entries, ...recordFacts(request, proposal.facts ?? [])], history.retired ?? [], request.event);
}

function restoreSharedRewrites(rewrites:SharedSpecRewrites,active:Map<string,BoundFact>,retired:BoundFact[],applied:AcceptanceCondition[],goal:string|null,
  review?: SemanticRewriteReview):void {
  const all=[...active.values(),...retired];
  const transfer=(related:BoundFact[],update:(bindings:NonNullable<BoundFact['bindings']>)=>void)=>{
    for(const fact of related){
      const target=active.has(fact.id)?fact:[...active.values()].filter(f=>f.principalId===fact.principalId&&f.key===fact.key).sort((a,b)=>b.revision-a.revision)[0];
      if(!target)throw Error("natural_fact_rewrite_source_invalid");
      target.bindings??={acceptance:[],goal:null};update(target.bindings);target.bindings.ambiguous=true;
    }
  };
  for(const {before,after} of rewrites.acceptance){
    const related=all.filter(f=>f.bindings?.sharedAcceptance?.some(c=>sameCondition(c,before)));
    const [description,observation]=review ? [after.description, after.observation] : rewriteSharedText([before.description,before.observation],related,[...active.values()],retired);
    if(!related.length||!sameCondition(after,{description,observation})||!applied.some(c=>sameCondition(c,after))||(!sameCondition(before,after)&&applied.some(c=>sameCondition(c,before))))throw Error("natural_fact_rewrite_source_invalid");
    for(const fact of related)fact.bindings!.sharedAcceptance=fact.bindings!.sharedAcceptance!.filter(c=>!sameCondition(c,before));
    transfer(related,bindings=>{bindings.sharedAcceptance??=[];if(!bindings.sharedAcceptance.some(c=>sameCondition(c,after)))bindings.sharedAcceptance.push(after);});
  }
  if(rewrites.goal){
    const {before,after}=rewrites.goal,related=all.filter(f=>f.bindings?.sharedGoal===before);
    if(!related.length||(!review && rewriteSharedText([before],related,[...active.values()],retired)[0]!==after)||goal!==after)throw Error("natural_fact_rewrite_source_invalid");
    for(const fact of related)fact.bindings!.sharedGoal=null;
    transfer(related,bindings=>{bindings.sharedGoal=after;});
  }
}

/** Reconstruct source-bound observations from immutable Spec receipts. This is a
 * read projection, not a competing mutable authority or a vote/approval system. */
export function readFactHistory(db: DatabaseSync, workItemId: string, revision: number): FactHistory {
  const active = new Map<string, BoundFact>(), retired: BoundFact[] = [];
  const rows = db.prepare("SELECT j.source_event_id,e.principal_id,e.normalized_json,j.proposal_json,j.result_revision,s.acceptance_json,s.goal " +
    "FROM collaboration_natural_all_jobs j JOIN collaboration_external_events e ON e.source='dingtalk' AND e.source_event_id=j.source_event_id AND e.work_item_id=j.work_item_id " +
    "JOIN collaboration_work_item_snapshots s ON s.work_item_id=j.work_item_id AND s.revision=j.result_revision " +
    "WHERE j.work_item_id=? AND j.status='applied' AND j.result_revision<=? " +
    "AND (json_array_length(j.proposal_json,'$.factRecords')>0 OR json_array_length(j.proposal_json,'$.factCorrectionRecords')>0 " +
    "OR json_array_length(j.proposal_json,'$.sharedSpecRewrites.acceptance')>0 OR json_type(j.proposal_json,'$.sharedSpecRewrites.goal')='object') ORDER BY j.result_revision")
    .iterate(workItemId, revision);
  for (const raw of rows) {
    const row = rowSchema.parse(raw), receipt = receiptSchema.parse(JSON.parse(row.proposal_json));
    const event = z.object({ text: z.string() }).parse(JSON.parse(row.normalized_json));
    if (receipt.eventEvidence.normalizedHash !== hash(row.normalized_json)) throw new Error("natural_fact_source_invalid");
    const facts = receipt.factRecords ?? [];
    for (const fact of facts) {
      if (fact.id !== factId(row.source_event_id, fact) || fact.sourceEventId !== row.source_event_id || fact.principalId !== row.principal_id ||
        fact.revision !== row.result_revision || !event.text.includes(fact.quote) || fact.kind === "requirement" && !fact.quote.includes(fact.value)) throw new Error("natural_fact_source_invalid");
    }
    for (const correction of receipt.factCorrectionRecords ?? []) {
      const prior = active.get(correction.factId);
      if (!prior || prior.principalId !== row.principal_id || correction.principalId !== row.principal_id || correction.sourceEventId !== row.source_event_id ||
        correction.revision !== row.result_revision || !event.text.includes(correction.quote) ||
        !facts.some(f => f.key === prior.key && f.kind === "requirement" && correction.quote.includes(f.value)) ||
        [...active.values()].some(f => f.key === prior.key && f.principalId === prior.principalId && f.revision > prior.revision)) throw new Error("natural_fact_correction_source_invalid");
      for (const [id, fact] of active) if (fact.principalId === prior.principalId && fact.key === prior.key) { retired.push(fact); active.delete(id); }
    }
    const applied = z.array(conditionSchema).parse(JSON.parse(row.acceptance_json));
    for (const fact of facts) {
      const matches = (quote: string) => facts.filter(candidate => candidate.quote.includes(quote) || quote.includes(candidate.quote));
      const acceptance = receipt.acceptance.filter(condition => applied.some(value => sameCondition(value, condition)) &&
        matches(condition.quote).length === 1 && matches(condition.quote)[0].id === fact.id).map(({ description, observation }) => ({ description, observation }));
      const goal = receipt.goal && row.goal === receipt.goal.text && matches(receipt.goal.quote).length === 1 && matches(receipt.goal.quote)[0].id === fact.id ? row.goal : null;
      const ambiguous = receipt.acceptance.some(condition => applied.some(value => sameCondition(value, condition)) &&
        matches(condition.quote).length > 1 && matches(condition.quote).some(candidate => candidate.id === fact.id)) ||
        !!(receipt.goal && row.goal === receipt.goal.text && matches(receipt.goal.quote).length > 1 && matches(receipt.goal.quote).some(candidate => candidate.id === fact.id));
      const sharedAcceptance=receipt.acceptance.filter(condition=>applied.some(value=>sameCondition(value,condition))&&
        matches(condition.quote).length>1&&matches(condition.quote).some(candidate=>candidate.id===fact.id)).map(({description,observation})=>({description,observation}));
      const sharedGoal=receipt.goal&&row.goal===receipt.goal.text&&matches(receipt.goal.quote).length>1&&matches(receipt.goal.quote).some(candidate=>candidate.id===fact.id)?row.goal:null;
      active.set(fact.id, { ...fact, bindings: { acceptance, goal, ambiguous,sharedAcceptance,sharedGoal } });
    }
    if (receipt.semanticFactReview) {
      const previous = z.object({ acceptance_json: z.string(), goal: z.string().nullable() }).parse(db.prepare(
        "SELECT acceptance_json,goal FROM collaboration_work_item_snapshots WHERE work_item_id=? AND revision=?").get(workItemId, row.result_revision - 1));
      const context = rewriteContext({ workItemId, revision: row.result_revision - 1, goal: previous.goal,
        acceptanceConditions: z.array(conditionSchema).parse(JSON.parse(previous.acceptance_json)) }, [...active.values()], retired,
      { sourceEventId: row.source_event_id, principalId: row.principal_id, text: event.text });
      const review = validateSemanticReview(context, receipt.semanticFactReview);
      if (JSON.stringify(review.rewrites) !== JSON.stringify(receipt.sharedSpecRewrites)) throw new Error("natural_fact_rewrite_review_invalid");
    }
    if(receipt.sharedSpecRewrites)restoreSharedRewrites(receipt.sharedSpecRewrites,active,retired,applied,row.goal,receipt.semanticFactReview);
  }
  const current = z.object({ acceptance_json: z.string(), goal: z.string().nullable() }).parse(db.prepare("SELECT acceptance_json,goal FROM collaboration_work_item_snapshots WHERE work_item_id=? AND revision=?").get(workItemId, revision));
  const conditions = z.array(conditionSchema).parse(JSON.parse(current.acceptance_json));
  const neededRetired = retired.filter(fact => fact.bindings?.goal === current.goal && current.goal !== null ||
    fact.bindings?.sharedGoal === current.goal && current.goal !== null ||
    [...(fact.bindings?.acceptance??[]),...(fact.bindings?.sharedAcceptance??[])].some(binding => conditions.some(condition => sameCondition(binding, condition))));
  // Repeated observations may omit acceptance already in the Spec. Compact the
  // observation, not its still-live provenance, or a later correction loses it.
  const compact = new Map<string, BoundFact>();
  for (const fact of [...active.values()].reverse()) {
    const key = JSON.stringify([fact.key, fact.kind, fact.value, fact.principalId]);
    const latest = compact.get(key);
    if (!latest) { compact.set(key, { ...fact, bindings: { ...fact.bindings, acceptance: [...(fact.bindings?.acceptance ?? [])], goal: fact.bindings?.goal ?? null } }); continue; }
    for (const condition of fact.bindings?.acceptance ?? []) if (!latest.bindings!.acceptance.some(c => sameCondition(c, condition))) latest.bindings!.acceptance.push(condition);
    if (fact.bindings?.goal === current.goal) latest.bindings!.goal = current.goal;
    if (fact.bindings?.ambiguous) latest.bindings!.ambiguous = true;
    latest.bindings!.sharedAcceptance??=[];
    for(const condition of fact.bindings?.sharedAcceptance??[])if(!latest.bindings!.sharedAcceptance.some(c=>sameCondition(c,condition)))latest.bindings!.sharedAcceptance.push(condition);
    if(fact.bindings?.sharedGoal===current.goal)latest.bindings!.sharedGoal=current.goal;
  }
  const entries: BoundFact[] = [], retiredEntries: BoundFact[] = [];
  let characters = 0, truncated = false;
  for (const fact of compact.values()) {
    const size = JSON.stringify(fact).length;
    if (entries.length >= 50 || characters + size > 12000) { truncated = true; continue; }
    characters += size; entries.push(fact);
  }
  for (const fact of neededRetired) {
    const size = JSON.stringify(fact).length;
    if (retiredEntries.length >= 50 || characters + size > 16000) { truncated = true; continue; }
    characters += size; retiredEntries.push(fact);
  }
  return { entries: entries.reverse(), retired: retiredEntries, truncated };
}

export function validateFactCorrections(request: NaturalIntakeRequest, proposal: NaturalIntakeProposal): void {
  const keys = new Set<string>();
  for (const correction of proposal.factCorrections ?? []) {
    const fact = request.factHistory?.entries.find(fact => fact.id === correction.factId);
    if (!fact || request.contextTruncated || request.factHistory?.truncated || fact.principalId !== request.event.principalId || !request.event.text.includes(correction.quote) ||
      !proposal.facts?.some(replacement => replacement.key === fact.key && replacement.kind === "requirement" && correction.quote.includes(replacement.value)) || keys.has(fact.key)) throw new Error("natural_fact_correction_invalid");
    if (request.factHistory!.entries.some(other => other.key === fact.key && other.principalId === fact.principalId && other.revision > fact.revision)) throw new Error("natural_fact_correction_stale");
    keys.add(fact.key);
  }
}
export function correctedFactHistory(request: NaturalIntakeRequest, corrections: FactCorrection[]): FactHistory {
  const history = request.factHistory ?? { entries: [], truncated: false };
  const keys = new Set(corrections.map(c => history.entries.find(f => f.id === c.factId)!.key));
  const removed = history.entries.filter(f => keys.has(f.key) && f.principalId === request.event.principalId);
  return { entries: history.entries.filter(f => !removed.includes(f)), retired: [...(history.retired ?? []), ...removed], truncated: history.truncated };
}
export function recordFactCorrections(request: NaturalIntakeRequest, corrections: FactCorrection[]) {
  return corrections.map(c => ({ ...c, sourceEventId: request.event.sourceEventId, principalId: request.event.principalId, revision: request.snapshot.revision + 1 }));
}
export function retainedFactAcceptance(request: NaturalIntakeRequest, history: FactHistory): AcceptanceCondition[] {
  return request.snapshot.acceptanceConditions.filter(condition => !history.retired?.some(f => f.bindings?.acceptance.some(c => sameCondition(c, condition))) ||
    history.entries.some(f => f.bindings?.acceptance.some(c => sameCondition(c, condition))));
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
