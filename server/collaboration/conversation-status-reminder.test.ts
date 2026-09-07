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
import { readLatestWorkItemSnapshot, appendWorkItemSnapshot } from "./snapshot.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const question = "账号或密码错误时，希望显示什么提示？";
function message(id: string, text: string, group = "group", person = "product") {
  return { sourceEventId: id, transportMessageId: id, conversationId: group, addressedToBot: true, text,
    sender: { senderId: person, senderCorpId: "synthetic-corp", senderStaffId: person, displayName: person }, receivedAt: Date.now() };
}
function setup(questions = [question]) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "conversation-reminder-")); directories.push(dataDirectory);
  const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(envelope) {
    const input = JSON.parse(envelope.user);
    if (input.candidates) return { version: 1, sourceEventId: input.sourceEventId,
      intent: input.sourceEventId.startsWith("new") ? "new_request" : input.sourceEventId === "answer" ? "contribution" : "status_query",
      targetWorkItemId: input.sourceEventId.startsWith("new") ? null : input.candidates.find((c: { title: string }) => c.title.includes("登录"))?.id ?? null,
      replySourceEventId: null, quote: input.text, confidence: "high" };
    const answered = input.event.sourceEventId === "answer";
    return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
      goal: { text: input.event.text, quote: input.event.text, confirmed: answered },
      acceptance: answered ? [{ description: input.event.text, observation: input.event.text, quote: input.event.text }] : [],
      answers: answered ? input.questions.filter((q: { id: string }) => q.id.startsWith("natural-") &&
        !["natural-input-pending", "natural-context-incomplete"].includes(q.id)).map((q: { id: string }) => ({ questionId: q.id, quote: input.event.text })) : [],
      questions: answered ? [] : questions.map((text, i) => ({ id: `message-${i}`, question: text, reason: "确认提示效果", role: "requester", respondent: null })) };
  } });
  const options = { dataDirectory, planning: { planner: { propose: validProposal }, policy, naturalIntake,
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] } } };
  const service = startCollaborationService(options);
  const ledger = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  return { service, options, db: ledger };
}
function target(db: DatabaseSync) {
  return String(db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='new'").get()!.work_item_id);
}
function state(db: DatabaseSync) {
  return ["work_items", "work_item_snapshots", "work_item_events", "natural_intake_jobs", "owner_bindings", "control_events", "runs"]
    .map(table => db.prepare(`SELECT * FROM collaboration_${table} ORDER BY rowid`).all());
}
function reply(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id=?").get(`conversation:${id}`)!;
  return (renderDingTalkSessionMessage(JSON.parse(String(row.payload_json))).markdown as { text: string }).text;
}
async function deliver(db: DatabaseSync) {
  const lease = new InstanceLeaseCoordinator(db, "reminder-test").acquire(Date.now(), 120000)!;
  const dispatcher = new OutboxDispatcher(db, { async deliver() { return { outcome: "sent" }; } },
    { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
  for (let i = 0; i < 20; i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
}

describe("status replies name a current delivered business question without changing requirements", () => {
  it("reminds what is missing and permits the next natural answer, including restart and replay", async () => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = state(h.db);
      h.service.close(); const restarted = startCollaborationService(h.options);
      try {
        const query = message("query", "登录现在到哪了？");
        restarted.ingestDingTalkMessage(query); await restarted.processNaturalIntake(); await deliver(h.db);
        expect(reply(h.db, "query")).toContain(question);
        expect(reply(h.db, "query")).toContain("尚未开始修改");
        expect(reply(h.db, "query")).not.toMatch(/修改完成|WI-|snapshot|Spec|建议回答/u);
        expect(reply(h.db, "query").length).toBeLessThan(220);
        expect(state(h.db)).toEqual(before);
        const count = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        restarted.ingestDingTalkMessage(query); await restarted.processNaturalIntake(); await deliver(h.db);
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(count);
        expect(state(h.db)).toEqual(before);
        restarted.ingestDingTalkMessage(message("answer", "统一显示账号或密码不正确。")); await restarted.processNaturalIntake(); await deliver(h.db);
        expect(readLatestWorkItemSnapshot(h.db, target(h.db))!.blockingAmbiguities).toEqual([]);
        restarted.ingestDingTalkMessage(message("after-answer", "登录进度呢？")); await restarted.processNaturalIntake(); await deliver(h.db);
        expect(reply(h.db, "after-answer")).not.toContain(question);
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["unsent", "sent-after-query", "changed-snapshot", "changed-version", "changed-group", "paused"])("does not repeat an inapplicable question: %s", async mode => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake();
      if (!["unsent", "sent-after-query"].includes(mode)) await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进度呢？"));
      if (mode === "sent-after-query") await deliver(h.db);
      await h.service.processNaturalIntake();
      if (!["unsent", "sent-after-query"].includes(mode)) expect(reply(h.db, "query")).toContain(question);
      if (mode === "changed-snapshot") appendWorkItemSnapshot(h.db, target(h.db), { blockingAmbiguities: [] }, Date.now());
      if (mode === "changed-version") h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(target(h.db));
      if (mode === "paused") h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(target(h.db));
      if (mode === "changed-group") {
        h.service.ingestDingTalkMessage(message("new-other", "支付问题", "private")); await h.service.processNaturalIntake();
        h.db.prepare("UPDATE collaboration_work_items SET conversation_id=(SELECT conversation_id FROM collaboration_external_events WHERE source_event_id='new-other') WHERE id=?").run(target(h.db));
      }
      const before = state(h.db);
      if (mode !== "unsent") await deliver(h.db);
      if (mode === "changed-group") {
        expect(h.db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE source_event_id='conversation:query'").get()).toEqual({ delivery_state: "superseded" });
      } else expect(reply(h.db, "query")).not.toContain(question);
      expect(state(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("reports another participant's publicly pending question neutrally, without assigning it to the viewer", async () => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = state(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进度呢？", "group", "manager")); await h.service.processNaturalIntake(); await deliver(h.db);
      expect(reply(h.db, "query")).toContain(question);
      expect(reply(h.db, "query")).not.toMatch(/等你|请你|@manager/u);
      expect(state(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not resend a stale question or rewrite an already attempted payload", async () => {
    const h = setup();
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进度呢？")); await h.service.processNaturalIntake();
      const original = reply(h.db, "query"); expect(original).toContain(question);
      const now = Date.now(), lease = new InstanceLeaseCoordinator(h.db, "reminder-test").acquire(now, 120000)!;
      let calls = 0;
      const dispatcher = new OutboxDispatcher(h.db, { async deliver() { calls++; return { outcome: "unknown", error: "synthetic-transport-timeout" }; } },
        { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
      await dispatcher.dispatchOne(lease, now); expect(calls).toBe(1);
      appendWorkItemSnapshot(h.db, target(h.db), { blockingAmbiguities: [] }, now + 1);
      const before = state(h.db);
      await dispatcher.dispatchOne(lease, now + 2000);
      expect(calls).toBe(1); expect(reply(h.db, "query")).toBe(original);
      expect(h.db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE source_event_id='conversation:query'").get()).toEqual({ delivery_state: "superseded" });
      expect(state(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("keeps a bounded redacted excerpt and discloses additional questions", async () => {
    const long = "api_key=synthetic_reminder_secret " + "目前提示很难理解".repeat(35) + " 应该怎么提示？";
    const h = setup([long, "网络异常时希望怎么提示？", "超时后应该怎么提示？"]);
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进度呢？")); await h.service.processNaturalIntake(); await deliver(h.db);
      const text = reply(h.db, "query");
      expect(text).toContain("原问题摘录"); expect(text).toContain("…"); expect(text).toContain("另有2个问题待确认");
      expect(text).not.toContain("synthetic_reminder_secret"); expect(text.length).toBeLessThan(220);
    } finally { h.service.close(); h.db.close(); }
  });
});
