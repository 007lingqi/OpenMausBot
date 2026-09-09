import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { candidateHasPassedTechnicalReview, readCandidateTechnicalAcceptance } from "./candidate-verification.ts";
import { acceptanceConditionHash } from "./acceptance-assertions.ts";
import { isCurrentCandidateResultBinding, readCandidateResultBinding, readVerifiedCandidateResultReply, stageCandidateResultBinding } from "./candidate-result-evidence.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import type { PlanStatusCard } from "./message-renderer.ts";
import { verifiedResultSummary } from "./verified-result-copy.ts";
import { candidateIsSupersededByRevision } from "./candidate-revision.ts";

/** No completed claim is made here. It reports only the feature assertions and two actual test stages already verified. */
export function prepareVerifiedCandidateResult(db:DatabaseSync,candidateRunId:string,now:number):"not_required"|"pending"|"delivered" {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(db);
    const candidate=z.object({result_sha:z.string()}).optional().parse(db.prepare("SELECT result_sha FROM collaboration_candidates WHERE run_id=?").get(candidateRunId));
    const technical=candidate?readCandidateTechnicalAcceptance(db,candidateRunId,candidate.result_sha):null;
    if(!technical || !technical.policy.conditions.some(condition=>condition.requirements.some(requirement=>requirement.type==="reply"))){db.exec("COMMIT");return "not_required";}
    const target={candidateRunId,candidateSha:candidate!.result_sha,specHash:technical.specHash,specIdentityHash:technical.specIdentityHash,policyHash:technical.policyHash};
    if(readVerifiedCandidateResultReply(db,target)){db.exec("COMMIT");return "delivered";}
    const workItem=z.object({version:z.number().int().positive()}).parse(db.prepare("SELECT version FROM collaboration_work_items WHERE id=?").get(technical.workItemId));
    const existing=db.prepare("SELECT outbox_id FROM collaboration_candidate_result_bindings WHERE candidate_run_id=? AND spec_hash=? AND policy_hash=? AND work_item_version=?")
      .get(candidateRunId,technical.specHash,technical.policyHash,workItem.version);
    if(existing){db.exec("COMMIT");return "pending";}
    const snapshot=readLatestWorkItemSnapshot(db,technical.workItemId);
    if(!snapshot || snapshot.revision!==technical.snapshotRevision) throw new Error("candidate_result_snapshot_changed");
    const featureHashes=new Set(technical.policy.conditions.filter(condition=>condition.requirements.some(requirement=>requirement.type==="assertions")).map(condition=>condition.conditionHash));
    const summary=verifiedResultSummary(snapshot.acceptanceConditions.filter(condition=>featureHashes.has(acceptanceConditionHash(condition)))
      .map(condition=>condition.description));
    const card:PlanStatusCard={type:"plan_status_card",headline:"修改和回归已核对",status:"verified_result",workItemId:technical.workItemId,workItemVersion:workItem.version,
      planRevision:technical.planRevision,snapshotRevision:technical.snapshotRevision,candidateSha:target.candidateSha,summary};
    const outbox=enqueueInboundCard(db,{sourceEventId:`candidate-result:${candidateRunId}:v${workItem.version}:${technical.specHash}`,aggregateType:"plan",aggregateId:technical.workItemId,
      aggregateVersion:workItem.version,card,supersessionKey:`work-item:${technical.workItemId}:execution-status`,now});
    stageCandidateResultBinding(db,{...target,outboxId:outbox.id,workItemId:technical.workItemId,workItemVersion:workItem.version,planRevision:technical.planRevision,
      snapshotRevision:technical.snapshotRevision,baseSha:technical.baseSha,now});
    db.exec("COMMIT");return "pending";
  }catch(error){db.exec("ROLLBACK");throw error;}
}

/** Called immediately before transport. A typed result without its fixed binding cannot be sent. */
export function isCurrentCandidateResultDelivery(db:DatabaseSync,row:{id:string;payload_json:string}):boolean {
  const payload=z.object({type:z.string().optional(),status:z.string().optional(),workItemId:z.string().optional(),candidateSha:z.string().optional()}).safeParse(JSON.parse(row.payload_json));
  if(payload.success && payload.data.type==="plan_status_card" && payload.data.status==="candidate_ready" && payload.data.workItemId && payload.data.candidateSha) {
    const candidates=z.array(z.object({run_id:z.string()})).parse(db.prepare("SELECT c.run_id FROM collaboration_candidates c JOIN collaboration_runs r ON r.id=c.run_id WHERE r.work_item_id=? AND c.result_sha=?")
      .all(payload.data.workItemId,payload.data.candidateSha));
    if(candidates.some(candidate=>candidateIsSupersededByRevision(db,candidate.run_id,payload.data.candidateSha!))) return false;
  }
  if(!payload.success || payload.data.type!=="plan_status_card" || payload.data.status!=="verified_result") return true;
  const binding=readCandidateResultBinding(db,row.id);
  if(!binding || !isCurrentCandidateResultBinding(db,binding) || !candidateHasPassedTechnicalReview(db,binding.candidate_run_id,binding.candidate_sha)) return false;
  const current=readCandidateTechnicalAcceptance(db,binding.candidate_run_id,binding.candidate_sha);
  return !!current && current.specHash===binding.spec_hash && current.specIdentityHash===binding.spec_identity_hash && current.policyHash===binding.policy_hash;
}
