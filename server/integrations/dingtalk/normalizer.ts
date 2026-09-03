import { createHash } from "node:crypto";

import type {
  DingTalkCardAction,
  DingTalkMention,
  DingTalkPrivateResourceCapability,
  DingTalkResourceKind,
  DingTalkResourceRef,
  DingTalkStreamEnvelope,
  NormalizedDingTalkMessage,
} from "./types.ts";

const MAX_PAYLOAD_BYTES = 256_000;
const MAX_TEXT_CHARACTERS = 8_000;
const MAX_REASON_CHARACTERS = 2_000;
const MAX_RESOURCES = 5;
const MAX_MENTIONS = 50;
const MAX_DOWNLOAD_CODE_CHARACTERS = 2_048;
export const UNSUPPORTED_MESSAGE_TEXT = "收到不支持的消息类型，内容未读取。";

type JsonObject = Record<string, unknown>;

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value as JsonObject;
}

function parsePayload(data: string): JsonObject {
  if (Buffer.byteLength(data, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("dingtalk_payload_too_large");
  try {
    return object(JSON.parse(data), "dingtalk_payload");
  } catch (error) {
    if (error instanceof Error && error.message === "dingtalk_payload_invalid") throw error;
    throw new Error("dingtalk_payload_invalid");
  }
}

function optionalString(record: JsonObject, key: string, maximum = 512): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function requiredString(record: JsonObject, key: string, maximum = 512): string {
  const raw = record[key];
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_missing`);
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  if (!value) throw new Error(`dingtalk_${key}_missing`);
  if (value.length > maximum) throw new Error(`dingtalk_${key}_too_large`);
  return value;
}

function requiredOpaque(record: JsonObject, key: string, maximum = 512): string {
  const value = requiredString(record, key, maximum);
  if (/\s/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function optionalOpaque(record: JsonObject, key: string, maximum = 512): string | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_invalid`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > maximum || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function optionalPrivateOpaque(record: JsonObject, key: string, maximum: number): string | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw || raw !== raw.trim()) throw new Error(`dingtalk_${key}_invalid`);
  if (raw.length > maximum || /\s|[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error(`dingtalk_${key}_invalid`);
  }
  return raw;
}

function envelopeIdentifier(value: string | undefined, key: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`dingtalk_${key}_missing`);
  if (normalized.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`dingtalk_${key}_invalid`);
  }
  return normalized;
}

