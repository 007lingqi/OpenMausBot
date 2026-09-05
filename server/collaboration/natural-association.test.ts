import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import type { NaturalAssociationRequest } from "./natural-association.ts";
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
