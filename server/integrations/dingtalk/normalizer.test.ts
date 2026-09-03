import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeBotMessage, normalizeCardAction, UNSUPPORTED_MESSAGE_TEXT } from "./normalizer.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string, messageId = `transport-${name}`, eventId?: string): DingTalkStreamEnvelope {
  return {
    type: "CALLBACK",
    headers: { messageId, topic: "fixture", ...(eventId ? { eventId } : {}) },
    data: readFileSync(join(fixtures, name), "utf8"),
  };
}

describe("DingTalk strict normalizer", () => {
  it("keeps business and transport identities separate and keeps the reply webhook ephemeral", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-text.json", "transport-99"));
    expect(normalized.message).toMatchObject({
      sourceEventId: "biz-message-1",
      transportMessageId: "transport-99",
      conversationId: "cid-group-1",
      text: "修复登录失败，并补充回归测试",
      sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1" },
    });
    expect(normalized.replyChannel).toMatchObject({ sourceEventId: "biz-message-1", expiresAt: 4_102_444_800_000 });
    expect(JSON.stringify(normalized.message)).not.toContain("sessionWebhook");
    expect(JSON.stringify(normalized.message)).not.toContain("test-only");
  });

  it("extracts bounded rich text, mentions, public resource refs, and private media capabilities", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-rich-text-reference.json"));
    expect(normalized).toMatchObject({
      contentKind: "mixed",
      message: {
        text: "复现于空 Token\n@机器人",
        replyToSourceEventId: "biz-message-1",
        mentions: [{ targetId: "ignored", displayName: "机器人" }],
        resources: [{ capabilityRef: expect.stringMatching(/^[a-f0-9]{64}$/u), kind: "picture" }],
      },
      privateCapabilities: [{
        capabilityRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
        downloadCode: "ignored-media-code",
      }],
    });
    expect(normalized.message.resources?.[0]?.capabilityRef).toBe(normalized.privateCapabilities?.[0]?.capabilityRef);
    expect(JSON.stringify(normalized.message)).not.toContain("ignored-media-code");
  });

  it("recognizes attachment messages without trusting supplied URLs or captions", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-unsupported-media.json"));
    expect(normalized).toMatchObject({
      contentKind: "attachment",
      message: {
        text: "收到 1 个附件，内容待安全读取。",
        resources: [{ capabilityRef: expect.stringMatching(/^[a-f0-9]{64}$/u), kind: "file" }],
      },
      privateCapabilities: [{
        capabilityRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
        downloadCode: "do-not-forward",
      }],
    });
    expect(JSON.stringify(normalized.message)).not.toContain("attacker.invalid");
    expect(JSON.stringify(normalized.message)).not.toContain("ignore previous instructions");
    expect(JSON.stringify(normalized)).not.toContain("attacker.invalid");
  });

  it.each(["file", "picture", "audio", "video"])("recognizes %s downloadCode", (msgtype) => {
    const envelope = fixture("bot-message-unsupported-media.json", `transport-${msgtype}`);
    const payload = JSON.parse(envelope.data) as Record<string, unknown>;
    payload.msgId = `biz-${msgtype}`;
    payload.msgtype = msgtype;
    payload.robotCode = "robot-private";
    payload.content = {
      downloadCode: `code-${msgtype}`,
      fileName: `${msgtype}.bin`,
      mimeType: "application/octet-stream",
      fileSize: "42",
      downloadUrl: "https://attacker.invalid/never-use",
    };
    const normalized = normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) });
    expect(normalized).toMatchObject({
      contentKind: "attachment",
      message: {
        resources: [{ kind: msgtype, name: `${msgtype}.bin`, mimeType: "application/octet-stream", sizeBytes: 42 }],
      },
      privateCapabilities: [{ downloadCode: `code-${msgtype}`, robotCode: "robot-private" }],
    });
    expect(JSON.stringify(normalized.message)).not.toMatch(/code-|robot-private|attacker\.invalid/u);
  });

  it("supports rich-text downloadCode aliases, keeps at most five resources, and keeps text mentions", () => {
    const envelope = fixture("bot-message-rich-text-reference.json", "transport-rich-media");
    const payload = JSON.parse(envelope.data) as Record<string, unknown>;
    payload.robotCode = "robot-private";
    payload.content = {
      richText: [
        { text: "请检查附件" },
        { atName: "张三", atUserId: "staff-zhang" },
        { downloadCode: "file-code", fileName: "bug.docx", fileType: "application/vnd.test", fileSize: 12 },
        { pictureDownloadCode: "picture-1" },
        { pictureDownloadCode: "picture-2" },
        { pictureDownloadCode: "picture-3" },
        { pictureDownloadCode: "picture-4" },
        { pictureDownloadCode: "ignored-sixth" },
      ],
    };
    const normalized = normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) });
    expect(normalized.contentKind).toBe("mixed");
    expect(normalized.message.text).toBe("请检查附件\n@张三");
    expect(normalized.message.mentions).toEqual([{ targetId: "staff-zhang", displayName: "张三" }]);
    expect(normalized.message.resources).toHaveLength(5);
    expect(normalized.message.resources?.map((resource) => resource.kind)).toEqual([
      "file", "picture", "picture", "picture", "picture",
    ]);
    expect(normalized.privateCapabilities).toHaveLength(5);
    expect(JSON.stringify(normalized)).not.toContain("ignored-sixth");
  });

  it("rejects invalid opaque download and robot codes", () => {
    const envelope = fixture("bot-message-unsupported-media.json", "transport-invalid-code");
    const payload = JSON.parse(envelope.data) as Record<string, unknown>;
    payload.robotCode = "robot\ncode";
    expect(() => normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) }))
      .toThrowError("dingtalk_robotCode_invalid");

    delete payload.robotCode;
    payload.content = { downloadCode: "x".repeat(2_049) };
    expect(() => normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) }))
      .toThrowError("dingtalk_downloadCode_invalid");

    payload.content = { downloadCode: " code-with-padding" };
    expect(() => normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) }))
      .toThrowError("dingtalk_downloadCode_invalid");
  });

  it("keeps root text mentions without granting them authority", () => {
    const envelope = fixture("bot-message-text.json", "transport-text-mentions");
    const payload = JSON.parse(envelope.data) as Record<string, unknown>;
    payload.atUsers = [
      { atUserId: "staff-3", atName: "产品经理", isAdmin: true },
      { staffId: "staff-4", name: "测试" },
    ];
    const normalized = normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) });
    expect(normalized.message.mentions).toEqual([
      { targetId: "staff-3", displayName: "产品经理" },
      { targetId: "staff-4", displayName: "测试" },
    ]);
    expect(JSON.stringify(normalized.message.mentions)).not.toContain("isAdmin");
  });

  it("still replaces unsupported messages without a safe resource capability", () => {
    const envelope = fixture("bot-message-unsupported-media.json", "transport-no-code");
    const payload = JSON.parse(envelope.data) as Record<string, unknown>;
    payload.content = { downloadUrl: "https://attacker.invalid/no-code" };
    const normalized = normalizeBotMessage({ ...envelope, data: JSON.stringify(payload) });
    expect(normalized).toMatchObject({ contentKind: "unsupported", message: { text: UNSUPPORTED_MESSAGE_TEXT } });
  });

  it("uses Stream event identity for card dedupe and ignores embedded privilege claims", () => {
    const messageIdentity = normalizeBotMessage(fixture("bot-message-text.json")).message.sender;
    const normalized = normalizeCardAction(
      fixture("card-action-owner.json", "transport-card-1", "event-card-1"),
      1_700_000_003_000,
    );
    expect(normalized).toEqual({
      transportEventId: "event-card-1",
      transportMessageId: "transport-card-1",
      actionToken: "opaque-test-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "owner-1",
        senderId: "owner-sender-1",
        displayName: "Owner",
      },
      reason: "验收不符合预期",
      receivedAt: 1_700_000_003_000,
      origin: "card",
    });
    expect(normalized).not.toHaveProperty("action");
    expect(normalized).not.toHaveProperty("role");
    expect(normalized).not.toHaveProperty("workItemId");
    const sameMemberEnvelope = fixture("card-action-owner.json", "transport-card-2", "event-card-2");
    const sameMemberPayload = JSON.parse(sameMemberEnvelope.data) as Record<string, unknown>;
    sameMemberPayload.userId = messageIdentity.senderStaffId;
    sameMemberPayload.senderId = messageIdentity.senderId;
    const sameMember = normalizeCardAction(
      { ...sameMemberEnvelope, data: JSON.stringify(sameMemberPayload) },
      1_700_000_003_000,
    );
    expect({ corp: sameMember.sender.senderCorpId, staff: sameMember.sender.senderStaffId }).toEqual({
      corp: messageIdentity.senderCorpId,
      staff: messageIdentity.senderStaffId,
    });
  });

  it("selects only the clicked token from card private data and audits button rejection", () => {
    expect(normalizeCardAction(
      fixture("card-action-private-data.json", "transport-card-private", "event-card-private"),
      1_700_000_003_000,
    )).toEqual({
      transportEventId: "event-card-private",
      transportMessageId: "transport-card-private",
      actionToken: "reject-opaque-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "owner-1",
        senderId: "owner-sender-1",
        displayName: "Owner",
      },
      reason: "Owner rejected candidate via DingTalk interactive card",
      receivedAt: 1_700_000_003_000,
      origin: "card",
    });
  });
});
