import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import type { OwnerActionOutcome } from "../../collaboration/actions.ts";
import type { DingTalkInboundSink, DingTalkOwnerActionSink, DingTalkStreamSdkPort, MaybePromise } from "./ports.ts";
import { DingTalkSessionReplyRegistry } from "./reply-router.ts";
import type { DingTalkCardAction, DingTalkInboundMessage, DingTalkStreamEnvelope } from "./types.ts";
import { DingTalkStreamAdapter } from "./stream-adapter.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function envelope(name: string, messageId: string, eventId?: string): DingTalkStreamEnvelope {
  return {
    type: "CALLBACK",
    headers: { messageId, topic: name.includes("card") ? "card" : "robot", ...(eventId ? { eventId } : {}) },
    data: readFileSync(join(fixtures, name), "utf8"),
  };
}

function scenario<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
}

function inboundOutcome(message: DingTalkInboundMessage, duplicate = false): InboundMessageOutcome {
  return {
    accepted: true,
    duplicate,
    sourceEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    principalId: "principal-1",
    principalResolution: "resolved",
    association: "created",
    workItemId: "WI-1",
    card: {
      type: "primary_status_card",
      headline: "已接收",
      acknowledgement: "durable",
      workItemId: "WI-1",
      workItemStatus: "collecting",
      workItemVersion: 1,
      association: "created",
    },
    outboxId: "outbox-1",
  };
}

function ownerOutcome(duplicate = false): OwnerActionOutcome {
  return {
    allowed: true,
    duplicate,
    action: "pause",
    workItemId: "WI-1",
    workItemVersion: 2,
    controlState: "paused",
    candidateSha: null,
    reason: "allowed",
    revisedSnapshotRevision: null,
    interruptRequestedRunIds: [],
  };
}

