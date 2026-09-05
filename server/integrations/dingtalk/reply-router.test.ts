import { describe, expect, it } from "vitest";

import type { DingTalkActiveSendPort, DingTalkSessionSendPort } from "./ports.ts";
import { DingTalkReplyRouter, DingTalkSessionReplyRegistry } from "./reply-router.ts";

describe("DingTalk reply routing", () => {
  it("allows a safe fallback after a verifiable session rejection and safe retry before message submission", async () => {
    const sessions = new DingTalkSessionReplyRegistry(() => 1000);
    sessions.capture({ sourceEventId: "event", webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession", expiresAt: 2000 });
    let calls = 0;
    const router = new DingTalkReplyRouter(sessions, { async send() { return { ok: false, status: 200, code: "dingtalk_310000" }; } },
      { async send() { calls++; return { ok: false, status: 503, deliveryState: "not_sent" }; } });
    expect(await router.send({ sourceEventId: "event", proactiveOpenConversationId: "group", payload: {}, idempotencyKey: "key" }))
      .toMatchObject({ kind: "retryable" });
    expect(calls).toBe(1);
  });
  it("does not retry an uncertain proactive send", async () => {
    const router = new DingTalkReplyRouter(new DingTalkSessionReplyRegistry(), { async send() { throw new Error("unused"); } },
      { async send() { throw new Error("provider error with private details"); } });
    expect(await router.send({ proactiveOpenConversationId: "group", payload: {}, idempotencyKey: "key" }))
      .toEqual({ kind: "unknown", code: "proactive_delivery_unconfirmed" });
  });
  it.each(["throw", "http_502", "invalid_response"])("does not fall back or report retry-safe after uncertain session delivery: %s", async mode => {
    const sessions = new DingTalkSessionReplyRegistry(() => 1000);
    sessions.capture({ sourceEventId: "event", webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque", expiresAt: 2000 });
    let activeCalls = 0;
    const router = new DingTalkReplyRouter(sessions, { async send() {
      if (mode === "throw") throw new Error("lost acknowledgement");
      return { ok: false, status: mode === "http_502" ? 502 : 200, code: mode === "http_502" ? "http_502" : "dingtalk_response_invalid" };
    } }, { async send() { activeCalls++; return { ok: true, status: 200 }; } });
    expect(await router.send({ sourceEventId: "event", proactiveOpenConversationId: "group", payload: {}, idempotencyKey: "same-event" }))
      .toMatchObject({ kind: "unknown" });
    expect(activeCalls).toBe(0);
  });
  it("uses a live session webhook without confusing it with proactive conversation identity", async () => {
    const sessions = new DingTalkSessionReplyRegistry(() => 1_000);
    sessions.capture({
      sourceEventId: "event-1",
      webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      expiresAt: 2_000,
    });
    const sessionCalls: string[] = [];
    const sessionSender: DingTalkSessionSendPort = {
      async send(url) {
        sessionCalls.push(url);
        return { ok: true, status: 200 };
      },
    };
    const activeCalls: string[] = [];
    const activeSender: DingTalkActiveSendPort = {
      async send(input) {
        activeCalls.push(input.proactiveOpenConversationId);
        return { ok: true, status: 200 };
      },
    };
    const result = await new DingTalkReplyRouter(sessions, sessionSender, activeSender).send({
      sourceEventId: "event-1",
      proactiveOpenConversationId: "open-conversation-1",
      payload: { text: "ok" },
      idempotencyKey: "outbox-1",
    });
    expect(result).toEqual({ kind: "sent", channel: "session" });
    expect(sessionCalls).toHaveLength(1);
    expect(activeCalls).toEqual([]);
    expect(sessions.active("event-1")).not.toBeNull();
  });

  it("routes a candidate decision card through proactive create-and-deliver even while session is live", async () => {
    const sessions = new DingTalkSessionReplyRegistry(() => 1_000);
    sessions.capture({
      sourceEventId: "event-1",
      webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      expiresAt: 2_000,
    });
    let sessionCalls = 0;
    const activePayloads: unknown[] = [];
    const router = new DingTalkReplyRouter(
      sessions,
      { async send() { sessionCalls += 1; return { ok: true, status: 200 }; } },
      {
        async send(input) {
          activePayloads.push(input.payload);
          return { ok: true, status: 200 };
        },
      },
    );
    const payload = {
      type: "plan_status_card",
      headline: "候选已就绪",
      cardTemplateId: "template-1",
      outTrackId: "candidate-run-1",
      workItemId: "WI-1",
      workItemVersion: 4,
      status: "candidate_ready",
      summary: "目标测试已通过",
      candidateSha: "2".repeat(40),
      actions: [
        { label: "接受候选", actionToken: "accept-token" },
        { label: "拒绝候选", actionToken: "reject-token" },
      ],
    };
    expect(await router.send({
      sourceEventId: "event-1",
      proactiveOpenConversationId: "cid-group",
      payload,
      idempotencyKey: "outbox-1",
    })).toEqual({ kind: "sent", channel: "proactive" });
    expect(sessionCalls).toBe(0);
    expect(activePayloads).toEqual([payload]);
  });

  it("falls back to the explicitly configured proactive target after session expiry", async () => {
    let now = 1_000;
    const sessions = new DingTalkSessionReplyRegistry(() => now);
    sessions.capture({
      sourceEventId: "event-1",
      webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      expiresAt: 2_000,
    });
    now = 2_001;
    const targets: string[] = [];
    const router = new DingTalkReplyRouter(
      sessions,
      { send: async () => ({ ok: true, status: 200 }) },
      {
        async send(input) {
          targets.push(input.proactiveOpenConversationId);
          return { ok: true, status: 200 };
        },
      },
    );
    expect(await router.send({
      sourceEventId: "event-1",
      proactiveOpenConversationId: "open-conversation-1",
      payload: {},
      idempotencyKey: "outbox-1",
    })).toEqual({ kind: "sent", channel: "proactive" });
    expect(targets).toEqual(["open-conversation-1"]);
  });

  it("reports an unroutable delivery without rolling back business state", async () => {
    const router = new DingTalkReplyRouter(new DingTalkSessionReplyRegistry(), {
      send: async () => ({ ok: false, status: 410 }),
    });
    expect(await router.send({ payload: {}, idempotencyKey: "outbox-1" })).toEqual({
      kind: "permanent",
      code: "delivery_unroutable",
    });
  });
});
