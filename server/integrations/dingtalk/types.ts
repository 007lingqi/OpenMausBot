export interface DingTalkSender {
  senderCorpId?: string;
  senderStaffId?: string;
  senderId: string;
  displayName: string;
}

export type DingTalkResourceKind = "file" | "picture" | "audio" | "video";

/** Public, durable description of an inbound resource. No download authority belongs here. */
export interface DingTalkResourceRef {
  capabilityRef: string;
  kind: DingTalkResourceKind;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** A public mention extracted from message text. It never grants permissions. */
export interface DingTalkMention {
  targetId?: string;
  displayName?: string;
}

/** Transport delivery and DingTalk business event identifiers are distinct. */
export interface DingTalkInboundMessage {
  sourceEventId: string;
  transportMessageId: string;
  conversationId: string;
  addressedToBot: boolean;
  text: string;
  resources?: DingTalkResourceRef[];
  mentions?: DingTalkMention[];
  replyToSourceEventId?: string;
  sender: DingTalkSender;
  receivedAt?: number;
}

/** Ephemeral authority needed by the downloader; callers must not persist or log it. */
export interface DingTalkPrivateResourceCapability {
  capabilityRef: string;
  downloadCode: string;
  robotCode?: string;
}

export interface DingTalkSessionReplyChannel {
  sourceEventId: string;
  webhookUrl: string;
  expiresAt: number;
}

export interface DingTalkCardAction {
  /** Stream delivery identity, used by the durable sink for idempotency. */
  transportEventId: string;
  transportMessageId: string;
  actionToken: string;
  sender: DingTalkSender;
  reason?: string;
  receivedAt: number;
  origin?: "card" | "text";
}

export type DingTalkOwnerTextCommandName =
  | "status"
  | "pause"
  | "resume"
  | "retry"
  | "cancel"
  | "refresh_approval"
  | "approve_candidate"
  | "reject_candidate";

export interface DingTalkOwnerTextCommand {
  transportEventId: string;
  transportMessageId: string;
  command: DingTalkOwnerTextCommandName;
  workItemId: string;
  reason?: string;
  sender: DingTalkSender;
  receivedAt: number;
}

export interface DingTalkOwnerTextCommandOutcome {
  allowed: boolean;
  duplicate: boolean;
  command: DingTalkOwnerTextCommandName;
  workItemId: string;
  reason: string;
}

export interface DingTalkProjectionRecoveryOutcome {
  allowed: boolean;
  duplicate: boolean;
  workItemId: string | null;
  reason: string;
}

export interface DingTalkStreamEnvelope {
  type: string;
  headers: {
    messageId: string;
    topic: string;
    eventId?: string;
    time?: string;
  };
  data: string;
}

export interface NormalizedDingTalkMessage {
  message: DingTalkInboundMessage;
  replyChannel?: DingTalkSessionReplyChannel;
  privateCapabilities?: DingTalkPrivateResourceCapability[];
  contentKind: "text" | "rich_text" | "attachment" | "mixed" | "unsupported";
  payloadHash: string;
}
