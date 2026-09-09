import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { startCollaborationService } from "./service.ts";
import { ModelNaturalIntakeInterpreter } from "./natural-intake.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";

it("delivers an online-material authorization failure while conversational interpretation is still running", async () => {
  const root = mkdtempSync(join(tmpdir(), "conversation-actionable-notification-"));
  const initial = startCollaborationService({ dataDirectory: root }); initial.close();
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const now = Date.now();
  const lease = new InstanceLeaseCoordinator(db, "actionable-notification-test").acquire(now, 120_000)!;
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const read = vi.fn(async () => { throw new Error("unauthorized_read_must_not_start"); });
  const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(envelope) {
    const input = JSON.parse(envelope.user);
    if (input.candidates) return { version: 1, sourceEventId: input.sourceEventId, intent: "new_request",
      targetWorkItemId: null, replySourceEventId: null, quote: input.text, confidence: "high" };
    started(); await wait;
    return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
      goal: null, acceptance: [], answers: [], questions: [] };
  } });
  const service = startCollaborationService({ dataDirectory: root,
    onlineDocuments: { reader: { authorizationFingerprint() { throw new Error("fixture_authorization_missing"); }, read },
      currentLease: () => lease },
    planning: { planner: { propose: () => validProposal() }, policy, naturalIntake,
      defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] } },
  });
  let running: Promise<unknown> | undefined;
  try {
    service.ingestDingTalkMessage({ sourceEventId: "new", transportMessageId: "new", conversationId: "group",
      addressedToBot: true, text: "请修复这份文档描述的问题 https://alidocs.dingtalk.com/i/nodes/fixture",
      sender: { senderId: "person", senderCorpId: "corp", senderStaffId: "person", displayName: "测试同事" }, receivedAt: now });
    running = service.processNaturalIntake(); await entered;
    await service.processOnlineDocuments();
    expect(db.prepare("SELECT status FROM collaboration_natural_intake_jobs WHERE source_event_id='new'").get())
      .toEqual({ status: "running" });
    expect(db.prepare("SELECT status,error_code FROM collaboration_online_read_jobs").all())
      .toEqual([{ status: "failed", error_code: "online_document_not_authorized" }]);
    expect(read).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE source_event_id LIKE 'online-read-failed:%'").get())
      .toEqual({ n: 1 });

    const replies: string[] = [];
    const dispatcher = new OutboxDispatcher(db, { async deliver(message) {
      replies.push((renderDingTalkSessionMessage(message.payload).markdown as { text: string }).text);
      return { outcome: "sent" };
    } }, { maxAttempts: 3, claimTtlMs: 10_000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    for (let i = 0; i < 8; i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("请负责人检查这份材料的读取授权和可读性");
    expect(replies[0]).not.toContain("我先看一下");
    expect(db.prepare("SELECT delivery_state,attempt FROM collaboration_outbox WHERE source_event_id LIKE 'online-read-failed:%'").get())
      .toEqual({ delivery_state: "sent", attempt: 1 });
    expect(await dispatcher.dispatchOne(lease, Date.now())).toBeNull();
    expect(replies).toHaveLength(1);
  } finally {
    release(); await running;
    service.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
