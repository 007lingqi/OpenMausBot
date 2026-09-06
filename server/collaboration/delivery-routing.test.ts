import { mkdtempSync, rmSync } from "node:fs";
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
import { parseDingTalkOwnerTextCommand } from "../integrations/dingtalk/text-actions.ts";

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
  vi.spyOn(SecureDingTalkCredentialFileProvider.prototype, "load").mockReturnValue({ clientId: "synthetic-client", clientSecret: "synthetic-secret" });
  const destinations: string[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
    if (String(url).includes("groupMessages")) destinations.push(JSON.parse(String(init?.body)).openConversationId);
    return new Response(JSON.stringify({ errcode: 0, processQueryKey: "synthetic-receipt" }));
  });
  vi.stubGlobal("fetch", fetcher);
  const sessions = new DingTalkSessionReplyRegistry();
  return { root, db, message, destinations, fetcher, sessions, delivery: createDingTalkDelivery(sessions, environment, root) };
}

describe("production delivery group routing", () => {
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
