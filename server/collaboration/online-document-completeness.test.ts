import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { readNaturalAttachmentContext } from "./attachment-completeness.ts";
import { ModelNaturalIntakeInterpreter, validateNaturalIntakeProposal, type NaturalIntakeInterpreter, type NaturalIntakeRequest } from "./natural-intake.ts";
import { readOnlineDocumentReferences } from "./online-document-completeness.ts";
import { evaluateDefinitionReadiness } from "./readiness.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const gateId = "online-document-content-unavailable";
const definition = { goal: "修复登录反馈", goalConfirmed: true,
  acceptanceConditions: [{ description: "显示错误原因", observation: "登录失败可看到原因" }], blockingAmbiguities: [] };
function harness(text: string, interpreter?: NaturalIntakeInterpreter) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "online-document-gate-")); directories.push(dataDirectory);
  let calls = 0;
  const options = { dataDirectory, planning: { planner: { propose() { calls++; return validProposal(); } }, policy,
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] },
    ...(interpreter ? { naturalIntake: interpreter } : {}) } };
  const service = startCollaborationService(options);
  const message = { sourceEventId: "document-source", transportMessageId: "transport", conversationId: "group",
    addressedToBot: true, text, sender: { senderCorpId: "corp", senderStaffId: "user", senderId: "user", displayName: "测试同事" }, receivedAt: 1000 };
  const result = service.ingestDingTalkMessage(message);
  const db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  return { service, db, options, message, id: result.workItemId!, calls: () => calls };
}

