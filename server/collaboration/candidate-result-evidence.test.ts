import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { candidateResultDeliveryProof, confirmCandidateResultDelivery, readVerifiedCandidateResultReply, stageCandidateResultBinding } from "./candidate-result-evidence.ts";
import type { PlanStatusCard } from "./message-renderer.ts";

const databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(database=>database.close()));
function fixture(){
  const db=new DatabaseSync(":memory:");databases.push(db);
  db.exec(`
    CREATE TABLE collaboration_work_items(id TEXT,version INTEGER,conversation_id TEXT,current_plan_revision INTEGER,control_state TEXT,status TEXT,accepted_candidate_sha TEXT);
    CREATE TABLE collaboration_plan_revisions(work_item_id TEXT,revision INTEGER,snapshot_revision INTEGER);
    CREATE TABLE collaboration_runs(id TEXT,work_item_id TEXT,plan_revision INTEGER,attempt INTEGER,status TEXT);
    CREATE TABLE collaboration_candidates(run_id TEXT,base_sha TEXT,result_sha TEXT);
    CREATE TABLE collaboration_external_events(source TEXT,source_event_id TEXT,conversation_id TEXT);
    CREATE TABLE collaboration_outbox(id TEXT,aggregate_id TEXT,aggregate_version INTEGER,payload_json TEXT,delivery_state TEXT,sent_at INTEGER,superseded_at INTEGER,delivery_sequence INTEGER,dedupe_key TEXT);
    CREATE TABLE collaboration_candidate_result_bindings(outbox_id TEXT PRIMARY KEY,work_item_id TEXT,work_item_version INTEGER,conversation_id TEXT,plan_revision INTEGER,snapshot_revision INTEGER,
      candidate_run_id TEXT,base_sha TEXT,candidate_sha TEXT,spec_hash TEXT,spec_identity_hash TEXT,policy_hash TEXT,payload_hash TEXT,serialized_hash TEXT,created_at INTEGER);
    CREATE TABLE collaboration_candidate_result_deliveries(outbox_id TEXT PRIMARY KEY,payload_hash TEXT,serialized_hash TEXT,source_event_id TEXT,delivery_sequence INTEGER,sent_at INTEGER,idempotency_key_hash TEXT,channel TEXT,destination_hash TEXT,confirmation_kind TEXT);
  `);
  const sha="a".repeat(40),base="b".repeat(40);
  db.prepare("INSERT INTO collaboration_work_items VALUES(?,?,?,?,?,?,?)").run("work",3,"group",2,"active","collecting",null);
  db.prepare("INSERT INTO collaboration_plan_revisions VALUES(?,?,?)").run("work",2,4);
  db.prepare("INSERT INTO collaboration_runs VALUES(?,?,?,?,?)").run("run","work",2,1,"succeeded");
  db.prepare("INSERT INTO collaboration_candidates VALUES(?,?,?)").run("run",base,sha);
  db.prepare("INSERT INTO collaboration_external_events VALUES(?,?,?)").run("dingtalk","source","group");
  const card:PlanStatusCard={type:"plan_status_card",status:"verified_result",headline:"修改和回归已核对",workItemId:"work",workItemVersion:3,planRevision:2,snapshotRevision:4,candidateSha:sha,
    summary:"现在可以按全部、P0、P1、P2筛选，并与状态和搜索一起使用。自动回归和独立复核均已通过。"};
  db.prepare("INSERT INTO collaboration_outbox VALUES(?,?,?,?,?,?,?,?,?)").run("outbox","work",3,JSON.stringify(card),"pending",null,null,null,"dedupe");
  const target={candidateRunId:"run",candidateSha:sha,specHash:"c".repeat(64),specIdentityHash:"d".repeat(64),policyHash:"e".repeat(64)};
  const stage=()=>stageCandidateResultBinding(db,{...target,outboxId:"outbox",workItemId:"work",workItemVersion:3,planRevision:2,snapshotRevision:4,baseSha:base,now:100});
  const sent=()=>db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=200,delivery_sequence=1 WHERE id='outbox'").run();
  const transport={outboxId:"outbox",idempotencyKey:JSON.stringify(["outbox","dedupe"]),channel:"session" as const,destination:"source",confirmationKind:"business_response" as const};
  const confirm=()=>confirmCandidateResultDelivery(db,"outbox",candidateResultDeliveryProof(card,"source",transport),200);
  return{db,card,target,stage,sent,confirm,transport};
}
describe("fixed actual result delivery evidence",()=>{
  it("does not disguise a database failure as an isolated invalid result message",()=>{
    const f=fixture();f.db.exec("DROP TABLE collaboration_outbox");
    expect(f.stage).toThrow("no such table");
  });
  it("requires a bound two-sentence actual serialized message and a matching accepted send",()=>{
    const f=fixture();f.stage();expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
    f.sent();expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();f.confirm();
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toMatch(/^[a-f0-9]{64}$/u);
    expect(z.object({markdown:z.object({text:z.string()})}).parse(renderDingTalkSessionMessage(f.card)).markdown.text).toBe(f.card.summary);
  });
  it("does not accept a bare HTTP/sent status or a proof for another body or group",()=>{
    const f=fixture();f.stage();f.sent();
    confirmCandidateResultDelivery(f.db,"outbox",candidateResultDeliveryProof({...f.card,summary:"这不是本次结果。测试通过。"},"source",f.transport),200);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
    f.db.prepare("INSERT INTO collaboration_external_events VALUES(?,?,?)").run("dingtalk","other-source","other-group");
    confirmCandidateResultDelivery(f.db,"outbox",candidateResultDeliveryProof(f.card,"other-source",{...f.transport,destination:"other-source"}),200);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
  });
  it.each(["candidate","spec","policy","body","version","cancel"])("rejects changed %s at final read",what=>{
    const f=fixture();f.stage();f.sent();f.confirm();
    if(what==="candidate")f.db.exec("UPDATE collaboration_candidates SET result_sha='stale'");
    if(what==="spec")f.target.specHash="f".repeat(64);
    if(what==="policy")f.target.policyHash="f".repeat(64);
    if(what==="body")f.db.prepare("UPDATE collaboration_outbox SET payload_json=?").run(JSON.stringify({...f.card,summary:"其他修改。检查通过。"}));
    if(what==="version")f.db.exec("UPDATE collaboration_work_items SET version=4");
    if(what==="cancel")f.db.exec("UPDATE collaboration_work_items SET control_state='cancelled'");
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
  });
  it("keeps the same proof readable after the matching completion CAS and rejects other accepted candidates",()=>{
    const f=fixture();f.stage();f.sent();f.confirm();
    f.db.prepare("UPDATE collaboration_work_items SET version=4,status='accepted',control_state='accepted',accepted_candidate_sha=?").run(f.target.candidateSha);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).not.toBeNull();
    f.db.exec("UPDATE collaboration_work_items SET accepted_candidate_sha='different'");expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
  });
  it.each(["只有一句。","第一句。第二句。第三句。第四句。","已经修改完成。测试通过。","WI-1234 已执行。检查通过。"])("refuses unsuitable final message %s",summary=>{
    const f=fixture();f.db.prepare("UPDATE collaboration_outbox SET payload_json=?").run(JSON.stringify({...f.card,summary}));expect(f.stage).toThrow("candidate_result_binding_invalid");
  });
  it("records a late accepted send without restoring a cancelled work item",()=>{
    const f=fixture();f.stage();f.db.exec("UPDATE collaboration_work_items SET control_state='cancelled'");f.sent();f.confirm();
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_result_deliveries").get()).toEqual({n:1});
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
  });
  it("staging and confirmation replay preserve a single immutable binding and delivery",()=>{
    const f=fixture();f.stage();f.stage();f.sent();f.confirm();f.confirm();
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_result_bindings").get()).toEqual({n:1});
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_result_deliveries").get()).toEqual({n:1});
  });
  it("uses the same canonical digest when an equivalent card has a different property insertion order",()=>{
    const f=fixture();
    // SAFETY: Only the property order of the already typed fixture card is changed; keys and values are identical.
    const reordered=Object.fromEntries(Object.entries(f.card).reverse()) as PlanStatusCard;
    f.db.prepare("UPDATE collaboration_outbox SET payload_json=?").run(JSON.stringify(reordered));f.stage();f.sent();
    confirmCandidateResultDelivery(f.db,"outbox",candidateResultDeliveryProof(reordered,"source",f.transport),200);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).not.toBeNull();
  });
  it.each(["outboxId","idempotencyKey"] as const)("rejects a send proof for another %s",key=>{
    const f=fixture();f.stage();f.sent();
    confirmCandidateResultDelivery(f.db,"outbox",candidateResultDeliveryProof(f.card,"source",{...f.transport,[key]:"different"}),200);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
  });
  it("allows a current-version delivery while preserving the superseded old binding",()=>{
    const f=fixture();f.stage();
    f.db.exec("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=150; UPDATE collaboration_work_items SET version=5");
    const card={...f.card,workItemVersion:5};
    f.db.prepare("INSERT INTO collaboration_outbox VALUES(?,?,?,?,?,?,?,?,?)").run("outbox-2","work",5,JSON.stringify(card),"pending",null,null,null,"dedupe-2");
    stageCandidateResultBinding(f.db,{...f.target,outboxId:"outbox-2",workItemId:"work",workItemVersion:5,planRevision:2,snapshotRevision:4,baseSha:"b".repeat(40),now:160});
    f.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=200,delivery_sequence=2 WHERE id='outbox-2'");
    confirmCandidateResultDelivery(f.db,"outbox-2",candidateResultDeliveryProof(card,"source",{...f.transport,outboxId:"outbox-2",idempotencyKey:JSON.stringify(["outbox-2","dedupe-2"])}),200);
    expect(readVerifiedCandidateResultReply(f.db,f.target)).not.toBeNull();
    expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_result_bindings").get()).toEqual({n:2});
  });
});
