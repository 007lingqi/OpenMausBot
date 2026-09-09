import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startCollaborationService } from "./service.ts";
import { ModelNaturalIntakeInterpreter } from "./natural-intake.ts";
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

const paths: string[] = [];
function stripCandidateRevisionSchema(database: DatabaseSync): void {
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

  it("keeps a direct progress clarification read-only despite older requirement questions, including after restart", async () => {
    const h = setup(async input => {
      if (["login", "payment"].includes(input.sourceEventId)) return decision(input, "new_request");
      if (input.sourceEventId === "query") return decision(input, "status_query");
      const target = input.candidates.find(candidate => candidate.title.includes("登录"))!.id;
      return decision(input, input.sourceEventId === "answer" ? "contribution" : "status_query", target);
    });
    try {
      for (const [id, text] of [["login", "登录提示友好一点。"], ["payment", "支付失败提示不清楚。"]]) {
        h.service.ingestDingTalkMessage(message(id, text)); await h.service.processNaturalIntake(); await deliver(h.db);
      }
      const before = taskState(h.db);
      h.service.ingestDingTalkMessage(message("query", "现在进展怎么样？")); await h.service.processNaturalIntake(); await deliver(h.db);
      h.service.close(); const restarted = startCollaborationService(h.options);
      try {
        restarted.ingestDingTalkMessage(message("answer", "登录那个"));
        expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).toBe("read_only");
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

  it.each(["unsent", "sent_later", "other_speaker", "other_group"])("does not borrow a direct read-only question when it is %s", async mode => {
    const h = setup(async input => input.sourceEventId === "query" ? decision(input, "status_query") : decision(input, "new_request"));
    try {
      for (const id of ["login", "payment"]) {
        h.service.ingestDingTalkMessage(message(id, id === "login" ? "登录提示友好一点。" : "支付提示友好一点。"));
        await h.service.processNaturalIntake(); await deliver(h.db);
      }
      h.service.ingestDingTalkMessage(message("query", "现在进展怎么样？")); await h.service.processNaturalIntake();
      if (["other_speaker", "other_group"].includes(mode)) await deliver(h.db);
      h.service.ingestDingTalkMessage(message("answer", "登录那个", mode === "other_group" ? "different" : "group", mode === "other_speaker" ? "tester" : "product"));
      if (mode === "sent_later") await deliver(h.db);
      expect(readConversationContext(h.db, job(h.db, "answer")).pendingQuestion?.kind).not.toBe("read_only");
      expect(item(h.db, "answer")).toBeNull();
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