function optionalExactText(record: JsonObject, key: string, maximum: number): string | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_invalid`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,16}$/u.test(value)) return Number(value);
  return undefined;
}

function payloadHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface ExtractedContent {
  text?: string;
  mentions: DingTalkMention[];
  resources: DingTalkResourceRef[];
  privateCapabilities: DingTalkPrivateResourceCapability[];
}

function publicMention(record: JsonObject): DingTalkMention | undefined {
  const targetId =
    optionalOpaque(record, "atUserId", 256) ??
    optionalOpaque(record, "staffId", 256) ??
    optionalOpaque(record, "dingtalkId", 256) ??
    optionalOpaque(record, "userId", 256);
  const displayName =
    optionalString(record, "atName", 128) ??
    optionalString(record, "name", 128) ??
    optionalString(record, "displayName", 128);
  if (!targetId && !displayName) return undefined;
  return {
    ...(targetId ? { targetId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function rootMentions(record: JsonObject): DingTalkMention[] {
  const raw = Array.isArray(record.atUsers) ? record.atUsers : [];
  const mentions: DingTalkMention[] = [];
  for (const item of raw.slice(0, MAX_MENTIONS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const mention = publicMention(item as JsonObject);
    if (mention) mentions.push(mention);
  }
  return mentions;
}

function sizeBytes(record: JsonObject): number | undefined {
  const size = numeric(record.sizeBytes ?? record.fileSize ?? record.size);
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) return undefined;
  return size;
}

function mimeType(record: JsonObject): string | undefined {
  for (const key of ["mimeType", "contentType", "fileType"]) {
    const value = optionalString(record, key, 255);
    if (value && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(value)) return value.toLowerCase();
  }
  return undefined;
}

function resourceName(record: JsonObject): string | undefined {
  return optionalString(record, "fileName", 512) ?? optionalString(record, "name", 512);
}

function capabilityRef(
  sourceEventId: string,
  ordinal: number,
  kind: DingTalkResourceKind,
): string {
  return createHash("sha256")
    .update(`${sourceEventId}\0${ordinal}\0${kind}`)
    .digest("hex");
}

function addResource(
  extracted: ExtractedContent,
  sourceEventId: string,
  kind: DingTalkResourceKind,
  downloadCode: string,
  robotCode: string | undefined,
  metadata: JsonObject,
): void {
  if (extracted.resources.length >= MAX_RESOURCES) return;
  const ref = capabilityRef(sourceEventId, extracted.resources.length, kind);
  const name = resourceName(metadata);
  const mime = mimeType(metadata);
  const size = sizeBytes(metadata);
  extracted.resources.push({
    capabilityRef: ref,
    kind,
    ...(name ? { name } : {}),
    ...(mime ? { mimeType: mime } : {}),
    ...(size !== undefined ? { sizeBytes: size } : {}),
  });
  extracted.privateCapabilities.push({
    capabilityRef: ref,
    downloadCode,
    ...(robotCode ? { robotCode } : {}),
  });
}

function emptyExtractedContent(): ExtractedContent {
  return { mentions: [], resources: [], privateCapabilities: [] };
}

function richText(record: JsonObject, sourceEventId: string, robotCode: string | undefined): ExtractedContent {
  const content = record.content;
  const rich = content && typeof content === "object" && !Array.isArray(content)
    ? (content as JsonObject).richText
    : record.richText;
  const extracted = emptyExtractedContent();
  extracted.mentions = rootMentions(record);
  if (!Array.isArray(rich)) return extracted;
  const fragments: string[] = [];
  for (const item of rich.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const safe = item as JsonObject;
    const text = optionalString(safe, "text", 2_000);
    const mention = optionalString(safe, "atName", 128);
    if (text) fragments.push(text);
    else if (mention) fragments.push(`@${mention}`);
    const publicAt = publicMention(safe);
    if (publicAt && extracted.mentions.length < MAX_MENTIONS) extracted.mentions.push(publicAt);
    const pictureCode = optionalPrivateOpaque(safe, "pictureDownloadCode", MAX_DOWNLOAD_CODE_CHARACTERS);
    const downloadCode = optionalPrivateOpaque(safe, "downloadCode", MAX_DOWNLOAD_CODE_CHARACTERS);
    if (pictureCode) addResource(extracted, sourceEventId, "picture", pictureCode, robotCode, safe);
    else if (downloadCode) addResource(extracted, sourceEventId, "file", downloadCode, robotCode, safe);
    if (fragments.join("\n").length >= MAX_TEXT_CHARACTERS) break;
  }
  const combined = fragments.join("\n").trim().slice(0, MAX_TEXT_CHARACTERS);
  if (combined) extracted.text = combined;
  return extracted;
}

function attachment(
  record: JsonObject,
  sourceEventId: string,
  kind: DingTalkResourceKind,
  robotCode: string | undefined,
): ExtractedContent {
  const extracted = emptyExtractedContent();
  const content = object(record.content, "dingtalk_content");
  const downloadCode = optionalPrivateOpaque(content, "downloadCode", MAX_DOWNLOAD_CODE_CHARACTERS);
  if (downloadCode) addResource(extracted, sourceEventId, kind, downloadCode, robotCode, content);
  return extracted;
}

function actionData(record: JsonObject): JsonObject {
  const raw = record.actionData ?? record.value ?? record.cardPrivateData;
  if (typeof raw === "string") {
    try {
      return object(JSON.parse(raw), "dingtalk_action_data");
    } catch {
      throw new Error("dingtalk_action_data_invalid");
    }
  }
  return object(raw, "dingtalk_action_data");
}

export function normalizeBotMessage(envelope: DingTalkStreamEnvelope, receivedAt = Date.now()): NormalizedDingTalkMessage {
  const record = parsePayload(envelope.data);
  const sourceEventId = requiredOpaque(record, "msgId", 256);
  const msgType = optionalString(record, "msgtype", 64)?.toLowerCase();
  const robotCode = optionalPrivateOpaque(record, "robotCode", 256);
  let extracted = emptyExtractedContent();
  let text: string;
  let contentKind: NormalizedDingTalkMessage["contentKind"];
  if (msgType === "text") {
    const textRecord = object(record.text, "dingtalk_text");
    text = requiredString(textRecord, "content", MAX_TEXT_CHARACTERS);
    extracted.mentions = rootMentions(record);
    contentKind = "text";
  } else if (msgType === "richtext" || msgType === "rich_text") {
    extracted = richText(record, sourceEventId, robotCode);
    if (extracted.resources.length > 0) {
      text = extracted.text ?? `收到 ${extracted.resources.length} 个附件，内容待安全读取。`;
      contentKind = extracted.text ? "mixed" : "attachment";
    } else {
      text = extracted.text ?? UNSUPPORTED_MESSAGE_TEXT;
      contentKind = extracted.text ? "rich_text" : "unsupported";
    }
  } else if (msgType === "file" || msgType === "picture" || msgType === "audio" || msgType === "video") {
    extracted = attachment(record, sourceEventId, msgType, robotCode);
    text = extracted.resources.length > 0
      ? `收到 ${extracted.resources.length} 个附件，内容待安全读取。`
      : UNSUPPORTED_MESSAGE_TEXT;
    contentKind = extracted.resources.length > 0 ? "attachment" : "unsupported";
  } else {
    text = UNSUPPORTED_MESSAGE_TEXT;
    contentKind = "unsupported";
  }

  const transportMessageId = envelopeIdentifier(envelope.headers.messageId, "transport_message_id");
  const conversationId = requiredOpaque(record, "conversationId", 256);
  const senderCorpId = optionalOpaque(record, "senderCorpId", 256);
  const senderStaffId = optionalOpaque(record, "senderStaffId", 256);
  const senderId =
    optionalOpaque(record, "senderId", 256) ??
    `unresolved-${createHash("sha256").update(`${senderCorpId ?? ""}\0${senderStaffId ?? ""}\0${transportMessageId}`).digest("hex").slice(0, 20)}`;
  const sessionWebhook = optionalExactText(record, "sessionWebhook", 4_096);
  const sessionWebhookExpiredTime = numeric(record.sessionWebhookExpiredTime);

  return {
    message: {
      sourceEventId,
      transportMessageId,
      conversationId,
      addressedToBot: true,
      text,
      ...(extracted.resources.length > 0 ? { resources: extracted.resources } : {}),
      ...(extracted.mentions.length > 0 ? { mentions: extracted.mentions } : {}),
      ...(optionalOpaque(record, "originalMsgId", 256)
        ? { replyToSourceEventId: optionalOpaque(record, "originalMsgId", 256) }
        : {}),
      sender: {
        ...(senderCorpId ? { senderCorpId } : {}),
        ...(senderStaffId ? { senderStaffId } : {}),
        senderId,
        displayName: optionalString(record, "senderNick", 256) ?? "DingTalk member",
      },
      receivedAt,
    },
    ...(sessionWebhook && sessionWebhookExpiredTime
      ? { replyChannel: { sourceEventId, webhookUrl: sessionWebhook, expiresAt: sessionWebhookExpiredTime } }
      : {}),
    ...(extracted.privateCapabilities.length > 0 ? { privateCapabilities: extracted.privateCapabilities } : {}),
    contentKind,
    payloadHash: payloadHash(envelope.data),
  };
}

export function normalizeCardAction(envelope: DingTalkStreamEnvelope, receivedAt = Date.now()): DingTalkCardAction {
  const record = parsePayload(envelope.data);
  const action = actionData(record);
  const actionId = optionalOpaque(action, "actionId", 128) ?? optionalOpaque(record, "actionId", 128);
  let actionToken = optionalOpaque(action, "actionToken", 1_024);
  if (!actionToken && actionId) {
    const privateData = actionData({ actionData: record.cardPrivateData });
    const tokens = object(privateData.actionTokens, "dingtalk_action_tokens");
    actionToken = requiredOpaque(tokens, actionId, 1_024);
  }
  if (!actionToken) throw new Error("dingtalk_actionToken_missing");
  const senderCorpId = optionalOpaque(record, "senderCorpId", 256) ?? optionalOpaque(record, "corpId", 256);
  const senderStaffId = optionalOpaque(record, "senderStaffId", 256) ?? optionalOpaque(record, "userId", 256);
  const transportMessageId = envelopeIdentifier(envelope.headers.messageId, "transport_message_id");
  return {
    transportEventId: envelope.headers.eventId
      ? envelopeIdentifier(envelope.headers.eventId, "transport_event_id")
      : transportMessageId,
    transportMessageId,
    actionToken,
    sender: {
      ...(senderCorpId ? { senderCorpId } : {}),
      ...(senderStaffId ? { senderStaffId } : {}),
      senderId: optionalOpaque(record, "senderId", 256) ?? senderStaffId ?? `unresolved-${transportMessageId}`,
      displayName: optionalString(record, "senderNick", 256) ?? "DingTalk member",
    },
    ...(optionalString(action, "reason", MAX_REASON_CHARACTERS)
      ? { reason: optionalString(action, "reason", MAX_REASON_CHARACTERS) }
      : actionId === "action-2"
        ? { reason: "Owner rejected candidate via DingTalk interactive card" }
        : {}),
    origin: "card",
    // Authorization TTLs use the service receive clock, never payload/header time.
    receivedAt,
  };
}
