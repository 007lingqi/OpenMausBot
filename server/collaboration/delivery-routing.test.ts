import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollaborationService } from "./service.ts";
import { createDingTalkDelivery } from "../collaboration-headless.ts";
import { DingTalkSessionReplyRegistry } from "../integrations/dingtalk/reply-router.ts";
import { SecureDingTalkCredentialFileProvider } from "./operations/credentials.ts";
import type { OutboxDeliveryPort } from "./outbox.ts";
import { proactiveConversationRoutes } from "./delivery-routing.ts";
import { requestDeliveryReview } from "./delivery-review.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { recoverNaturalIntake } from "./natural-intake-recovery.ts";
import { recoverAttachmentProjection } from "./attachment-projection-recovery.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { CollaborationHeadlessRuntime } from "./operations/runtime.ts";
import { parseDingTalkOwnerTextCommand, parseDingTalkOwnerTextAction } from "../integrations/dingtalk/text-actions.ts";
import { ModelNaturalIntakeInterpreter } from "./natural-intake.ts";
import { validProposal, policy } from "./planner.test-fixtures.ts";
import { approvalPayloadHash } from "./approval-presentation.ts";
import { FetchDingTalkInteractiveCardSender } from "../integrations/dingtalk/interactive-card-sender.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { resultDeliveryFixture } from "./outbox-result.test-fixtures.ts";
import { readVerifiedCandidateResultReply } from "./candidate-result-evidence.ts";
import { z } from "zod";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(environment: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), "delivery-routing-")); roots.push(root);
  const service = startCollaborationService({ dataDirectory: root });
  for (const group of ["group-a", "group-b"]) service.ingestDingTalkMessage({
    sourceEventId: `event-${group}`, transportMessageId: `event-${group}`, conversationId: group,
    addressedToBot: true, text: `修正${group}保存提示`, receivedAt: 1000,
    sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Test" },
  });
  service.close();
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const message = (event: string): Parameters<OutboxDeliveryPort["deliver"]>[0] => {
    const row = db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id=?").get(event) as Record<string, string | number>;
    return { id: String(row.id), source: "dingtalk", dedupeKey: String(row.dedupe_key), aggregateType: "work_item",
      aggregateId: String(row.aggregate_id), aggregateVersion: Number(row.aggregate_version), kind: "primary_status_card", payload: JSON.parse(String(row.payload_json)) };
  };
  vi.spyOn(SecureDingTalkCredentialFileProvider.prototype, "load").mockReturnValue({ clientId: "synthetic-client", clientSecret: "synthetic-secret-at-least-32-bytes-long" });
  const destinations: string[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
    if (String(url).endsWith("/groupMessages/query")) return new Response(JSON.stringify({ sendStatus: "SUCCESS" }));
    if (String(url).includes("groupMessages")) destinations.push(JSON.parse(String(init?.body)).openConversationId);
    return new Response(JSON.stringify({ errcode: 0, processQueryKey: "synthetic-receipt" }));
  });
  vi.stubGlobal("fetch", fetcher);
  const sessions = new DingTalkSessionReplyRegistry();
  return { root, db, message, destinations, fetcher, sessions, delivery: createDingTalkDelivery(sessions, environment, root) };
}

