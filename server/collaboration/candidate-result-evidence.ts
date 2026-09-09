import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import type { InboundCard } from "./message-renderer.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const sha=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const id=z.string().min(1).max(512);
const checksum=(text:string)=>createHash("sha256").update(text).digest("hex");
const resultCardSchema=z.object({type:z.literal("plan_status_card"),status:z.literal("verified_result"),headline:z.literal("修改和回归已核对"),
  workItemId:id,workItemVersion:z.number().int().positive(),planRevision:z.number().int().positive(),snapshotRevision:z.number().int().positive(),candidateSha:sha,summary:z.string().min(1).max(600)}).strict();
const bindingSchema=z.object({outbox_id:id,work_item_id:id,work_item_version:z.number().int().positive(),conversation_id:id,plan_revision:z.number().int().positive(),snapshot_revision:z.number().int().positive(),
  candidate_run_id:id,base_sha:sha,candidate_sha:sha,spec_hash:digest,spec_identity_hash:digest,policy_hash:digest,payload_hash:digest,serialized_hash:digest,created_at:z.number().int().nonnegative()}).strict();
export type CandidateResultBinding=z.infer<typeof bindingSchema>;
const deliverySchema=z.object({outbox_id:id,payload_hash:digest,serialized_hash:digest,source_event_id:id,delivery_sequence:z.number().int().positive(),sent_at:z.number().int().nonnegative(),
  idempotency_key_hash:digest,channel:z.enum(["session","proactive"]),destination_hash:digest,confirmation_kind:z.enum(["business_response","accepted_receipt"])}).strict();
const proofSchema=z.object({outboxId:id,idempotencyKeyHash:digest,sourceEventId:id,payloadHash:digest,serializedHash:digest,
  channel:z.enum(["session","proactive"]),destinationHash:digest,confirmationKind:z.enum(["business_response","accepted_receipt"])}).strict();
export type CandidateResultDeliveryProof=z.infer<typeof proofSchema>;
export interface CandidateResultTarget {candidateRunId:string;candidateSha:string;specHash:string;specIdentityHash:string;policyHash:string}

