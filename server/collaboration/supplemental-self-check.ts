import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readAssertionReport, type CoverageCommand } from "./acceptance-assertions.ts";
import { containmentBindingHash, runtimeIdentityFingerprint } from "./containment.ts";
import type { TargetCommandSpec, TestEvidence } from "./quality-gate.ts";

// oxlint-disable-next-line anti-slop/no-object-parameters -- Hashing accepts only already-parsed rows and typed definition maps; it does not interpret a domain payload.
const hash = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.object({
  runId:z.string().min(1).max(256),commandId:z.string().min(1).max(256),
  canonicalWorktreePath:z.string().max(4096).refine(isAbsolute),instanceOwner:z.string().min(1).max(256),
  instanceFence:z.number().int().positive(),nonce:z.string().min(32).max(256),
}).strict();
const phaseEvidenceSchema = z.object({
  commandId:z.string().min(1).max(256),argv:z.array(z.string()).min(1).max(128),cwd:z.string().max(4096).refine(isAbsolute),
  state:z.literal("target_passed"),exitCode:z.literal(0),durationMs:z.number().nonnegative(),
  stdout:z.string().max(262144),containmentBinding:bindingSchema,containmentFingerprint:digest,
  ordinal:z.number().int().positive(),
}).strict();
const receiptSchema = z.object({
  version:z.literal(1),kind:z.literal("supplemental_self_check"),sessionId:z.string().min(1).max(256),
  candidateRunId:z.string().min(1).max(256),candidateSha:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  contractHash:digest,verifierAttempt:z.number().int().positive(),definitions:z.record(z.string(),digest),originalEvidenceHash:digest,
  self:z.array(phaseEvidenceSchema).min(1).max(16),verifier:z.array(phaseEvidenceSchema).min(1).max(16),
}).strict();
export type SupplementalSelfCheck = z.infer<typeof receiptSchema>;

export interface SupplementalSelfCheckTarget {
  candidateRunId:string;candidateSha:string;contractHash:string;verifierAttempt:number;
  definitions:Readonly<Record<string,string>>;commands:Readonly<Record<string,TargetCommandSpec>>;
}

/** The old executor report remains immutable and must already prove a successful, bound self-test. */
function originalEvidence(database:DatabaseSync,target:SupplementalSelfCheckTarget): string {
  const rows=z.array(z.object({command_id:z.string(),state:z.string(),argv_json:z.string(),stdout:z.string(),containment_binding_json:z.string().nullable()}).strict()).parse(
    database.prepare("SELECT command_id,state,argv_json,stdout,containment_binding_json FROM collaboration_test_evidence WHERE run_id=? ORDER BY command_id").all(target.candidateRunId));
  const ids=Object.keys(target.commands).sort();
  if(rows.length!==ids.length || rows.some((row,index)=>{
    if(row.command_id!==ids[index] || row.state!=="target_passed" || !row.containment_binding_json) return true;
    const binding=z.object({runId:z.string(),commandId:z.string(),nonce:z.string().min(1).max(256)}).parse(JSON.parse(row.containment_binding_json));
    if(binding.runId!==target.candidateRunId || binding.commandId!==row.command_id) return true;
    if(!target.commands[row.command_id].assertionReporter && !target.commands[row.command_id].assertionContract) return false;
    const assertions=readAssertionReport(row.stdout,{runId:target.candidateRunId,nonce:binding.nonce});
    return !assertions?.length || assertions.some(assertion=>assertion.state!=="passed");
  })) throw new Error("supplemental_self_check_invalid");
  return hash(rows);
}

export function hasBoundOriginalSelfTests(database:DatabaseSync,target:SupplementalSelfCheckTarget):boolean {
  try { originalEvidence(database,target);return true; } catch {return false;}
}