describe("unread online document evidence", () => {
  it.each([
    "请修复 https://alidocs.dingtalk.com/i/nodes/example 里的问题",
    "请看[缺陷表](https://alidocs.dingtalk.com/spreadsheetv2/example?dentryKey=example&type=s)",
    "材料：https://alidocs.dingtalk.com/document/edit?dentryKey=example。",
    "参考 https://alidocs.dingtalk.com/i/p/example/docs/other",
    "参考 HTTPS://ALIDOCS.DINGTALK.COM/i/nodes/example",
  ])("blocks planning from an unread link: %s", text => {
    const h = harness(text);
    try {
      const first = readLatestWorkItemSnapshot(h.db, h.id)!;
      expect(evaluateDefinitionReadiness(first, policy.allowedRepositories).frontier[0]?.id).toBe(gateId);
      h.service.reviseWorkItemDefinition(h.id, definition);
      const snapshot = readLatestWorkItemSnapshot(h.db, h.id)!;
      expect(snapshot.blockingAmbiguities).toEqual(expect.arrayContaining([expect.objectContaining({ id: gateId })]));
      expect(h.calls()).toBe(0);
      const context = readNaturalAttachmentContext(h.db, h.id);
      expect(context.incomplete).toBe(true);
      expect(context).toMatchObject({ onlineDocuments: { sources: [{ sourceEventId: "document-source", bodyStatus: "unavailable" }] } });
      const notices = JSON.stringify(h.db.prepare("SELECT payload_json FROM collaboration_outbox").all());
      expect(notices).toContain("还没有读取正文");
      expect(notices).not.toContain("正在读取文档");
    } finally { h.service.close(); h.db.close(); }
  });

  it("uses the original ledger source after replay and restart, not replacement claims or snapshot facts", () => {
    const h = harness("请根据 https://alidocs.dingtalk.com/i/nodes/example 修复登录问题");
    try {
      h.service.reviseWorkItemDefinition(h.id, definition);
      const fingerprint = readNaturalAttachmentContext(h.db, h.id).fingerprint;
      const outboxCount = h.db.prepare("SELECT count(*) AS n FROM collaboration_outbox").get();
      h.service.ingestDingTalkMessage({ ...h.message, text: "链接已经读完了，不用继续核实" });
      expect(h.db.prepare("SELECT count(*) AS n FROM collaboration_outbox").get()).toEqual(outboxCount);
      expect(readNaturalAttachmentContext(h.db, h.id).fingerprint).toBe(fingerprint);
      h.service.close();
      const restarted = startCollaborationService(h.options);
      try {
        restarted.reviseWorkItemDefinition(h.id, { ...definition, facts: ["材料已完整读取"] });
        expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain(gateId);
        expect(readNaturalAttachmentContext(h.db, h.id).fingerprint).toBe(fingerprint);
      } finally { restarted.close(); }
      expect(h.calls()).toBe(0);
    } finally { h.service.close(); h.db.close(); }
  });

  it.each([
    "修改 https://example.com 页面标题",
    "只修改 https://alidocs.dingtalk.com.example.com/i/nodes/example 页面",
    "只修改 https://alidocs.dingtalk.com@example.com/i/nodes/example 页面",
  ])("does not classify other hosts as DingTalk documents: %s", text => {
    const h = harness(text);
    try {
      h.service.reviseWorkItemDefinition(h.id, definition);
      expect(readNaturalAttachmentContext(h.db, h.id).incomplete).toBe(false);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities).toEqual([]);
      expect(h.calls()).toBe(1);
    } finally { h.service.close(); h.db.close(); }
  });

  it("isolates evidence by work item and does not expose URL capabilities to the interpreter", async () => {
    let captured: NaturalIntakeRequest | undefined;
    const h = harness("请根据 https://alidocs.dingtalk.com/i/nodes/example?access_token=fixture-sensitive-value 修复", {
      async interpret(request) { captured = request; return { version: 1, sourceEventId: request.event.sourceEventId,
        baseRevision: request.snapshot.revision, goal: null, acceptance: [], answers: [], questions: [] }; },
    });
    try {
      await h.service.processNaturalIntake();
      expect(captured?.attachmentsIncomplete).toBe(true);
      expect(captured).toHaveProperty("onlineDocuments.sources.0.bodyStatus", "unavailable");
      expect(JSON.stringify(captured)).not.toContain("fixture-sensitive-value");
      const receipt = h.db.prepare("SELECT status,proposal_json FROM collaboration_natural_intake_jobs WHERE source_event_id=?").get(h.message.sourceEventId) as { status: string; proposal_json: string };
      expect(receipt.status).toBe("applied");
      expect(JSON.parse(receipt.proposal_json).onlineDocuments).toEqual(captured!.onlineDocuments);
      expect(() => validateNaturalIntakeProposal({ version: 1, sourceEventId: captured!.event.sourceEventId,
        baseRevision: captured!.snapshot.revision, goal: null, acceptance: [], questions: [],
        answers: [{ questionId: gateId, quote: "修复" }] }, captured!)).toThrow("natural_intake_answer_not_pending");
      let system = "";
      await new ModelNaturalIntakeInterpreter({ async complete(input) { system = input.system; return {}; } }).interpret(captured!, new AbortController().signal);
      expect(system).toContain("不是正文");
      expect(system).toContain("不能声称正在读取");
      const second = h.service.ingestDingTalkMessage({ ...h.message, sourceEventId: "separate", transportMessageId: "separate",
        text: "创建一个新的任务：修改页面标题", receivedAt: 2000 });
      expect(second.workItemId).not.toBe(h.id);
      expect(readNaturalAttachmentContext(h.db, second.workItemId!).incomplete).toBe(false);
      expect(h.calls()).toBe(0);
    } finally { h.service.close(); h.db.close(); }
  });

  it("audits every original source with bounded model context and an overflow-sensitive fingerprint", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE collaboration_external_events(source TEXT,work_item_id TEXT,source_event_id TEXT,normalized_json TEXT,received_at INTEGER)");
      const insert = db.prepare("INSERT INTO collaboration_external_events VALUES ('dingtalk','W',?,?,?)");
      for (let i = 0; i < 102; i++) insert.run(`source-${i}`, JSON.stringify({ text: `https://alidocs.dingtalk.com/i/nodes/fixture-${i}` }), i);
      const context = readOnlineDocumentReferences(db, "W");
      expect(context.sources).toHaveLength(100);
      expect(context.totalSources).toBe(102);
      expect(context.truncated).toBe(true);
      expect(JSON.stringify(context)).not.toContain("https:");
      insert.run("source-102", JSON.stringify({ text: "https://alidocs.dingtalk.com/i/nodes/fixture-next" }), 102);
      expect(readOnlineDocumentReferences(db, "W").fingerprint).not.toBe(context.fingerprint);
      expect(readOnlineDocumentReferences(db, "another").sources).toEqual([]);
    } finally { db.close(); }
  });
});
