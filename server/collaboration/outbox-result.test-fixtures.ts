import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { z } from "zod";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { enqueueInboundCard } from "./outbox.ts";
import type { PlanStatusCard } from "./message-renderer.ts";
import * as resultCompletion from "./candidate-result-completion.ts";
import { candidateResultDeliveryProof, isCurrentCandidateResultBinding, readCandidateResultBinding,
  stageCandidateResultBinding } from "./candidate-result-evidence.ts";

/** Real Ledger, binding and transport-state tests; only independent technical verification is assumed passed. */
export function resultDeliveryFixture(root: string) {
  const repository=join(root,"repository");mkdirSync(repository);
  const service=startCollaborationService({dataDirectory:root,
    planning:{planner:{propose:validProposal},policy:{...policy,allowedRepositories:[repository]}}});
  const received=service.ingestDingTalkMessage({sourceEventId:"result-source",transportMessageId:"result-message",conversationId:"result-group",
    addressedToBot:true,text:"创建新任务：支持优先级筛选",receivedAt:1000,
    sender:{senderCorpId:"corp",senderStaffId:"contributor",senderId:"contributor",displayName:"Contributor"}});
  if(!received.workItemId) throw new Error("fixture_work_item_missing");
  const workItemId=received.workItemId;
  service.reviseWorkItemDefinition(workItemId,{goal:"支持优先级筛选",goalConfirmed:true,repository,
    acceptanceConditions:[{description:"能够筛选优先级",observation:"筛选列表正确"}],blockingAmbiguities:[]},2000);
  service.close();
  const path=join(root,"collaboration","collaboration.sqlite"),db=new DatabaseSync(path);db.exec("PRAGMA foreign_keys=ON");
  const modify=z.object({node_id:z.string(),assigned_agent_id:z.string()}).parse(db.prepare(
    "SELECT node_id,assigned_agent_id FROM collaboration_work_nodes WHERE work_item_id=? AND node_type='modify' AND active=1").get(workItemId));
  const work=z.object({version:z.number(),current_plan_revision:z.number(),snapshot_revision:z.number()}).parse(db.prepare(
    "SELECT w.version,w.current_plan_revision,p.snapshot_revision FROM collaboration_work_items w JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision WHERE w.id=?").get(workItemId));
  const target={candidateRunId:"result-run",candidateSha:"a".repeat(40),specHash:"c".repeat(64),specIdentityHash:"d".repeat(64),policyHash:"e".repeat(64)};
  db.prepare("INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES(?,?,?,?,1,?,'thread','turn','succeeded',?,?,'candidate',?,?,3000,3100)")
    .run(target.candidateRunId,workItemId,work.current_plan_revision,modify.node_id,modify.assigned_agent_id,repository,repository,"b".repeat(40),target.candidateSha);
  db.prepare("INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES('result-candidate',?,'target_tests_passed',?,?,'[\"src/page.ts\"]','[]','{}',3100)")
    .run(target.candidateRunId,"b".repeat(40),target.candidateSha);
  db.exec("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=3100 WHERE sent_at IS NULL");
  const card:PlanStatusCard={type:"plan_status_card",status:"verified_result",headline:"修改和回归已核对",workItemId,workItemVersion:work.version,
    planRevision:work.current_plan_revision,snapshotRevision:work.snapshot_revision,candidateSha:target.candidateSha,
    summary:"现在可以按优先级筛选，并与状态和搜索一起使用。自动回归和独立复核均已通过。"};
  const outbox=enqueueInboundCard(db,{sourceEventId:"result-status",aggregateType:"plan",aggregateId:workItemId,aggregateVersion:work.version,card,now:3200});
  stageCandidateResultBinding(db,{...target,outboxId:outbox.id,workItemId,workItemVersion:work.version,planRevision:work.current_plan_revision,
    snapshotRevision:work.snapshot_revision,baseSha:"b".repeat(40),now:3200});
  // The dispatcher is the subject. Technical acceptance has its own real candidate-to-result integration tests.
  const gate=vi.spyOn(resultCompletion,"isCurrentCandidateResultDelivery").mockImplementation((database,row)=>{
    const binding=readCandidateResultBinding(database,row.id);
    return binding!==null && isCurrentCandidateResultBinding(database,binding);
  });
  const lease=new InstanceLeaseCoordinator(db,"result-delivery-instance").acquire(4000,100000)!;
  const proof=(channel:"session"|"proactive"="session",confirmationKind:"business_response"|"accepted_receipt"="business_response")=>
    candidateResultDeliveryProof(card,"result-source",{outboxId:outbox.id,idempotencyKey:JSON.stringify([outbox.id,"dingtalk:event:result-status:ack"]),
      channel,destination:channel==="session"?"result-source":"open-result-group",confirmationKind});
  return {db,path,workItemId,target,card,outbox,lease,proof,gate};
}