class FakeSdk implements DingTalkStreamSdkPort {
  readonly handlers = new Map<"robot" | "card", (message: DingTalkStreamEnvelope) => MaybePromise<void>>();
  readonly acknowledgements: string[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  reconnectCalls = 0;
  connected = true;
  acknowledgeError: Error | null = null;

  subscribe(topic: "robot" | "card", handler: (message: DingTalkStreamEnvelope) => MaybePromise<void>): void {
    if (this.handlers.has(topic)) throw new Error("duplicate_handler");
    this.handlers.set(topic, handler);
  }

  async connect(): Promise<{ connected: boolean }> {
    this.connectCalls += 1;
    return { connected: this.connected };
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  acknowledge(messageId: string): void {
    if (this.acknowledgeError) throw this.acknowledgeError;
    this.acknowledgements.push(messageId);
  }

  async reconnect(): Promise<{ connected: boolean }> {
    this.reconnectCalls += 1;
    this.connected = true;
    return { connected: true };
  }

  state(): "connected" | "reconnecting" | "stopped" {
    return this.connected ? "connected" : "reconnecting";
  }

  async emit(topic: "robot" | "card", message: DingTalkStreamEnvelope): Promise<void> {
    const handler = this.handlers.get(topic);
    if (!handler) throw new Error("handler_missing");
    await handler(message);
  }
}

describe("DingTalk Stream adapter", () => {
  it("registers callbacks once and relies on the SDK reconnect lifecycle", async () => {
    const recorded = scenario<{ initialConnected: boolean; expectedState: string; expectedTopics: string[] }>("reconnect.json");
    const sdk = new FakeSdk();
    sdk.connected = recorded.initialConnected;
    const adapter = new DingTalkStreamAdapter(
      sdk,
      { ingest: (message) => inboundOutcome(message) },
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
    );
    const first = adapter.start();
    const second = adapter.start();
    expect(await first).toBe(recorded.expectedState);
    expect(await second).toBe(recorded.expectedState);
    expect(sdk.connectCalls).toBe(1);
    expect([...sdk.handlers.keys()].sort()).toEqual(recorded.expectedTopics);
    adapter.stop();
    expect(sdk.disconnectCalls).toBe(1);
    expect(adapter.state()).toBe("stopped");
  });

  it("acknowledges only after the authoritative ingest transaction resolves", async () => {
    const recorded = scenario<{ transportMessageId: string; requiredOrder: string[] }>("late-ack.json");
    const sdk = new FakeSdk();
    let resolveIngest: ((outcome: InboundMessageOutcome) => void) | undefined;
    let captured: DingTalkInboundMessage | undefined;
    const inbound: DingTalkInboundSink = {
      ingest(message) {
        captured = message;
        return new Promise((resolve) => {
          resolveIngest = resolve;
        });
      },
    };
    const adapter = new DingTalkStreamAdapter(
      sdk,
      inbound,
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
    );
    await adapter.start();
    const delivery = sdk.emit("robot", envelope("bot-message-text.json", recorded.transportMessageId));
    await Promise.resolve();
    expect(captured?.sourceEventId).toBe("biz-message-1");
    expect(sdk.acknowledgements).toEqual([]);
    if (!captured || !resolveIngest) throw new Error("ingest_not_started");
    resolveIngest(inboundOutcome(captured));
    await delivery;
    expect(recorded.requiredOrder).toEqual(["persist", "ack"]);
    expect(sdk.acknowledgements).toEqual([recorded.transportMessageId]);
  });

  it("persists and processes private attachment capabilities before acknowledging", async () => {
    const sdk = new FakeSdk();
    const order: string[] = [];
    const captured: unknown[] = [];
    const adapter = new DingTalkStreamAdapter(
      sdk,
      {
        ingest(message) {
          order.push("ledger");
          expect(message.resources).toEqual([
            expect.objectContaining({ kind: "file", name: "bugs.csv" }),
          ]);
          expect(JSON.stringify(message)).not.toContain("download-private");
          return inboundOutcome(message);
        },
        ingestAttachments(capabilities) {
          order.push("attachment");
          captured.push(...capabilities);
        },
      },
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(),
    );
    await adapter.start();
    const payload = JSON.parse(envelope("bot-message-text.json", "attachment-transport").data) as Record<string, unknown>;
    payload.msgtype = "file";
    payload.robotCode = "robot-code";
    payload.content = { fileName: "bugs.csv", downloadCode: "download-private", fileType: "text/csv" };
    delete payload.text;
    await sdk.emit("robot", {
      ...envelope("bot-message-text.json", "attachment-transport"),
      data: JSON.stringify(payload),
    });

    expect(order).toEqual(["ledger", "attachment"]);
    expect(captured).toEqual([
      expect.objectContaining({ downloadCode: "download-private", robotCode: "robot-code" }),
    ]);
    expect(sdk.acknowledgements).toEqual(["attachment-transport"]);
  });

  it("does not acknowledge an attachment when durable resource processing fails", async () => {
    const sdk = new FakeSdk();
    const adapter = new DingTalkStreamAdapter(
      sdk,
      {
        ingest: (message) => inboundOutcome(message),
        ingestAttachments() {
          throw new Error("attachment_store_unavailable");
        },
      },
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(),
    );
    await adapter.start();
    const base = envelope("bot-message-text.json", "attachment-failed");
    const payload = JSON.parse(base.data) as Record<string, unknown>;
    payload.msgtype = "file";
    payload.content = { fileName: "bugs.csv", downloadCode: "download-private" };
    delete payload.text;
    await sdk.emit("robot", { ...base, data: JSON.stringify(payload) });
    expect(sdk.acknowledgements).toEqual([]);
  });

  it("treats a durable duplicate as success but leaves failed persistence unacknowledged", async () => {
    const recorded = scenario<{ businessEventId: string; transportMessageIds: string[] }>("duplicate-delivery.json");
    const sdk = new FakeSdk();
    const seen = new Set<string>();
    const inbound: DingTalkInboundSink = {
      ingest(message) {
        const duplicate = seen.has(message.sourceEventId);
        seen.add(message.sourceEventId);
        return inboundOutcome(message, duplicate);
      },
    };
    const adapter = new DingTalkStreamAdapter(
      sdk,
      inbound,
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
    );
    await adapter.start();
    await sdk.emit("robot", envelope("bot-message-text.json", recorded.transportMessageIds[0]!));
    await sdk.emit("robot", envelope("bot-message-text.json", recorded.transportMessageIds[1]!));
    expect(seen).toEqual(new Set([recorded.businessEventId]));
    expect(sdk.acknowledgements).toEqual(recorded.transportMessageIds);

    const failedSdk = new FakeSdk();
    const failed = new DingTalkStreamAdapter(
      failedSdk,
      { ingest: () => { throw new Error("ledger_write_failed"); } },
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(),
    );
    await failed.start();
    await failedSdk.emit("robot", envelope("bot-message-text.json", "transport-failed"));
    expect(failedSdk.acknowledgements).toEqual([]);
  });

  it("requests a Stream reconnect when a durable message cannot be acknowledged", async () => {
    const sdk = new FakeSdk();
    sdk.acknowledgeError = new Error("socket_not_open");
    const logged: Array<{ event: string; code?: string }> = [];
    const adapter = new DingTalkStreamAdapter(
      sdk,
      { ingest: (message) => inboundOutcome(message) },
      { perform: () => ownerOutcome() },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
      { write: (event) => logged.push(event) },
    );
    await adapter.start();

    await sdk.emit("robot", envelope("bot-message-text.json", "transport-ack-failed"));

    await vi.waitFor(() => expect(sdk.reconnectCalls).toBe(1));
    expect(sdk.acknowledgements).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({
      event: "dingtalk.message.not_acknowledged",
      code: "dingtalk_transport_error",
    }));
  });

  it("acknowledges and discards messages outside the configured conversation allowlist", async () => {
    const sdk = new FakeSdk();
    const ingested: DingTalkInboundMessage[] = [];
    const logged: Array<{ event: string; code?: string }> = [];
    const sessions = new DingTalkSessionReplyRegistry(() => 1_700_000_000_000);
    const adapter = new DingTalkStreamAdapter(
      sdk,
      {
        ingest(message) {
          ingested.push(message);
          return inboundOutcome(message);
        },
      },
      { perform: () => ownerOutcome() },
      sessions,
      { write: (event) => logged.push(event) },
      { allowedConversationIds: new Set(["cid-research-1"]) },
    );
    await adapter.start();
    await sdk.emit("robot", envelope("bot-message-text.json", "transport-outside-allowlist"));
    expect(ingested).toEqual([]);
    expect(sdk.acknowledgements).toEqual(["transport-outside-allowlist"]);
    expect(sessions.active("biz-message-1")).toBeNull();
    expect(logged).toContainEqual(expect.objectContaining({
      event: "dingtalk.message.ignored",
      code: "conversation_not_allowed",
    }));
  });

  it("passes only opaque token, current sender, reason, and transport event identity to Owner actions", async () => {
    const sdk = new FakeSdk();
    let captured: DingTalkCardAction | undefined;
    const actions: DingTalkOwnerActionSink = {
      perform(action) {
        captured = action;
        return ownerOutcome();
      },
    };
    const adapter = new DingTalkStreamAdapter(
      sdk,
      { ingest: (message) => inboundOutcome(message) },
      actions,
      new DingTalkSessionReplyRegistry(),
    );
    await adapter.start();
    await sdk.emit("card", envelope("card-action-owner.json", "card-transport", "card-event"));
    expect(captured).toMatchObject({
      transportEventId: "card-event",
      actionToken: "opaque-test-token",
      sender: { senderCorpId: "corp-1", senderStaffId: "owner-1" },
      reason: "验收不符合预期",
    });
    expect(sdk.acknowledgements).toEqual(["card-transport"]);
  });

  it("routes copied text decisions to Owner actions instead of creating a new Work Item", async () => {
    const sdk = new FakeSdk();
    const ingested: DingTalkInboundMessage[] = [];
    let captured: DingTalkCardAction | undefined;
    const adapter = new DingTalkStreamAdapter(
      sdk,
      {
        ingest(message) {
          ingested.push(message);
          return inboundOutcome(message);
        },
      },
      {
        perform(action) {
          captured = action;
          return ownerOutcome();
        },
      },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
    );
    await adapter.start();
    const command = envelope("bot-message-text.json", "transport-text-action");
    const payload = JSON.parse(command.data) as { text: { content: string } };
    payload.text.content = "@研发助手 接受 accept_code_12345678901234567890123456789012";
    await sdk.emit("robot", { ...command, data: JSON.stringify(payload) });
    expect(ingested).toEqual([]);
    expect(captured).toMatchObject({
      transportEventId: "biz-message-1",
      transportMessageId: "transport-text-action",
      actionToken: "accept_code_12345678901234567890123456789012",
      origin: "text",
    });
    expect(sdk.acknowledgements).toEqual(["transport-text-action"]);
  });

  it("routes deterministic WI commands without creating requirement events", async () => {
    const sdk = new FakeSdk();
    const ingested: DingTalkInboundMessage[] = [];
    const commands: string[] = [];
    const adapter = new DingTalkStreamAdapter(
      sdk,
      {
        ingest(message) {
          ingested.push(message);
          return inboundOutcome(message);
        },
      },
      {
        perform: () => ownerOutcome(),
        performCommand(command) {
          commands.push(`${command.command}:${command.workItemId}`);
          return {
            allowed: true,
            duplicate: false,
            command: command.command,
            workItemId: command.workItemId,
            reason: "status_returned",
          };
        },
      },
      new DingTalkSessionReplyRegistry(() => 1_700_000_000_000),
    );
    await adapter.start();
    const command = envelope("bot-message-text.json", "transport-owner-command");
    const payload = JSON.parse(command.data) as { text: { content: string } };
    payload.text.content = "@研发助手 状态 WI-A1B2C3D4E5F6";
    await sdk.emit("robot", { ...command, data: JSON.stringify(payload) });
    expect(ingested).toEqual([]);
    expect(commands).toEqual(["status:WI-A1B2C3D4E5F6"]);
    expect(sdk.acknowledgements).toEqual(["transport-owner-command"]);
  });
});
