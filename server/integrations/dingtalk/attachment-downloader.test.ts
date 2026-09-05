import { describe, expect, it } from "vitest";

import {
  FetchDingTalkAttachmentDownloader,
  type DingTalkAttachmentDownloadResult,
} from "./attachment-downloader.ts";

const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const RESOLVE_URL = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";

function credentials() {
  return { load: () => ({ clientId: "robot-app", clientSecret: "app-secret" }) };
}

function safeResult(value: DingTalkAttachmentDownloadResult): string {
  return JSON.stringify(value);
}

describe("DingTalk attachment downloader", () => {
  it.each(["token-fetch", "token-body", "resolve-fetch", "resolve-body", "file-fetch", "file-body"])("bounds total download time at %s even when the transport ignores abort", async (stage) => {
    let cancelled = false;
    const body = () => new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
    const calls: string[] = [];
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (url) => {
      const step = String(url) === TOKEN_URL ? "token" : String(url) === RESOLVE_URL ? "resolve" : "file";
      calls.push(step);
      if (stage === `${step}-fetch`) return new Promise(() => {});
      if (stage === `${step}-body`) return new Response(body());
      return new Response(step === "token" ? JSON.stringify({ accessToken: "token", expireIn: 7200 })
        : step === "resolve" ? JSON.stringify({ downloadUrl: "https://files.dingtalk.com/file" }) : "ok");
    }, Date.now, { timeoutMs: 20 });
    const result = await Promise.race([downloader.download({ capabilityRef: "ref", downloadCode: "private" }),
      new Promise(resolve => setTimeout(() => resolve("hung"), 500))]);
    expect(result).toEqual({ ok: false, kind: "retryable", code: "dingtalk_attachment_timeout" });
    expect(calls.at(-1)).toBe(stage.split("-")[0]);
    if (stage.endsWith("body")) expect(cancelled).toBe(true);
  });

  it("discards late token responses without caching or advancing a cancelled request", async () => {
    let release!: (value: Response) => void;
    let calls = 0;
    let cancelled = false;
    const controller = new AbortController();
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { release = resolve; });
      return new Response("", { status: 503 });
    });
    const pending = downloader.download({ capabilityRef: "ref", downloadCode: "private" }, controller.signal);
    controller.abort();
    await pending;
    release(new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ accessToken: "late-token", expireIn: 7200 }))); },
      cancel() { cancelled = true; },
    })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
    expect(await downloader.download({ capabilityRef: "ref", downloadCode: "private" })).toMatchObject({ code: "dingtalk_attachment_token_http" });
    expect(calls).toBe(2);
  });

  it("cancels a hanging token request without leaking errors or continuing to resolve a file", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (_url, init) => {
      calls++; signal = init?.signal ?? undefined; return new Promise(() => {});
    });
    const pending = downloader.download({ capabilityRef: "ref", downloadCode: "private-code" }, controller.signal);
    controller.abort();
    expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("hung"), 50))])).toEqual({ ok: false, kind: "retryable", code: "dingtalk_attachment_cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });
  it("resolves and streams an attachment while caching the access token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let fileNumber = 0;
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), { status: 200 });
      }
      if (url === RESOLVE_URL) {
        fileNumber += 1;
        return new Response(JSON.stringify({ downloadUrl: `https://files.dingtalk.com/file-${fileNumber}` }), {
          status: 200,
        });
      }
      return new Response(fileNumber === 1 ? "first" : "second", {
        status: 200,
        headers: {
          "content-length": fileNumber === 1 ? "5" : "6",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }, () => 1_000);

    const first = await downloader.download({
      capabilityRef: "public-ref-1",
      downloadCode: "private-code-1",
      robotCode: "robot-app",
    });
    const second = await downloader.download({
      capabilityRef: "public-ref-2",
      downloadCode: "private-code-2",
    });

    expect(first).toMatchObject({
      ok: true,
      sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      mediaType: "text/plain",
    });
    expect(first.ok && Buffer.from(first.bytes).toString("utf8")).toBe("first");
    expect(second.ok && Buffer.from(second.bytes).toString("utf8")).toBe("second");
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: TOKEN_URL, init: { method: "POST", redirect: "error" } });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ appKey: "robot-app", appSecret: "app-secret" });
    expect(calls[1]).toMatchObject({
      url: RESOLVE_URL,
      init: {
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "access-token" }),
      },
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      downloadCode: "private-code-1",
      robotCode: "robot-app",
    });
    expect(calls[2]).toMatchObject({
      url: "https://files.dingtalk.com/file-1",
      init: { method: "GET", redirect: "error" },
    });
  });

  it.each([
    "http://files.dingtalk.com/file",
    "https://user:pass@files.dingtalk.com/file",
    "https://files.dingtalk.com/file#fragment",
    "https://localhost/file",
    "https://127.0.0.1/file",
    "https://10.1.2.3/file",
    "https://dingtalk.com.attacker.example/file",
    "https://aliyuncs.com.attacker.example/file",
  ])("permanently rejects unsafe download URL %s without fetching it", async (downloadUrl) => {
    const calls: string[] = [];
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ downloadUrl }), { status: 200 });
    });

    await expect(downloader.download({ capabilityRef: "ref", downloadCode: "private-code" })).resolves.toEqual({
      ok: false,
      kind: "permanent",
      code: "dingtalk_attachment_download_url_unsafe",
    });
    expect(calls).toEqual([TOKEN_URL, RESOLVE_URL]);
  });

  it("rejects an oversized stream as permanent and cancels the reader", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }), { status: 200 });
      }
      if (url === RESOLVE_URL) {
        return new Response(JSON.stringify({ downloadUrl: "https://download.aliyuncs.com/file" }), { status: 200 });
      }
      return new Response(oversized, { status: 200 });
    });

    await expect(downloader.download({ capabilityRef: "ref", downloadCode: "private-code" })).resolves.toEqual({
      ok: false,
      kind: "permanent",
      code: "dingtalk_attachment_too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("checks the announced and actual size", async () => {
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }), { status: 200 });
      }
      if (url === RESOLVE_URL) {
        return new Response(JSON.stringify({ downloadUrl: "https://download.aliyuncs.com/file" }), { status: 200 });
      }
      return new Response("short", { status: 200, headers: { "content-length": "6" } });
    });

    await expect(downloader.download({ capabilityRef: "ref", downloadCode: "private-code" })).resolves.toEqual({
      ok: false,
      kind: "retryable",
      code: "dingtalk_attachment_size_mismatch",
    });
  });

  it("classifies transport and HTTP failures without exposing sensitive upstream data", async () => {
    const secret = "private-download-code";
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "Throttled", message: `do not leak ${secret}` }), { status: 503 });
    });

    const result = await downloader.download({ capabilityRef: "ref", downloadCode: secret });
    expect(result).toEqual({
      ok: false,
      kind: "retryable",
      code: "dingtalk_attachment_resolve_http",
      status: 503,
    });
    expect(safeResult(result)).not.toContain(secret);
    expect(safeResult(result)).not.toContain("Throttled");
  });

  it("treats invalid capabilities and rejected business responses as permanent", async () => {
    const downloader = new FetchDingTalkAttachmentDownloader(credentials(), async (input) => {
      if (String(input) === TOKEN_URL) {
        return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: false, code: "InvalidDownloadCode" }), { status: 200 });
    });

    await expect(downloader.download({ capabilityRef: "ref", downloadCode: "" })).resolves.toEqual({
      ok: false,
      kind: "permanent",
      code: "dingtalk_attachment_capability_invalid",
    });
    await expect(downloader.download({ capabilityRef: "ref", downloadCode: "expired" })).resolves.toEqual({
      ok: false,
      kind: "permanent",
      code: "dingtalk_attachment_resolve_rejected",
    });
  });
});
