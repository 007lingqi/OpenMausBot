import type {
  DingTalkActiveSendPort,
  DingTalkDeliveryPort,
  DingTalkDeliveryResult,
  DingTalkSessionSendPort,
  DingTalkHttpResult,
} from "./ports.ts";
import type { DingTalkSessionReplyChannel } from "./types.ts";
import { isDingTalkCandidateOwnerCard } from "./cards.ts";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** No Bot/Webhook idempotency key is guaranteed by the remote API. */
function deliveryUncertain(result: DingTalkHttpResult): boolean {
  if (result.deliveryState) return result.deliveryState === "unknown";
  if (result.code && /^dingtalk_\d+$/u.test(result.code)) return false;
  return result.status === 408 || result.status >= 500 || (result.status >= 200 && result.status < 300);
}

function validSessionWebhook(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "dingtalk.com" && !url.hostname.endsWith(".dingtalk.com"))) {
    throw new Error("dingtalk_session_webhook_invalid");
  }
  return url;
}

export class DingTalkSessionReplyRegistry {
  private readonly channels = new Map<string, DingTalkSessionReplyChannel>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  capture(channel: DingTalkSessionReplyChannel): void {
    validSessionWebhook(channel.webhookUrl);
    if (!Number.isSafeInteger(channel.expiresAt) || channel.expiresAt <= this.now()) return;
    this.channels.set(channel.sourceEventId, { ...channel });
  }

  active(sourceEventId: string): DingTalkSessionReplyChannel | null {
    const channel = this.channels.get(sourceEventId);
    if (!channel) return null;
    if (channel.expiresAt <= this.now()) {
      this.channels.delete(sourceEventId);
      return null;
    }
    return { ...channel };
  }

  consume(sourceEventId: string): void {
    this.channels.delete(sourceEventId);
  }

  clear(): void {
    this.channels.clear();
  }
}

export class DingTalkReplyRouter implements DingTalkDeliveryPort {
  private readonly sessions: DingTalkSessionReplyRegistry;
  private readonly sessionSender: DingTalkSessionSendPort;
  private readonly activeSender?: DingTalkActiveSendPort;

  constructor(
    sessions: DingTalkSessionReplyRegistry,
    sessionSender: DingTalkSessionSendPort,
    activeSender?: DingTalkActiveSendPort,
  ) {
    this.sessions = sessions;
    this.sessionSender = sessionSender;
    this.activeSender = activeSender;
  }

  async send(input: {
    sourceEventId?: string;
    proactiveOpenConversationId?: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkDeliveryResult> {
    if (isDingTalkCandidateOwnerCard(input.payload)) {
      if (!input.proactiveOpenConversationId || !this.activeSender) {
        return { kind: "permanent", code: "interactive_card_delivery_unroutable" };
      }
      try {
        const response = await this.activeSender.send({
          proactiveOpenConversationId: input.proactiveOpenConversationId,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
        });
        if (response.ok) return { kind: "sent", channel: "proactive" };
        if (deliveryUncertain(response)) return { kind: "unknown", code: "interactive_card_delivery_unconfirmed" };
        return isRetryableStatus(response.status)
          ? { kind: "retryable", code: response.code ?? "interactive_card_send_failed" }
          : { kind: "permanent", code: response.code ?? "interactive_card_send_rejected" };
      } catch {
        return { kind: "unknown", code: "interactive_card_delivery_unconfirmed" };
      }
    }
    const channel = input.sourceEventId ? this.sessions.active(input.sourceEventId) : null;
    if (channel) {
      try {
        const response = await this.sessionSender.send(channel.webhookUrl, input.payload);
        if (response.ok) {
          return { kind: "sent", channel: "session" };
        }
        if (deliveryUncertain(response)) return { kind: "unknown", code: "session_delivery_unconfirmed" };
        if (!input.proactiveOpenConversationId || !this.activeSender) {
          return isRetryableStatus(response.status)
            ? { kind: "retryable", code: response.code ?? "session_send_failed" }
            : { kind: "permanent", code: response.code ?? "session_send_rejected" };
        }
      } catch {
        return { kind: "unknown", code: "session_delivery_unconfirmed" };
      }
    }

    if (!input.proactiveOpenConversationId || !this.activeSender) {
      return { kind: "permanent", code: "delivery_unroutable" };
    }
    try {
      const response = await this.activeSender.send({
        proactiveOpenConversationId: input.proactiveOpenConversationId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
      if (response.ok) return { kind: "sent", channel: "proactive" };
      if (deliveryUncertain(response)) return { kind: "unknown", code: "proactive_delivery_unconfirmed" };
      return isRetryableStatus(response.status)
        ? { kind: "retryable", code: response.code ?? "proactive_send_failed" }
        : { kind: "permanent", code: response.code ?? "proactive_send_rejected" };
    } catch {
      return { kind: "unknown", code: "proactive_delivery_unconfirmed" };
    }
  }
}
