import type { DingTalkHttpResult, DingTalkSessionSendPort } from "./ports.ts";
import { renderDingTalkSessionMessage } from "./session-message.ts";
import { boundedReplyRequest } from "./bounded-reply-request.ts";
import { inspectDingTalkBusinessStatus } from "./business-status.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function assertDingTalkWebhook(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "dingtalk.com" && !url.hostname.endsWith(".dingtalk.com"))) {
    throw new Error("dingtalk_session_webhook_invalid");
  }
  return url;
}

/** Sends only to the ephemeral webhook supplied by DingTalk. The URL is never retained or logged here. */
export class FetchDingTalkSessionSender implements DingTalkSessionSendPort {
  private readonly fetcher: FetchLike;

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
  }

  async send(webhookUrl: string, payload: unknown): Promise<DingTalkHttpResult> {
    const url = assertDingTalkWebhook(webhookUrl);
    let response: Awaited<ReturnType<typeof boundedReplyRequest>>;
    try {
      response = await boundedReplyRequest(this.fetcher, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(renderDingTalkSessionMessage(payload)),
        redirect: "error",
      }, 16 * 1024);
    } catch {
      return { ok: false, status: 503, code: "dingtalk_session_transport", deliveryState: "unknown" };
    }
    if (!response.ok) return { ok: false, status: response.status, code: `http_${response.status}` };
    const result = response.record;
    if (!result) {
      return { ok: false, status: response.status, code: "dingtalk_response_invalid" };
    }
    const business = result as { errcode?: unknown; success?: unknown };
    const status = inspectDingTalkBusinessStatus(result);
    if (status === "unconfirmed") return { ok: false, status: response.status, code: "dingtalk_response_inconsistent", deliveryState: "unknown" };
    if (business.errcode === 0 || business.success === true) return { ok: true, status: response.status };
    const code =
      typeof business.errcode === "number" && Number.isSafeInteger(business.errcode)
        ? `dingtalk_${business.errcode}`
        : "dingtalk_business_rejected";
    return { ok: false, status: response.status, code, deliveryState: status === "rejected" ? "not_sent" : "unknown" };
  }
}
