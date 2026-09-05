import type { DingTalkCredentialProvider, DingTalkCredentials } from "./config.ts";
import { isDingTalkCandidateOwnerCard, renderDingTalkOwnerStatusCard } from "./cards.ts";
import type { DingTalkActiveSendPort, DingTalkHttpResult } from "./ports.ts";
import { renderDingTalkSessionMessage } from "./session-message.ts";
import { boundedReplyRequest } from "./bounded-reply-request.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const CREATE_AND_DELIVER_URL = "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver";
const GROUP_MESSAGE_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class FetchDingTalkInteractiveCardSender implements DingTalkActiveSendPort {
  private readonly credentials: DingTalkCredentialProvider;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private cached: { accessToken: string; expiresAt: number; clientId: string } | null = null;

  constructor(credentials: DingTalkCredentialProvider, fetcher: FetchLike = fetch, now: () => number = Date.now) {
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.now = now;
  }

  async send(input: {
    proactiveOpenConversationId: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkHttpResult> {
    const card = isDingTalkCandidateOwnerCard(input.payload) ? input.payload : null;
    const conversationId = input.proactiveOpenConversationId.trim();
    if (!conversationId || conversationId.length > 512) {
      return { ok: false, status: 400, code: "dingtalk_active_message_invalid" };
    }
    const credentials = this.credentials.load();
    if (!credentials) return { ok: false, status: 503, code: "dingtalk_credentials_missing", deliveryState: "not_sent" };
    const accessToken = await this.accessToken(credentials);
    if (!accessToken) return { ok: false, status: 502, code: "dingtalk_access_token_failed", deliveryState: "not_sent" };
    let endpoint: string;
    let payload: Record<string, unknown>;
    if (card) {
      endpoint = CREATE_AND_DELIVER_URL;
      payload = {
        ...renderDingTalkOwnerStatusCard(card),
        imGroupOpenSpaceModel: { supportForward: false },
        imGroupOpenDeliverModel: {
          robotCode: credentials.clientId,
          openConversationId: conversationId,
        },
      };
    } else {
      const message = renderDingTalkSessionMessage(input.payload) as {
        msgtype?: unknown;
        markdown?: unknown;
      };
      if (message.msgtype !== "markdown" || !record(message.markdown)) {
        return { ok: false, status: 400, code: "dingtalk_group_message_invalid" };
      }
      endpoint = GROUP_MESSAGE_URL;
      payload = {
        msgParam: JSON.stringify(message.markdown),
        msgKey: "sampleMarkdown",
        openConversationId: conversationId,
        robotCode: credentials.clientId,
      };
    }
    let response: Awaited<ReturnType<typeof boundedReplyRequest>>;
    try {
      response = await boundedReplyRequest(this.fetcher, endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(payload),
        redirect: "error",
      }, 64 * 1024);
    } catch {
      return {
        ok: false,
        status: 503,
        code: card ? "dingtalk_interactive_card_transport" : "dingtalk_group_message_transport",
        deliveryState: "unknown",
      };
    }
    if (!response.ok) return { ok: false, status: response.status, code: `http_${response.status}` };
    const result = response.record;
    if (!result) return { ok: false, status: response.status, code: "dingtalk_response_invalid", deliveryState: "unknown" };
    if (result.success === false || (typeof result.code === "string" && result.code !== "0")) {
      return {
        ok: false,
        status: response.status,
        code: card ? "dingtalk_interactive_card_rejected" : "dingtalk_group_message_rejected",
        deliveryState: "not_sent",
      };
    }
    if (!card && (typeof result.processQueryKey !== "string" || !result.processQueryKey.trim())) {
      return { ok: false, status: response.status, code: "dingtalk_group_message_unconfirmed", deliveryState: "unknown" };
    }
    return { ok: true, status: response.status };
  }

  private async accessToken(credentials: DingTalkCredentials): Promise<string | null> {
    if (
      this.cached &&
      this.cached.clientId === credentials.clientId &&
      this.cached.expiresAt > this.now() + 60_000
    ) return this.cached.accessToken;
    let response: Awaited<ReturnType<typeof boundedReplyRequest>>;
    try {
      response = await boundedReplyRequest(this.fetcher, ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: credentials.clientId, appSecret: credentials.clientSecret }),
        redirect: "error",
      }, 64 * 1024);
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const result = response.record;
    const accessToken = typeof result?.accessToken === "string" ? result.accessToken.trim() : "";
    const expireIn = typeof result?.expireIn === "number" ? result.expireIn : 0;
    if (!accessToken || accessToken.length > 8_192 || !Number.isFinite(expireIn) || expireIn < 60) return null;
    this.cached = {
      accessToken,
      clientId: credentials.clientId,
      expiresAt: this.now() + expireIn * 1_000,
    };
    return accessToken;
  }
}
