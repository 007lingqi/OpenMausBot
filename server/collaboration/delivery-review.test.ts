import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { requestDeliveryReview, isCurrentDeliveryReviewNotice } from "./delivery-review.ts";
import { parseDingTalkDeliveryReviewRequest } from "../integrations/dingtalk/text-actions.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { CollaborationHeadlessRuntime } from "./operations/runtime.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function message(id: string, text = "查看待核查回复", group = "group-a"): DingTalkInboundMessage {
  return { sourceEventId: id, transportMessageId: id, conversationId: group, text, addressedToBot: true,
    sender: { senderCorpId: "corp", senderStaffId: "owner", senderId: "owner", displayName: "负责人" }, receivedAt: 1000 };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delivery-review-")); roots.push(root);
  const service = startCollaborationService({ dataDirectory: root });
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const owner = new LocalOwnerRegistry(join(root, "collaboration", "collaboration.sqlite"));
  owner.bootstrap({ senderCorpId: "corp", senderStaffId: "owner", now: 1000 });
  const first = service.ingestDingTalkMessage(message("input-a", "保存失败"));
  service.ingestDingTalkMessage(message("input-b", "另一个群的保密问题", "group-b"));
  db.exec("UPDATE collaboration_outbox SET delivery_state='dead_letter',last_error='private-provider-error'");
  const request = (input = message("query")) => requestDeliveryReview(db, input, 2000, () => {});
  const notice = () => db.prepare("SELECT source_event_id,aggregate_id,aggregate_version FROM collaboration_outbox WHERE source_event_id='query'").get() as {source_event_id:string;aggregate_id:string;aggregate_version:number};
  return { root, db, owner, service, first, request, notice, close() { db.close(); owner.close(); service.close(); } };
}