function verifiedResultMessage(f: ReturnType<typeof fixture>): Parameters<OutboxDeliveryPort["deliver"]>[0] {
  return { ...f.message("event-group-a"), aggregateType: "plan", kind: "plan_status_card", payload: {
    type: "plan_status_card", status: "verified_result", headline: "修改和回归已核对",
    workItemId: f.message("event-group-a").aggregateId, workItemVersion: 1, planRevision: 1, snapshotRevision: 1,
    candidateSha: "a".repeat(40), summary: "现在可以按优先级筛选，并与状态和搜索一起使用。自动回归和独立复核均已通过。",
  } };
}
const deliveryDigest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("actual verified-result delivery proofs", () => {
  it("records an actual business-success reply without reviving a candidate cancelled while fetch was pending",async()=>{
    const root=mkdtempSync(join(tmpdir(),"result-fetch-cancel-"));roots.push(root);const f=resultDeliveryFixture(root);
    const requests:string[]=[];
    vi.stubGlobal("fetch",async(_url:string|URL,init?:RequestInit)=>{
      requests.push(String(init?.body));
      f.db.prepare("UPDATE collaboration_work_items SET control_state='cancelled',status='cancelled' WHERE id=?").run(f.workItemId);
      return new Response(JSON.stringify({errcode:0}));
    });
    const sessions=new DingTalkSessionReplyRegistry();sessions.capture({sourceEventId:"result-source",
      webhookUrl:"https://oapi.dingtalk.com/robot/send?access_token=fixture-private",expiresAt:Date.now()+60000});
    try{
      const dispatcher=new OutboxDispatcher(f.db,createDingTalkDelivery(sessions,{},root),{maxAttempts:3,claimTtlMs:1000,baseBackoffMs:10,maxBackoffMs:100});
      expect(await dispatcher.dispatchOne(f.lease,4001)).toMatchObject({state:"sent"});
      expect(requests).toEqual([JSON.stringify(renderDingTalkSessionMessage(f.card))]);
      expect(f.db.prepare("SELECT confirmation_kind,channel FROM collaboration_candidate_result_deliveries WHERE outbox_id=?").get(f.outbox.id))
        .toEqual({confirmation_kind:"business_response",channel:"session"});
      expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
      expect(f.db.prepare("SELECT status,control_state FROM collaboration_work_items WHERE id=?").get(f.workItemId)).toEqual({status:"cancelled",control_state:"cancelled"});
    }finally{f.db.close();}
  });
  it.each(["session", "proactive"] as const)("binds the actual serialized %s request only after business success", async channel => {
    const f=fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-a" });
    try {
      if(channel==="session") f.sessions.capture({sourceEventId:"event-group-a",webhookUrl:"https://oapi.dingtalk.com/robot/send?access_token=fixture-private-webhook",expiresAt:Date.now()+60000});
      const message=verifiedResultMessage(f),serialized=renderDingTalkSessionMessage(message.payload);
      const delivered=await f.delivery.deliver(message);
      expect(delivered).toEqual({outcome:"sent",candidateResultDelivery:{outboxId:message.id,
        idempotencyKeyHash:deliveryDigest(JSON.stringify([message.id,message.dedupeKey])),sourceEventId:"event-group-a",
        payloadHash:deliveryDigest(JSON.stringify(message.payload)),serializedHash:deliveryDigest(JSON.stringify(serialized)),
        channel,destinationHash:deliveryDigest(`${channel}:${channel==="session"?"event-group-a":"open-a"}`),confirmationKind:"business_response"}});
      const request=f.fetcher.mock.calls.find(([url])=>channel==="session"?String(url).includes("/robot/send?"):String(url).endsWith("/groupMessages/send"));
      expect(request).toBeDefined();
      if(channel==="session") expect(JSON.parse(String(request?.[1]?.body))).toEqual(serialized);
      else expect(JSON.parse(String(request?.[1]?.body))).toEqual({msgParam:JSON.stringify(serialized.markdown),msgKey:"sampleMarkdown",openConversationId:"open-a",robotCode:"synthetic-client"});
      expect(JSON.stringify(delivered)).not.toMatch(/fixture-private-webhook|synthetic-token|synthetic-receipt/u);
    } finally {f.db.close();}
  });
  it.each([{}, {errcode:40035}, {errcode:0,success:false}])("does not issue a result proof for HTTP 200 without consistent business success: %j", response => {
    const f=fixture({});
    f.sessions.capture({sourceEventId:"event-group-a",webhookUrl:"https://oapi.dingtalk.com/robot/send?access_token=fixture",expiresAt:Date.now()+60000});
    f.fetcher.mockImplementation(async()=>new Response(JSON.stringify(response),{status:200}));
    return f.delivery.deliver(verifiedResultMessage(f)).then(result=>{
      expect(result.outcome).not.toBe("sent");expect(result).not.toHaveProperty("candidateResultDelivery");
    }).finally(()=>f.db.close());
  });
  it("reconciles an exactly bound accepted receipt without resending and rejects body, key or destination substitutions", async () => {
    const environment={OMB_DINGTALK_ALLOWED_CONVERSATION_IDS:"group-a",OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID:"open-a"};
    const f=fixture(environment);
    try {
      const message=verifiedResultMessage(f);await f.delivery.deliver(message);
      const sendCount=()=>f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/groupMessages/send")).length;
      const restarted=createDingTalkDelivery(new DingTalkSessionReplyRegistry(),environment,f.root);
      for(let index=0;index<2;index++) expect(await restarted.reconcile!(message)).toMatchObject({outcome:"sent",candidateResultDelivery:{
        outboxId:message.id,channel:"proactive",destinationHash:deliveryDigest("proactive:open-a"),confirmationKind:"accepted_receipt"}});
      expect(await restarted.deliver(message)).toMatchObject({outcome:"sent",candidateResultDelivery:{confirmationKind:"accepted_receipt"}});
      // Force the outer receipt read to miss once; the real sender/vault/query path must still bind the recovered proof.
      vi.spyOn(FetchDingTalkInteractiveCardSender.prototype,"queryAccepted").mockResolvedValueOnce(null);
      expect(await restarted.deliver(message)).toMatchObject({outcome:"sent",candidateResultDelivery:{confirmationKind:"accepted_receipt"}});
      expect(sendCount()).toBe(1);
      const changedBody={...message,payload:{...message.payload,summary:"这是不同的结果。检查通过。"}};
      expect(await restarted.reconcile!(changedBody)).toMatchObject({outcome:"unknown"});
      expect(await restarted.reconcile!({...message,dedupeKey:`${message.dedupeKey}-different`})).toBeNull();
      const otherDestination=createDingTalkDelivery(new DingTalkSessionReplyRegistry(),{...environment,OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID:"open-other"},f.root);
      expect(await otherDestination.reconcile!(message)).toMatchObject({outcome:"unknown"});
      expect(sendCount()).toBe(1);
    } finally {f.db.close();}
  });
});

