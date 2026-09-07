import type {
  DingTalkCardAction,
  DingTalkInboundMessage,
  DingTalkOwnerTextCommand,
  DingTalkOwnerTextCommandName,
} from "./types.ts";

const TEXT_ACTION = /^(?:请)?(接受|拒绝)[ \t]+([A-Za-z0-9_-]{32,128})(?:[ \t]+(.{1,2000}))?[。！!]?$/u;
const TEXT_COMMAND = /^(?:请)?(状态|暂停|恢复|重试|取消|刷新验收码)[ \t]+(WI-[A-F0-9]{12})[。！!]?$/iu;
const CANDIDATE_COMMAND = /^(?:请)?(批准|退回)[ \t]+(WI-[A-F0-9]{12})(?:[ \t]+(.{1,2000}))?[。！!]?$/iu;
const COMMANDS: Readonly<Record<string, DingTalkOwnerTextCommandName>> = {
  状态: "status",
  暂停: "pause",
  恢复: "resume",
  重试: "retry",
  取消: "cancel",
  刷新验收码: "refresh_approval",
};

/** Match a whole direct utterance, never a command-looking suffix in source material.
 * The optional label is the one our replies render; arbitrary @people are not stripped.
 * This is intent parsing only. Identity, candidate and replay gates remain in the core.
 */
export function directControlText(message: DingTalkInboundMessage): string | null {
  if (!message.addressedToBot || message.resources?.length || /[\r\n\u2028\u2029\p{Cf}]/u.test(message.text)) return null;
  return message.text.trim().replace(/^@研发助手[ \t]+/u, "");
}

export function parseDingTalkDeliveryReviewRequest(message: DingTalkInboundMessage): boolean {
  return message.addressedToBot && !message.resources?.length && /^(?:请)?(?:查看|核查)(?:待核查|未确认|未送达)(?:的)?回复[。！!]?$/u.test(message.text.trim());
}

/** Only explicit direct text is control intent; quoted/document content is not. */
export function parseDingTalkRequirementRecoveryRequest(message: DingTalkInboundMessage): boolean {
  return message.addressedToBot && !message.resources?.length && /^(?:请)?(?:继续|重新)整理需求[。！!]?$/u.test(message.text.trim());
}

/** Only explicit direct text is control intent; quoted/document content is not. */
export function parseDingTalkProjectionRecoveryRequest(message: DingTalkInboundMessage): { ordinal?: number } | null {
  if (!message.addressedToBot || message.resources?.length) return null;
  const matched = /^(?:请)?(?:继续|重新)整理(?:第([1-9][0-9]?|[一二三四五六七八九十])份)?附件[。！!]?$/u.exec(message.text.trim());
  if (!matched) return null;
  if (!matched[1]) return {};
  const ordinal = Number(matched[1]) || "一二三四五六七八九十".indexOf(matched[1]) + 1;
  return { ordinal };
}

/**
 * Parses the deliberately small Owner text protocol. The opaque value is the
 * same server-issued, SHA/version-bound token used by interactive cards; no
 * privilege, Work Item or candidate claim is trusted from visible text.
 */
export function parseDingTalkOwnerTextAction(message: DingTalkInboundMessage): DingTalkCardAction | null {
  const text = directControlText(message);
  if (text === null) return null;
  const matched = TEXT_ACTION.exec(text);
  if (!matched) return null;
  const reject = matched[1] === "拒绝";
  const suppliedReason = matched[3]?.trim();
  // Never silently discard conditions, questions or additional requested actions.
  if (!reject && suppliedReason) return null;
  return {
    conversationId: message.conversationId,
    transportEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    actionToken: matched[2]!,
    sender: message.sender,
    ...(reject && suppliedReason ? { reason: suppliedReason } : {}),
    receivedAt: message.receivedAt ?? Date.now(),
    origin: "text",
  };
}

/** Parses WI-addressed control commands without delegating their meaning to the Planner. */
export function parseDingTalkOwnerTextCommand(message: DingTalkInboundMessage): DingTalkOwnerTextCommand | null {
  const text = directControlText(message);
  if (text === null) return null;
  const candidate = CANDIDATE_COMMAND.exec(text);
  if (candidate) {
    if (candidate[1] === "批准" && candidate[3]?.trim()) return null;
    return {
      conversationId: message.conversationId,
      transportEventId: message.sourceEventId,
      transportMessageId: message.transportMessageId,
      command: candidate[1] === "批准" ? "approve_candidate" : "reject_candidate",
      workItemId: candidate[2]!.toUpperCase(),
      ...(candidate[3]?.trim() ? { reason: candidate[3].trim() } : {}),
      sender: message.sender,
      receivedAt: message.receivedAt ?? Date.now(),
    };
  }
  const matched = TEXT_COMMAND.exec(text);
  if (!matched) return null;
  const command = COMMANDS[matched[1]!];
  if (!command) return null;
  return {
    conversationId: message.conversationId,
    transportEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    command,
    workItemId: matched[2]!.toUpperCase(),
    sender: message.sender,
    receivedAt: message.receivedAt ?? Date.now(),
  };
}
