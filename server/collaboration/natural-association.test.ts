import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { NaturalAssociationCoordinator, type NaturalAssociationRequest } from "./natural-association.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }); });
function message(id: string, text: string) { return { sourceEventId: id, transportMessageId: id, conversationId: "group", addressedToBot: true,
  text, sender: { senderId: "tester", senderCorpId: "corp", senderStaffId: "tester", displayName: "测试同事" }, receivedAt: Date.now() }; }
function setup(associate: (request: NaturalAssociationRequest) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "natural-association-")); paths.push(directory);
  const options = { dataDirectory: directory, planning: { planner: { propose: validProposal }, policy,
    naturalIntake: { associate, async interpret(request: import("./natural-intake.ts").NaturalIntakeRequest) {
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, acceptance: [], answers: [], questions: [] };
    } } } };
  return { service: startCollaborationService(options), options,
    db: new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite")) };
}
describe("natural group association before requirement interpretation", () => {
  it.each(["foreign", "unassigned", "cancelled", "accepted"])("keeps a quoted reply unresolved when its late parent is %s", async mode => {
    let calls = 0;
    const h = setup(async () => { calls++; throw new Error("must not guess the quoted context"); });
    try {
      const target = h.service.ingestDingTalkMessage(message("first", "登录失败提示"));
      h.service.ingestDingTalkMessage({ ...message("child", "就是这个意思"), replyToSourceEventId: "parent" });
      for (let i=0;i<3;i++) await h.service.processNaturalIntake();
      if (mode === "foreign") h.service.ingestDingTalkMessage({ ...message("parent", "新任务：导出失败"), conversationId: "another-group" });
      else if (mode === "unassigned") h.service.ingestDingTalkMessage({ ...message("parent", "这个也一样"), replyToSourceEventId: "child" });
      else {
        h.service.ingestDingTalkMessage({ ...message("parent", "网络错误时"), replyToSourceEventId: "first" });
        h.db.prepare("UPDATE collaboration_work_items SET status=? WHERE id=?").run(mode, target.workItemId!);
      }
      for (let i=0;i<6;i++) await h.service.processNaturalIntake();
      expect(calls).toBe(0);
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='child'").get()).toEqual({ work_item_id: null });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events e JOIN collaboration_external_events x ON x.id=e.external_event_id WHERE x.source_event_id='child'").get()).toEqual({ n: 0 });
    } finally { h.service.close(); h.db.close(); }
  });
  it("does not let the model guess an unknown quoted message and follows a late known parent after restart", async () => {
    let calls = 0;
    const h = setup(async request => { calls++; return { version: 1, sourceEventId: request.sourceEventId, decision: "associate",
      workItemId: request.candidates[0].id, quote: request.text, confidence: "high" }; });
    try {
      const first = h.service.ingestDingTalkMessage(message("first", "登录错误显示原因"));
      h.service.ingestDingTalkMessage({ ...message("reply", "补充：超时也显示"), replyToSourceEventId: "late-parent" });
      for (let i=0;i<3;i++) await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='reply'").get()).toEqual({ work_item_id: null });
      expect(calls).toBe(0);
      h.service.ingestDingTalkMessage({ ...message("late-parent", "补充：网络错误"), replyToSourceEventId: "first" });
      h.service.close();
      const restarted = startCollaborationService(h.options);
      try {
        for (let i=0;i<5;i++) await restarted.processNaturalIntake();
        expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='reply'").get()).toEqual({ work_item_id: first.workItemId });
        expect(calls).toBe(0);
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events e JOIN collaboration_external_events x ON x.id=e.external_event_id WHERE x.source_event_id='reply'").get()).toEqual({ n: 1 });
        const proof = h.db.prepare("SELECT proposal_json FROM collaboration_natural_association_jobs j JOIN collaboration_external_events e ON e.id=j.event_id WHERE e.source_event_id='reply'").get() as { proposal_json: string };
        expect(JSON.parse(proof.proposal_json)).toMatchObject({ replySourceEventId: "late-parent", workItemId: first.workItemId });
        expect(restarted.ingestDingTalkMessage({ ...message("reply", "改写重放不能改变原引用"), replyToSourceEventId: "first" }).duplicate).toBe(true);
        for (let i=0;i<3;i++) await restarted.processNaturalIntake();
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events e JOIN collaboration_external_events x ON x.id=e.external_event_id WHERE x.source_event_id='reply'").get()).toEqual({ n: 1 });
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it.each(["unsent", "other_person", "other_group", "expired", "multiple", "closed", "out_of_range", "intervening_question", "quoted_other"] as const)("does not apply an ungrounded ordinal: %s", async (mode) => {
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "clarify", workItemId: null, quote: request.text, confidence: "uncertain" }));
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败提示不准确"));
      h.service.ingestDingTalkMessage(message("second", "新任务：导出日期不准确"));
      const original = h.service.ingestDingTalkMessage(message("which", "错误时也要显示处理建议"));
      await h.service.processNaturalIntake();
      if (mode === "multiple") {
        h.service.ingestDingTalkMessage(message("which-again", "还需要核对日期"));
        await h.service.processNaturalIntake();
      }
      if (mode !== "unsent") {
        const lease = new InstanceLeaseCoordinator(h.db, "fixture").acquire(Date.now(), 120000)!;
        const dispatcher = new OutboxDispatcher(h.db, { async deliver() { return { outcome: "sent" as const }; } },
          { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
        for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
      }
      if (mode === "closed" && original.card.type === "association_choice_card") h.db.prepare("UPDATE collaboration_work_items SET status='cancelled' WHERE id=?").run(original.card.candidateWorkItems[1].id);
      if (mode === "intervening_question" && original.card.type === "association_choice_card") {
        await new Promise(resolve => setTimeout(resolve, 5));
        const { enqueueInboundCard } = await import("./outbox.ts");
        enqueueInboundCard(h.db, { sourceEventId: "new-question", aggregateType: "work_item", aggregateId: original.card.candidateWorkItems[0].id,
          aggregateVersion: 1, now: Date.now(), card: { type: "clarification_card", headline: "需要澄清", workItemId: original.card.candidateWorkItems[0].id,
            snapshotRevision: 1, questions: [{ id: "other", title: "另一个选择", question: "先处理登录还是导出？", recommendedAnswer: "请说明" }] } });
        const lease = new InstanceLeaseCoordinator(h.db, "fixture").acquire(Date.now(), 120000)!;
        const dispatcher = new OutboxDispatcher(h.db, { async deliver() { return { outcome: "sent" as const }; } },
          { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
        await dispatcher.dispatchOne(lease, Date.now());
      }
      const selection = { ...message("choice", mode === "out_of_range" ? "第三个" : "第二个"),
        ...(mode === "quoted_other" ? { replyToSourceEventId: "another-bot-question" } : {}) };
      if (mode === "other_person") selection.sender = { ...selection.sender, senderStaffId: "other", senderId: "other" };
      if (mode === "other_group") {
        selection.conversationId = "other-group";
        h.service.ingestDingTalkMessage({ ...message("foreign", "另一个群的任务"), conversationId: "other-group" });
      }
      if (mode === "expired") selection.receivedAt += 31 * 60_000;
      h.service.ingestDingTalkMessage(selection);
      for (let i=0;i<4;i++) await h.service.processNaturalIntake();
      for (const source of ["which", "choice"]) expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id=?").get(source)).toEqual({ work_item_id: null });
    } finally { h.service.close(); h.db.close(); }
  });
  it("resolves the actually delivered second choice and the original message after restart without model guessing", async () => {
    let calls = 0;
    const h = setup(async request => { calls++; return { version: 1, sourceEventId: request.sourceEventId, decision: "clarify", workItemId: null,
      quote: request.text, confidence: "uncertain" }; });
    const first = h.service.ingestDingTalkMessage(message("first", "登录失败提示不准确"));
    const second = h.service.ingestDingTalkMessage(message("second", "新任务：导出日期不准确"));
    // Finish earlier requirement questions before asking the attribution question.
    // Otherwise "second" is genuinely ambiguous, as covered by intervening_question.
    for (let i=0;i<4;i++) await h.service.processNaturalIntake();
    const lease = new InstanceLeaseCoordinator(h.db, "fixture").acquire(Date.now(), 120000)!;
    const dispatcher = new OutboxDispatcher(h.db, { async deliver() { return { outcome: "sent" as const }; } },
      { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
    // Deliver the earlier questions first, not merely generate them. Millisecond ties in
    // queued creation times must not turn this positive scenario into an intervening question.
    for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
    const original = h.service.ingestDingTalkMessage(message("which", "错误时也要显示处理建议"));
    await h.service.processNaturalIntake();
    const card = original.card;
    if (card.type !== "association_choice_card") throw new Error("expected choices");
    const chosen = card.candidateWorkItems[1].id;
    expect([first.workItemId, second.workItemId]).toContain(chosen);
    for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
    expect(h.db.prepare("SELECT id FROM collaboration_outbox WHERE sent_at IS NOT NULL AND kind IN ('association_choice_card','clarification_card') ORDER BY delivery_sequence DESC LIMIT 1").get()).toEqual({ id: original.outboxId });
    // Recency and ordering change after the actual question was sent.
    h.db.prepare("UPDATE collaboration_work_items SET updated_at=? WHERE id=?").run(Date.now()+1000, chosen);
    h.service.close();
    const restarted = startCollaborationService(h.options);
    try {
      const selection = message("choice", "第二个");
      restarted.ingestDingTalkMessage(selection);
      const callsBeforeChoice = calls;
      for (let i=0;i<5;i++) await restarted.processNaturalIntake();
      expect(calls).toBe(callsBeforeChoice);
      for (const source of ["which", "choice"]) expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id=?").get(source))
        .toEqual({ work_item_id: chosen });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events e JOIN collaboration_external_events x ON x.id=e.external_event_id WHERE x.source_event_id='which'").get()).toEqual({ n: 1 });
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs j JOIN collaboration_external_events e ON e.id=j.event_id WHERE e.source_event_id='which'").get()).toEqual({ status: "projected" });
      expect(h.db.prepare("SELECT source_event_id FROM collaboration_natural_intake_jobs WHERE source_event_id IN ('which','choice') ORDER BY source_event_id").all())
        .toEqual([{ source_event_id: "choice" }, { source_event_id: "which" }]);
      expect(() => h.db.prepare("UPDATE collaboration_sent_association_choices SET payload_json='{}'").run()).toThrow("immutable");
      const before = h.db.prepare("SELECT version FROM collaboration_work_items WHERE id=?").get(chosen);
      restarted.ingestDingTalkMessage(selection);
      await restarted.processNaturalIntake();
      expect(h.db.prepare("SELECT version FROM collaboration_work_items WHERE id=?").get(chosen)).toEqual(before);
    } finally { restarted.close(); h.db.close(); }
  });
  it("does not use a prompt whose delivery was confirmed only after the selection arrived", async () => {
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "clarify", workItemId: null, quote: request.text, confidence: "uncertain" }));
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败提示"));
      h.service.ingestDingTalkMessage(message("second", "新任务：导出失败"));
      h.service.ingestDingTalkMessage(message("which", "需要说明处理方式"));
      await h.service.processNaturalIntake();
      const lease = new InstanceLeaseCoordinator(h.db, "fixture").acquire(Date.now(), 120000)!;
      const dispatcher = new OutboxDispatcher(h.db, { async deliver(input) {
        if (input.kind === "association_choice_card") {
          h.service.ingestDingTalkMessage(message("early-choice", "第二个"));
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        return { outcome: "sent" as const };
      } }, { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 1000 });
      for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
      for (let i=0;i<4;i++) await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='early-choice'").get()).toEqual({ work_item_id: null });
    } finally { h.service.close(); h.db.close(); }
  });
  it("bounds projection failures across restarts and durably reports the interruption once", async () => {
    const associate = async (request: NaturalAssociationRequest) => ({ version: 1, sourceEventId: request.sourceEventId,
      decision: "associate", workItemId: request.candidates[0].id, quote: request.text, confidence: "high" });
    const h = setup(associate);
    let calls = 0;
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("answer", "就是这个意思"));
      for (let i = 0; i < 5; i++) {
        const coordinator = new NaturalAssociationCoordinator(h.db, associate, () => { calls++; throw new Error("secret-provider-detail"); });
        await expect(coordinator.processOne()).resolves.toBeUndefined();
        coordinator.close();
      }
      expect(calls).toBe(3);
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs").get()).toEqual({ status: "failed" });
      const notices = h.service.pendingOutbox().filter(row => row.sourceEventId === "natural-projection-failed:answer");
      expect(notices).toHaveLength(1);
      expect(JSON.stringify(notices[0].card)).toContain("这条补充已保存");
      expect(JSON.stringify(notices)).not.toContain("secret-provider-detail");
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("resumes a routed projection without repeating the association or contribution", async () => {
    let modelCalls = 0;
    const associate = async (request: NaturalAssociationRequest) => { modelCalls++; return { version: 1, sourceEventId: request.sourceEventId,
      decision: "associate", workItemId: request.candidates[0].id, quote: request.text, confidence: "high" }; };
    const h = setup(associate);
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("answer", "就是这个意思"));
      const broken = new NaturalAssociationCoordinator(h.db, associate, () => { throw new Error("temporary"); });
      await broken.processOne(); broken.close();
      const recovered = new NaturalAssociationCoordinator(h.db, associate, () => {});
      await recovered.processOne(); await recovered.processOne(); recovered.close();
      expect(modelCalls).toBe(1);
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs").get()).toEqual({ status: "projected" });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("waits for a live projection lease and recovers the final crashed attempt without executing again", async () => {
    const associate = async (request: NaturalAssociationRequest) => ({ version: 1, sourceEventId: request.sourceEventId,
      decision: "associate", workItemId: request.candidates[0].id, quote: request.text, confidence: "high" });
    const h = setup(associate);
    let calls = 0;
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("answer", "就是这个意思"));
      const coordinator = new NaturalAssociationCoordinator(h.db, associate, () => { calls++; throw new Error("temporary"); });
      await coordinator.processOne(1000);
      h.db.prepare("UPDATE collaboration_natural_association_jobs SET projection_attempts=3,claim_token='crashed',lease_until=2000").run();
      await coordinator.processOne(1999);
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs").get()).toEqual({ status: "routed" });
      await coordinator.processOne(2000); await coordinator.processOne(2001);
      expect(calls).toBe(1);
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs").get()).toEqual({ status: "failed" });
      expect(h.service.pendingOutbox().filter(row => row.sourceEventId === "natural-projection-failed:answer")).toHaveLength(1);
      coordinator.close();
    } finally { h.service.close(); h.db.close(); }
  });
  it("links an ordinary contextual answer without WI or reply metadata and preserves the original contribution", async () => {
    let calls = 0;
    const h = setup(async request => { calls++; expect(request.candidates[0].questions).not.toHaveLength(0); return { version: 1, sourceEventId: request.sourceEventId,
      decision: "associate", workItemId: request.candidates[0].id, quote: request.text, confidence: "high" }; });
    try {
      const first = h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      await h.service.processNaturalIntake();
      h.service.ingestDingTalkMessage(message("answer", "就是这个意思"));
      await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT work_item_id, association_state FROM collaboration_external_events WHERE source_event_id='answer'").get())
        .toEqual({ work_item_id: first.workItemId, association_state: "associated" });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 1 });
      h.service.ingestDingTalkMessage(message("answer", "更改重放内容"));
      await h.service.processNaturalIntake();
      expect(calls).toBe(1);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_item_events").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("creates a distinct task for a natural topic change and recovers a queued decision after restart", async () => {
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "create", workItemId: null,
      quote: request.text, confidence: "high" }));
    h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
    h.service.ingestDingTalkMessage(message("other", "导出的报表日期不正确"));
    h.service.close();
    const restarted = startCollaborationService(h.options);
    try {
      await restarted.processNaturalIntake();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 2 });
      expect(h.db.prepare("SELECT association_state FROM collaboration_external_events WHERE source_event_id='other'").get())
        .toEqual({ association_state: "created" });
    } finally { restarted.close(); h.db.close(); }
  });

  it("cannot route across conversations or grant Owner permissions", async () => {
    let calls = 0;
    const h = setup(async request => { calls++; return { version: 1, sourceEventId: request.sourceEventId, decision: "associate",
      workItemId: "WI-FOREIGN", quote: request.text, confidence: "high", ownerId: "attacker" }; });
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("ambiguous", "就是这个意思"));
      for (let i = 0; i < 4; i++) await h.service.processNaturalIntake();
      expect(calls).toBe(3);
      expect(h.service.ownerBinding()).toBeNull();
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='ambiguous'").get()).toEqual({ work_item_id: null });
    } finally { h.service.close(); h.db.close(); }
  });

  it("rejects an out-of-conversation target even when the proposal otherwise matches the schema", async () => {
    let foreignId: string | null = null;
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "associate",
      workItemId: foreignId, quote: request.text, confidence: "high" }));
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      foreignId = h.service.ingestDingTalkMessage({ ...message("foreign", "支付错误"), conversationId: "other-group" }).workItemId;
      h.service.ingestDingTalkMessage(message("ambiguous", "就是这个意思"));
      await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='ambiguous'").get()).toEqual({ work_item_id: null });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not guess an ordinal against recency order without the original displayed choices", async () => {
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "associate",
      workItemId: request.candidates[0].id, quote: request.text, confidence: "high" }));
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("ordinal", "第二个"));
      await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='ordinal'").get()).toEqual({ work_item_id: null });
      expect(h.db.prepare("SELECT status FROM collaboration_natural_association_jobs").get()).toEqual({ status: "clarify" });
    } finally { h.service.close(); h.db.close(); }
  });

  it("does not let old continuation keywords preempt a semantic topic-change decision", async () => {
    const h = setup(async request => ({ version: 1, sourceEventId: request.sourceEventId, decision: "create", workItemId: null,
      quote: request.text, confidence: "high" }));
    try {
      h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("supplement", "补充一个导出报表日期不对的问题"));
      await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 2 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("can route a clear new issue in a busy group using current task summaries and a bounded recent window", async () => {
    const h = setup(async request => {
      expect(request.historyWindowLimited).toBe(true);
      expect(request.history.length).toBeLessThanOrEqual(12);
      return { version: 1, sourceEventId: request.sourceEventId, decision: "create", workItemId: null, quote: request.text, confidence: "high" };
    });
    try {
      for (let i = 0; i < 13; i++) h.service.ingestDingTalkMessage(message(`prior-${i}`, `新任务：历史事项 ${i}`));
      h.service.ingestDingTalkMessage(message("fresh", "导出的报表日期不正确"));
      await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 14 });
    } finally { h.service.close(); h.db.close(); }
  });

  it("rejects a routing decision when a background Spec revision changes the candidate while the model waits", async () => {
    let release!: (value: unknown) => void;
    let request!: NaturalAssociationRequest;
    const h = setup(input => { request = input; return new Promise(resolve => { release = resolve; }); });
    try {
      const first = h.service.ingestDingTalkMessage(message("first", "登录失败时说明原因"));
      h.service.ingestDingTalkMessage(message("ambiguous", "就是这个意思"));
      const pending = h.service.processNaturalIntake();
      h.service.reviseWorkItemDefinition(first.workItemId!, { goal: "改为处理退出登录", goalConfirmed: false });
      release({ version: 1, sourceEventId: request.sourceEventId, decision: "associate", workItemId: first.workItemId,
        quote: request.text, confidence: "high" });
      await pending;
      expect(h.db.prepare("SELECT work_item_id FROM collaboration_external_events WHERE source_event_id='ambiguous'").get()).toEqual({ work_item_id: null });
    } finally { h.service.close(); h.db.close(); }
  });
});
