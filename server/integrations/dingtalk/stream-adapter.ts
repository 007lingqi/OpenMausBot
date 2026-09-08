import { normalizeBotMessage, normalizeCardAction } from "./normalizer.ts";
import type { DingTalkInboundSink, DingTalkOwnerActionSink, DingTalkStreamSdkPort } from "./ports.ts";
import {
  NullDingTalkSafeLogger,
  safeErrorCode,
  stableIdentifierHash,
  type DingTalkSafeLogger,
} from "./safe-log.ts";
import { DingTalkSessionReplyRegistry } from "./reply-router.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";
import { parseDingTalkOwnerTextAction, parseDingTalkOwnerTextCommand, parseDingTalkProjectionRecoveryRequest, parseDingTalkRequirementRecoveryRequest, parseDingTalkDeliveryReviewRequest } from "./text-actions.ts";

export type DingTalkStreamState = "stopped" | "connecting" | "connected" | "reconnecting" | "stopping";

export interface DingTalkStreamAdapterOptions {
  /** When configured, messages from every other conversation are acknowledged and discarded before persistence. */
  allowedConversationIds?: ReadonlySet<string>;
}

export class DingTalkStreamAdapter {
  private readonly sdk: DingTalkStreamSdkPort;
  private readonly inbound: DingTalkInboundSink;
  private readonly ownerActions: DingTalkOwnerActionSink;
  private readonly replyChannels: DingTalkSessionReplyRegistry;
  private readonly logger: DingTalkSafeLogger;
  private readonly options: DingTalkStreamAdapterOptions;
  private currentState: DingTalkStreamState = "stopped";
  private handlersRegistered = false;
  private connectPromise: Promise<DingTalkStreamState> | null = null;
  private lifecycleGeneration = 0;

  constructor(
    sdk: DingTalkStreamSdkPort,
    inbound: DingTalkInboundSink,
    ownerActions: DingTalkOwnerActionSink,
    replyChannels: DingTalkSessionReplyRegistry,
    logger: DingTalkSafeLogger = new NullDingTalkSafeLogger(),
    options: DingTalkStreamAdapterOptions = {},
  ) {
    this.sdk = sdk;
    this.inbound = inbound;
    this.ownerActions = ownerActions;
    this.replyChannels = replyChannels;
    this.logger = logger;
    this.options = options;
  }

  state(): DingTalkStreamState {
    if (this.currentState === "connected" || this.currentState === "reconnecting") {
      return this.sdk.state();
    }
    return this.currentState;
  }

  async maintain(): Promise<DingTalkStreamState> {
    if (this.currentState === "stopped" || this.currentState === "stopping") return this.currentState;
    if (this.sdk.state() === "connected") {
      this.currentState = "connected";
      return this.currentState;
    }
    this.requestReconnect();
    return this.currentState;
  }

  private requestReconnect(): void {
    if (this.currentState === "stopped" || this.currentState === "stopping") return;
    this.currentState = "reconnecting";
    void this.sdk.reconnect()
      .then(({ connected }) => {
        if (this.currentState === "reconnecting") {
          this.currentState = connected ? "connected" : "reconnecting";
        }
      })
      .catch(() => undefined);
  }

  private acknowledge(transportMessageId: string): void {
    try {
      this.sdk.acknowledge(transportMessageId);
    } catch (error) {
      this.requestReconnect();
      throw error;
    }
  }