describe("Owner delivery review", () => {
  it("bounds the shown list and scopes an explicit source quote without changing old deliveries", () => {
    const f = fixture();
    try {
      for (let i=0;i<7;i++) f.service.ingestDingTalkMessage(message(`extra-${i}`, `另一事项 ${i}`));
      f.db.exec("UPDATE collaboration_outbox SET delivery_state='dead_letter'");
      expect(f.request()).toMatchObject({ total: 8, items: expect.any(Array) });
      const result = f.request(message("list-again"));
      expect(result.items).toHaveLength(5);
      const scoped = f.request({ ...message("scoped"), replyToSourceEventId: "input-a" });
      expect(scoped.total).toBe(1);
      expect(scoped.items[0].workItemId).toBe(f.first.workItemId);
    } finally { f.close(); }
  });
  it("does not reuse query events as ordinary input and suppresses a stale notice in the actual dispatcher", () => {
    const f = fixture();
    try {
      f.request();
      expect(() => f.service.ingestDingTalkMessage(message("query", "新任务：改代码"))).toThrow("delivery_review_event_conflict");
      f.db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=2500 WHERE source_event_id='input-a'").run();
      let sends = 0;
      const lease = new InstanceLeaseCoordinator(f.db,"review-test").acquire(3000,60000)!;
      const dispatcher = new OutboxDispatcher(f.db,{async deliver(){ sends++; return {outcome:"sent"}; }},{maxAttempts:3,claimTtlMs:10000,baseBackoffMs:10,maxBackoffMs:100});
      return dispatcher.dispatchOne(lease,3000).then(result => { expect(result?.state).toBe("superseded"); expect(sends).toBe(0); }).finally(() => f.close());
    } catch(error) { f.close(); throw error; }
  });
  it("wires runtime review and rejects query replay through Owner command and action routes", async () => {
    const f = fixture();
    // The runtime opens the existing test service's ledger; no Stream or real credentials.
    const runtime = new CollaborationHeadlessRuntime({dataDirectory: f.root,platform:"linux"});
    try {
      await runtime.start();
      expect(runtime.reviewDingTalkDeliveries(message("query"))).toMatchObject({allowed:true,total:1});
      expect(() => runtime.performDingTalkOwnerTextCommand({ transportEventId:"query",transportMessageId:"query",command:"pause",workItemId:f.first.workItemId!,sender:message("q").sender,receivedAt:3000 })).toThrow("delivery_review_event_conflict");
      expect(() => runtime.performDingTalkOwnerAction({ transportEventId:"query",transportMessageId:"query",actionToken:"not-used",sender:message("q").sender,receivedAt:3000,origin:"text" })).toThrow("delivery_review_event_conflict");
    } finally { await runtime.stop(); f.close(); }
  });
  it("returns a bounded same-group snapshot without changing work, prior deliveries or Spec", () => {
    const f = fixture();
    try {
      const before = f.db.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      const work = f.db.prepare("SELECT * FROM collaboration_work_items ORDER BY id").all();
      const outcome = f.request();
      expect(outcome).toMatchObject({ kind: "delivery_review", allowed: true, total: 1, duplicate: false });
      expect(outcome.items).toHaveLength(1);
      expect(outcome.items[0].workItemId).toBe(f.first.workItemId);
      expect(f.db.prepare("SELECT * FROM collaboration_work_items ORDER BY id").all()).toEqual(work);
      expect(f.db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id<>'query' ORDER BY id").all()).toEqual(before);
      const reply = JSON.stringify(f.db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id='query'").get());
      expect(reply).toContain("保存失败");
      expect(reply).not.toContain("另一个群");
      expect(reply).not.toContain("private-provider-error");
      expect(reply).not.toContain(outcome.items[0].outboxId);
      expect(f.request()).toMatchObject({ duplicate: true, total: 1 });
      expect(f.db.prepare("SELECT COUNT(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 1 });
      expect(isCurrentDeliveryReviewNotice(f.db, f.notice())).toBe(true);
    } finally { f.close(); }
  });
  it.each(["not_owner", "missing_identity", "unknown_quote", "foreign_quote"])("does not expose a fallback list for %s", mode => {
    const f = fixture();
    try {
      const input = message("query");
      if (mode === "not_owner") input.sender.senderStaffId = "member";
      if (mode === "missing_identity") delete input.sender.senderStaffId;
      if (mode === "unknown_quote") input.replyToSourceEventId = "missing";
      if (mode === "foreign_quote") input.replyToSourceEventId = "input-b";
      expect(f.request(input)).toMatchObject({ allowed: false, items: [], total: 0 });
      const reply = JSON.stringify(f.db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id='query'").get());
      expect(reply).not.toContain("保存失败");
      expect(reply).not.toContain("另一个群");
    } finally { f.close(); }
  });
  it("binds replay to original intent and suppresses a notice after its Owner or source changes", () => {
    const f = fixture();
    try {
      f.request();
      expect(() => f.request(message("query", "查看未确认回复"))).toThrow("delivery_review_event_conflict");
      f.db.prepare("UPDATE collaboration_outbox SET payload_json='{}' WHERE source_event_id='input-a'").run();
      expect(isCurrentDeliveryReviewNotice(f.db, f.notice())).toBe(false);
      f.owner.recover({ expectedGeneration: 1, senderCorpId: "corp", senderStaffId: "new-owner", now: 3000 });
      expect(f.request()).toMatchObject({ allowed: false, duplicate: true, items: [] });
    } finally { f.close(); }
  });
  it("rolls back the query record and audit if its reply cannot be persisted", () => {
    const f = fixture();
    try {
      f.db.exec("CREATE TRIGGER fixture_reject_reply BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_write_failed'); END");
      expect(() => f.request()).toThrow("fixture_write_failed");
      expect(f.db.prepare("SELECT COUNT(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
  it.each(["查看待核查回复", "请查看未确认的回复", "核查未送达回复"])("recognizes direct natural query: %s", text => {
    expect(parseDingTalkDeliveryReviewRequest(message("query", text))).toBe(true);
    expect(parseDingTalkDeliveryReviewRequest({ ...message("query", text), addressedToBot: false })).toBe(false);
    expect(parseDingTalkDeliveryReviewRequest(message("query", `文档要求：${text}`))).toBe(false);
  });
});
