import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { ModelNaturalIntakeInterpreter } from "./natural-intake.ts";
import type { ConversationIntentRequest } from "./conversation-intent.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { ConversationIngressCoordinator } from "./conversation-ingress.ts";
import { classifyConversationIntent } from "./conversation-intent.ts";
import { conversationSourceHash, readConversationContext, type ConversationJob } from "./conversation-context.ts";
import { applyCollaborationMigrations } from "./migrations.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }); });
function message(id: string, text: string, group = "group", person = "product") {
  return { sourceEventId: id, transportMessageId: id, conversationId: group, addressedToBot: true, text,
    sender: { senderId: person, senderCorpId: "corp", senderStaffId: person, displayName: person }, receivedAt: Date.now() };
}
function decision(input: ConversationIntentRequest, intent: string, target: string | null = null, reply: string | null = null) {
  return { version: 1, sourceEventId: input.sourceEventId, intent, targetWorkItemId: target,
    replySourceEventId: reply, quote: input.text, confidence: "high" };
}
function setup(classify: (request: ConversationIntentRequest) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "conversation-ingress-")); paths.push(directory);
  const interpreted: string[] = [], requests: ConversationIntentRequest[] = [];
  const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(envelope) {
    const input = JSON.parse(envelope.user);
    if ((envelope.responseSchema as { properties: Record<string, unknown> }).properties.intent) {
      requests.push(input); return classify(input);
    }
    interpreted.push(input.event.sourceEventId);
    return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
      goal: null, acceptance: [], answers: [], questions: [] };
  } });
  const options = { dataDirectory: directory, planning: { planner: { propose: validProposal }, policy, naturalIntake } };
  const dbFile = join(directory, "collaboration", "collaboration.sqlite");
  const service = startCollaborationService(options), db = new DatabaseSync(dbFile);
  return { service, options, db, interpreted, requests };
}
function item(db: DatabaseSync, event: string) {
  return (db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id=?").get(event) as { work_item_id: string | null })?.work_item_id;
}
function taskState(db: DatabaseSync) {
  return ["collaboration_work_items", "collaboration_work_item_snapshots", "collaboration_work_item_events", "collaboration_natural_intake_jobs", "collaboration_owner_bindings"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
function reply(db: DatabaseSync, source: string) {
  const row = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id=?").get(`conversation:${source}`) as { payload_json: string } | undefined;
  return row ? (renderDingTalkSessionMessage(JSON.parse(row.payload_json)).markdown as { text: string }).text : null;
}
async function deliver(db: DatabaseSync) {
  const lease = new InstanceLeaseCoordinator(db, "fixture").acquire(Date.now(), 120000)!;
  const dispatcher = new OutboxDispatcher(db, { async deliver() { return { outcome: "sent" as const }; } },
    { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
  for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
}

function job(db: DatabaseSync, source: string): ConversationJob {
  return db.prepare("SELECT e.*,j.* FROM collaboration_external_events e JOIN collaboration_conversation_intents j ON j.event_id=e.id WHERE e.source_event_id=?")
    .get(source) as unknown as ConversationJob;
}

describe("durable conversational ingress before Work Item mutation", () => {
  it("holds the current plan while an incoming message is unclassified without altering its Spec", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "status_query", input.sourceEventId === "new" ? null : input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录错误提示。")); await h.service.processNaturalIntake();
      const target = item(h.db, "new")!;
      h.service.reviseWorkItemDefinition(target, { goal: "错误提示可读", goalConfirmed: true, repository: policy.allowedRepositories[0],
        acceptanceConditions: [{ description: "显示错误提示", observation: "pnpm test target" }], blockingAmbiguities: [] });
      expect(readPlanMaterialReadiness(h.db, target).ready).toBe(true);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "进展怎么样？"));
      expect(readPlanMaterialReadiness(h.db, target).ready).toBe(false);
      expect(taskState(h.db)).toEqual(before);
      await h.service.processNaturalIntake();
      expect(readPlanMaterialReadiness(h.db, target).ready).toBe(true);
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });
  it("upgrades a v35 ledger without creating intent jobs for old messages or changing history", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录提示。")); await h.service.processNaturalIntake(); h.service.close();
      const before = taskState(h.db), events = h.db.prepare("SELECT * FROM collaboration_external_events").all();
      const migrations = h.db.prepare("SELECT * FROM collaboration_schema_migrations WHERE version<=35 ORDER BY version").all();
      h.db.exec("DROP TABLE collaboration_conversation_intents; DELETE FROM collaboration_schema_migrations WHERE version=36; PRAGMA user_version=35");
      expect(applyCollaborationMigrations(h.db)).toEqual({ schemaVersion: 36, appliedMigrations: 36 });
      expect(taskState(h.db)).toEqual(before);
      expect(h.db.prepare("SELECT * FROM collaboration_external_events").all()).toEqual(events);
      expect(h.db.prepare("SELECT * FROM collaboration_schema_migrations WHERE version<=35 ORDER BY version").all()).toEqual(migrations);
      expect(h.db.prepare("SELECT * FROM collaboration_conversation_intents").all()).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it("protects the source, accepted target, result and failure budgets from rollback", async () => {
    const h = setup(async input => decision(input, "acknowledgement"));
    try {
      h.service.ingestDingTalkMessage(message("thanks", "谢谢。"));
      expect(() => h.db.exec("UPDATE collaboration_conversation_intents SET source_hash='changed'")).toThrow();
      expect(() => h.db.exec("UPDATE collaboration_conversation_intents SET context_outbox_sequence=42")).toThrow();
      await h.service.processNaturalIntake();
      for (const change of ["attempts=0", "status='pending'", "proposal_json='{}'", "target_work_item_id='invented'"]) {
        expect(() => h.db.exec(`UPDATE collaboration_conversation_intents SET ${change}`)).toThrow("immutable");
      }
    } finally { h.service.close(); h.db.close(); }
  });

  it("rejects a target changed while the model was considering the contribution", async () => {
    const h = setup(async input => {
      if (input.sourceEventId === "new") return decision(input, "new_request");
      h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(input.candidates[0].id);
      return decision(input, "contribution", input.candidates[0].id);
    });
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录提示。")); await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("add", "网络异常也要提示。"));
      for (let i=0;i<3;i++) await h.service.processNaturalIntake();
      expect(item(h.db, "add")).toBeNull();
      expect(h.interpreted).toEqual(["new"]);
      expect(reply(h.db, "add")).toContain("停止自动重试");
    } finally { h.service.close(); h.db.close(); }
  });

  it("resumes a routed event without reclassifying or duplicating its requirement projection", async () => {
    const h = setup(async input => decision(input, "new_request"));
    const coordinator = new ConversationIngressCoordinator(h.db, (input, signal) => classifyConversationIntent({
      async complete() { return decision(input, "new_request"); },
    }, input, signal), () => { throw new Error("projection interrupted"); });
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录提示。")); await coordinator.processOne();
      expect(job(h.db, "new").status).toBe("routed"); const target = item(h.db, "new");
      h.service.close(); const restarted = startCollaborationService(h.options);
      try { await restarted.processNaturalIntake(); await restarted.processNaturalIntake(); } finally { restarted.close(); }
      expect(item(h.db, "new")).toBe(target); expect(h.requests).toEqual([]); expect(h.interpreted).toEqual(["new"]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events").get()).toEqual({ n: 1 });
      expect(job(h.db, "new").status).toBe("applied");
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });
  it("keeps an earlier same-time message from seeing later messages and pins an old explicit reply", async () => {
    const h = setup(async input => decision(input, "acknowledgement"));
    try {
      const time = Date.now();
      h.service.ingestDingTalkMessage({ ...message("earlier", "谢谢"), receivedAt: time });
      h.service.ingestDingTalkMessage({ ...message("later", "不要让前一条看到这句话"), receivedAt: time });
      expect(readConversationContext(h.db, job(h.db, "earlier")).history.map(row => row.sourceEventId)).toEqual(["earlier"]);
      for (let i=0;i<15;i++) h.service.ingestDingTalkMessage(message(`filler-${i}`, "谢谢"));
      h.service.ingestDingTalkMessage({ ...message("quoted", "这是我说的那条"), replyToSourceEventId: "earlier" });
      const context = readConversationContext(h.db, job(h.db, "quoted"));
      expect(context.history.some(row => row.sourceEventId === "earlier")).toBe(true);
      expect(context.history).toHaveLength(12);
    } finally { h.service.close(); h.db.close(); }
  });

  it("preserves the purpose of a delivered question for the same speaker only", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "acknowledgement"));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake();
      await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "对，就是这样。"));
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).toBe("requirement");
      await h.service.processNaturalIntake();
      expect(reply(h.db, "answer")).not.toContain("不客气");
      h.service.ingestDingTalkMessage(message("other", "谢谢", "group", "tester"));
      expect(readConversationContext(h.db, job(h.db, "other")).pendingQuestion).toBeNull();
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not turn a read-only clarification answer into a contribution", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "query" ? "status_query" : "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("query", "进度怎样了？")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "我说的是登录那个。"));
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).toBe("read_only");
      await h.service.processNaturalIntake();
      expect(item(h.db, "answer")).toBeNull();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("rechecks status at dispatch instead of sending an obsolete progress claim", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "status_query", input.sourceEventId === "new" ? null : input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "现在进度呢？")); await h.service.processNaturalIntake();
      h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(item(h.db, "new")!);
      const lease = new InstanceLeaseCoordinator(h.db, "fixture").acquire(Date.now(), 120000)!;
      const sent: string[] = [];
      const dispatcher = new OutboxDispatcher(h.db, { async deliver(message) { sent.push(JSON.stringify(message.payload)); return { outcome: "sent" }; } },
        { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
      for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
      expect(sent.join(" ")).toContain("已暂停");
      expect(sent.join(" ")).not.toContain("确认后才能开始");
    } finally { h.service.close(); h.db.close(); }
  });

  it("notifies every failed event even after more than one notice page", async () => {
    const h = setup(async () => { throw new Error("private failure"); });
    try {
      for (let i=0;i<23;i++) h.service.ingestDingTalkMessage(message(`failed-${i}`, "谢谢"));
      for (let i=0;i<70;i++) await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_conversation_intents WHERE status='failed'").get()).toEqual({ n: 23 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE source_event_id LIKE 'conversation:failed-%'").get()).toEqual({ n: 23 });
      expect(reply(h.db, "failed-22")).toContain("停止自动重试");
    } finally { h.service.close(); h.db.close(); }
  });

  it("claims once across connections and ignores a stopped model's late result", async () => {
    const h = setup(async input => decision(input, "new_request"));
    let resolve!: (value: unknown) => void;
    const slow = new Promise<unknown>(done => { resolve = done; });
    const otherDb = new DatabaseSync(join(h.options.dataDirectory, "collaboration", "collaboration.sqlite"));
    let calls = 0;
    const classifier = (input: ConversationIntentRequest, signal: AbortSignal) => classifyConversationIntent({ async complete() { calls++; return slow; } }, input, signal);
    const a = new ConversationIngressCoordinator(h.db, classifier, () => undefined);
    const b = new ConversationIngressCoordinator(otherDb, classifier, () => undefined);
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录错误提示。"));
      const first = a.processOne(); await b.processOne(); expect(calls).toBe(1);
      a.close(); await first;
      resolve(decision(readConversationContext(h.db, job(h.db, "new")), "new_request"));
      await Promise.resolve(); expect(item(h.db, "new")).toBeNull();
      expect(h.db.prepare("SELECT attempts FROM collaboration_conversation_intents").get()).toEqual({ attempts: 1 });
    } finally { a.close(); b.close(); otherDb.close(); h.service.close(); h.db.close(); }
  });

  it("rolls back task creation when outbox persistence fails and preserves the attempt budget", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("new", "修正登录错误提示。"));
      const source = job(h.db, "new"); expect(source.source_hash).toBe(conversationSourceHash(source.normalized_json));
      h.db.exec("CREATE TRIGGER test_outbox_failure BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
      await h.service.processNaturalIntake();
      expect(item(h.db, "new")).toBeNull();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_conversation_intents").get()).toEqual({ status: "pending", attempts: 1 });
      h.db.exec("DROP TRIGGER test_outbox_failure"); await h.service.processNaturalIntake();
      expect(item(h.db, "new")).toMatch(/^WI-/);
      expect(h.db.prepare("SELECT attempts FROM collaboration_conversation_intents").get()).toEqual({ attempts: 2 });
    } finally { h.service.close(); h.db.close(); }
  });
  it("acknowledges thanks in an empty group without creating or interpreting a task", async () => {
    const h = setup(async input => decision(input, "acknowledgement"));
    try {
      const before = taskState(h.db);
      expect(h.service.ingestDingTalkMessage(message("thanks", "好的，谢谢。"))).toMatchObject({ workItemId: null, deferred: true });
      expect(taskState(h.db)).toEqual(before);
      await h.service.processNaturalIntake();
      expect(reply(h.db, "thanks")).toContain("不客气");
      expect(h.interpreted).toEqual([]);
      expect(taskState(h.db)).toEqual(before);
      expect(h.service.ingestDingTalkMessage(message("thanks", "恶意改写重放为新需求")).duplicate).toBe(true);
      await h.service.processNaturalIntake();
      expect(h.requests).toHaveLength(1);
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("creates a real request only after classification and still projects it into the existing Spec pipeline", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      const received = h.service.ingestDingTalkMessage(message("new", "登录失败后保留用户名，密码不要保留。"));
      expect(received.workItemId).toBeNull();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
      await h.service.processNaturalIntake();
      expect(item(h.db, "new")).toMatch(/^WI-/);
      expect(h.interpreted).toEqual(["new"]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events").get()).toEqual({ n: 1 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_snapshots").get()).toEqual({ n: 2 });
      h.service.ingestDingTalkMessage(message("new", "改写后的重放"));
      await h.service.processNaturalIntake();
      expect(h.requests).toHaveLength(1);
      expect(h.interpreted).toEqual(["new"]);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["plain", "wi", "reply"])("keeps a %s progress query out of requirements and task versions", async mode => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "status_query", input.sourceEventId === "new" ? null : input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时提示原因。")); await h.service.processNaturalIntake();
      const target = item(h.db, "new")!, before = taskState(h.db);
      h.service.ingestDingTalkMessage({ ...message("query", mode === "wi" ? `${target} 现在到哪了？` : "登录那个现在到哪了？"),
        ...(mode === "reply" ? { replyToSourceEventId: "new" } : {}) });
      expect(taskState(h.db)).toEqual(before);
      await h.service.processNaturalIntake();
      expect(reply(h.db, "query")).toContain("补充");
      expect(item(h.db, "query")).toBeNull();
      expect(taskState(h.db)).toEqual(before);
      expect(h.interpreted).toEqual(["new"]);
      h.service.ingestDingTalkMessage(message("query", "重放不能变成补充")); await h.service.processNaturalIntake();
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("treats a progress question without any tasks as a context question, not a new request", async () => {
    const h = setup(async input => decision(input, "status_query"));
    try {
      h.service.ingestDingTalkMessage(message("query", "现在到哪了？")); await h.service.processNaturalIntake();
      expect(reply(h.db, "query")).toContain("哪个问题");
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
      expect(h.interpreted).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not grant a control request to a regular member or interpret it as development", async () => {
    const h = setup(async input => decision(input, "control_request"));
    try {
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("control", "同意发布到生产。", "group", "tester")); await h.service.processNaturalIntake();
      expect(reply(h.db, "control")).toContain("负责人");
      expect(taskState(h.db)).toEqual(before);
      expect(h.interpreted).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it("allows a second person to contribute while keeping their status question read-only", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : input.sourceEventId === "add" ? "contribution" : "status_query",
      input.sourceEventId === "new" ? null : input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录失败时保留用户名。")); await h.service.processNaturalIntake();
      const target = item(h.db, "new");
      h.service.ingestDingTalkMessage(message("add", "测试补充：网络错误也要保留。", "group", "tester")); await h.service.processNaturalIntake();
      expect(item(h.db, "add")).toBe(target);
      expect(h.interpreted).toEqual(["new", "add"]);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "这个改好了吗？", "group", "tester")); await h.service.processNaturalIntake();
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("uses only real sent same-group assistant replies as explanation sources", async () => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : decision(input, "explanation", input.candidates[0].id,
      input.history.find(entry => entry.role === "assistant" && entry.workItemId === input.candidates[0].id)?.sourceEventId ?? null));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake();
      await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("explain", "这句话是什么意思？")); await h.service.processNaturalIntake();
      expect(reply(h.db, "explain")).toContain("之前的回复");
      expect(h.requests.at(-1)?.history.some(entry => entry.role === "assistant")).toBe(true);
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not show another group's candidates or replies and rejects a foreign model target", async () => {
    let foreign = "";
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : decision(input, "status_query", foreign));
    try {
      h.service.ingestDingTalkMessage(message("new", "甲群的保密需求。")); await h.service.processNaturalIntake(); foreign = item(h.db, "new")!;
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "现在到哪了？", "another-group"));
      for (let i=0;i<4;i++) await h.service.processNaturalIntake();
      expect(h.requests.at(-1)?.candidates).toEqual([]);
      expect(h.requests.at(-1)?.history.every(entry => !entry.text.includes("保密需求"))).toBe(true);
      expect(taskState(h.db)).toEqual(before);
      expect(reply(h.db, "query")).not.toContain("保密需求");
      expect(h.requests.filter(input => input.sourceEventId === "query")).toHaveLength(3);
    } finally { h.service.close(); h.db.close(); }
  });

  it("resumes an unprocessed event after restart and preserves failure limits across restarts", async () => {
    const h = setup(async () => { throw new Error("private model error"); });
    try {
      h.service.ingestDingTalkMessage(message("query", "现在到哪了？")); h.service.close();
      for (let i=0;i<4;i++) { const service = startCollaborationService(h.options); await service.processNaturalIntake(); service.close(); }
      expect(h.requests).toHaveLength(3);
      expect(reply(h.db, "query")).toContain("还没能确认");
      expect(reply(h.db, "query")).not.toContain("private");
      expect(item(h.db, "query")).toBeNull();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("keeps invalid WI references rejected before model routing", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      expect(h.service.ingestDingTalkMessage(message("invalid", "WI-MISSING 现在到哪了？")).association).toBe("invalid_reference");
      await h.service.processNaturalIntake();
      expect(h.requests).toEqual([]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });
});