function validateReceipt(database:DatabaseSync,receipt:SupplementalSelfCheck,target:SupplementalSelfCheckTarget,settled:boolean):CoverageCommand[]|null {
  if(receipt.candidateRunId!==target.candidateRunId || receipt.candidateSha!==target.candidateSha || receipt.contractHash!==target.contractHash ||
    receipt.verifierAttempt!==target.verifierAttempt || hash(receipt.definitions)!==hash(target.definitions) || receipt.originalEvidenceHash!==originalEvidence(database,target)) return null;
  const session=z.object({candidate_run_id:z.string(),candidate_sha:z.string(),instance_owner:z.string(),instance_fence:z.number()}).optional().parse(
    database.prepare("SELECT candidate_run_id,candidate_sha,instance_owner,instance_fence FROM collaboration_verification_sessions WHERE id=?").get(receipt.sessionId));
  if(!session || session.candidate_run_id!==target.candidateRunId || session.candidate_sha!==target.candidateSha) return null;
  const reservation=database.prepare("SELECT 1 FROM collaboration_candidate_recheck_attempts WHERE session_id=? AND candidate_run_id=? AND candidate_sha=? AND contract_hash=? AND verifier_attempt=? AND instance_owner=? AND instance_fence=?")
    .get(receipt.sessionId,target.candidateRunId,target.candidateSha,target.contractHash,target.verifierAttempt,session.instance_owner,session.instance_fence);
  if(!reservation) return null;
  const lifecycle=z.array(z.object({ordinal:z.number().int(),binding_json:z.string(),proof_json:z.string().nullable()})).parse(
    database.prepare("SELECT c.ordinal,c.binding_json,p.proof_json FROM collaboration_verification_commands c LEFT JOIN collaboration_verification_proofs p ON p.session_id=c.session_id AND p.ordinal=c.ordinal WHERE c.session_id=? ORDER BY c.ordinal").all(receipt.sessionId));
  const ids=Object.keys(target.commands);
  if(!ids.length || receipt.self.length!==ids.length || receipt.verifier.length!==ids.length || lifecycle.length!==ids.length*2) return null;
  const fingerprints=new Set<string>(),nonces=new Set<string>();
  const selfRoot=receipt.self[0].containmentBinding.canonicalWorktreePath,verifierRoot=receipt.verifier[0].containmentBinding.canonicalWorktreePath;
  if(selfRoot===verifierRoot) return null;
  const output:CoverageCommand[]=[];
  for(const [index,item] of [...receipt.self,...receipt.verifier].entries()) {
    const self=index<ids.length,commandId=ids[index%ids.length],command=target.commands[commandId];
    const binding=item.containmentBinding,stored=lifecycle[index];
    const runId=`${target.candidateRunId}:verifier:${target.verifierAttempt}${self?":self-recheck":""}`;
    if(item.commandId!==commandId || binding.commandId!==commandId || binding.runId!==runId || binding.instanceOwner!==session.instance_owner ||
      binding.instanceFence!==session.instance_fence || binding.canonicalWorktreePath!==(self?selfRoot:verifierRoot) ||
      item.ordinal!==index+1 || stored.ordinal!==item.ordinal || containmentBindingHash(bindingSchema.parse(JSON.parse(stored.binding_json)))!==containmentBindingHash(binding) ||
      hash(item.argv)!==hash(command.argv) || item.cwd!==resolve(binding.canonicalWorktreePath,command.cwd??".") ||
      !stored.proof_json || fingerprints.has(item.containmentFingerprint) || nonces.has(binding.nonce)) return null;
    const proof=z.object({identity:z.object({backend:z.string(),opaqueId:z.string(),hostGeneration:z.string(),verifierVersion:z.string()}),receipt:z.string()}).parse(JSON.parse(stored.proof_json));
    if(runtimeIdentityFingerprint(proof.identity)!==item.containmentFingerprint) return null;
    const reportsAssertions=!!(command.assertionReporter || command.assertionContract);
    const assertions=reportsAssertions?readAssertionReport(item.stdout,{runId,nonce:binding.nonce}):undefined;
    if(reportsAssertions && (!assertions?.length || assertions.some(assertion=>assertion.state!=="passed"))) return null;
    if(!reportsAssertions && item.stdout!=="") return null;
    fingerprints.add(item.containmentFingerprint);nonces.add(binding.nonce);
    if(self) output.push({commandId,state:item.state,assertions,assertionContract:command.assertionContract});
  }
  if(settled) {
    const row=z.object({evidence_json:z.string()}).optional().parse(database.prepare("SELECT evidence_json FROM collaboration_verification_settlements WHERE session_id=?").get(receipt.sessionId));
    if(!row) return null;
    const settlementEntries=z.array(z.object({ordinal:z.number().int().positive(),fingerprint:digest,state:z.literal("empty")}).strict());
    const value=z.union([settlementEntries,z.object({evidence:settlementEntries}).transform(record=>record.evidence)]).parse(JSON.parse(row.evidence_json));
    const entries=settlementEntries.safeParse(value);
    if(!entries.success || entries.data.length!==lifecycle.length || entries.data.some((entry,index)=>entry.ordinal!==index+1 || entry.fingerprint!==[...receipt.self,...receipt.verifier][index].containmentFingerprint)) return null;
  }
  return output;
}

/** Called only after the two real runners return; does not fabricate or overwrite executor evidence. */
export function buildSupplementalSelfCheck(database:DatabaseSync,input:SupplementalSelfCheckTarget&{
  sessionId:string;selfEvidence:readonly TestEvidence[];verifierEvidence:readonly TestEvidence[];
}):SupplementalSelfCheck {
  try {
    const phase=(evidence:readonly TestEvidence[],offset:number)=>evidence.map((item,index)=>({
      commandId:item.commandId,argv:item.argv,cwd:item.cwd,state:item.state,exitCode:item.exitCode,durationMs:item.durationMs,
      // Only the bound assertion document is retained, never stderr or model output.
      stdout:input.commands[item.commandId]?.assertionReporter || input.commands[item.commandId]?.assertionContract?item.stdout:"",
      containmentBinding:item.containmentBinding,containmentFingerprint:item.containmentFingerprint,ordinal:offset+index+1,
    }));
    const receipt=receiptSchema.parse({version:1,kind:"supplemental_self_check",sessionId:input.sessionId,
      candidateRunId:input.candidateRunId,candidateSha:input.candidateSha,contractHash:input.contractHash,verifierAttempt:input.verifierAttempt,
      definitions:input.definitions,originalEvidenceHash:originalEvidence(database,input),self:phase(input.selfEvidence,0),verifier:phase(input.verifierEvidence,input.selfEvidence.length)});
    if(!validateReceipt(database,receipt,input,false)) throw new Error("invalid");
    return receipt;
  } catch { throw new Error("supplemental_self_check_invalid"); }
}

/** Final readers require every individual lifecycle proof and empty settlement, not just a cached pass. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the persisted JSON boundary; receiptSchema parses every field before use.
export function readSupplementalSelfCheck(database:DatabaseSync,value:unknown,target:SupplementalSelfCheckTarget):CoverageCommand[]|null {
  try {
    const parsed=receiptSchema.safeParse(value);
    return parsed.success?validateReceipt(database,parsed.data,target,true):null;
  } catch { return null; }
}
