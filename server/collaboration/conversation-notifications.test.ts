import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { ModelNaturalIntakeInterpreter } from "./natural-intake.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { coalesceConversationNotification } from "./conversation-notifications.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function message(id: string, text: string, group = "group") {
  return { sourceEventId: id, transportMessageId: id, conversationId: group, addressedToBot: true, text,
    sender: { senderId: "product", senderCorpId: "synthetic-corp", senderStaffId: "product", displayName: "product" }, receivedAt: Date.now() };
}
function setup(options: { clarify?: boolean; failPlanning?: boolean; beforeInterpret?: () => Promise<void> } = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "conversation-notifications-")); directories.push(dataDirectory);
  const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(envelope) {
    const input = JSON.parse(envelope.user);
    if (input.candidates) return { version: 1, sourceEventId: input.sourceEventId, intent: input.sourceEventId === "add" ? "contribution" : "new_request",
      targetWorkItemId: input.sourceEventId === "add" ? input.candidates[0].id : null, replySourceEventId: null, quote: input.text, confidence: "high" };
    await options.beforeInterpret?.();
    return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
      goal: { text: input.event.text, quote: input.event.text, confirmed: !options.clarify },
      acceptance: options.clarify ? [] : [{ description: input.event.text, observation: input.event.text, quote: input.event.text }],
      answers: [], questions: options.clarify ? [{ id: "copy", question: "账号或密码错误时希望显示什么提示？", reason: "确认具体效果", role: "requester", respondent: null }] : [] };
  } });
  const config = { dataDirectory, planning: { planner: { propose() { if (options.failPlanning) throw new Error("synthetic-planner-failure"); return validProposal(); } },
    policy, naturalIntake, defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] } } };
  const service = startCollaborationService(config), db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  return { service, db, config };
}
function receipt(db: DatabaseSync, id = "new") {
  return db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id=?").get(`conversation:${id}`)!;
}
function requirements(db: DatabaseSync) {
  return ["work_items", "work_item_events", "work_item_snapshots", "natural_intake_jobs", "owner_bindings", "control_events", "runs"]
    .map(table => db.prepare(`SELECT * FROM collaboration_${table} ORDER BY rowid`).all());
}
async function deliver(db: DatabaseSync) {
  const lease = new InstanceLeaseCoordinator(db, "notification-test").acquire(Date.now(), 120000)!;
  const replies: Array<{ kind: string; text: string }> = [];
  const dispatcher = new OutboxDispatcher(db, { async deliver(message) {
    replies.push({ kind: message.kind, text: (renderDingTalkSessionMessage(message.payload).markdown as { text: string }).text });
    return { outcome: "sent" };
  } }, { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
  for (let i = 0; i < 20; i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
  return replies;
}

describe("conversational notifications avoid duplicate receipts without hiding real progress", () => {
  it.each(["clarification", "ready", "planning-failed"])("sends one current %s reply, not a receipt followed by the same stage", async stage => {
    const h = setup({ clarify: stage === "clarification", failPlanning: stage === "planning-failed" });
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名、清空密码。")); await h.service.processNaturalIntake();
      const before = requirements(h.db), replies = await deliver(h.db);
      expect(replies).toHaveLength(1); expect(replies[0].kind).not.toBe("primary_status_card");
      expect(replies[0].text).toContain(stage === "clarification" ? "账号或密码错误" : stage === "ready" ? "准备开始修改" : "修改方案还没整理完成");
      expect(replies[0].text).not.toContain("修改完成");
      expect(receipt(h.db)).toMatchObject({ delivery_state: "superseded", attempt: 0, sent_at: null });
      expect(requirements(h.db)).toEqual(before);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_external_events WHERE source_event_id='new'").get()).toEqual({ n: 1 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not repeat a receipt for a supplement and preserves replay behavior after restart", async () => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const added = message("add", "登录超时时也保留用户名。"), old = receipt(h.db);
      h.service.ingestDingTalkMessage(added); await h.service.processNaturalIntake();
      h.service.close(); const restarted = startCollaborationService(h.config);
      try {
        const before = requirements(h.db), replies = await deliver(h.db);
        expect(replies).toHaveLength(1); expect(replies[0].text).not.toContain("补充已收到");
        expect(receipt(h.db, "add")).toMatchObject({ delivery_state: "superseded", attempt: 0 });
        expect(receipt(h.db)).toEqual(old);
        const count = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        restarted.ingestDingTalkMessage(added); await restarted.processNaturalIntake();
        expect(await deliver(h.db)).toEqual([]); expect(requirements(h.db)).toEqual(before);
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(count);
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("keeps one immediate response during slow interpretation, then sends the real result", async () => {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const h = setup({ clarify: true, beforeInterpret: async () => { started(); await wait; } });
    let running: Promise<unknown> | undefined;
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); running = h.service.processNaturalIntake(); await entered;
      const early = await deliver(h.db);
      expect(early).toHaveLength(1); expect(early[0].kind).toBe("primary_status_card");
      expect(early[0].text).not.toMatch(/确认目标|关键信息|修改完成/u);
      const sent = receipt(h.db);
      release(); await running;
      const final = await deliver(h.db);
      expect(final).toHaveLength(1); expect(final[0].text).toContain("账号或密码错误");
      expect(receipt(h.db)).toEqual(sent);
    } finally { release(); await running; h.service.close(); h.db.close(); }
  });

  it.each(["claimed", "unknown"])("does not supersede a receipt whose delivery is %s", async mode => {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const h = setup({ beforeInterpret: async () => { started(); await wait; } });
    let running: Promise<unknown> | undefined;
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); running = h.service.processNaturalIntake(); await entered;
      if (mode === "claimed") h.db.prepare("UPDATE collaboration_outbox SET delivery_state='claimed',attempt=1,claim_owner='in-flight',claim_fence=1,claim_expires_at=? WHERE id=?")
        .run(Date.now() + 10000, receipt(h.db).id);
      else h.db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1,last_error='delivery_unconfirmed',dead_lettered_at=? WHERE id=?")
        .run(Date.now(), receipt(h.db).id);
      const before = receipt(h.db); release(); await running;
      expect(receipt(h.db)).toEqual(before);
    } finally { release(); await running; h.service.close(); h.db.close(); }
  });

  it("cannot coalesce the pending receipt of a different task or group", async () => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); await h.service.processNaturalIntake();
      const old = receipt(h.db);
      h.service.ingestDingTalkMessage(message("other", "支付失败提示原因。", "other-group")); await h.service.processNaturalIntake();
      expect(receipt(h.db)).toEqual(old);
      const replies = await deliver(h.db); expect(replies).toHaveLength(2);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("rolls back a failed replacement while preserving the original receipt and intake budget", async () => {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const h = setup({ clarify: true, beforeInterpret: async () => { started(); await wait; } });
    let running: Promise<unknown> | undefined;
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); running = h.service.processNaturalIntake(); await entered;
      const before = receipt(h.db);
      h.db.exec("CREATE TRIGGER test_receipt_failure BEFORE UPDATE ON collaboration_outbox WHEN OLD.kind='primary_status_card' AND NEW.delivery_state='superseded' BEGIN SELECT RAISE(ABORT,'synthetic-write-failure'); END");
      release(); await running;
      expect(receipt(h.db)).toEqual(before);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs WHERE source_event_id='new'").get()).toEqual({ status: "pending", attempts: 1 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE kind='clarification_card' AND delivery_state='pending'").get()).toEqual({ n: 0 });
      h.db.exec("DROP TRIGGER test_receipt_failure"); await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs WHERE source_event_id='new'").get()).toEqual({ status: "applied", attempts: 2 });
      expect(await deliver(h.db)).toHaveLength(1);
    } finally { release(); await running; h.service.close(); h.db.close(); }
  });

  it.each(["version", "group", "card-snapshot", "card-item", "plan-revision", "resources"])("leaves a legacy unattempted receipt alone when the replacement proof differs: %s", async change => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); await h.service.processNaturalIntake();
      // Explicit legacy fixture: before this feature, both rows were pending.
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='pending',superseded_at=NULL WHERE id=?").run(receipt(h.db).id);
      const stage = h.db.prepare("SELECT * FROM collaboration_outbox WHERE kind='plan_status_card' AND delivery_state='pending'").get()!;
      const card = JSON.parse(String(stage.payload_json));
      if (change === "version") h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(stage.aggregate_id);
      if (change === "card-snapshot") card.snapshotRevision++;
      if (change === "card-item") card.workItemId = "WI-NOT-THE-ITEM";
      if (change === "plan-revision") card.planRevision++;
      if (change === "group") {
        h.service.ingestDingTalkMessage(message("other", "支付问题", "other-group")); await h.service.processNaturalIntake();
        h.db.prepare("UPDATE collaboration_work_items SET conversation_id=(SELECT conversation_id FROM collaboration_external_events WHERE source_event_id='other') WHERE id=?").run(stage.aggregate_id);
      }
      if (change === "resources") h.db.prepare("UPDATE collaboration_outbox SET payload_json=json_set(payload_json,'$.resourceCount',1) WHERE id=?").run(receipt(h.db).id);
      h.db.prepare("UPDATE collaboration_outbox SET payload_json=? WHERE id=?").run(JSON.stringify(card), stage.id);
      const before = receipt(h.db);
      expect(coalesceConversationNotification(h.db, String(stage.id), Date.now())).toBe("pending");
      expect(receipt(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });
});
