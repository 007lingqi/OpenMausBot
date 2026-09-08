import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import type { OwnerActionOutcome } from "../../collaboration/actions.ts";
import type { NaturalApprovalOutcome } from "../../collaboration/natural-approval.ts";
import type { NaturalRetryOutcome } from "../../collaboration/natural-retry.ts";
import type { DeliveryReviewOutcome } from "../../collaboration/delivery-review.ts";
import type {
  DingTalkCardAction,
  DingTalkInboundMessage,
  DingTalkPrivateResourceCapability,
  DingTalkOwnerTextCommand,
  DingTalkOwnerTextCommandOutcome,
  DingTalkProjectionRecoveryOutcome,
  DingTalkRequirementRecoveryOutcome,
  DingTalkStreamEnvelope,
} from "./types.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface DingTalkInboundSink {
  ingest(message: DingTalkInboundMessage): MaybePromise<InboundMessageOutcome>;
  ingestAttachments?(capabilities: readonly DingTalkPrivateResourceCapability[]): MaybePromise<void>;
}

export interface DingTalkOwnerActionSink {
  performNaturalRetry?(message: DingTalkInboundMessage): MaybePromise<NaturalRetryOutcome | null>;
  performNaturalApproval?(message: DingTalkInboundMessage): MaybePromise<NaturalApprovalOutcome | null>;
  reviewDeliveries?(message: DingTalkInboundMessage): MaybePromise<DeliveryReviewOutcome>;
  recoverRequirements?(message: DingTalkInboundMessage): MaybePromise<DingTalkRequirementRecoveryOutcome>;
  recoverProjection?(message: DingTalkInboundMessage): MaybePromise<DingTalkProjectionRecoveryOutcome>;
  perform(action: DingTalkCardAction): MaybePromise<OwnerActionOutcome>;
  performCommand?(command: DingTalkOwnerTextCommand): MaybePromise<DingTalkOwnerTextCommandOutcome>;
}

export interface DingTalkStreamSdkPort {
  subscribe(topic: "robot" | "card", handler: (message: DingTalkStreamEnvelope) => MaybePromise<void>): void;
  connect(): Promise<{ connected: boolean }>;
  reconnect(): Promise<{ connected: boolean }>;
  state(): "connected" | "reconnecting" | "stopped";
  disconnect(): void;
  acknowledge(transportMessageId: string): void;
}

export interface DingTalkHttpResult {
  ok: boolean;
  status: number;
  /** Existing accepted send recovered by query, not a fresh transmission. */
  recovered?: true;
  code?: string;
  deliveryState?: "not_sent" | "unknown";
}

export interface DingTalkSessionSendPort {
  send(webhookUrl: string, payload: unknown): Promise<DingTalkHttpResult>;
}

export interface DingTalkActiveSendPort {
  send(input: {
    proactiveOpenConversationId: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkHttpResult>;
}

export type DingTalkDeliveryResult =
  | { kind: "sent"; channel: "session" | "proactive"; recovered?: true }
  | { kind: "retryable"; code: string }
  | { kind: "unknown"; code: string }
  | { kind: "permanent"; code: string };

/** Transport-neutral shape consumed by the collaboration outbox dispatcher. */
export interface DingTalkDeliveryPort {
  send(input: {
    sourceEventId?: string;
    proactiveOpenConversationId?: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkDeliveryResult>;
}
