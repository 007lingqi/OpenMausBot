import { describe, expect, it } from "vitest";

import type { DingTalkInboundMessage } from "./types.ts";
import { parseDingTalkOwnerTextAction, parseDingTalkOwnerTextCommand, parseDingTalkProjectionRecoveryRequest, parseDingTalkRequirementRecoveryRequest } from "./text-actions.ts";

const token = "accept_code_12345678901234567890123456789012";

function message(text: string): DingTalkInboundMessage {
  return {
    sourceEventId: "source-1",
    transportMessageId: "transport-1",
    conversationId: "conversation-1",
    addressedToBot: true,
    text,
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "owner-1",
      senderId: "sender-1",
      displayName: "Owner",
    },
    receivedAt: 1_700_000_000_000,
  };
}

describe("DingTalk Owner text actions", () => {
  it("does not turn quoted, negated, attachment-bearing or unaddressed text into requirement recovery", () => {
    expect(parseDingTalkRequirementRecoveryRequest(message("请继续整理需求。"))).toBe(true);
    for (const text of ["不要继续整理需求", "“继续整理需求”", "文档说继续整理需求", "是否继续整理需求？", "继续整理需求\n并部署生产"]) {
      expect(parseDingTalkRequirementRecoveryRequest(message(text))).toBe(false);
    }
    expect(parseDingTalkRequirementRecoveryRequest({ ...message("继续整理需求"), addressedToBot: false })).toBe(false);
    expect(parseDingTalkRequirementRecoveryRequest({ ...message("继续整理需求"), resources: [{ capabilityRef: "a".repeat(64), kind: "file" }] })).toBe(false);
  });
  it("only accepts directly addressed explicit attachment recovery, not quoted instructions or documents", () => {
    expect(parseDingTalkProjectionRecoveryRequest(message("继续整理附件"))).toEqual({});
    expect(parseDingTalkProjectionRecoveryRequest(message("请重新整理第二份附件。"))).toEqual({ ordinal: 2 });
    for (const text of ["不要继续整理附件", "文档说：继续整理附件", "“继续整理附件”", "是否继续整理附件？", "继续整理第0份附件"]) {
      expect(parseDingTalkProjectionRecoveryRequest(message(text))).toBeNull();
    }
    expect(parseDingTalkProjectionRecoveryRequest({ ...message("继续整理附件"), addressedToBot: false })).toBeNull();
    expect(parseDingTalkProjectionRecoveryRequest({ ...message("继续整理附件"), resources: [{ capabilityRef: "a".repeat(64), kind: "file", name: "instructions.md" }] })).toBeNull();
  });
  it("turns a copied acceptance command into the existing opaque-token action contract", () => {
    expect(parseDingTalkOwnerTextAction(message(`@研发助手 接受 ${token}`))).toEqual({
      conversationId: "conversation-1",
      transportEventId: "source-1",
      transportMessageId: "transport-1",
      actionToken: token,
      sender: message("").sender,
      receivedAt: 1_700_000_000_000,
      origin: "text",
    });
  });

  it("keeps rejection feedback and ignores ordinary product discussion", () => {
    expect(parseDingTalkOwnerTextAction(message(`@研发助手 拒绝 ${token} 登录页仍然报错`))).toMatchObject({
      actionToken: token,
      reason: "登录页仍然报错",
      origin: "text",
    });
    expect(parseDingTalkOwnerTextAction(message("这个候选我还需要看一下"))).toBeNull();
  });

  it("parses the deterministic WI-addressed command set without treating discussion as control", () => {
    const cases = [
      ["状态", "status"],
      ["暂停", "pause"],
      ["恢复", "resume"],
      ["重试", "retry"],
      ["取消", "cancel"],
      ["刷新验收码", "refresh_approval"],
    ] as const;
    for (const [label, command] of cases) {
      expect(parseDingTalkOwnerTextCommand(message(`@研发助手 ${label} WI-a1b2c3d4e5f6`))).toMatchObject({
        command,
        workItemId: "WI-A1B2C3D4E5F6",
        transportEventId: "source-1",
      });
    }
    expect(parseDingTalkOwnerTextCommand(message("我们是否应该暂停这个需求？"))).toBeNull();
    expect(parseDingTalkOwnerTextCommand(message("状态 WI-INVALID-001"))).toBeNull();
  });

  it("parses plain-language approval and rejection by Work Item ID", () => {
    expect(parseDingTalkOwnerTextCommand(message("@研发助手 批准 WI-a1b2c3d4e5f6"))).toMatchObject({
      command: "approve_candidate",
      workItemId: "WI-A1B2C3D4E5F6",
    });
    expect(parseDingTalkOwnerTextCommand(message("@研发助手 退回 WI-a1b2c3d4e5f6 首页文案仍不清楚"))).toMatchObject({
      command: "reject_candidate",
      workItemId: "WI-A1B2C3D4E5F6",
      reason: "首页文案仍不清楚",
    });
    expect(parseDingTalkOwnerTextCommand(message("这个任务可以批准吗？"))).toBeNull();
  });
});