  start(): Promise<DingTalkStreamState> {
    if (this.connectPromise) return this.connectPromise;
    if (this.currentState === "connected" || this.currentState === "reconnecting") {
      return Promise.resolve(this.currentState);
    }
    if (!this.handlersRegistered) {
      this.sdk.subscribe("robot", (message) => this.receiveRobot(message));
      this.sdk.subscribe("card", (message) => this.receiveCard(message));
      this.handlersRegistered = true;
    }
    this.currentState = "connecting";
    const generation = ++this.lifecycleGeneration;
    this.connectPromise = this.sdk
      .connect()
      .then(({ connected }) => {
        if (generation !== this.lifecycleGeneration || this.currentState === "stopping" || this.currentState === "stopped") {
          return this.currentState;
        }
        this.currentState = connected ? "connected" : "reconnecting";
        return this.currentState;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  stop(): void {
    if (this.currentState === "stopped") return;
    this.currentState = "stopping";
    this.lifecycleGeneration += 1;
    this.sdk.disconnect();
    this.replyChannels.clear();
    this.currentState = "stopped";
  }

  private async receiveRobot(envelope: DingTalkStreamEnvelope): Promise<void> {
    try {
      const normalized = normalizeBotMessage(envelope);
      if (
        this.options.allowedConversationIds &&
        !this.options.allowedConversationIds.has(normalized.message.conversationId)
      ) {
        this.acknowledge(envelope.headers.messageId);
        this.logger.write({
          event: "dingtalk.message.ignored",
          topic: "robot",
          transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
          sourceEventIdHash: stableIdentifierHash(normalized.message.sourceEventId),
          code: "conversation_not_allowed",
        });
        return;
      }
      if (normalized.replyChannel) this.replyChannels.capture(normalized.replyChannel);
      if (parseDingTalkDeliveryReviewRequest(normalized.message)) {
        if (!this.ownerActions.reviewDeliveries) throw new Error("delivery_review_not_configured");
        await this.ownerActions.reviewDeliveries(normalized.message);
        this.acknowledge(envelope.headers.messageId);
        return;
      }
      if (parseDingTalkRequirementRecoveryRequest(normalized.message)) {
        if (!this.ownerActions.recoverRequirements) throw new Error("natural_intake_recovery_not_configured");
        await this.ownerActions.recoverRequirements(normalized.message);
        this.acknowledge(envelope.headers.messageId);
        return;
      }
      if (parseDingTalkProjectionRecoveryRequest(normalized.message)) {
        if (!this.ownerActions.recoverProjection) throw new Error("attachment_projection_recovery_not_configured");
        await this.ownerActions.recoverProjection(normalized.message);
        this.acknowledge(envelope.headers.messageId);
        return;
      }
      const ownerAction = parseDingTalkOwnerTextAction(normalized.message);
      if (ownerAction) {
        const outcome = await this.ownerActions.perform(ownerAction);
        this.acknowledge(envelope.headers.messageId);
        this.logger.write({
          event: "dingtalk.text_action.committed",
          topic: "robot",
          transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
          sourceEventIdHash: stableIdentifierHash(normalized.message.sourceEventId),
          workItemId: outcome.workItemId,
          duplicate: outcome.duplicate,
        });
        return;
      }
      const ownerCommand = parseDingTalkOwnerTextCommand(normalized.message);
      if (ownerCommand) {
        if (!this.ownerActions.performCommand) throw new Error("dingtalk_owner_text_commands_not_configured");
        const outcome = await this.ownerActions.performCommand(ownerCommand);
        this.acknowledge(envelope.headers.messageId);
        this.logger.write({
          event: "dingtalk.text_command.committed",
          topic: "robot",
          transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
          sourceEventIdHash: stableIdentifierHash(normalized.message.sourceEventId),
          workItemId: outcome.workItemId,
          duplicate: outcome.duplicate,
        });
        return;
      }
      const naturalRetry = this.ownerActions.performNaturalRetry ? await this.ownerActions.performNaturalRetry(normalized.message) : null;
      if (naturalRetry) {
        this.acknowledge(envelope.headers.messageId);
        return;
      }
      const naturalApproval = await this.ownerActions.performNaturalApproval?.(normalized.message);
      if (naturalApproval) {
        this.acknowledge(envelope.headers.messageId);
        return;
      }
      const outcome = await this.inbound.ingest(normalized.message);
      if (normalized.privateCapabilities?.length) {
        if (!this.inbound.ingestAttachments) throw new Error("dingtalk_attachment_ingestion_not_configured");
        await this.inbound.ingestAttachments(normalized.privateCapabilities);
      }
      // Success/duplicate both mean the authoritative transaction is durable.
      this.acknowledge(envelope.headers.messageId);
      this.logger.write({
        event: "dingtalk.message.committed",
        topic: "robot",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        sourceEventIdHash: stableIdentifierHash(normalized.message.sourceEventId),
        workItemId: outcome.workItemId,
        duplicate: outcome.duplicate,
      });
    } catch (error) {
      // No acknowledgement: DingTalk may redeliver and core idempotency converges it.
      this.logger.write({
        event: "dingtalk.message.not_acknowledged",
        topic: "robot",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        code: safeErrorCode(error),
      });
    }
  }

  private async receiveCard(envelope: DingTalkStreamEnvelope): Promise<void> {
    try {
      const action = normalizeCardAction(envelope);
      const outcome = await this.ownerActions.perform(action);
      this.acknowledge(envelope.headers.messageId);
      this.logger.write({
        event: "dingtalk.card_action.committed",
        topic: "card",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        sourceEventIdHash: stableIdentifierHash(action.transportEventId),
        workItemId: outcome.workItemId,
        duplicate: outcome.duplicate,
      });
    } catch (error) {
      this.logger.write({
        event: "dingtalk.card_action.not_acknowledged",
        topic: "card",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        code: safeErrorCode(error),
      });
    }
  }
}
