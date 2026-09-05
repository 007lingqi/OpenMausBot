import { describe, expect, it } from "vitest";

import { FetchDingTalkSessionSender } from "./sender.ts";
import { FetchDingTalkInteractiveCardSender } from "./interactive-card-sender.ts";
import { DingTalkReplyRouter, DingTalkSessionReplyRegistry } from "./reply-router.ts";

const payload = { type: "primary_status_card", headline: "已接收", workItemId: "WI-TEST" };
const credentials = { load: () => ({ clientId: "synthetic-app", clientSecret: "synthetic-secret" }) };
const input = { proactiveOpenConversationId: "synthetic-group", idempotencyKey: "synthetic-outbox", payload };
const token = { accessToken: "synthetic-access", expireIn: 7200 };

describe("DingTalk business receipt consistency", () => {
  it.each([
    { errcode: 0, success: false },
    { errcode: 310000, success: true },
    { errcode: 0, code: "rejected" },
    { errcode: "invalid", success: true },
    { errcode: 0, success: "false" },
    { errcode: 0, code: {} },
    { errcode: 0, code: null },
    { errcode: null, success: true },
    { errcode: 0, success: null },
    { errcode: 0, code: " " },
    { errcode: 0.5, success: true },
  ])("does not accept or retry a contradictory session reply: %j", async body => {
    let fallbacks = 0;
    const sessions = new DingTalkSessionReplyRegistry();
    sessions.capture({ sourceEventId: "event", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
    const router = new DingTalkReplyRouter(sessions, new FetchDingTalkSessionSender(async () => new Response(JSON.stringify(body))),
      { async send() { fallbacks++; return { ok: true, status: 200 }; } });
    expect(await router.send({ ...input, sourceEventId: "event" })).toEqual({ kind: "unknown", code: "session_delivery_unconfirmed" });
    expect(fallbacks).toBe(0);
  });

  it.each([
    { success: false }, { code: 123 }, { errcode: 310000 }, { success: true, code: 123 }, { success: "true" }, { code: [] },
  ])("does not trust a message query key beside conflicting or malformed status: %j", async flags => {
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async url => new Response(JSON.stringify(
      String(url).endsWith("/accessToken") ? token : { processQueryKey: "synthetic-query", ...flags })));
    expect(await sender.send(input)).toMatchObject({ ok: false, deliveryState: "unknown" });
  });

  it.each([{ code: 123 }, { errcode: 310000 }, { success: false }])("classifies explicit message rejection without a receipt as not sent: %j", async flags => {
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async url => new Response(JSON.stringify(
      String(url).endsWith("/accessToken") ? token : flags)));
    expect(await sender.send(input)).toMatchObject({ ok: false, deliveryState: "not_sent" });
  });

  it.each([{ success: false }, { code: 123 }, { errcode: 310000 }, { success: "true" }])("never caches or uses a token beside rejection/invalid status: %j", async flags => {
    let tokenCalls = 0;
    let messages = 0;
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async url => {
      if (String(url).endsWith("/accessToken")) {
        tokenCalls++;
        return new Response(JSON.stringify({ ...token, ...flags }));
      }
      messages++;
      return new Response(JSON.stringify({ processQueryKey: "synthetic-query" }));
    });
    for (let attempt = 0; attempt < 2; attempt++) expect(await sender.send(input)).toMatchObject({ ok: false, deliveryState: "not_sent" });
    expect(tokenCalls).toBe(2);
    expect(messages).toBe(0);
  });

  it.each([{ errcode: 0 }, { success: true }, { errcode: 0, code: "0", success: true }])("preserves coherent session success: %j", async flags => {
    const sender = new FetchDingTalkSessionSender(async () => new Response(JSON.stringify(flags)));
    expect(await sender.send("https://api.dingtalk.com/session-fixture", payload)).toEqual({ ok: true, status: 200 });
  });

  it.each([{}, { code: 0 }, { code: "0", success: true }])("preserves coherent message receipts: %j", async flags => {
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async url => new Response(JSON.stringify(
      String(url).endsWith("/accessToken") ? token : { processQueryKey: "synthetic-query", ...flags })));
    expect(await sender.send(input)).toEqual({ ok: true, status: 200 });
  });

  it.each([{ success: true }, { code: 0 }, { processQueryKey: "" }, { processQueryKey: [] }])("does not substitute generic success for a missing message receipt: %j", async flags => {
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async url => new Response(JSON.stringify(
      String(url).endsWith("/accessToken") ? token : flags)));
    expect(await sender.send(input)).toMatchObject({ ok: false, deliveryState: "unknown" });
  });

  it("still allows a verifiable session rejection to use the active channel", async () => {
    const sessions = new DingTalkSessionReplyRegistry();
    sessions.capture({ sourceEventId: "event", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
    let calls = 0;
    const router = new DingTalkReplyRouter(sessions, new FetchDingTalkSessionSender(async () => new Response(JSON.stringify({ success: false }))),
      { async send() { calls++; return { ok: true, status: 200 }; } });
    expect(await router.send({ ...input, sourceEventId: "event" })).toEqual({ kind: "sent", channel: "proactive" });
    expect(calls).toBe(1);
  });
});
