import { afterEach, describe, expect, it, vi } from "vitest";

import { FetchDingTalkSessionSender } from "./sender.ts";
import { FetchDingTalkInteractiveCardSender } from "./interactive-card-sender.ts";

const payload = { type: "primary_status_card", headline: "已接收", workItemId: "WI-TEST" };
const input = { proactiveOpenConversationId: "synthetic-group", idempotencyKey: "synthetic-outbox", payload };
const credentials = { load: () => ({ clientId: "synthetic-app", clientSecret: "synthetic-secret" }) };

afterEach(() => { vi.useRealTimers(); });

describe("bounded DingTalk reply transport", () => {
  it.each(["headers", "body"])("bounds accepted-message query %s within the remaining outbox deadline", async phase => {
    vi.useFakeTimers();
    let result: unknown = "pending";
    let signal: AbortSignal | null | undefined;
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async (url, init) => {
      if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      if (String(url).endsWith("/send")) return new Response(JSON.stringify({ processQueryKey: "synthetic-query" }));
      signal = init?.signal;
      return phase === "headers" ? new Promise<Response>(() => {}) : new Response(new ReadableStream());
    });
    void sender.send(input).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(4_001);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares a single deadline between response headers and body", async () => {
    vi.useFakeTimers();
    let result: unknown = "pending";
    let cancelled = 0;
    const sender = new FetchDingTalkSessionSender(async () => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      return new Response(new ReadableStream({ cancel() { cancelled++; } }));
    });
    void sender.send("https://api.dingtalk.com/session-fixture", payload).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(8_001);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns on timeout even if cancelling the response body never settles", async () => {
    vi.useFakeTimers();
    let result: unknown = "pending";
    const sender = new FetchDingTalkSessionSender(async () => new Response(new ReadableStream({
      cancel() { return new Promise<void>(() => {}); },
    })));
    void sender.send("https://api.dingtalk.com/session-fixture", payload).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(8_001);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces a byte limit rather than a Unicode character limit", async () => {
    const sender = new FetchDingTalkSessionSender(async () => new Response(JSON.stringify({ errcode: 0, errmsg: "中".repeat(6_000) })));
    expect(await sender.send("https://api.dingtalk.com/session-fixture", payload)).toMatchObject({ ok: false, deliveryState: "unknown" });
  });

  it("accepts valid split UTF-8 and clears the deadline on success", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode(JSON.stringify({ errcode: 0, errmsg: "成功" }));
    const sender = new FetchDingTalkSessionSender(async () => new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    })));
    expect(await sender.send("https://api.dingtalk.com/session-fixture", payload)).toEqual({ ok: true, status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["oversize", "invalid", "http_rejection"])("cancels %s bodies without waiting for EOF", async mode => {
    vi.useFakeTimers();
    let cancelled = 0;
    const sender = new FetchDingTalkSessionSender(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: mode === "http_rejection" ? 429 : 200,
      headers: mode === "http_rejection" ? {} : { "content-length": mode === "oversize" ? "999999" : "NaN" },
    }));
    expect(await sender.send("https://api.dingtalk.com/session-fixture", payload)).toMatchObject({ ok: false });
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("ends a stuck session %s without retrying or reporting delivery", async phase => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let cancelCount = 0;
    let result: unknown = "pending";
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      signal = init?.signal;
      if (phase === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ cancel() { cancelCount++; } }));
    });
    void sender.send("https://api.dingtalk.com/session-fixture", payload).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
    expect(signal?.aborted).toBe(true);
    if (phase === "body") expect(cancelCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["token_headers", "token_body", "message_headers", "message_body"])("bounds %s with submission-aware failure", async phase => {
    vi.useFakeTimers();
    let posted = 0;
    let signal: AbortSignal | null | undefined;
    let result: unknown = "pending";
    const sender = new FetchDingTalkInteractiveCardSender(credentials, async (url, init) => {
      const token = String(url).endsWith("/accessToken");
      if (!token) posted++;
      if (token && phase.startsWith("message")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      signal = init?.signal;
      if (phase.endsWith("headers")) return new Promise<Response>(() => {});
      return new Response(new ReadableStream());
    });
    void sender.send(input).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(result).toMatchObject({ ok: false, deliveryState: phase.startsWith("token") ? "not_sent" : "unknown" });
    expect(posted).toBe(phase.startsWith("token") ? 0 : 1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["session", "token", "message"])("stops reading oversized %s bodies before EOF", async phase => {
    vi.useFakeTimers();
    let cancelled = 0;
    let result: unknown = "pending";
    const body = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); },
      cancel() { cancelled++; },
    }));
    const operation = phase === "session"
      ? new FetchDingTalkSessionSender(async () => body()).send("https://api.dingtalk.com/session-fixture", payload)
      : new FetchDingTalkInteractiveCardSender(credentials, async url =>
        phase === "message" && String(url).endsWith("/accessToken")
          ? new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 })) : body()).send(input);
    void operation.then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false, deliveryState: phase === "token" ? "not_sent" : "unknown" });
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a fetch response arriving after its deadline without processing it", async () => {
    vi.useFakeTimers();
    let respond!: (response: Response) => void;
    let cancelled = 0;
    let result: unknown = "pending";
    const operation = new FetchDingTalkSessionSender(async () => new Promise<Response>(resolve => { respond = resolve; }))
      .send("https://api.dingtalk.com/session-fixture", payload);
    void operation.then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
    respond(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toBe(1);
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown" });
  });
});
