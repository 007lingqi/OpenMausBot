import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startCollaborationService } from "./service.ts";
import { ModelNaturalIntakeInterpreter, type NaturalIntakeRequest } from "./natural-intake.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import type { ConversationIntentDecision, ConversationIntentRequest } from "./conversation-intent.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { ConversationIngressCoordinator } from "./conversation-ingress.ts";
import { classifyConversationIntent } from "./conversation-intent.ts";
import { conversationSourceHash, conversationStatus, readConversationContext, type ConversationJob } from "./conversation-context.ts";
import { applyCollaborationMigrations, COLLABORATION_SCHEMA_VERSION } from "./migrations.ts";
import { readPlanMaterialReadiness } from "./plan-material-readiness.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { projectConversationTurn } from "./conversation-turn.ts";
import { turnSourceOrigin } from "./turn-sources.ts";

const paths: string[] = [];
const turnReviewEnvelope = z.object({ properties: z.object({ allIntentsCovered: z.object({}).passthrough() }).passthrough() }).passthrough();
function stripCandidateRevisionSchema(database: DatabaseSync): void {
  database.exec("DROP TABLE collaboration_turn_parts; DELETE FROM collaboration_schema_migrations WHERE version=41");
  const triggers = z.array(z.object({ name: z.string().regex(/^[a-z_]+$/u) })).parse(
    database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'candidate_revision_%'").all());
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name}"`);
  database.exec("DROP TABLE collaboration_candidate_revision_stages; DROP TABLE collaboration_candidate_revision_requests");
}
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }); });
function message(id: string, text: string, group = "group", person = "product") {
  return { sourceEventId: id, transportMessageId: id, conversationId: group, addressedToBot: true, text,
    sender: { senderId: person, senderCorpId: "corp", senderStaffId: person, displayName: person }, receivedAt: Date.now() };
}
function decision(input: ConversationIntentRequest, intent: string, target: string | null = null, reply: string | null = null) {
  return { version: 1, sourceEventId: input.sourceEventId, intent, targetWorkItemId: target,
    replySourceEventId: reply, quote: input.text, confidence: "high" };
}
function adviceDecision(input: ConversationIntentRequest, target: string | null = null) {
  return { ...decision(input, "advice", target), advice: { basisSourceEventIds: [input.sourceEventId],
    summary: "可以先比较范围和投入。", options: [
      { title: "轻量版", description: "优先覆盖核心功能。", tradeoff: "投入较小，复杂流程需后续考虑。" },
      { title: "标准版", description: "兼顾权限和操作记录。", tradeoff: "覆盖更完整，设计投入较高。" }],
    question: "你更倾向哪一版？" as string | null } };
}
function setup(classify: (request: ConversationIntentRequest) => Promise<unknown>, interpret?: (request: NaturalIntakeRequest) => unknown) {
  const directory = mkdtempSync(join(tmpdir(), "conversation-ingress-")); paths.push(directory);
  const interpreted: string[] = [], requests: ConversationIntentRequest[] = [];
  const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(envelope) {
    const input = JSON.parse(envelope.user);
    if (turnReviewEnvelope.safeParse(envelope.responseSchema).success) {
      return { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
    }
    if ((envelope.responseSchema as { properties: Record<string, unknown> }).properties.intent) {
      requests.push(input); return classify(input);
    }
    interpreted.push(input.event.sourceEventId);
    if (interpret) return interpret(input);
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
  it("keeps a current-discussion boundary separate from Owner controls and resumes that purpose after restart", async () => {
    const h = setup(async input => {
      if (["login", "payment"].includes(input.sourceEventId)) return decision(input, "new_request");
      const login = input.candidates.find(c => c.title.includes("登录"))!.id;
      if (input.sourceEventId === "scope") return { ...decision(input, "clarify"), parts: [
        { ...decision(input, "discussion_only", login), text: "登录提示改成“请重新登录”，但本轮先只讨论，不修改代码", quote: "登录提示改成“请重新登录”，但本轮先只讨论，不修改代码" },
        { ...decision(input, "status_query", input.candidates.find(c => c.title.includes("支付"))!.id), text: "支付进展如何", quote: "支付进展如何" },
      ] };
      return decision(input, "contribution", login);
    });
    try {
      for (const [id, text] of [["login", "登录提示调整"], ["payment", "支付提示调整"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      const before = taskState(h.db);
      const scoped = message("scope", "登录提示改成“请重新登录”，但本轮先只讨论，不修改代码；支付进展如何？");
      h.service.ingestDingTalkMessage(scoped); await h.service.processNaturalIntake(); await deliver(h.db);
      const text = reply(h.db, "scope");
      expect(text).toContain("登录"); expect(text).toContain("讨论"); expect(text).toContain("支付");
      expect(text).not.toMatch(/负责人|审批|暂停|已修改|修改完成/u);
      expect(taskState(h.db)).toEqual(before);
      h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        resumed.ingestDingTalkMessage(scoped); await resumed.processNaturalIntake();
        resumed.ingestDingTalkMessage(message("assent", "对，就这样"));
        expect(readConversationContext(h.db, job(h.db, "assent")).pendingQuestion).toMatchObject({ kind: "read_only", origin: "discussion", answerExpected: false });
        await resumed.processNaturalIntake();
        expect(job(h.db, "assent").proposal_json).toContain('"reason":"pending_read_only"');
        expect(taskState(h.db)).toEqual(before);
        expect(resumed.ownerBinding()).toBeNull();
      } finally { resumed.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it("projects two independent modifications without sharing their requirement contexts", async () => {
    const texts = ["登录增加超时提示", "支付增加退款提示"];
    const contexts: NaturalIntakeRequest[] = [];
    const h = setup(async input => input.sourceEventId !== "two-changes" ? decision(input, "new_request") : {
      ...decision(input, "clarify"), parts: texts.map(text => ({ ...decision(input, "contribution", input.candidates.find(c => c.title.startsWith(text.slice(0, 2)))!.id), text, quote: text })),
    }, request => {
      contexts.push(request);
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: { text: request.event.text, quote: request.event.text, confirmed: true },
        acceptance: [{ description: request.event.text, observation: "页面提示与要求一致", quote: request.event.text }], answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["login", "登录改提示"], ["payment", "支付改提示"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake();
      }
      h.service.ingestDingTalkMessage(message("two-changes", texts.join("，"))); await h.service.processNaturalIntake();
      // Each scheduler tick consumes one durable requirement job.
      await h.service.processNaturalIntake();
      expect(readLatestWorkItemSnapshot(h.db, item(h.db, "login")!)?.goal).toBe(texts[0]);
      expect(readLatestWorkItemSnapshot(h.db, item(h.db, "payment")!)?.goal).toBe(texts[1]);
      const derived = contexts.filter(request => request.event.sourceEventId.startsWith("turn:"));
      expect(derived).toHaveLength(2);
      expect(derived[0].history?.map(event => event.text)).toEqual(["登录改提示", texts[0]]);
      expect(derived[1].history?.map(event => event.text)).toEqual(["支付改提示", texts[1]]);
      expect(h.db.prepare("SELECT version FROM collaboration_work_items ORDER BY rowid").all()).toEqual([{ version: 2 }, { version: 2 }]);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("two-changes", texts.join("，"))); await h.service.processNaturalIntake();
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });
  it("answers a query alongside a control request, refreshing progress at send without changing tasks or authority", async () => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : {
      ...decision(input, "clarify"), parts: [
        { ...decision(input, "control_request", input.candidates[0].id), text: "暂停登录修改", quote: "暂停登录修改" },
        { ...decision(input, "status_query", input.candidates[0].id), text: "登录进展如何", quote: "登录进展如何" },
      ],
    });
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示调整")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("mixed-control", "暂停登录修改，登录进展如何？")); await h.service.processNaturalIntake();
      expect(reply(h.db, "mixed-control")).toContain("负责人");
      expect(reply(h.db, "mixed-control")).toContain("登录");
      expect(taskState(h.db)).toEqual(before);
      h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(item(h.db, "new"));
      await deliver(h.db);
      expect(reply(h.db, "mixed-control")).toContain("已暂停");
      expect(h.service.ownerBinding()).toBeNull();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_turn_parts WHERE child_event_id IS NOT NULL").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("refreshes an independent query even after the modification branch has exhausted projection", async () => {
    const h = setup(async input => decision(input, "new_request"));
    const coordinator = new ConversationIngressCoordinator(h.db, (input, signal) => classifyConversationIntent({ async complete(envelope) {
      if (turnReviewEnvelope.safeParse(envelope.responseSchema).success) return { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
      return { ...decision(input, "clarify"), parts: [
        { ...decision(input, "new_request"), text: "新增登录提示", quote: "新增登录提示" },
        { ...decision(input, "status_query", input.candidates[0].id), text: "支付进展如何", quote: "支付进展如何" },
      ] };
    } }, input, signal), () => { throw new Error("projection interrupted"); });
    try {
      h.service.ingestDingTalkMessage(message("payment", "支付提示调整")); await h.service.processNaturalIntake(); await deliver(h.db);
      const id = item(h.db, "payment")!, snapshot = readLatestWorkItemSnapshot(h.db, id);
      h.service.ingestDingTalkMessage(message("partial", "新增登录提示，支付进展如何"));
      for (let i = 0; i < 3; i++) await coordinator.processOne(Date.now());
      expect(job(h.db, "partial").status).toBe("failed");
      h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(id);
      await deliver(h.db);
      expect(reply(h.db, "partial")).toContain("已暂停");
      expect(reply(h.db, "partial")).not.toContain("修改完成");
      expect(readLatestWorkItemSnapshot(h.db, id)).toEqual(snapshot);
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it("preserves the exact non-status clarification when refreshing a mixed reply", async () => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : {
      ...decision(input, "clarify"), parts: [
        { ...decision(input, "status_query"), text: "那个进展如何", quote: "那个进展如何" },
        { ...decision(input, "status_query", input.candidates[0].id), text: "登录进展如何", quote: "登录进展如何" },
      ],
    });
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示调整")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("mixed-query", "那个进展如何，登录进展如何？")); await h.service.processNaturalIntake();
      const clarification = reply(h.db, "mixed-query")!.split("\n\n")[0];
      expect(clarification).toContain("登录提示调整");
      h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(item(h.db, "new"));
      await deliver(h.db);
      expect(reply(h.db, "mixed-query")!.split("\n\n")[0]).toBe(clarification);
      expect(reply(h.db, "mixed-query")).toContain("已暂停");
    } finally { h.service.close(); h.db.close(); }
  });

  it("stops a branch at its persisted attempt budget rather than projecting a fourth time", async () => {
    const h = setup(async input => decision(input, "new_request"));
    const coordinator = new ConversationIngressCoordinator(h.db, (input, signal) => classifyConversationIntent({ async complete(envelope) {
      if (turnReviewEnvelope.safeParse(envelope.responseSchema).success) return { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
      return { ...decision(input, "clarify"), parts: ["新增登录提示", "新增支付提示"].map(text => ({ ...decision(input, "new_request"), text, quote: text })) };
    } }, input, signal), () => { throw new Error("projection interrupted"); });
    try {
      h.service.ingestDingTalkMessage(message("two-new", "新增登录提示，新增支付提示")); await coordinator.processOne(Date.now());
      const current = job(h.db, "two-new");
      expect(current.status).toBe("routed");
      h.db.prepare("UPDATE collaboration_turn_parts SET attempts=3 WHERE parent_event_id=? AND ordinal=0").run(current.id);
      let calls = 0;
      expect(() => projectConversationTurn(h.db, current, Date.now(), () => { calls++; })).toThrow("conversation_turn_projection_exhausted");
      expect(calls).toBe(0);
      expect(h.db.prepare("SELECT status FROM collaboration_turn_parts WHERE parent_event_id=? AND ordinal=0").get(current.id)).toEqual({ status: "failed" });
      expect(() => projectConversationTurn(h.db, current, Date.now(), () => { calls++; })).toThrow("conversation_turn_projection_exhausted");
      expect(calls).toBe(0);
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it("recovers the remaining branch after interruption, retaining two distinct tasks and one visible source", async () => {
    const h = setup(async input => decision(input, "new_request"));
    const calls: string[] = [];
    const coordinator = new ConversationIngressCoordinator(h.db, (input, signal) => classifyConversationIntent({ async complete(envelope) {
      if (turnReviewEnvelope.safeParse(envelope.responseSchema).success) return { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
      return { ...decision(input, "clarify"), parts: ["新增登录提示", "新增支付提示"].map(text => ({ ...decision(input, "new_request"), text, quote: text })) };
    } }, input, signal), (_id, source) => { calls.push(source); if (calls.length === 2) throw new Error("interrupted"); });
    try {
      h.service.ingestDingTalkMessage(message("two-new", "新增登录提示，新增支付提示")); await coordinator.processOne(Date.now());
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_turn_parts ORDER BY ordinal").all()).toEqual([
        { status: "applied", attempts: 1 }, { status: "routed", attempts: 1 },
      ]);
      const before = h.db.prepare("SELECT id,title,version FROM collaboration_work_items ORDER BY rowid").all();
      coordinator.close(); h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        await resumed.processNaturalIntake();
        expect(h.interpreted).toEqual([calls[1]]);
        expect(h.db.prepare("SELECT status,attempts FROM collaboration_turn_parts ORDER BY ordinal").all()).toEqual([
          { status: "applied", attempts: 1 }, { status: "applied", attempts: 2 },
        ]);
        expect(h.db.prepare("SELECT title FROM collaboration_work_items ORDER BY title").all()).toHaveLength(2);
        expect(turnSourceOrigin(h.db, calls[0])).toBe("two-new");
        resumed.ingestDingTalkMessage(message("later", "现在进展如何"));
        const history = readConversationContext(h.db, job(h.db, "later")).history.filter(entry => entry.role === "user");
        expect(history.map(entry => entry.text)).toEqual(["新增登录提示，新增支付提示", "现在进展如何"]);
        expect(h.db.prepare("SELECT id,title,version FROM collaboration_work_items ORDER BY rowid").all()).toEqual(before);
        h.db.prepare("UPDATE collaboration_external_events SET normalized_json=json_set(normalized_json,'$.text','篡改') WHERE source_event_id=?").run(calls[1]);
        expect(() => turnSourceOrigin(h.db, calls[1])).toThrow("conversation_turn_source_invalid");
      } finally { resumed.close(); }
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it("applies only the requested contribution while answering another task in the same turn, once across restart", async () => {
    const changed = "登录提示改成“请重新登录”";
    const query = "支付那个进展怎么样";
    const seen: string[] = [];
    const h = setup(async input => {
      if (input.sourceEventId !== "mixed") return decision(input, "new_request");
      const login = input.candidates.find(c => c.title.includes("登录"))!;
      const payment = input.candidates.find(c => c.title.includes("支付"))!;
      return { ...decision(input, "clarify"), parts: [
        { ...decision(input, "contribution", login.id), text: changed, quote: changed },
        { ...decision(input, "status_query", payment.id), text: query, quote: query },
      ] };
    }, request => {
      seen.push(request.event.text);
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: { text: request.event.text, quote: request.event.text, confirmed: true },
        acceptance: [{ description: request.event.text, observation: "核对对应页面提示", quote: request.event.text }], answers: [], questions: [] };
    });
    try {
      h.service.ingestDingTalkMessage(message("login", "登录失败提示需要修改")); await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("payment", "支付失败状态需要修复")); await h.service.processNaturalIntake();
      const loginId = item(h.db, "login")!, paymentId = item(h.db, "payment")!;
      const paymentBefore = readLatestWorkItemSnapshot(h.db, paymentId);
      const mixed = message("mixed", `${changed}，${query}？`);
      h.service.ingestDingTalkMessage(mixed); await h.service.processNaturalIntake();
      expect(readLatestWorkItemSnapshot(h.db, loginId)?.goal).toBe(changed);
      expect(readLatestWorkItemSnapshot(h.db, paymentId)).toEqual(paymentBefore);
      expect(seen).toEqual(["登录失败提示需要修改", "支付失败状态需要修复", changed]);
      expect(reply(h.db, "mixed")).toContain("支付");
      expect(reply(h.db, "mixed")).toContain("已记录");
      expect(reply(h.db, "mixed")).not.toMatch(/修改完成|Work Item|WI-/u);
      expect(h.db.prepare("SELECT count(*) AS n FROM collaboration_turn_parts WHERE parent_event_id=(SELECT id FROM collaboration_external_events WHERE source_event_id='mixed')").get()).toEqual({ n: 2 });
      const before = taskState(h.db), outbox = h.service.pendingOutbox();
      h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        resumed.ingestDingTalkMessage(mixed); await resumed.processNaturalIntake();
        expect(taskState(h.db)).toEqual(before);
        expect(resumed.pendingOutbox()).toEqual(outbox);
        expect(resumed.ownerBinding()).toBeNull();
      } finally { resumed.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("retains constraints stated only before the item existed when implementing the selected scheme", async () => {
    const requests: NaturalIntakeRequest[] = [];
    const constraint = "只改提示文字，不改登录逻辑，也不要增加依赖";
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, input.sourceEventId === "choose" ? "select_option" : "new_request"),
        choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: input.sourceEventId === "choose" ? 2 : 1 } }, request => {
      requests.push(request);
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: [{ description: constraint, observation: "登录行为和依赖不变，仅提示改变", quote: constraint }], answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["consult", `给我两个登录提示方案，${constraint}。`], ["choose", "选第二个"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        resumed.ingestDingTalkMessage(message("implement", "请实现刚才选择的方案")); await resumed.processNaturalIntake();
        expect(h.db.prepare("SELECT status FROM collaboration_natural_intake_jobs WHERE source_event_id='implement'").get()).toEqual({ status: "applied" });
        expect(readLatestWorkItemSnapshot(h.db, item(h.db, "implement")!)?.acceptanceConditions)
          .toEqual(expect.arrayContaining([expect.objectContaining({ description: constraint })]));
        expect(JSON.stringify(requests[0].implementationContext)).toContain(constraint);
        const state = taskState(h.db);
        resumed.ingestDingTalkMessage(message("implement", "请实现刚才选择的方案")); await resumed.processNaturalIntake();
        expect(taskState(h.db)).toEqual(state);
      } finally { resumed.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("keeps cited participants and corrections in order without importing unrelated group chatter", async () => {
    let captured: NaturalIntakeRequest | undefined;
    const h = setup(async input => {
      if (input.sourceEventId === "noise") return decision(input, "acknowledgement");
      if (input.sourceEventId === "implement") return { ...decision(input, "new_request"),
        choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: 2 } };
      const result = adviceDecision(input);
      if (input.sourceEventId === "correct") result.advice.basisSourceEventIds = ["limits", "correct"];
      return result;
    }, request => {
      captured = request;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: [], answers: [], questions: [] };
    });
    try {
      for (const [id, text, person] of [["limits", "提示只显示一行，给两个方案", "tester"], ["noise", "谢谢，周末团建去看电影", "manager"],
        ["correct", "更正前面测试的要求：提示可以两行，但不改登录逻辑。按这个给两个方案", "product"], ["implement", "选第二个，请开始修改", "product"]]) {
        h.service.ingestDingTalkMessage(message(id, text, "group", person)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      const sources = captured?.implementationContext?.discussionSources ?? [];
      expect(sources.filter(source => source.role === "user").map(source => source.sourceEventId)).toEqual(["limits", "correct"]);
      expect(sources.find(source => source.sourceEventId === "limits")?.principalId).not.toBe(sources.find(source => source.sourceEventId === "correct")?.principalId);
      expect(JSON.stringify(sources)).not.toContain("团建");
      expect(captured?.contextTruncated).toBe(false);
    } finally { h.service.close(); h.db.close(); }
  });

  it("bounds long selection history without certifying the omitted requirements as complete", async () => {
    let captured: NaturalIntakeRequest | undefined;
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, input.sourceEventId === "implement" ? "new_request" : "select_option"),
        choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: input.sourceEventId === "choose-0" ? 2 : 1 } }, request => {
      captured = request;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: [], answers: [], questions: [] };
    });
    try {
      h.service.ingestDingTalkMessage(message("consult", "给两个方案，只改提示不要增加依赖")); await h.service.processNaturalIntake(); await deliver(h.db);
      for (let n = 0; n < 26; n++) {
        h.service.ingestDingTalkMessage(message(`choose-${n}`, n === 0 ? "选第二个" : "按这个来"));
        await h.service.processNaturalIntake(); await deliver(h.db);
      }
      h.service.ingestDingTalkMessage(message("implement", "请实现刚才选择的方案")); await h.service.processNaturalIntake();
      expect(captured?.implementationContext?.discussionSources?.length).toBeLessThanOrEqual(24);
      expect(captured?.implementationContext?.discussionContextIncomplete).toBe(true);
      expect(captured?.contextTruncated).toBe(true);
      expect(readLatestWorkItemSnapshot(h.db, item(h.db, "implement")!)?.blockingAmbiguities)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: "natural-context-incomplete" })]));
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not import another item's discussion through a cited user event with no direct work item link", async () => {
    let captured: NaturalIntakeRequest | undefined;
    const h = setup(async input => {
      if (input.sourceEventId === "other-task") return decision(input, "new_request");
      if (input.sourceEventId === "implement") return { ...decision(input, "new_request"),
        choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: 2 } };
      const result = adviceDecision(input, input.sourceEventId === "other-advice" ? input.candidates[0].id : null);
      if (input.sourceEventId === "consult") result.advice.basisSourceEventIds = ["other-advice", "consult"];
      return result;
    }, request => {
      captured = request;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: [], answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["other-task", "请修改支付提示"], ["other-advice", "支付那个必须添加退款按钮，给两个方案"],
        ["consult", "另一个登录提示问题先给我两个方案"], ["implement", "选第二个，请开始修改"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      expect(captured?.event.sourceEventId).toBe("implement");
      expect(captured?.contextTruncated).toBe(true);
      expect(captured?.implementationContext?.discussionSources?.some(source => source.sourceEventId === "other-advice")).toBe(false);
    } finally { h.service.close(); h.db.close(); }
  });

  it("rechecks the original offer after a later selection while the requirement model is working", async () => {
    let changed = false;
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, input.sourceEventId === "choose" ? "select_option" : "new_request"),
        choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: input.sourceEventId === "choose" ? 2 : 1 } }, request => {
      h.db.prepare("UPDATE collaboration_outbox SET payload_json=json_set(payload_json,'$.summary','已变更') WHERE source_event_id='conversation:consult'").run();
      changed = true;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: { text: request.implementationContext!.selection.option.description, quote: request.event.text, confirmed: true },
        acceptance: [], answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["consult", "两个方案，只改提示"], ["choose", "选第二个"], ["implement", "请实现刚才选择的方案"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      expect(changed).toBe(true);
      expect(h.db.prepare("SELECT status,proposal_json FROM collaboration_natural_intake_jobs WHERE source_event_id='implement'").get())
        .toEqual({ status: "pending", proposal_json: null });
      expect(readLatestWorkItemSnapshot(h.db, item(h.db, "implement")!)?.goalConfirmed).toBe(false);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each([false, true])("carries a delivered scheme into an explicit implementation request and its Spec (direct=%s)", async direct => {
    const requests: NaturalIntakeRequest[] = [];
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, input.sourceEventId === "choose" ? "select_option" : "new_request"),
        choice: { sourceEventId: input.discussionOptions?.sourceEventId ?? "missing", optionIndex: input.sourceEventId === "choose" || direct ? 2 : 1 } }, request => {
      requests.push(request);
      const selected = request.implementationContext?.selection.option;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: selected ? { text: selected.description, quote: request.event.text, confirmed: true } : null,
        acceptance: selected ? [{ description: selected.description, observation: "界面覆盖权限与操作记录", quote: selected.description }] : [],
        answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["consult", "给我两个后台方案"], ...(!direct ? [["choose", "选第二个"]] : [])]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
      h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        const input = message("implement", direct ? "选第二个，请开始修改" : "请实现刚才选择的方案");
        resumed.ingestDingTalkMessage(input); await resumed.processNaturalIntake();
        expect(job(h.db, "implement").status).toBe("applied");
        const id = item(h.db, "implement")!;
        expect(readLatestWorkItemSnapshot(h.db, id)).toMatchObject({ goal: "兼顾权限和操作记录。", goalConfirmed: true,
          acceptanceConditions: [expect.objectContaining({ description: "兼顾权限和操作记录。" })] });
        expect(requests[0]).toMatchObject({ implementationContext: { requestSourceEventId: "implement",
          selection: { option: { title: "标准版" } } } });
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 0 });
        const before = taskState(h.db);
        resumed.ingestDingTalkMessage(input); await resumed.processNaturalIntake();
        expect(taskState(h.db)).toEqual(before); expect(requests).toHaveLength(1);
      } finally { resumed.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("selects the second actually delivered option across restart without creating work or repeating the menu", async () => {
    const h = setup(async input => input.sourceEventId === "choose"
      ? { ...decision(input, "select_option"), choice: { sourceEventId: input.discussionOptions?.sourceEventId ?? "missing", optionIndex: 2 } }
      : adviceDecision(input));
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我两个后台方案"));
      await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.close(); const resumed = startCollaborationService(h.options);
      try {
        const input = message("choose", "选第二个");
        resumed.ingestDingTalkMessage(input); await resumed.processNaturalIntake(); await deliver(h.db);
        expect(job(h.db, "choose").status).toBe("applied");
        expect(JSON.parse(job(h.db, "choose").proposal_json!)).toMatchObject({ action: "select_option",
          selection: { optionIndex: 2, option: { title: "标准版", description: "兼顾权限和操作记录。" } } });
        expect(reply(h.db, "choose")).toContain("标准版");
        expect(reply(h.db, "choose")).not.toMatch(/轻量版|需要补充一点|修改完成|执行|WI-/u);
        expect(taskState(h.db)).toEqual(before); expect(h.interpreted).toEqual([]);
        const count = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        resumed.ingestDingTalkMessage(input); await resumed.processNaturalIntake();
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(count);
      } finally { resumed.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["unsent", "sent_later", "other_speaker", "other_group", "wrong_index", "missing_source"].flatMap(mode =>
    [false, true].map(implementation => ({ mode, implementation }))))("rejects invalid scheme evidence $mode (implementation=$implementation)", async ({ mode, implementation }) => {
    const h = setup(async input => input.sourceEventId === "choose"
      ? { ...decision(input, implementation ? "new_request" : "select_option"), choice: {
        sourceEventId: mode === "missing_source" ? "outbox:invented" : input.discussionOptions?.sourceEventId ?? "missing",
        optionIndex: mode === "wrong_index" ? 1 : 2 } }
      : adviceDecision(input));
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我两个后台方案")); await h.service.processNaturalIntake();
      if (!["unsent", "sent_later"].includes(mode)) await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("choose", implementation ? "选第二个，请开始修改" : "选第二个", mode === "other_group" ? "elsewhere" : "group", mode === "other_speaker" ? "tester" : "product"));
      if (mode === "sent_later") await deliver(h.db);
      await h.service.processNaturalIntake();
      expect(JSON.parse(job(h.db, "choose").proposal_json!)).toMatchObject({ action: "ask_context" });
      expect(taskState(h.db)).toEqual(before); expect(h.interpreted).toEqual([]);
      expect(reply(h.db, "choose")).not.toContain("已选");
    } finally { h.service.close(); h.db.close(); }
  });

  it("continues with the single selected option instead of asking which option again", async () => {
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, "select_option"), choice: { sourceEventId: input.discussionOptions?.sourceEventId ?? "missing",
        optionIndex: input.sourceEventId === "choose" ? 2 : 1 } });
    try {
      for (const [id, text] of [["consult", "给我两个方案"], ["choose", "选第二个"], ["continue", "按这个来"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      expect(JSON.parse(job(h.db, "continue").proposal_json!)).toMatchObject({ action: "select_option", selection: { option: { title: "标准版" } } });
      expect(reply(h.db, "continue")).toContain("标准版");
      expect(reply(h.db, "continue")).not.toEqual(reply(h.db, "choose"));
      expect(reply(h.db, "continue")!.length).toBeLessThan(reply(h.db, "choose")!.length);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not certify an option list whose actual DingTalk serialization was truncated", async () => {
    const h = setup(async input => input.sourceEventId === "consult"
      ? { ...adviceDecision(input), advice: { basisSourceEventIds: [input.sourceEventId], summary: "背景".repeat(100),
        options: ["一", "二", "三"].map(n => ({ title: `方案${n}`, description: "说明".repeat(90), tradeoff: "取舍".repeat(60) })), question: null } }
      : { ...decision(input, "select_option"), choice: { sourceEventId: input.discussionOptions?.sourceEventId ?? "missing", optionIndex: 3 } });
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我几个方案")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("choose", "选第三个")); await h.service.processNaturalIntake();
      expect(JSON.parse(job(h.db, "choose").proposal_json!)).toMatchObject({ action: "ask_context" });
      expect(reply(h.db, "choose")).not.toContain("已选");
    } finally { h.service.close(); h.db.close(); }
  });

  it.each([false, true])("rechecks the exact delivered offer before committing (implementation=%s)", async implementation => {
    const h = setup(async input => adviceDecision(input));
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我两个方案")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("choose", implementation ? "选第二个，请开始修改" : "选第二个"));
      const before = taskState(h.db);
      const coordinator = new ConversationIngressCoordinator(h.db, async (input, signal) => {
        const selected = await classifyConversationIntent({ async complete() {
          return { ...decision(input, implementation ? "new_request" : "select_option"), choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: 2 } };
        } }, input, signal);
        h.db.prepare("UPDATE collaboration_outbox SET payload_json=json_set(payload_json,'$.summary','被更改的方案') WHERE source_event_id='conversation:consult'").run();
        return selected;
      }, () => { throw new Error("selection must not project work"); });
      await coordinator.processOne(); coordinator.close();
      expect(job(h.db, "choose").status).toBe("pending");
      expect(job(h.db, "choose").proposal_json).toBeNull();
      expect(reply(h.db, "choose")).toBeNull();
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["payload", "delivery"])("does not persist a Spec if scheme %s changes during interpretation", async fault => {
    let changed = false;
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, "new_request"), choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: 2 } }, request => {
      const selected = request.implementationContext!.selection.option;
      if (fault === "payload") h.db.prepare("UPDATE collaboration_outbox SET payload_json=json_set(payload_json,'$.summary','变化') WHERE source_event_id='conversation:consult'").run();
      if (fault === "delivery") h.db.prepare("UPDATE collaboration_outbox SET delivery_state='pending' WHERE source_event_id='conversation:consult'").run();
      changed = true;
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: { text: selected.description, quote: request.event.text, confirmed: true }, acceptance: [], answers: [], questions: [] };
    });
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我两个方案")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("implement", "选第二个，请开始修改")); await h.service.processNaturalIntake();
      expect(changed).toBe(true);
      const snapshot = readLatestWorkItemSnapshot(h.db, item(h.db, "implement")!)!;
      expect(snapshot.goal).not.toBe("兼顾权限和操作记录。");
      expect(snapshot.goalConfirmed).toBe(false);
      expect(h.db.prepare("SELECT status,proposal_json FROM collaboration_natural_intake_jobs WHERE source_event_id='implement'").get())
        .toEqual({ status: "pending", proposal_json: null });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("contributes an implementation choice to the existing item without creating a second one", async () => {
    const contexts: NaturalIntakeRequest[] = [];
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request")
      : input.sourceEventId === "consult" ? adviceDecision(input, input.candidates[0].id)
      : { ...decision(input, "contribution", input.candidates[0].id), choice: { sourceEventId: input.discussionOptions!.sourceEventId, optionIndex: 2 } }, request => {
      contexts.push(request);
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: request.implementationContext ? [{ description: request.implementationContext.selection.option.description,
          observation: "界面验证权限与记录", quote: request.implementationContext.selection.option.description }] : [], answers: [], questions: [] };
    });
    try {
      for (const [id, text] of [["new", "请新增管理后台"], ["consult", "后台给我两个方案"], ["implement", "选第二个，请开始修改"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      expect(item(h.db, "implement")).toBe(item(h.db, "new"));
      expect(job(h.db, "implement").status).toBe("applied");
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 1 });
      expect(contexts.at(-1)?.implementationContext?.selection.option.title).toBe("标准版");
      expect(readLatestWorkItemSnapshot(h.db, item(h.db, "new")!)?.acceptanceConditions)
        .toEqual(expect.arrayContaining([expect.objectContaining({ description: "兼顾权限和操作记录。" })]));
    } finally { h.service.close(); h.db.close(); }
  });

  it("rejects an offer tied to a stale task revision", async () => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request")
      : input.sourceEventId === "consult" ? adviceDecision(input, input.candidates[0].id)
      : { ...decision(input, "select_option", input.candidates[0].id), choice: { sourceEventId: input.discussionOptions?.sourceEventId ?? "missing", optionIndex: 2 } });
    try {
      h.service.ingestDingTalkMessage(message("new", "修复登录提示")); await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("consult", "给登录问题两个方案")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(item(h.db, "new"));
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("choose", "选第二个")); await h.service.processNaturalIntake();
      expect(JSON.parse(job(h.db, "choose").proposal_json!)).toMatchObject({ action: "ask_context", reason: "reference_conflict" });
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it("answers the two consultation turns with actual options and no task, Spec, run or authority changes", async () => {
    const h = setup(async input => ({ ...decision(input, "advice"), advice: {
      basisSourceEventIds: input.sourceEventId === "options" ? ["consult", "options"] : ["consult"],
      summary: "可以按范围比较以下方案。", options: [
        { title: "轻量版", description: "围绕账号和内容管理设计。", tradeoff: "开发投入较小，适合先验证需求。" },
        { title: "标准版", description: "加入权限分工和操作记录。", tradeoff: "覆盖更完整，设计投入较大。" },
        { title: "扩展版", description: "再考虑审批流程和多团队协作。", tradeoff: "适合复杂业务，维护成本更高。" }],
      question: "你更看重快速使用，还是完整的业务流程？" } }));
    try {
      const before = taskState(h.db);
      for (const [id, text] of [["consult", "我想增加一个后台管理，应该如何"], ["options", "你帮我思考下给我几个版本，我选择下"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
        expect(job(h.db, id).status).toBe("applied");
        expect(job(h.db, id).proposal_json).toContain('"action":"offer_advice"');
        expect(reply(h.db, id)).toContain("轻量版"); expect(reply(h.db, id)).toContain("标准版"); expect(reply(h.db, id)).toContain("扩展版");
        expect(reply(h.db, id)).not.toMatch(/以下是可选方案|仅供讨论|不代表已安排实施/u);
        expect(reply(h.db, id)).toContain("可以按范围比较以下方案。\n\n1\\. 轻量版：围绕账号和内容管理设计。 取舍：开发投入较小，适合先验证需求。");
        expect(reply(h.db, id)).not.toMatch(/补充已收到|修改完成|开始修改|WI-/u);
        expect(item(h.db, id)).toBeNull(); expect(taskState(h.db)).toEqual(before);
      }
      expect(h.requests).toHaveLength(2); expect(h.interpreted).toEqual([]);
      expect(h.requests[1].history).toEqual(expect.arrayContaining([expect.objectContaining({ sourceEventId: "consult", text: "我想增加一个后台管理，应该如何" })]));
      for (const table of ["collaboration_runs", "collaboration_control_events", "collaboration_action_tokens", "collaboration_plan_revisions"]) {
        expect(h.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["你更倾向哪一版？", null])("keeps delivered advice read-only across restart and replay even with question=%s", async question => {
    const h = setup(async input => input.sourceEventId === "accept" ? decision(input, "new_request")
      : { ...adviceDecision(input), advice: { ...adviceDecision(input).advice, question } });
    try {
      h.service.ingestDingTalkMessage(message("consult", "能先给我几种方案吗？")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.close(); const restarted = startCollaborationService(h.options);
      try {
        const input = message("accept", "按这个来"); restarted.ingestDingTalkMessage(input);
        expect(readConversationContext(h.db, job(h.db, "accept")).pendingQuestion).toMatchObject({ kind: "read_only", origin: "advice",
          text: question ?? "可以先比较范围和投入。" });
        await restarted.processNaturalIntake(); await deliver(h.db);
        expect(job(h.db, "accept").proposal_json).toContain('"reason":"pending_read_only"');
        expect(taskState(h.db)).toEqual(before); expect(h.interpreted).toEqual([]);
        const count = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        restarted.ingestDingTalkMessage(input); await restarted.processNaturalIntake();
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(count);
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("rechecks a custom new-task adapter after delivered advice without a follow-up question", async () => {
    const h = setup(async input => ({ ...adviceDecision(input), advice: { ...adviceDecision(input).advice, question: null } }));
    let projections = 0;
    const coordinator = new ConversationIngressCoordinator(h.db, async input => ({ sourceEventId: input.sourceEventId, quote: input.text,
      intent: "new_request", action: "create_work", target: null, reply: null }), () => { projections++; });
    try {
      h.service.ingestDingTalkMessage(message("consult", "比较几个方案，不需要再问我。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("choice", "按这个来")); await coordinator.processOne();
      expect(item(h.db, "choice")).toBeNull(); expect(taskState(h.db)).toEqual(before); expect(projections).toBe(0);
      expect(job(h.db, "choice").status).toBe("pending");
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_plan_revisions").get()).toEqual({ n: 0 });
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it("does not invent a pending question when acknowledging advice that had no follow-up question", async () => {
    const h = setup(async input => input.sourceEventId === "thanks" ? decision(input, "acknowledgement")
      : { ...adviceDecision(input), advice: { ...adviceDecision(input).advice, question: null } });
    try {
      h.service.ingestDingTalkMessage(message("consult", "先比较几个方案，不需要追问。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("thanks", "谢谢。")); await h.service.processNaturalIntake();
      expect(job(h.db, "thanks").proposal_json).toContain('"action":"acknowledge"');
      expect(reply(h.db, "thanks")).toContain("不客气"); expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each([
    "请新增日志导出功能，但暂时不要实施，只比较方案和投入。",
    "文案里写着‘请新增日志导出功能’，现在只讨论措辞，不执行。",
  ])("does not start a requirement from a positive excerpt inside a read-only message: %s", async text => {
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input)
      : { ...decision(input, "new_request"), quote: "请新增日志导出功能" });
    try {
      h.service.ingestDingTalkMessage(message("consult", "比较几个可选方案。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("choice", text)); await h.service.processNaturalIntake();
      expect(job(h.db, "choice").proposal_json).toContain('"reason":"pending_read_only"');
      expect(item(h.db, "choice")).toBeNull(); expect(taskState(h.db)).toEqual(before); expect(h.interpreted).toEqual([]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_plan_revisions").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("allows a later explicit implementation request after advice with no question", async () => {
    const h = setup(async input => input.sourceEventId === "consult"
      ? { ...adviceDecision(input), advice: { ...adviceDecision(input).advice, question: null } } : decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("consult", "比较几个方案，不需要追问。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("implement", "请新增日志导出功能，不要改变现有权限逻辑。")); await h.service.processNaturalIntake();
      expect(item(h.db, "implement")).toMatch(/^WI-/u); expect(h.interpreted).toEqual(["implement"]);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each([false, true])("allows an explicit new implementation request after advice, including after a clarification=%s", async clarifyFirst => {
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input) : decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("consult", "先给我比较几个方案。")); await h.service.processNaturalIntake(); await deliver(h.db);
      if (clarifyFirst) {
        h.service.ingestDingTalkMessage(message("choice", "标准版")); await h.service.processNaturalIntake(); await deliver(h.db);
        expect(item(h.db, "choice")).toBeNull(); expect(h.interpreted).toEqual([]);
      }
      h.service.ingestDingTalkMessage(message("implement", "请新增一个独立的日志导出页面，按日期导出，只允许负责人查看。"));
      await h.service.processNaturalIntake();
      expect(job(h.db, "implement").proposal_json).toContain('"action":"create_work"');
      expect(item(h.db, "implement")).toMatch(/^WI-/u); expect(h.interpreted).toEqual(["implement"]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 0 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not permanently block a specific new requirement after an uncertain consultation", async () => {
    const h = setup(async input => input.sourceEventId === "consult" ? { ...adviceDecision(input), confidence: "uncertain" } : decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("consult", "帮我比较下。")); await h.service.processNaturalIntake(); await deliver(h.db);
      expect(job(h.db, "consult").proposal_json).toContain('"reason":"uncertain"');
      h.service.ingestDingTalkMessage(message("implement", "请新增独立的日志导出页面，按日期筛选。")); await h.service.processNaturalIntake();
      expect(item(h.db, "implement")).toMatch(/^WI-/u); expect(h.interpreted).toEqual(["implement"]);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["按这个来", "标准版", "请新增后台的话，应该如何设计？"])("keeps an ambiguous choice or another consultation read-only despite an adapter proposing a task: %s", async text => {
    const h = setup(async input => input.sourceEventId === "consult" ? adviceDecision(input) : decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("consult", "先比较方案。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("choice", text)); await h.service.processNaturalIntake();
      expect(job(h.db, "choice").proposal_json).toContain('"reason":"pending_read_only"');
      expect(taskState(h.db)).toEqual(before); expect(h.interpreted).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it("rechecks an advice basis against same-group history when classification finishes", async () => {
    const h = setup(async input => {
      const raw = adviceDecision(input);
      if (input.sourceEventId === "answer") {
        raw.advice.basisSourceEventIds.push("consult");
        h.db.prepare("UPDATE collaboration_external_events SET normalized_json=json_set(normalized_json,'$.text','已经变化的历史') WHERE source_event_id='consult'").run();
      }
      return raw;
    });
    try {
      h.service.ingestDingTalkMessage(message("consult", "先比较方案。")); await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("answer", "标准版有哪些取舍？")); await h.service.processNaturalIntake();
      expect(job(h.db, "answer").status).toBe("pending"); expect(job(h.db, "answer").proposal_json).toBeNull();
      expect(reply(h.db, "answer")).toBeNull(); expect(h.interpreted).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["routing", "failure"])("preserves an attempted legacy ingress receipt during %s", async mode => {
    const h = setup(async input => { if (mode === "failure") throw new Error("fixture unavailable"); return adviceDecision(input); });
    try {
      h.service.ingestDingTalkMessage(message("consult", "先比较方案。"));
      // An older release may have attempted this receipt without a known result.
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='pending',attempt=1,superseded_at=NULL,next_attempt_at=? WHERE source_event_id='consult'").run(Date.now() + 100000);
      const before = h.db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id='consult'").get();
      for (let i = 0; i < (mode === "failure" ? 3 : 1); i++) await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT * FROM collaboration_outbox WHERE source_event_id='consult'").get()).toEqual(before);
      expect(job(h.db, "consult").status).toBe(mode === "failure" ? "failed" : "applied");
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not downgrade a pending approval to ordinary advice after delivering the clarification", async () => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : adviceDecision(input));
    try {
      const owners = new LocalOwnerRegistry(join(h.options.dataDirectory, "collaboration", "collaboration.sqlite"));
      try { owners.bootstrap({ senderCorpId: "corp", senderStaffId: "product", now: Date.now() }); } finally { owners.close(); }
      h.service.ingestDingTalkMessage(message("new", "调整登录提示。")); await h.service.processNaturalIntake();
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE sent_at IS NULL").run(Date.now());
      const target = item(h.db, "new")!;
      const card = enqueueInboundCard(h.db, { sourceEventId: "candidate-notice", aggregateType: "plan", aggregateId: target, aggregateVersion: 1,
        now: Date.now(), card: { type: "plan_status_card", status: "candidate_ready", headline: "修改完成，需要负责人确认", workItemId: target,
          approvalRequired: true, summary: "需要核对改动和影响。" } });
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=?,delivery_sequence=1 WHERE id=?").run(Date.now(), card.id);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("consult", "再比较一下方案。")); await h.service.processNaturalIntake(); await deliver(h.db);
      expect(job(h.db, "consult").proposal_json).toContain('"reason":"pending_approval"');
      h.service.ingestDingTalkMessage(message("answer", "同意"));
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).toBe("approval");
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["unsent", "sent_later", "other_speaker", "other_group"])("does not borrow an advice question when it is %s", async mode => {
    const h = setup(async input => adviceDecision(input));
    try {
      h.service.ingestDingTalkMessage(message("consult", "先给几个方案。")); await h.service.processNaturalIntake();
      if (["other_speaker", "other_group"].includes(mode)) await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "标准版可以再说详细些吗？", mode === "other_group" ? "different" : "group", mode === "other_speaker" ? "tester" : "product"));
      if (mode === "sent_later") await deliver(h.db);
      const context = readConversationContext(h.db, job(h.db, "answer"));
      expect(context.pendingQuestion).toBeNull();
      if (mode !== "other_speaker") expect(context.history.filter(entry => entry.role === "assistant")).toEqual([]);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["other_group", "unsent", "sent_later"])("rejects an advice basis that refers to %s history", async mode => {
    let source = "";
    const h = setup(async input => {
      const raw = adviceDecision(input);
      if (input.sourceEventId === "answer") raw.advice.basisSourceEventIds.push(source);
      return raw;
    });
    try {
      h.service.ingestDingTalkMessage(message("consult", "先比较私密业务的方案。")); await h.service.processNaturalIntake();
      source = `outbox:${(h.db.prepare("SELECT id FROM collaboration_outbox WHERE source_event_id='conversation:consult'").get() as { id: string }).id}`;
      if (mode === "other_group") await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "给我讲讲标准版。", mode === "other_group" ? "different" : "group"));
      if (mode === "sent_later") await deliver(h.db);
      const before = taskState(h.db);
      for (let i = 0; i < 3; i++) await h.service.processNaturalIntake();
      expect(job(h.db, "answer").status).toBe("failed");
      expect(reply(h.db, "answer")).toContain("停止自动重试");
      expect(reply(h.db, "answer")).not.toContain("轻量版"); expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["plain", "wi", "reply"])("keeps %s advice about an existing task separate from its requirements", async mode => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : adviceDecision(input, input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "调整登录提示。")); await h.service.processNaturalIntake();
      const target = item(h.db, "new")!, before = taskState(h.db);
      h.service.ingestDingTalkMessage({ ...message("consult", mode === "wi" ? `${target} 还有哪些方案？` : "登录提示还有哪些方案？"),
        ...(mode === "reply" ? { replyToSourceEventId: "new" } : {}) });
      await h.service.processNaturalIntake();
      expect(job(h.db, "consult")).toMatchObject({ status: "applied", target_work_item_id: target });
      expect(item(h.db, "consult")).toBeNull(); expect(taskState(h.db)).toEqual(before);
      expect(reply(h.db, "consult")).toContain("取舍"); expect(h.interpreted).toEqual(["new"]);
    } finally { h.service.close(); h.db.close(); }
  });

  it("revalidates and redacts a custom advice adapter before storing or rendering it", async () => {
    const h = setup(async input => adviceDecision(input));
    let projectCalls = 0;
    const coordinator = new ConversationIngressCoordinator(h.db, async input => ({
      sourceEventId: input.sourceEventId, intent: "advice", quote: input.text, action: "offer_advice", target: null, reply: null,
      advice: { ...adviceDecision(input).advice, summary: "需要保护 API_KEY=synthetic-private-value。" },
    }), () => { projectCalls++; });
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我几个可选方案。")); const before = taskState(h.db);
      await coordinator.processOne();
      expect(job(h.db, "consult").status).toBe("applied");
      expect(job(h.db, "consult").proposal_json).not.toContain("synthetic-private-value");
      expect(reply(h.db, "consult")).toContain("敏感信息已隐藏"); expect(reply(h.db, "consult")).not.toContain("synthetic-private-value");
      expect(projectCalls).toBe(0); expect(taskState(h.db)).toEqual(before);
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it.each(["unknown_field", "too_many_options", "claim", "forged_source"])("rejects a custom advice payload with %s without projecting a task", async mode => {
    const h = setup(async input => adviceDecision(input)); let projectCalls = 0;
    const coordinator = new ConversationIngressCoordinator(h.db, async input => {
      const advice = adviceDecision(input).advice;
      const patch = mode === "unknown_field" ? { approved: true } : mode === "too_many_options" ? { options: Array(4).fill(advice.options[0]) }
        : mode === "claim" ? { summary: "已经修改完成。" } : { basisSourceEventIds: [input.sourceEventId, "foreign"] };
      return { sourceEventId: input.sourceEventId, intent: "advice", quote: input.text, action: "offer_advice", target: null, reply: null,
        advice: { ...advice, ...patch } } as ConversationIntentDecision;
    }, () => { projectCalls++; });
    try {
      h.service.ingestDingTalkMessage(message("consult", "给我几个可选方案。")); const before = taskState(h.db);
      for (let i = 0; i < 3; i++) await coordinator.processOne();
      expect(job(h.db, "consult").status).toBe("failed"); expect(job(h.db, "consult").proposal_json).toBeNull();
      expect(reply(h.db, "consult")).not.toMatch(/轻量版|已经修改完成/u);
      expect(projectCalls).toBe(0); expect(taskState(h.db)).toEqual(before);
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it("rejects advice when its associated task changes during classification", async () => {
    const h = setup(async input => {
      if (input.sourceEventId === "new") return decision(input, "new_request");
      h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(input.candidates[0].id);
      return adviceDecision(input, input.candidates[0].id);
    });
    try {
      h.service.ingestDingTalkMessage(message("new", "调整登录提示。")); await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("consult", "再比较几个方案？"));
      for (let i = 0; i < 3; i++) await h.service.processNaturalIntake();
      expect(job(h.db, "consult").status).toBe("failed"); expect(job(h.db, "consult").proposal_json).toBeNull();
      expect(item(h.db, "consult")).toBeNull(); expect(h.interpreted).toEqual(["new"]);
      expect(reply(h.db, "consult")).not.toContain("轻量版");
    } finally { h.service.close(); h.db.close(); }
  });

  it("ignores a stopped classifier's late advice and resumes only a fresh claimed attempt", async () => {
    const h = setup(async input => adviceDecision(input));
    let resolve!: (value: ConversationIntentDecision) => void;
    const coordinator = new ConversationIngressCoordinator(h.db, () => new Promise(done => { resolve = done; }), () => { throw new Error("must not project advice"); });
    try {
      h.service.ingestDingTalkMessage(message("consult", "能否比较几个方案？")); const before = taskState(h.db);
      const running = coordinator.processOne(); coordinator.close(); await running;
      const context = readConversationContext(h.db, job(h.db, "consult"));
      resolve({ sourceEventId: context.sourceEventId, quote: context.text, intent: "advice", action: "offer_advice", target: null, reply: null,
        advice: adviceDecision(context).advice }); await Promise.resolve();
      expect(reply(h.db, "consult")).toBeNull(); expect(taskState(h.db)).toEqual(before);
      h.service.close(); const restarted = startCollaborationService(h.options);
      try {
        h.db.prepare("UPDATE collaboration_conversation_intents SET lease_until=0 WHERE status='running'").run();
        await restarted.processNaturalIntake();
        expect(job(h.db, "consult").status).toBe("applied"); expect(reply(h.db, "consult")).toContain("轻量版");
        expect(h.requests).toHaveLength(1); expect(taskState(h.db)).toEqual(before);
      } finally { restarted.close(); }
    } finally { coordinator.close(); h.service.close(); h.db.close(); }
  });

  it.each(["owner", "member", "former-owner", "unconfigured", "same-staff-other-corp"])("keeps conversation working after an approval notice for %s, including replay and restart", async person => {
    const h = setup(async input => input.sourceEventId === "new" ? decision(input, "new_request") : decision(input, "status_query", input.candidates[0].id));
    try {
      const owners = new LocalOwnerRegistry(join(h.options.dataDirectory, "collaboration", "collaboration.sqlite"));
      try {
        if (person !== "unconfigured") owners.bootstrap({ senderCorpId: "corp", senderStaffId: "product", now: Date.now() });
        if (person === "former-owner") owners.recover({ expectedGeneration: 1, senderCorpId: "corp", senderStaffId: "replacement", now: Date.now() });
      } finally { owners.close(); }
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake();
      // Keep this fixture focused on a delivered legacy notice, not other pending questions.
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE sent_at IS NULL").run(Date.now());
      const target = item(h.db, "new")!;
      const card = enqueueInboundCard(h.db, { sourceEventId: "candidate-notice", aggregateType: "plan", aggregateId: target, aggregateVersion: 1,
        now: Date.now(), card: { type: "plan_status_card", status: "candidate_ready", headline: "修改完成，需要负责人确认", workItemId: target,
          approvalRequired: true, summary: "登录提示有调整，需要负责人核对。" } });
      // Historical delivery fixture: its old candidate need not still be executable
      // for the next incoming message to safely read the delivered conversation.
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=?,delivery_sequence=1 WHERE id=?").run(Date.now(), card.id);
      h.service.close();
      const restarted = startCollaborationService(h.options);
      try {
        const input = message("query", "现在到哪了？", "group", person === "member" ? "tester" : "product");
        if (person === "same-staff-other-corp") input.sender.senderCorpId = "another-corp";
        const before = taskState(h.db);
        restarted.ingestDingTalkMessage(input);
        const context = readConversationContext(h.db, job(h.db, "query"));
        expect(context.pendingQuestion?.kind ?? null).toBe(person === "owner" ? "approval" : null);
        await restarted.processNaturalIntake(); await deliver(h.db);
        expect(job(h.db, "query").status).toBe("applied");
        expect(reply(h.db, "query")).toContain("登录提示友好一点");
        expect(reply(h.db, "query")).toContain("还需要补充信息");
        expect(reply(h.db, "query")).not.toMatch(/修改完成|WI-|candidate_ready|principal_id/u);
        expect(item(h.db, "query")).toBeNull(); expect(taskState(h.db)).toEqual(before);
        const receipts = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        restarted.ingestDingTalkMessage(input); await restarted.processNaturalIntake();
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(receipts);
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_action_tokens").get()).toEqual({ n: 0 });
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it("names the unresolved same-group topics instead of asking a context-free question", async () => {
    const h = setup(async input => input.sourceEventId === "answer"
      ? decision(input, "contribution", input.candidates[0].id) : decision(input, "new_request"));
    try {
      for (const [id, text, group] of [["other", "别群的薪资事项", "private"], ["login", "登录提示友好一点。", "group"], ["payment", "支付失败提示不清楚。", "group"]]) {
        h.service.ingestDingTalkMessage(message(id, text, group)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("answer", "对，就这样。")); await h.service.processNaturalIntake(); await deliver(h.db);
      const text = reply(h.db, "answer")!;
      expect(text).toContain("登录提示友好一点"); expect(text).toContain("支付失败提示不清楚");
      expect(text).not.toMatch(/薪资|WI-|第一个|序号|固定模板/u);
      expect(text.length).toBeLessThan(150);
      expect(item(h.db, "answer")).toBeNull(); expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["single", "compound", "discussion_and_query"])("keeps a %s progress clarification read-only despite older requirement questions, including after restart", async mode => {
    const h = setup(async input => {
      if (["login", "payment"].includes(input.sourceEventId)) return decision(input, "new_request");
      if (input.sourceEventId === "query") return mode === "single" ? decision(input, "status_query") : {
        ...decision(input, "clarify"), parts: [
          { ...decision(input, mode === "compound" ? "status_query" : "discussion_only", mode === "compound" ? input.candidates.find(candidate => candidate.title.includes("支付"))!.id : null), text: mode === "compound" ? "支付进展如何" : "前面的先只讨论", quote: mode === "compound" ? "支付进展如何" : "前面的先只讨论" },
          { ...decision(input, "status_query"), text: "现在进展怎么样？", quote: "现在进展怎么样？" },
        ],
      };
      const target = input.candidates.find(candidate => candidate.title.includes("登录"))!.id;
      return decision(input, input.sourceEventId === "answer" ? "contribution" : "status_query", target);
    });
    try {
      for (const [id, text] of [["login", "登录提示友好一点。"], ["payment", "支付失败提示不清楚。"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", mode === "single" ? "现在进展怎么样？" : `${mode === "compound" ? "支付进展如何" : "前面的先只讨论"}，现在进展怎么样？`)); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.close(); const restarted = startCollaborationService(h.options);
      try {
        restarted.ingestDingTalkMessage(message("answer", "登录那个"));
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).toBe("read_only");
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.answerExpected).not.toBe(false);
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.text).toContain("你想查看哪件事的进度");
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.text).not.toContain("不发起这项新改动");
        await restarted.processNaturalIntake(); await deliver(h.db);
        expect(job(h.db, "answer").proposal_json).toContain('"reason":"pending_read_only"');
        expect(item(h.db, "answer")).toBeNull(); expect(taskState(h.db)).toEqual(before);
        const next = message("answer-correct", "我想看登录那个的进度");
        restarted.ingestDingTalkMessage(next); await restarted.processNaturalIntake(); await deliver(h.db);
        expect(reply(h.db, "answer-correct")).toContain("还需要补充信息");
        expect(job(h.db, "answer-correct").target_work_item_id).toBe(item(h.db, "login"));
        expect(taskState(h.db)).toEqual(before);
        expect(reply(h.db, "query")).toContain("登录提示友好一点");
        const count = h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get();
        restarted.ingestDingTalkMessage(next); await restarted.processNaturalIntake();
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_outbox").get()).toEqual(count);
        expect(taskState(h.db)).toEqual(before);
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("redacts and bounds topic hints while retaining the original task titles", async () => {
    const h = setup(async input => input.sourceEventId === "query" ? decision(input, "status_query") : decision(input, "new_request"));
    try {
      for (const [id, text] of [["login", "登录提示调整"], ["payment", "支付提示调整"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake();
      }
      const title = "WI-PRIVATE api_key=synthetic_private_value 登录提示".repeat(4).slice(0, 120);
      h.db.prepare("UPDATE collaboration_work_items SET title=? WHERE id=?").run(title, item(h.db, "login"));
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "现在进展怎么样？")); await h.service.processNaturalIntake();
      const text = reply(h.db, "query")!;
      expect(text).toContain("支付提示调整"); expect(text).toContain("…");
      expect(text).not.toMatch(/WI-PRIVATE|synthetic_private_value/u); expect(text.length).toBeLessThan(150);
      expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["duplicate", "too_many"])("does not invent an exclusive choice when topic hints are %s", async mode => {
    const h = setup(async input => input.sourceEventId === "query" ? decision(input, "status_query") : decision(input, "new_request"));
    try {
      for (let index = 0; index < (mode === "duplicate" ? 2 : 4); index++) {
        h.service.ingestDingTalkMessage(message("new-" + index, mode === "duplicate" ? "调整登录错误提示。" : "独立修改事项" + index));
        await h.service.processNaturalIntake();
      }
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "现在进展怎么样？")); await h.service.processNaturalIntake();
      expect(reply(h.db, "query")).not.toContain("「");
      expect(item(h.db, "query")).toBeNull(); expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["single", "compound"].flatMap(kind => ["unsent", "sent_later", "other_speaker", "other_group", "intervening"].map(mode => [kind, mode])))("does not borrow a %s read-only question when it is %s", async (kind, mode) => {
    const h = setup(async input => {
      if (input.sourceEventId === "intervening") return decision(input, "acknowledgement");
      if (input.sourceEventId !== "query") return decision(input, "new_request");
      return kind === "single" ? decision(input, "status_query") : { ...decision(input, "clarify"), parts: [
        { ...decision(input, "status_query", input.candidates.find(candidate => candidate.title.includes("支付"))!.id), text: "支付进展如何", quote: "支付进展如何" },
        { ...decision(input, "status_query"), text: "现在进展怎么样？", quote: "现在进展怎么样？" },
      ] };
    });
    try {
      for (const id of ["login", "payment"]) {
        h.service.ingestDingTalkMessage(message(id, id === "login" ? "登录提示友好一点。" : "支付提示友好一点。"));
        await h.service.processNaturalIntake(); await deliver(h.db);
      }
      h.service.ingestDingTalkMessage(message("query", kind === "single" ? "现在进展怎么样？" : "支付进展如何，现在进展怎么样？")); await h.service.processNaturalIntake();
      if (["other_speaker", "other_group", "intervening"].includes(mode)) await deliver(h.db);
      if (mode === "intervening") {
        h.service.ingestDingTalkMessage(message("intervening", "不用查了，谢谢")); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      h.service.ingestDingTalkMessage(message("answer", "登录那个", mode === "other_group" ? "different" : "group", mode === "other_speaker" ? "tester" : "product"));
      if (mode === "sent_later") await deliver(h.db);
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).not.toBe("read_only");
      expect(item(h.db, "answer")).toBeNull();
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not treat a clipped compound question as delivered evidence or permit its short answer to modify work", async () => {
    const h = setup(async input => {
      if (input.sourceEventId === "answer") return decision(input, "contribution", input.candidates[0].id);
      if (input.sourceEventId !== "query") return decision(input, "new_request");
      return { ...decision(input, "clarify"), parts: [
        { ...decision(input, "status_query", input.candidates[0].id), text: "登录进展如何", quote: "登录进展如何" },
        { ...decision(input, "status_query"), text: "还有那个呢", quote: "还有那个呢" },
      ] };
    });
    try {
      h.service.ingestDingTalkMessage(message("login", "登录提示调整")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进展如何，还有那个呢")); await h.service.processNaturalIntake();
      // Simulate a delivered legacy/overlong combined presentation. Keep the
      // persisted branch question intact, but outside the actual visible text.
      const row = z.object({ id: z.string(), payload_json: z.string() }).parse(h.db.prepare("SELECT id,payload_json FROM collaboration_outbox WHERE source_event_id='conversation:query'").get());
      const card = JSON.parse(row.payload_json); card.summary = "背景说明".repeat(300) + card.summary;
      h.db.prepare("UPDATE collaboration_outbox SET payload_json=?,delivery_state='sent',sent_at=?,delivery_sequence=(SELECT COALESCE(MAX(delivery_sequence),0)+1 FROM collaboration_outbox) WHERE id=?")
        .run(JSON.stringify(card), Date.now(), row.id);
      expect(z.object({ text: z.string() }).parse(renderDingTalkSessionMessage(card).markdown).text).not.toContain("你想查看");
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("answer", "登录那个"));
      const context = readConversationContext(h.db, job(h.db, "answer"));
      expect(context.pendingQuestion?.sourceEventId).not.toBe(`outbox:${row.id}`);
      expect(context.contextTruncated).toBe(true);
      await h.service.processNaturalIntake();
      expect(item(h.db, "answer")).toBeNull(); expect(taskState(h.db)).toEqual(before);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each(["stale", "moved_group"])("omits topic hints if a candidate becomes %s during classification", async mode => {
    const h = setup(async input => {
      if (input.sourceEventId !== "query") return decision(input, "new_request");
      const target = input.candidates.find(candidate => candidate.title.includes("登录"))!.id;
      if (mode === "stale") h.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(target);
      else h.db.prepare("UPDATE collaboration_work_items SET conversation_id=(SELECT conversation_id FROM collaboration_work_items WHERE title='别群问题') WHERE id=?").run(target);
      return decision(input, "status_query");
    });
    try {
      for (const [id, text, group] of [["other", "别群问题", "private"], ["login", "登录提示", "group"], ["payment", "支付提示", "group"]]) {
        h.service.ingestDingTalkMessage(message(id, text, group)); await h.service.processNaturalIntake();
      }
      h.service.ingestDingTalkMessage(message("query", "现在进展怎么样？")); await h.service.processNaturalIntake();
      expect(reply(h.db, "query")).not.toMatch(/登录|支付|别群|「/u);
      expect(item(h.db, "query")).toBeNull();
    } finally { h.service.close(); h.db.close(); }
  });

  it("keeps status replies brief without changing the full requirement or its source", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "status_query", input.sourceEventId === "new" ? null : input.candidates[0].id));
    const text = "登录失败后保留用户名、清空密码。账号不存在或密码错误，都提示“账号或密码不正确”；网络断开则提示“网络异常，请稍后重试”。";
    try {
      h.service.ingestDingTalkMessage(message("new", text)); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录现在进展怎么样？")); await h.service.processNaturalIntake(); await deliver(h.db);
      const response = reply(h.db, "query")!;
      expect(response).toContain("登录失败后保留用户名、清空密码…");
      expect(response).not.toContain("账号不存在或密码错误");
      expect(response.length).toBeLessThan(90);
      expect(response).toContain("还需要补充信息");
      expect(taskState(h.db)).toEqual(before);
      expect(h.db.prepare("SELECT title FROM collaboration_work_items").get()).toEqual({ title: text });
    } finally { h.service.close(); h.db.close(); }
  });

  it("bounds an unpunctuated status label after redaction, while keeping actual progress authoritative", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("new", "改进登录错误提示")); await h.service.processNaturalIntake();
      const target = item(h.db, "new")!;
      h.db.prepare("UPDATE collaboration_work_items SET title=?,control_state='paused' WHERE id=?")
        .run("WI-PRIVATE api_key=synthetic_private_value 登录错误提示".repeat(4), target);
      const response = conversationStatus(h.db, target);
      expect(response).not.toMatch(/WI-PRIVATE|synthetic_private_value/u);
      expect(response).toContain("已暂停");
      expect(response).toContain("…");
      expect(response.length).toBeLessThan(90);
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not consume an unresolved requirement question when its addressee asks for progress", async () => {
    const h = setup(async input => decision(input, input.sourceEventId === "new" ? "new_request" : "status_query", input.sourceEventId === "new" ? null : input.candidates[0].id));
    try {
      h.service.ingestDingTalkMessage(message("new", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("query", "登录进度怎么样了？")); await h.service.processNaturalIntake(); await deliver(h.db);
      const before = taskState(h.db);
      h.service.close();
      const restarted = startCollaborationService(h.options);
      try {
        restarted.ingestDingTalkMessage(message("answer", "对，就是这样。"));
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion).toMatchObject({ kind: "requirement", workItemIds: [item(h.db, "new")] });
        expect(taskState(h.db)).toEqual(before);
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });

  it("retains both unanswered topics when the same participant introduces an independent question", async () => {
    const h = setup(async input => decision(input, "new_request"));
    try {
      h.service.ingestDingTalkMessage(message("login", "登录提示友好一点。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("payment", "另一个独立问题，支付提示也要改。")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "就这样。"));
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion).toMatchObject({ kind: "association",
        workItemIds: expect.arrayContaining([item(h.db, "login"), item(h.db, "payment")]) });
    } finally { h.service.close(); h.db.close(); }
  });
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
      stripCandidateRevisionSchema(h.db);
      h.db.exec("DROP TABLE IF EXISTS collaboration_candidate_result_deliveries; DROP TABLE IF EXISTS collaboration_candidate_result_bindings; DROP TABLE IF EXISTS collaboration_candidate_recheck_attempts; DROP TABLE collaboration_approval_presentations; DROP TABLE collaboration_conversation_intents; DELETE FROM collaboration_schema_migrations WHERE version>=36; PRAGMA user_version=35");
      expect(applyCollaborationMigrations(h.db)).toEqual({ schemaVersion: COLLABORATION_SCHEMA_VERSION, appliedMigrations: COLLABORATION_SCHEMA_VERSION });
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