function parseResultMessage(payload:InboundCard) {
  const card=resultCardSchema.parse(payload);
  const sentences=card.summary.match(/[^。！？!?]+[。！？!?]/gu)??[];
  if(sentences.length<2 || sentences.length>3 || sentences.join("")!==card.summary ||
    /修改(?:已)?完成|任务(?:已)?完成|已验收|WI-[A-Z0-9-]+|```|\b(?:SHA|diff|execution_failed|candidate_ready)\b/iu.test(card.summary) ||
    redactSensitiveText(card.summary)!==card.summary) throw new Error("candidate_result_message_invalid");
  const serialized=renderDingTalkSessionMessage(card);
  const rendered=z.object({markdown:z.object({text:z.string()})}).parse(serialized);
  if(!rendered.markdown.text.trim()) throw new Error("candidate_result_message_invalid");
  return {card,payloadHash:checksum(JSON.stringify(card)),serializedHash:checksum(JSON.stringify(serialized))};
}

export function candidateResultDeliveryProof(payload:InboundCard,sourceEventId:string,input:{outboxId:string;idempotencyKey:string;channel:"session"|"proactive";destination:string;confirmationKind:"business_response"|"accepted_receipt"}):CandidateResultDeliveryProof|undefined {
  try { const parsed=parseResultMessage(payload);if(!input.destination) return undefined;
    return proofSchema.parse({outboxId:input.outboxId,idempotencyKeyHash:checksum(input.idempotencyKey),sourceEventId,payloadHash:parsed.payloadHash,serializedHash:parsed.serializedHash,
      channel:input.channel,destinationHash:checksum(`${input.channel}:${input.destination}`),confirmationKind:input.confirmationKind}); }
  catch {return undefined;}
}

function sourceConversation(db:DatabaseSync,sourceEventId:string):string|null {
  const rows=z.array(z.object({conversation_id:id})).parse(db.prepare("SELECT DISTINCT conversation_id FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=?").all(sourceEventId));
  return rows.length===1?rows[0].conversation_id:null;
}

function readOutbox(db:DatabaseSync,outboxId:string) {
  return z.object({id:id,dedupe_key:id,aggregate_id:id,aggregate_version:z.number().int().positive(),payload_json:z.string(),delivery_state:z.string(),sent_at:z.number().nullable(),superseded_at:z.number().nullable(),delivery_sequence:z.number().nullable()}).optional().parse(
    db.prepare("SELECT id,dedupe_key,aggregate_id,aggregate_version,payload_json,delivery_state,sent_at,superseded_at,delivery_sequence FROM collaboration_outbox WHERE id=?").get(outboxId));
}

export function readCandidateResultBinding(db:DatabaseSync,outboxId:string):CandidateResultBinding|null {
  try {return bindingSchema.optional().parse(db.prepare("SELECT * FROM collaboration_candidate_result_bindings WHERE outbox_id=?").get(outboxId))??null;}catch{return null;}
}

/** State-only half of the send gate. The caller must additionally revalidate the technical acceptance gate. */
export function isCurrentCandidateResultBinding(db:DatabaseSync,binding:CandidateResultBinding,completed=false):boolean {
  const row=z.object({version:z.number(),conversation_id:z.string(),current_plan_revision:z.number().nullable(),control_state:z.string(),status:z.string(),accepted_candidate_sha:z.string().nullable(),snapshot_revision:z.number(),base_sha:z.string(),result_sha:z.string()}).optional().parse(
    db.prepare("SELECT w.version,w.conversation_id,w.current_plan_revision,w.control_state,w.status,w.accepted_candidate_sha,p.snapshot_revision,c.base_sha,c.result_sha FROM collaboration_work_items w "+
      "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision JOIN collaboration_runs r ON r.work_item_id=w.id AND r.plan_revision=w.current_plan_revision "+
      "JOIN collaboration_candidates c ON c.run_id=r.id WHERE w.id=? AND r.id=? AND r.status='succeeded' AND r.attempt=(SELECT MAX(attempt) FROM collaboration_runs WHERE work_item_id=w.id AND plan_revision=w.current_plan_revision)")
      .get(binding.work_item_id,binding.candidate_run_id));
  if(!row || row.conversation_id!==binding.conversation_id || row.current_plan_revision!==binding.plan_revision || row.snapshot_revision!==binding.snapshot_revision || row.base_sha!==binding.base_sha || row.result_sha!==binding.candidate_sha) return false;
  if(row.control_state==="active") return row.version===binding.work_item_version && row.accepted_candidate_sha===null;
  return completed && row.control_state==="accepted" && row.status==="accepted" && row.version===binding.work_item_version+1 && row.accepted_candidate_sha===binding.candidate_sha;
}

/** Called inside the preparation transaction after technical verification and enqueue; not an authorization API. */
export function stageCandidateResultBinding(db:DatabaseSync,input:CandidateResultTarget&{outboxId:string;workItemId:string;workItemVersion:number;planRevision:number;snapshotRevision:number;baseSha:string;now:number}):void {
  try {
    const outbox=readOutbox(db,input.outboxId);
    if(!outbox || outbox.delivery_state!=="pending" || outbox.sent_at!==null || outbox.superseded_at!==null) throw new Error("invalid");
    const parsed=parseResultMessage(resultCardSchema.parse(JSON.parse(outbox.payload_json)));
    const {card}=parsed;
    const workItem=z.object({conversation_id:id}).parse(db.prepare("SELECT conversation_id FROM collaboration_work_items WHERE id=?").get(input.workItemId));
    const binding=bindingSchema.parse({outbox_id:input.outboxId,work_item_id:input.workItemId,work_item_version:input.workItemVersion,conversation_id:workItem.conversation_id,
      plan_revision:input.planRevision,snapshot_revision:input.snapshotRevision,candidate_run_id:input.candidateRunId,base_sha:input.baseSha,candidate_sha:input.candidateSha,
      spec_hash:input.specHash,spec_identity_hash:input.specIdentityHash,policy_hash:input.policyHash,payload_hash:parsed.payloadHash,serialized_hash:parsed.serializedHash,created_at:input.now});
    if(card.workItemId!==input.workItemId || card.workItemVersion!==input.workItemVersion || card.planRevision!==input.planRevision || card.snapshotRevision!==input.snapshotRevision || card.candidateSha!==input.candidateSha ||
      outbox.aggregate_id!==input.workItemId || outbox.aggregate_version!==input.workItemVersion || !isCurrentCandidateResultBinding(db,binding)) throw new Error("invalid");
    const existing=readCandidateResultBinding(db,input.outboxId);
    if(existing) { if(JSON.stringify({...existing,created_at:binding.created_at})!==JSON.stringify(binding)) throw new Error("invalid");return; }
    const values=Object.values(binding);
    db.prepare(`INSERT INTO collaboration_candidate_result_bindings(${Object.keys(binding).join(",")}) VALUES(${values.map(()=>"?").join(",")})`).run(...values);
  } catch(error) {
    if(error instanceof z.ZodError || error instanceof SyntaxError ||
      (error instanceof Error && ["invalid","candidate_result_message_invalid"].includes(error.message))) {
      throw new Error("candidate_result_binding_invalid");
    }
    throw error;
  }
}

/** Only the transport calls this after its actual business-success response or exact accepted-send reconciliation. */
export function confirmCandidateResultDelivery(db:DatabaseSync,outboxId:string,proof:CandidateResultDeliveryProof|undefined,now:number):void {
  const parsed=proofSchema.safeParse(proof),binding=readCandidateResultBinding(db,outboxId),outbox=readOutbox(db,outboxId);
  if(!parsed.success || !binding || !outbox || outbox.delivery_state!=="sent" || outbox.sent_at!==now || !outbox.delivery_sequence || outbox.superseded_at!==null) return;
  try {
    const actual=parseResultMessage(resultCardSchema.parse(JSON.parse(outbox.payload_json)));
    if(parsed.data.outboxId!==outboxId || parsed.data.idempotencyKeyHash!==checksum(JSON.stringify([outboxId,outbox.dedupe_key])) ||
      (parsed.data.channel==="session" && parsed.data.destinationHash!==checksum(`session:${parsed.data.sourceEventId}`)) ||
      parsed.data.payloadHash!==binding.payload_hash || parsed.data.serializedHash!==binding.serialized_hash || actual.payloadHash!==binding.payload_hash || actual.serializedHash!==binding.serialized_hash ||
      sourceConversation(db,parsed.data.sourceEventId)!==binding.conversation_id) return;
    const delivery=deliverySchema.parse({outbox_id:outboxId,payload_hash:binding.payload_hash,serialized_hash:binding.serialized_hash,source_event_id:parsed.data.sourceEventId,delivery_sequence:outbox.delivery_sequence,sent_at:now,
      idempotency_key_hash:parsed.data.idempotencyKeyHash,channel:parsed.data.channel,destination_hash:parsed.data.destinationHash,confirmation_kind:parsed.data.confirmationKind});
    const existing=deliverySchema.optional().parse(db.prepare("SELECT * FROM collaboration_candidate_result_deliveries WHERE outbox_id=?").get(outboxId));
    if(existing) return;
    db.prepare("INSERT INTO collaboration_candidate_result_deliveries(outbox_id,payload_hash,serialized_hash,source_event_id,delivery_sequence,sent_at,idempotency_key_hash,channel,destination_hash,confirmation_kind) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(delivery.outbox_id,delivery.payload_hash,delivery.serialized_hash,delivery.source_event_id,delivery.delivery_sequence,delivery.sent_at,delivery.idempotency_key_hash,delivery.channel,delivery.destination_hash,delivery.confirmation_kind);
  }catch{/* Invalid, stale or unbound delivery must never prove completion. */}
}

/** Read-only full reply proof. Never trusts a bare Outbox sent flag, a cached hash, or a different candidate. */
export function readVerifiedCandidateResultReply(db:DatabaseSync,target:CandidateResultTarget):string|null {
  try {
    const rows=z.array(bindingSchema).parse(db.prepare("SELECT * FROM collaboration_candidate_result_bindings WHERE candidate_run_id=? AND candidate_sha=? AND spec_hash=? AND spec_identity_hash=? AND policy_hash=?")
      .all(target.candidateRunId,target.candidateSha,target.specHash,target.specIdentityHash,target.policyHash)).filter(binding=>isCurrentCandidateResultBinding(db,binding,true));
    if(rows.length!==1) return null;
    const binding=rows[0],outbox=readOutbox(db,binding.outbox_id);
    if(!isCurrentCandidateResultBinding(db,binding,true) || !outbox || outbox.delivery_state!=="sent" || outbox.sent_at===null || outbox.superseded_at!==null ||
      outbox.aggregate_id!==binding.work_item_id || outbox.aggregate_version!==binding.work_item_version) return null;
    const actual=parseResultMessage(resultCardSchema.parse(JSON.parse(outbox.payload_json)));
    const delivery=deliverySchema.optional().parse(db.prepare("SELECT * FROM collaboration_candidate_result_deliveries WHERE outbox_id=?").get(binding.outbox_id));
    if(!delivery || actual.payloadHash!==binding.payload_hash || actual.serializedHash!==binding.serialized_hash || delivery.payload_hash!==binding.payload_hash || delivery.serialized_hash!==binding.serialized_hash ||
      delivery.idempotency_key_hash!==checksum(JSON.stringify([binding.outbox_id,outbox.dedupe_key])) ||
      (delivery.channel==="session" && delivery.destination_hash!==checksum(`session:${delivery.source_event_id}`)) ||
      delivery.sent_at!==outbox.sent_at || delivery.delivery_sequence!==outbox.delivery_sequence || sourceConversation(db,delivery.source_event_id)!==binding.conversation_id) return null;
    return checksum(JSON.stringify({binding,delivery}));
  }catch{return null;}
}
