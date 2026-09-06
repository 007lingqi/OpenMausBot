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
