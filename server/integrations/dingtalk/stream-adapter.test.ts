import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import type { OwnerActionOutcome } from "../../collaboration/actions.ts";
import type { DingTalkInboundSink, DingTalkOwnerActionSink, DingTalkStreamSdkPort, MaybePromise } from "./ports.ts";
import { DingTalkSessionReplyRegistry } from "./reply-router.ts";
import type { DingTalkCardAction, DingTalkInboundMessage, DingTalkStreamEnvelope } from "./types.ts";
import { DingTalkStreamAdapter } from "./stream-adapter.ts";
import { DingTalkAttachmentCapabilityVault } from "./attachment-capability-vault.ts";
import { AttachmentIngestionCoordinator } from "../../collaboration/attachment-ingestion.ts";
import { CollaborationHeadlessRuntime } from "../../collaboration/operations/runtime.ts";
import type { DingTalkAttachmentDownloadResult } from "./attachment-downloader.ts";

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
  it("routes a named natural retry to durable Owner control before intake and only ACKs after commit", async () => {
    const sdk = new FakeSdk(), ingest = vi.fn((input: DingTalkInboundMessage) => inboundOutcome(input));
    const performNaturalRetry = vi.fn().mockRejectedValueOnce(new Error("fixture_ledger_unavailable"))
      .mockResolvedValue({ ...ownerOutcome(), action: "retry", kind: "natural_retry" });
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform: () => ownerOutcome(), performNaturalRetry }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    try {
      const packet = envelope("bot-message-text.json", "natural-retry");
      const payload = JSON.parse(packet.data); payload.text.content = "重试刚才的优先级筛选任务";
      const input = { ...packet, data: JSON.stringify(payload) };
      await sdk.emit("robot", input); expect(sdk.acknowledgements).toEqual([]);
      await sdk.emit("robot", input); expect(sdk.acknowledgements).toEqual(["natural-retry"]);
      expect(ingest).not.toHaveBeenCalled(); expect(performNaturalRetry).toHaveBeenCalledTimes(2);
    } finally { adapter.stop(); }
  });
  it("routes natural approval to the durable control sink before ingress and ACKs only after commit", async () => {
    const sdk = new FakeSdk(), ingest = vi.fn((input: DingTalkInboundMessage) => inboundOutcome(input));
    const performNaturalApproval = vi.fn().mockRejectedValueOnce(new Error("fixture_ledger_unavailable"))
      .mockResolvedValue({ ...ownerOutcome(), action: "accept", kind: "natural_approval" });
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform: () => ownerOutcome(), performNaturalApproval }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    try {
      const packet = envelope("bot-message-text.json", "natural-approval");
      const payload = JSON.parse(packet.data); payload.text.content = "可以，就按这次改动来。";
      const input = { ...packet, data: JSON.stringify(payload) };
      await sdk.emit("robot", input); expect(sdk.acknowledgements).toEqual([]);
      await sdk.emit("robot", input); expect(sdk.acknowledgements).toEqual(["natural-approval"]);
      expect(ingest).not.toHaveBeenCalled(); expect(performNaturalApproval).toHaveBeenCalledTimes(2);
      performNaturalApproval.mockResolvedValue(null);
      await sdk.emit("robot", { ...input, headers: { ...input.headers, messageId: "ordinary" } });
      expect(ingest).toHaveBeenCalledTimes(1);
    } finally { adapter.stop(); }
  });
  it.each([
    "示例： 批准 WI-A1B2C3D4E5F6",
    "不要 暂停 WI-A1B2C3D4E5F6",
    "批准 WI-A1B2C3D4E5F6 如果检查通过",
    "```text\n批准 WI-A1B2C3D4E5F6\n```",
    "接受 accept_code_12345678901234567890123456789012 可以吗？",
    "好的，同意。",
  ])("keeps discussion out of Owner control and persists before ACK: %s", async text => {
    const sdk = new FakeSdk();
    const perform = vi.fn(() => ownerOutcome());
    const performCommand = vi.fn();
    const ingest = vi.fn().mockRejectedValueOnce(new Error("fixture_ledger_unavailable"))
      .mockImplementation((input: DingTalkInboundMessage) => inboundOutcome(input));
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform, performCommand }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    try {
      const packet = envelope("bot-message-text.json", "discussion-only");
      const payload = JSON.parse(packet.data) as { text: { content: string } };
      payload.text.content = text;
      const input = { ...packet, data: JSON.stringify(payload) };
      await sdk.emit("robot", input);
      expect(sdk.acknowledgements).toEqual([]);
      await sdk.emit("robot", input);
      expect(sdk.acknowledgements).toEqual(["discussion-only"]);
      expect(ingest).toHaveBeenCalledTimes(2);
      expect(perform).not.toHaveBeenCalled();
      expect(performCommand).not.toHaveBeenCalled();
    } finally { adapter.stop(); }
  });

  it("routes natural delivery review to its durable sink, ACKs only on success and creates no task", async () => {
    const sdk = new FakeSdk();
    const ingest = vi.fn((message: DingTalkInboundMessage) => inboundOutcome(message));
    const reviewDeliveries = vi.fn().mockRejectedValueOnce(new Error("fixture_storage_failed")).mockResolvedValue({kind:"delivery_review",allowed:true,duplicate:false,total:0,items:[],ownerGeneration:1,conversationId:"group",reason:"delivery_review_returned"});
    const adapter = new DingTalkStreamAdapter(sdk,{ingest},{perform:()=>ownerOutcome(),reviewDeliveries},new DingTalkSessionReplyRegistry());
    await adapter.start();
    const packet = envelope("bot-message-text.json","review-query");
    const body = JSON.parse(packet.data) as Record<string,unknown>; body.text={content:"查看待核查回复"};
    const request={...packet,data:JSON.stringify(body)};
    await sdk.emit("robot",request); expect(sdk.acknowledgements).toEqual([]);
    await sdk.emit("robot",request); expect(sdk.acknowledgements).toEqual(["review-query"]);
    expect(reviewDeliveries).toHaveBeenCalledTimes(2); expect(ingest).not.toHaveBeenCalled();
    adapter.stop();
  });
  it("does not ACK requirement recovery until its durable sink succeeds", async () => {
    const sdk = new FakeSdk();
    const ingest = vi.fn((message: DingTalkInboundMessage) => inboundOutcome(message));
    const recoverRequirements = vi.fn().mockRejectedValueOnce(new Error("fixture_storage_failed"))
      .mockResolvedValue({ allowed: true, duplicate: false, workItemId: "WI-1", reason: "natural_intake_recovered", recoveredInputs: 1 });
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform: () => ownerOutcome(), recoverRequirements }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    const packet = envelope("bot-message-text.json", "recovery-persist");
    const payload = JSON.parse(packet.data) as Record<string, unknown>; payload.text = { content: "继续整理需求" };
    const request = { ...packet, data: JSON.stringify(payload) };
    await sdk.emit("robot", request);
    expect(sdk.acknowledgements).toEqual([]);
    await sdk.emit("robot", request);
    expect(sdk.acknowledgements).toEqual(["recovery-persist"]);
    expect(ingest).not.toHaveBeenCalled();
    adapter.stop();
  });
  it.each(["继续整理需求", "请继续整理需求", "重新整理需求。"])("routes %s to durable Owner recovery without creating another task", async text => {
    const sdk = new FakeSdk();
    const ingest = vi.fn((message: DingTalkInboundMessage) => inboundOutcome(message));
    const recoverRequirements = vi.fn(() => ({ allowed: true, duplicate: false, workItemId: "WI-1", reason: "natural_intake_recovered", recoveredInputs: 1 }));
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform: () => ownerOutcome(), recoverRequirements }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    const packet = envelope("bot-message-text.json", "requirement-recovery");
    const payload = JSON.parse(packet.data) as Record<string, unknown>;
    payload.text = { content: text };
    await sdk.emit("robot", { ...packet, data: JSON.stringify(payload) });
    expect(recoverRequirements).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(sdk.acknowledgements).toEqual(["requirement-recovery"]);
    adapter.stop();
  });
  it.each(["继续整理附件", "请重新整理附件", "继续整理第2份附件"])("routes the explicit recovery request %s to Owner control, never ordinary task creation", async text => {
    const sdk = new FakeSdk();
    const ingest = vi.fn((message: DingTalkInboundMessage) => inboundOutcome(message));
    const recoverProjection = vi.fn(() => ({ allowed: true, duplicate: false, workItemId: "WI-1", reason: "attachment_projection_recovered" }));
    const adapter = new DingTalkStreamAdapter(sdk, { ingest }, { perform: () => ownerOutcome(), recoverProjection }, new DingTalkSessionReplyRegistry());
    await adapter.start();
    const packet = envelope("bot-message-text.json", "projection-recovery");
    const payload = JSON.parse(packet.data) as Record<string, unknown>;
    payload.text = { content: text };
    await sdk.emit("robot", { ...packet, data: JSON.stringify(payload) });
    expect(recoverProjection).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(sdk.acknowledgements).toEqual(["projection-recovery"]);
    adapter.stop();
  });

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

  it.each(["none", "vault", "ack", "restart"])("combines real Ledger and Vault durability with nonblocking ACK and idempotent replay (%s boundary)", async failure => {
    const root = mkdtempSync(join(tmpdir(), "stream-attachment-lifecycle-"));
    let sdk = new FakeSdk();
    let vault!: DingTalkAttachmentCapabilityVault;
    let db!: DatabaseSync;
    let release!: (result: DingTalkAttachmentDownloadResult) => void;
    const waiting = new Promise<DingTalkAttachmentDownloadResult>(resolve => { release = resolve; });
    const download = vi.fn(() => waiting);
    const delivered: string[] = [];
    let now = Date.now();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: root, platform: "linux", clock: { now: () => now },
      outboxDelivery: { async deliver(item) { delivered.push(item.id); return { outcome: "sent" }; } },
      attachmentIngestionFactory(context) {
        db = new DatabaseSync(context.databaseFile);
        vault = new DingTalkAttachmentCapabilityVault(join(root, "vault"), "synthetic-fixture-secret-at-least-32-bytes");
        if (failure === "vault") vi.spyOn(vault, "store").mockImplementationOnce(() => { throw new Error("fixture_vault_unavailable"); });
        return new AttachmentIngestionCoordinator({ ...context, vault, downloader: { download }, onEvidence: undefined });
      },
      dingTalk: { enabled: true, credentials: { load: () => ({ clientId: "fixture", clientSecret: "fixture" }) },
        createStream(_credentials, sinks) {
          const adapter = new DingTalkStreamAdapter(sdk, sinks, sinks, new DingTalkSessionReplyRegistry(), undefined,
            { allowedConversationIds: new Set(["cid-group-1"]) });
          return { start: async () => { await adapter.start(); return "connected"; }, stop: () => adapter.stop(), state: () => adapter.state(), maintain: () => adapter.maintain() };
        },
      },
    });
    const base = envelope("bot-message-text.json", "combined-attachment");
    const payload = JSON.parse(base.data) as Record<string, unknown>;
    payload.msgtype = "file";
    payload.robotCode = "fixture";
    payload.content = { fileName: "bugs.csv", downloadCode: "private-combined-code", fileType: "text/csv" };
    delete payload.text;
    const packet = { ...base, data: JSON.stringify(payload) };
    try {
      await runtime.start();
      const acknowledge = sdk.acknowledge.bind(sdk);
      vi.spyOn(sdk, "acknowledge").mockImplementation(id => {
        const attachment = db.prepare("SELECT capability_ref FROM collaboration_attachments").get() as { capability_ref: string };
        expect(vault.read(attachment.capability_ref).downloadCode).toBe("private-combined-code");
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_external_events").get()).toEqual({ n: 1 });
        if (sdk.acknowledgements.length === 0) expect(download).not.toHaveBeenCalled();
        acknowledge(id);
      });
      if (failure === "ack") sdk.acknowledgeError = new Error("fixture_ack_unavailable");
      const emit = () => Promise.race([sdk.emit("robot", packet).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
      expect(await emit()).toBe(true);
      if (failure === "vault" || failure === "ack") {
        expect(sdk.acknowledgements).toEqual([]);
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_external_events").get()).toEqual({ n: 1 });
        expect(download).not.toHaveBeenCalled();
        sdk.acknowledgeError = null;
        expect(await emit()).toBe(true);
      }
      expect(sdk.acknowledgements).toEqual(["combined-attachment"]);
      expect(await emit()).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_work_items").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachments").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_outbox").get()).toEqual({ n: 1 });
      expect(JSON.stringify(db.prepare("SELECT normalized_json FROM collaboration_external_events").all())).not.toContain("private-combined-code");
      if (failure === "restart") {
        await runtime.stop();
        db.close();
        sdk = new FakeSdk();
        await runtime.start();
      }
      // Normalization timestamps actual receipt, not the fixture's remote createAt.
      now = Date.now();
      expect((db.prepare("SELECT next_attempt_at FROM collaboration_attachments").get() as { next_attempt_at: number }).next_attempt_at).toBeLessThanOrEqual(now);
      await runtime.drainOnce();
      await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
      for (let index = 0; index < 3; index++) { now += 20000; await runtime.drainOnce(); }
      expect(runtime.health().ready).toBe(true);
      expect(delivered).toHaveLength(1);
      expect(download).toHaveBeenCalledTimes(1);
      release({ ok: false, kind: "retryable", code: "dingtalk_attachment_cancelled" });
      await runtime.stop();
      expect(db.prepare("SELECT ingest_state FROM collaboration_attachments").get()).toEqual({ ingest_state: "downloading" });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_failures").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_work_item_evidence").get()).toEqual({ n: 0 });
    } finally {
      release({ ok: false, kind: "retryable", code: "dingtalk_attachment_cancelled" });
      await runtime.stop();
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes private attachment capabilities to durable ingestion before acknowledging", async () => {
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