describe("production delivery group routing", () => {
  it.each(["work_item", "plan"] as const)("routes a derived %s reply through the one real parent session", async aggregateType => {
    const f = fixture({});
    const service = startCollaborationService({ dataDirectory: f.root, planning: { planner: { propose: validProposal }, policy,
      naturalIntake: new ModelNaturalIntakeInterpreter({ async complete(envelope) {
        const input = JSON.parse(envelope.user);
        if (z.object({ properties: z.object({ allIntentsCovered: z.object({}).passthrough() }).passthrough() }).passthrough()
          .safeParse(envelope.responseSchema).success) return { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
        if (input.event) return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
          goal: null, acceptance: [], answers: [], questions: [{ key: "expected", question: "提示应显示什么？", blocksPlanning: true, quote: input.event.text }] };
        const part = (text: string) => ({ version: 1, sourceEventId: input.sourceEventId, intent: "new_request", targetWorkItemId: null,
          replySourceEventId: null, quote: text, confidence: "high", text });
        return { version: 1, sourceEventId: input.sourceEventId, intent: "clarify", targetWorkItemId: null,
          replySourceEventId: null, quote: input.text, confidence: "high", parts: [part("新增登录提示"), part("新增支付提示")] };
      } }) } });
    try {
      service.ingestDingTalkMessage({ sourceEventId: "real-parent", transportMessageId: "real-parent", conversationId: "group-a", addressedToBot: true,
        text: "新增登录提示，新增支付提示", sender: { senderId: "staff", senderCorpId: "corp", senderStaffId: "staff", displayName: "Test" } });
      await service.processNaturalIntake();
      const child = z.object({ source_event_id: z.string(), work_item_id: z.string() }).parse(f.db.prepare("SELECT e.source_event_id,e.work_item_id FROM collaboration_turn_parts p JOIN collaboration_external_events e ON e.id=p.child_event_id ORDER BY ordinal LIMIT 1").get());
      expect(child).toBeDefined();
      f.sessions.capture({ sourceEventId: "real-parent", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=synthetic", expiresAt: Date.now() + 60000 });
      const outgoing = { ...f.message("event-group-a"), id: "derived-reply", aggregateType, aggregateId: child.work_item_id,
        dedupeKey: `dingtalk:event:${child.source_event_id}:ack` };
      expect(await f.delivery.deliver(outgoing)).toMatchObject({ outcome: "sent" });
      expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/robot/send?")).length).toBe(1);
      f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ errcode: 40035 })));
      expect(await f.delivery.deliver({ ...outgoing, id: "failed-reply" })).not.toMatchObject({ outcome: "sent" });
    } finally { service.close(); f.db.close(); }
  });
  it("delivers a natural approval reply to its persisted original group without an external requirement event", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b",
      OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' });
    const service = startCollaborationService({ dataDirectory: f.root });
    try {
      expect(service.performNaturalApproval({ sourceEventId: "natural-control", transportMessageId: "transport", conversationId: "group-a",
        addressedToBot: true, text: "批准这次改动", receivedAt: 1200,
        sender: { senderId: "sender", senderCorpId: "corp", senderStaffId: "staff", displayName: "Test" } }, 1200))
        .toMatchObject({ allowed: false });
      expect(f.db.prepare("SELECT 1 FROM collaboration_external_events WHERE source_event_id='natural-control'").get()).toBeUndefined();
      const row = f.db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id='natural-control'").get() as Record<string, string | number>;
      const reply: Parameters<OutboxDeliveryPort["deliver"]>[0] = { id: String(row.id), source: "dingtalk", dedupeKey: String(row.dedupe_key),
        aggregateType: "association", aggregateId: String(row.aggregate_id), aggregateVersion: 1,
        kind: "command_status_card", payload: JSON.parse(String(row.payload_json)) };
      expect(await f.delivery.deliver(reply)).toMatchObject({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-a"]);
    } finally { service.close(); f.db.close(); }
  });

  it("does not attest a cached receipt discovered between the outer query and sender query", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-a" });
    try {
      vi.spyOn(FetchDingTalkInteractiveCardSender.prototype, "queryAccepted").mockResolvedValueOnce(null)
        .mockResolvedValue({ ok: true, status: 200, recovered: true });
      expect(await f.delivery.deliver({ ...f.message("event-group-a"), aggregateType: "plan", kind: "plan_status_card",
        payload: { type: "plan_status_card", status: "candidate_ready", headline: "修改完成，需要负责人确认",
          workItemId: f.message("event-group-a").aggregateId, workItemVersion: 1, candidateSha: "2".repeat(40), approvalRequired: true } }))
        .toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual([]);
    } finally { f.db.close(); }
  });
  it.each(["session", "proactive"])("attests only a confirmed Markdown approval send via %s, never its later receipt query", async channel => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    try {
      if (channel === "session") f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=synthetic", expiresAt: Date.now() + 60000 });
      const message: Parameters<OutboxDeliveryPort["deliver"]>[0] = { ...f.message("event-group-a"), aggregateType: "plan", kind: "plan_status_card",
        payload: { type: "plan_status_card", status: "candidate_ready", headline: "修改完成，需要负责人确认",
          workItemId: f.message("event-group-a").aggregateId, workItemVersion: 1, candidateSha: "2".repeat(40), approvalRequired: true,
          summary: "登录提示已调整，涉及权限逻辑，需要负责人确认。" } };
      expect(await f.delivery.deliver(message)).toEqual({ outcome: "sent", approvalDelivery: {
        sourceEventId: "event-group-a", payloadHash: approvalPayloadHash(message.payload),
      } });
      if (channel === "proactive") {
        expect(await f.delivery.reconcile!(message)).toEqual({ outcome: "sent" });
        expect(await f.delivery.deliver(message)).toEqual({ outcome: "sent" });
        expect(f.destinations).toEqual(["open-a"]);
      }
    } finally { f.db.close(); }
  });
  it("does not attest HTTP success when DingTalk rejects the approval message", async () => {
    const f = fixture({});
    try {
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=synthetic", expiresAt: Date.now() + 60000 });
      f.fetcher.mockResolvedValue(new Response(JSON.stringify({ errcode: 40035, errmsg: "rejected" })));
      const result = await f.delivery.deliver({ ...f.message("event-group-a"), aggregateType: "plan", kind: "plan_status_card",
        payload: { type: "plan_status_card", status: "candidate_ready", headline: "修改完成，需要负责人确认",
          workItemId: f.message("event-group-a").aggregateId, workItemVersion: 1, candidateSha: "2".repeat(40), approvalRequired: true } });
      expect(result).toMatchObject({ outcome: "permanent_failure" });
      expect(result).not.toHaveProperty("approvalDelivery");
    } finally { f.db.close(); }
  });
  it("routes a deferred read-only reply to its durable original group without a Work Item or session", async () => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    const service = startCollaborationService({ dataDirectory: f.root, planning: { planner: { propose: validProposal }, policy,
      naturalIntake: new ModelNaturalIntakeInterpreter({ async complete(request) {
        const input = JSON.parse(request.user);
        return { version: 1, sourceEventId: input.sourceEventId, intent: "acknowledgement", targetWorkItemId: null, replySourceEventId: null, quote: input.text, confidence: "high" };
      } }) } });
    try {
      service.ingestDingTalkMessage({ sourceEventId: "thanks", transportMessageId: "thanks", conversationId: "group-b", addressedToBot: true,
        text: "谢谢。", sender: { senderId: "staff", senderCorpId: "corp", senderStaffId: "staff", displayName: "Test" } });
      await service.processNaturalIntake();
      const message = { ...f.message("conversation:thanks"), aggregateType: "association" as const };
      expect(f.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='thanks'").get()).toEqual({ work_item_id: null });
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver(message)).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
      expect(await f.delivery.deliver({ ...message, id: "forged", aggregateId: "missing" })).not.toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { service.close(); f.db.close(); }
  });
  it("reconstructs query-only delivery without resending through an available session", async () => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env); let state = "PROCESSING";
    f.fetcher.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      if (String(url).endsWith("/query")) return new Response(JSON.stringify({ sendStatus: state }));
      return new Response(JSON.stringify({ processQueryKey: "private-query-key" }));
    });
    try {
      const message = f.message("event-group-a");
      expect(await f.delivery.deliver(message)).toMatchObject({ outcome: "unknown" });
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=synthetic", expiresAt: Date.now() + 60000 });
      state = "SUCCESS";
      const rebuilt = createDingTalkDelivery(f.sessions, env, f.root);
      expect(await rebuilt.reconcile!(message)).toEqual({ outcome: "sent" });
      expect(await rebuilt.deliver(message)).toEqual({ outcome: "sent" });
      // Removing the route must not turn an accepted proactive send into a fresh session send.
      expect(await createDingTalkDelivery(f.sessions, {}, f.root).deliver(message)).toMatchObject({ outcome: "unknown" });
      const urls = f.fetcher.mock.calls.map(([url]) => String(url));
      expect(urls.filter(url => url.endsWith("/groupMessages/send"))).toHaveLength(1);
      expect(urls.some(url => url.includes("oapi.dingtalk.com"))).toBe(false);
      expect(JSON.stringify(f.db.prepare("SELECT * FROM collaboration_outbox").all())).not.toContain("private-query-key");
    } finally { f.db.close(); }
  });
  it("keeps an unused session path available without proactive credentials", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-a" });
    try {
      vi.spyOn(SecureDingTalkCredentialFileProvider.prototype, "load").mockReturnValue(null);
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=synthetic", expiresAt: Date.now() + 60000 });
      expect(await f.delivery.deliver(f.message("event-group-a"))).toEqual({ outcome: "sent" });
    } finally { f.db.close(); }
  });
  it("keeps an accepted but processing reply unconfirmed across dispatcher restart without sending again", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' });
    let sends = 0;
    f.fetcher.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      if (String(url).endsWith("/send")) { sends++; return new Response(JSON.stringify({ processQueryKey: "synthetic-query" })); }
      return new Response(JSON.stringify({ sendStatus: "PROCESSING" }));
    });
    try {
      f.db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=1000 WHERE source_event_id='event-group-b'").run();
      const lease = new InstanceLeaseCoordinator(f.db, "query-test").acquire(2000, 10000)!;
      const options = { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 10, maxBackoffMs: 100 };
      expect(await new OutboxDispatcher(f.db, f.delivery, options).dispatchOne(lease, 2000)).toMatchObject({ state: "dead_letter" });
      expect(f.db.prepare("SELECT sent_at,delivery_state FROM collaboration_outbox WHERE source_event_id='event-group-a'").get()).toEqual({ sent_at: null, delivery_state: "dead_letter" });
      expect(await new OutboxDispatcher(f.db, f.delivery, options).dispatchOne(lease, 3000)).toMatchObject({ operation: "reconcile", state: "retry_scheduled" });
      f.fetcher.mockImplementation(async (url: string | URL) => {
        if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
        if (String(url).endsWith("/send")) sends++;
        return new Response(JSON.stringify({ sendStatus: "SUCCESS" }));
      });
      expect(await new OutboxDispatcher(f.db, createDingTalkDelivery(f.sessions, {
        OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}',
      }, f.root), options).dispatchOne(lease, 4000)).toMatchObject({ operation: "reconcile", state: "sent" });
      expect(sends).toBe(1);
      expect(JSON.stringify(f.db.prepare("SELECT last_error FROM collaboration_outbox").all())).not.toContain("synthetic-query");
    } finally { f.db.close(); }
  });
  it.each(["pause", "resume", "retry", "cancel", "approve_candidate", "reject_candidate"] as const)("rolls back %s decision if its reply cannot be saved", async commandName => {
    const f = fixture({});
    const owner = new LocalOwnerRegistry(join(f.root, "collaboration", "collaboration.sqlite"));
    try { owner.bootstrap({ senderCorpId: "corp", senderStaffId: "staff", now: 1000 }); } finally { owner.close(); }
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const command = { transportEventId: "atomic-command", transportMessageId: "atomic-command", conversationId: "group-b", command: commandName,
        workItemId: f.message("event-group-a").aggregateId, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Owner" } };
      const state = f.db.prepare("SELECT * FROM collaboration_work_items ORDER BY id").all();
      const audits = f.db.prepare("SELECT count(*) n FROM collaboration_audit_events").get();
      f.db.exec("CREATE TRIGGER fail_direct_reply BEFORE INSERT ON collaboration_outbox WHEN NEW.source_event_id='atomic-command' BEGIN SELECT RAISE(ABORT,'synthetic_direct_reply_failure'); END");
      expect(() => runtime.performDingTalkOwnerTextCommand(command)).toThrow("synthetic_direct_reply_failure");
      expect(f.db.prepare("SELECT * FROM collaboration_work_items ORDER BY id").all()).toEqual(state);
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_audit_events").get()).toEqual(audits);
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands WHERE source_event_id='atomic-command'").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("preserves rejected token text actions and their source after restart, without executing altered replay", async () => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    let runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const request = { sourceEventId: "token-request", transportMessageId: "token-request", conversationId: "group-b", addressedToBot: true,
        text: "接受 synthetic_unrecognized_action_token_1234567890", receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      const action = parseDingTalkOwnerTextAction(request)!;
      const first = runtime.performDingTalkOwnerAction(action);
      expect(first.allowed).toBe(false);
      expect(runtime.performDingTalkOwnerAction(action)).toEqual({ ...first, duplicate: true });
      expect(() => runtime.performDingTalkOwnerAction({ ...action, actionToken: "other-token" })).toThrow("event_conflict");
      for (const changed of [{ ...action, conversationId: "group-a" }, { ...action, origin: "card" as const },
        { ...action, sender: { ...action.sender, senderStaffId: "other" } }]) {
        expect(() => runtime.performDingTalkOwnerAction(changed)).toThrow("event_conflict");
      }
      expect(() => runtime.performDingTalkOwnerTextCommand({ transportEventId: action.transportEventId, transportMessageId: action.transportMessageId,
        command: "status", workItemId: f.message("event-group-a").aggregateId, sender: action.sender, receivedAt: 2100 })).toThrow("event_conflict");
      expect(() => runtime.ingestDingTalkMessage({ ...request, text: "新需求" })).toThrow("event_conflict");
      await runtime.stop();
      runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
      await runtime.start();
      expect(runtime.performDingTalkOwnerAction(action)).toEqual({ ...first, duplicate: true });
      await runtime.stop();
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver({ ...f.message("token-request"), aggregateType: "association" })).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("deduplicates a card callback without guessing a group or creating an outbound message", async () => {
    const f = fixture({});
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const action = { transportEventId: "card-request", transportMessageId: "card-request", actionToken: "invalid-card-token", origin: "card" as const,
        conversationId: "unproven-card-field", receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      const first = runtime.performDingTalkOwnerAction(action);
      expect(first.allowed).toBe(false);
      expect(runtime.performDingTalkOwnerAction(action)).toEqual({ ...first, duplicate: true });
      const receipt = f.db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id='card-request'").get() as { outcome_json: string };
      expect(JSON.parse(receipt.outcome_json)).toMatchObject({ kind: "token_action", outcome: { allowed: false } });
      expect(receipt.outcome_json).not.toContain("unproven-card-field");
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE source_event_id='card-request'").get()).toEqual({ n: 0 });
    } finally { await runtime.stop(); f.db.close(); }
  });
  it.each(["status", "refresh_approval"] as const)("persists %s outcome and group, preserving denial across restart and rejecting rewritten replay", async commandName => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    let runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const command = { transportEventId: "query-origin", transportMessageId: "query-origin", conversationId: "group-b", command: commandName,
        workItemId: f.message("event-group-a").aggregateId, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      const first = runtime.performDingTalkOwnerTextCommand(command);
      expect(first.allowed).toBe(commandName === "status");
      expect(runtime.performDingTalkOwnerTextCommand(command)).toEqual({ ...first, duplicate: true });
      const rows = f.db.prepare("SELECT * FROM collaboration_owner_text_commands WHERE source_event_id='query-origin'").all();
      expect(rows).toHaveLength(1);
      for (const altered of [{ ...command, conversationId: "group-a" }, { ...command, workItemId: "WI-AAAAAAAAAAAA" },
        { ...command, sender: { ...command.sender, senderStaffId: "other" } }, { ...command, command: "pause" as const }]) {
        expect(() => runtime.performDingTalkOwnerTextCommand(altered)).toThrow("event_conflict");
      }
      expect(() => runtime.ingestDingTalkMessage({ sourceEventId: command.transportEventId, transportMessageId: command.transportMessageId,
        conversationId: "group-b", text: "新的工作", addressedToBot: true, sender: command.sender })).toThrow("event_conflict");
      expect(() => runtime.performDingTalkOwnerAction({ transportEventId: command.transportEventId, transportMessageId: command.transportMessageId,
        actionToken: "synthetic-unused-token", sender: command.sender, receivedAt: 2100, origin: "text" })).toThrow("owner_query_event_conflict");
      await runtime.stop();
      runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
      await runtime.start();
      expect(runtime.performDingTalkOwnerTextCommand(command)).toEqual({ ...first, duplicate: true });
      expect(f.db.prepare("SELECT * FROM collaboration_owner_text_commands WHERE source_event_id='query-origin'").all()).toEqual(rows);
      await runtime.stop();
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver(f.message("query-origin"))).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("does not turn an old reply without a query receipt into a new success or group binding", async () => {
    const f = fixture({});
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const reply = f.db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id='event-group-a'").get() as Record<string, string | number>;
      f.db.prepare("INSERT INTO collaboration_outbox(id,source,source_event_id,aggregate_type,aggregate_id,aggregate_version,kind,dedupe_key,payload_json,created_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run("legacy-query", "dingtalk", "legacy-query", "work_item", reply.aggregate_id, reply.aggregate_version, reply.kind, "dingtalk:event:legacy-query:ack", reply.payload_json, 2000, 2000);
      const before = f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      expect(runtime.performDingTalkOwnerTextCommand({ transportEventId: "legacy-query", transportMessageId: "legacy-query", conversationId: "group-b",
        command: "refresh_approval", workItemId: String(reply.aggregate_id), receivedAt: 3000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } }))
        .toMatchObject({ allowed: false, duplicate: true, reason: "owner_query_legacy_outcome_unavailable" });
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands WHERE source_event_id='legacy-query'").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(before);
    } finally { await runtime.stop(); f.db.close(); }
  });
  it.each(["status", "refresh_approval"] as const)("rolls back %s reply when the query receipt fails", async commandName => {
    const f = fixture({});
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const before = f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      f.db.exec("CREATE TRIGGER fail_query_receipt BEFORE INSERT ON collaboration_owner_text_commands BEGIN SELECT RAISE(ABORT,'synthetic_query_failure'); END");
      expect(() => runtime.performDingTalkOwnerTextCommand({ transportEventId: "query-failed", transportMessageId: "query-failed", conversationId: "group-b",
        command: commandName, workItemId: f.message("event-group-a").aggregateId, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } })).toThrow("synthetic_query_failure");
      expect(f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(before);
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
    } finally { await runtime.stop(); f.db.close(); }
  });
  it.each([["暂停", false], ["恢复", false], ["重试", false], ["取消", false], ["批准", false], ["退回", false], ["暂停", true]] as const)("preserves the actual group for %s control replies (Owner=%s), including denial and replay", async (label, isOwner) => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      if (isOwner) {
        const owner = new LocalOwnerRegistry(join(f.root, "collaboration", "collaboration.sqlite"));
        try { owner.bootstrap({ senderCorpId: "corp", senderStaffId: "staff", now: 1000 }); } finally { owner.close(); }
      }
      await runtime.start();
      const workItemId = f.message("event-group-a").aggregateId;
      const command = parseDingTalkOwnerTextCommand({ sourceEventId: "control-origin", transportMessageId: "control-origin", conversationId: "group-b",
        addressedToBot: true, text: `${label} ${workItemId}`, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } })!;
      expect(command).toMatchObject({ conversationId: "group-b" });
      expect(runtime.performDingTalkOwnerTextCommand(command).allowed).toBe(isOwner);
      expect(runtime.performDingTalkOwnerTextCommand(command).duplicate).toBe(true);
      expect(() => runtime.performDingTalkOwnerTextCommand({ ...command, conversationId: "group-a" } as typeof command)).toThrow("event_conflict");
      const stored = f.db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id='control-origin'").get() as { outcome_json: string };
      expect(JSON.parse(stored.outcome_json).conversationId).toBe("group-b");
      const row = f.db.prepare("SELECT aggregate_type FROM collaboration_outbox WHERE source_event_id='control-origin'").get() as { aggregate_type: "plan" | "work_item" };
      const reply = { ...f.message("control-origin"), aggregateType: row.aggregate_type };
      await runtime.stop();
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver(reply)).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("does not manufacture an origin for legacy direct approval receipts on replay", async () => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: f.root, platform: "linux" });
    try {
      await runtime.start();
      const command = { transportEventId: "legacy-control", transportMessageId: "legacy-control", command: "approve_candidate" as const,
        workItemId: f.message("event-group-a").aggregateId, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      runtime.performDingTalkOwnerTextCommand(command);
      const before = f.db.prepare("SELECT * FROM collaboration_owner_text_commands").all();
      expect(runtime.performDingTalkOwnerTextCommand({ ...command, conversationId: "group-b" }).duplicate).toBe(true);
      expect(f.db.prepare("SELECT * FROM collaboration_owner_text_commands").all()).toEqual(before);
      await runtime.stop();
      const reply = { ...f.message("legacy-control"), aggregateType: "plan" as const };
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver(reply)).toMatchObject({ outcome: "permanent_failure" });
      expect(f.destinations).toEqual([]);
    } finally { await runtime.stop(); f.db.close(); }
  });
  it.each([
    ["继续整理需求", recoverNaturalIntake, "collaboration_natural_intake_recovery_requests"],
    ["继续整理附件", recoverAttachmentProjection, "collaboration_attachment_recovery_requests"],
  ] as const)("rolls back the %s response if its immutable origin receipt cannot be stored", (text, recover, table) => {
    const f = fixture({});
    try {
      const request = { sourceEventId: "rollback-query", transportMessageId: "rollback-query", conversationId: "group-b",
        addressedToBot: true, text, sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      const before = f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      f.db.exec(`CREATE TEMP TRIGGER reject_origin BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic_origin_write_failure'); END`);
      expect(() => recover(f.db, request, 2000, () => {})).toThrow("synthetic_origin_write_failure");
      expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(before);
      f.db.exec("DROP TRIGGER reject_origin");
      expect(recover(f.db, request, 2001, () => {}).duplicate).toBe(false);
      expect(() => f.db.exec(`UPDATE ${table} SET outcome_json='{}'`)).toThrow("immutable");
    } finally { f.db.close(); }
  });
  it.each([
    ["继续整理需求", recoverNaturalIntake, "collaboration_natural_intake_recovery_requests"],
    ["继续整理附件", recoverAttachmentProjection, "collaboration_attachment_recovery_requests"],
  ] as const)("routes a durable %s response to its actual request group after restart", async (text, recover, table) => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    try {
      const request = { sourceEventId: "recover-query", transportMessageId: "recover-query", conversationId: "group-b",
        addressedToBot: true, text, receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Member" } };
      expect(recover(f.db, request, 2000, () => {}).allowed).toBe(false);
      const before = f.db.prepare(`SELECT * FROM ${table}`).all();
      expect(() => recover(f.db, { ...request, conversationId: "group-a" }, 2001, () => {})).toThrow("event_conflict");
      expect(recover(f.db, request, 2002, () => {}).duplicate).toBe(true);
      expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
      const response = { ...f.message("recover-query"), aggregateType: "association" as const };
      const restarted = createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root);
      f.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1 WHERE source_event_id<>'recover-query'");
      const lease = new InstanceLeaseCoordinator(f.db, "recovery-routing-test").acquire(3000, 60000)!;
      const options = { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 10, maxBackoffMs: 100 };
      expect(await new OutboxDispatcher(f.db, restarted, options).dispatchOne(lease, 3000)).toMatchObject({ state: "sent" });
      expect(await new OutboxDispatcher(f.db, createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root), options).dispatchOne(lease, 3001)).toBeNull();
      expect(f.destinations).toEqual(["open-b"]);
      expect(JSON.parse(String((before[0] as { outcome_json: string }).outcome_json)).conversationId).toBe("group-b");
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE source_event_id='recover-query'").get()).toEqual({ n: 1 });
      // Old receipts cannot acquire new routing authority just by being replayed.
      const row = before[0] as { payload_hash: string; outcome_json: string };
      const legacyOutcome = JSON.parse(row.outcome_json);
      delete legacyOutcome.conversationId;
      f.db.prepare(`INSERT INTO ${table}(source_event_id,payload_hash,outcome_json,created_at) VALUES(?,?,?,?)`)
        .run("legacy-query", row.payload_hash, JSON.stringify(legacyOutcome), 1000);
      expect(recover(f.db, { ...request, sourceEventId: "legacy-query" }, 2003, () => {}).duplicate).toBe(true);
      expect(await restarted.deliver({ ...response, dedupeKey: "dingtalk:event:legacy-query:ack" })).toMatchObject({ outcome: "permanent_failure" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { f.db.close(); }
  });
  it.each(["not-json", "[]", "{}", '{"group-c":"open-c"}', '{"group-a":""}', '{"group-a":42}',
    '{"group-a":"open-a","group-b":"open-a"}', '{"group-a":" open-a"}', '{"group-a":"open\\na"}'])
  ("rejects invalid/untrusted configuration without echoing it: %s", raw => {
    expect(() => proactiveConversationRoutes({ OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: raw }, new Set(["group-a", "group-b"])))
      .toThrow("OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP_invalid");
  });
  it("rejects conflicting declarations, allows an identical single-group declaration", () => {
    const env = { OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a"}', OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-b" };
    expect(() => proactiveConversationRoutes(env, new Set(["group-a"]))).toThrow("OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP_conflict");
    expect(proactiveConversationRoutes({ ...env, OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-a" }, new Set(["group-a"])).get("group-a")).toBe("open-a");
  });
  it("routes a persisted Owner review after sender restart using the query group, not payload text", async () => {
    const env = { OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' };
    const f = fixture(env);
    const owner = new LocalOwnerRegistry(join(f.root, "collaboration", "collaboration.sqlite"));
    try {
      owner.bootstrap({ senderCorpId: "corp", senderStaffId: "staff", now: 1000 });
      requestDeliveryReview(f.db, { sourceEventId: "review", transportMessageId: "review", conversationId: "group-b",
        addressedToBot: true, text: "查看待核查回复", receivedAt: 2000,
        sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Owner" } }, 2000, () => {});
      const message = { ...f.message("review"), aggregateType: "association" as const };
      expect(await createDingTalkDelivery(new DingTalkSessionReplyRegistry(), env, f.root).deliver(message)).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-b"]);
    } finally { owner.close(); f.db.close(); }
  });
  it("uses the same proven group after a definite session rejection", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' });
    try {
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
      f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 310000 })));
      expect(await f.delivery.deliver(f.message("event-group-a"))).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-a"]);
    } finally { f.db.close(); }
  });
  it("does not use a mapped fallback after uncertain session delivery", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: '{"group-a":"open-a","group-b":"open-b"}' });
    try {
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
      f.fetcher.mockResolvedValueOnce(new Response("lost receipt"));
      expect(await f.delivery.deliver(f.message("event-group-a"))).toMatchObject({ outcome: "unknown" });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.destinations).toEqual([]);
    } finally { f.db.close(); }
  });
  it("never sends multi-group replies to an unbound global fallback", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-b" });
    try {
      expect(await f.delivery.deliver(f.message("event-group-a"))).toMatchObject({ outcome: "permanent_failure" });
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("maps both groups explicitly without equating conversation and openConversation IDs", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP: JSON.stringify({ "group-a": "open-a", "group-b": "open-b" }) });
    try {
      for (const group of ["group-a", "group-b"]) expect(await f.delivery.deliver(f.message(`event-${group}`))).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual(["open-a", "open-b"]);
    } finally { f.db.close(); }
  });
  it("retains legacy single-group fallback only for a proven source group", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-a" });
    try {
      expect(await f.delivery.deliver(f.message("event-group-a"))).toEqual({ outcome: "sent" });
      expect(await f.delivery.deliver(f.message("event-group-b"))).toMatchObject({ outcome: "permanent_failure" });
      const unknown = { ...f.message("event-group-a"), dedupeKey: "dingtalk:event:unknown:ack" };
      expect(await f.delivery.deliver(unknown)).toMatchObject({ outcome: "permanent_failure" });
      expect(f.destinations).toEqual(["open-a"]);
    } finally { f.db.close(); }
  });
  it("keeps an available session working when proactive mapping is unavailable", async () => {
    const f = fixture({ OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group-a,group-b", OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-b" });
    try {
      f.sessions.capture({ sourceEventId: "event-group-a", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
      expect(await f.delivery.deliver(f.message("event-group-a"))).toEqual({ outcome: "sent" });
      expect(f.destinations).toEqual([]);
    } finally { f.db.close(); }
  });
});
