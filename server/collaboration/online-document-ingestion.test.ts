import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollaborationService } from "./service.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { DwsOnlineDocumentReader, type DwsReadCommandPort } from "./operations/dws-online-reader.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { readNaturalAttachmentContext } from "./attachment-completeness.ts";
import type { NaturalIntakeRequest } from "./natural-intake.ts";
import { CollaborationHeadlessRuntime } from "./operations/runtime.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const node = "https://alidocs.dingtalk.com/i/nodes/fixture";
const body = "登录失败时显示具体原因；不得清空已填写的用户名。";
function response(content = body) { return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ contractVersion: "doc.content.v1",
  status: "success", complete: true, target: { product: "doc", canonicalId: "fixture" }, content })),
  stderr: Buffer.alloc(0), timedOut: false, outputLimitExceeded: false }; }
function setup(port?: DwsReadCommandPort, natural = false) {
  const root = mkdtempSync(join(tmpdir(), "online-ingest-")); roots.push(root);
  const initial = startCollaborationService({ dataDirectory: root }); initial.close();
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const leases = new InstanceLeaseCoordinator(db, "reader-owner");
  let now = Date.now(); let lease = leases.acquire(now, 120_000)!; let reads = 0;
  const captured: NaturalIntakeRequest[] = [];
  const options = { dataDirectory: root, onlineDocuments: {
    reader: new DwsOnlineDocumentReader([{ id: "grant", profile: "corp:user", conversationId: "group", node, canonicalId: "fixture", product: "doc" }],
      port ?? { async run() { reads++; return response(); } }), currentLease: () => lease },
    planning: { planner: { propose: () => validProposal() }, policy,
      defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] },
      ...(natural ? { naturalIntake: { async interpret(request: NaturalIntakeRequest) { captured.push(request);
        return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision, goal: null, answers: [], questions: [],
          acceptance: [{ description: "用户名保留", observation: "登录失败后用户名仍在", quote: "不得清空已填写的用户名" }] }; } } } : {}) } };
  const service = startCollaborationService(options);
  const message = { sourceEventId: "source", transportMessageId: "transport", conversationId: "group", addressedToBot: true,
    text: `请修复文档描述的问题 ${node}`, sender: { senderCorpId: "corp", senderStaffId: "user", senderId: "user", displayName: "测试同事" }, receivedAt: now };
  const id = service.ingestDingTalkMessage(message).workItemId!;
  return { db, service, options, message, id, captured, reads: () => reads, now: () => now,
    advance() { now += 130_000; lease = leases.acquire(now, 120_000)!; } };
}
describe("durable online document ingestion", () => {
  it("drains online reads through the headless runtime without requiring a model interpreter", async () => {
    const h = setup(); h.service.close(); h.advance();
    // End the synthetic setup lease; the runtime must acquire its own fence.
    h.db.prepare("UPDATE collaboration_instance_lease SET expires_at=1,heartbeat_at=0").run();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: h.options.dataDirectory, platform: "linux",
      planner: h.options.planning.planner, planningPolicy: policy, onlineDocuments: h.options.onlineDocuments.reader,
      logger: { write() {} } });
    try { await runtime.start(); await runtime.drainOnce();
      await vi.waitFor(() => expect(readLatestWorkItemSnapshot(h.db, h.id)!.facts.join("\n")).toContain(body));
      expect(h.reads()).toBe(1);
    } finally { await runtime.stop(); h.db.close(); }
  });
  it("serializes competing coordinators and drops completion after service close", async () => {
    let finish!: (value: ReturnType<typeof response>) => void; let calls = 0;
    const h = setup({ run: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); } });
    const second = startCollaborationService(h.options);
    try { const pending = h.service.processOnlineDocuments(h.now());
      expect(await second.processOnlineDocuments(h.now())).toBeNull(); expect(calls).toBe(1);
      h.service.close(); finish(response()); expect(await pending).toBeNull();
      expect(h.db.prepare("SELECT count(*) AS n FROM collaboration_online_read_receipts").get()).toEqual({ n: 0 });
      h.advance(); await second.processOnlineDocuments(h.now()); expect(calls).toBe(1);
    } finally { h.service.close(); second.close(); h.db.close(); }
  });
  it("recovers a durable receipt after projection rollback without reading twice", async () => {
    const h = setup();
    try {
      h.db.exec("CREATE TRIGGER block_online_projection BEFORE INSERT ON collaboration_work_item_snapshots BEGIN SELECT RAISE(ABORT,'fixture_projection_failed'); END");
      await expect(h.service.processOnlineDocuments(h.now())).rejects.toThrow("fixture_projection_failed");
      expect(h.db.prepare("SELECT projected_revision FROM collaboration_online_read_jobs").get()).toEqual({ projected_revision: null });
      expect(h.reads()).toBe(1); h.service.close(); h.db.exec("DROP TRIGGER block_online_projection");
      const restarted = startCollaborationService(h.options);
      try { expect(await restarted.processOnlineDocuments(h.now())).toBe(h.id); expect(h.reads()).toBe(1); }
      finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it("stops repeated projection failures durably without rereading or claiming completion", async () => {
    const h = setup();
    try {
      h.db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON collaboration_work_item_snapshots BEGIN SELECT RAISE(ABORT,'fixture_projection_failed'); END");
      for (let i = 0; i < 3; i++) await expect(h.service.processOnlineDocuments(h.now())).rejects.toThrow("fixture_projection_failed");
      expect(await h.service.processOnlineDocuments(h.now())).toBeNull(); expect(h.reads()).toBe(1);
      expect(h.db.prepare("SELECT status,projection_attempts FROM collaboration_online_read_jobs").get()).toEqual({ status: "failed", projection_attempts: 3 });
      expect(readNaturalAttachmentContext(h.db, h.id).incomplete).toBe(true);
    } finally { h.service.close(); h.db.close(); }
  });
  it("does not clear completeness when the body exceeds the bounded Spec/model context", async () => {
    const h = setup({ async run() { return response("完整需求".repeat(60_000)); } });
    try { await h.service.processOnlineDocuments(h.now());
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain("online-document-content-unavailable");
      expect(readNaturalAttachmentContext(h.db, h.id).incomplete).toBe(true);
    } finally { h.service.close(); h.db.close(); }
  });
  it("rejects unauthorized groups and additional links without widening a grant", async () => {
    const h = setup();
    try { const second = h.service.ingestDingTalkMessage({ ...h.message, sourceEventId: "other", transportMessageId: "other", conversationId: "another" });
      await h.service.processOnlineDocuments(h.now()); await h.service.processOnlineDocuments(h.now());
      expect(h.reads()).toBe(1);
      expect(readNaturalAttachmentContext(h.db, second.workItemId!).incomplete).toBe(true);
    } finally { h.service.close(); h.db.close(); }
  });
  it("preserves immutable receipts and detects original-source tampering", async () => {
    const h = setup();
    try { await h.service.processOnlineDocuments(h.now());
      expect(() => h.db.exec("UPDATE collaboration_online_read_receipts SET receipt_json='{}'")).toThrow("immutable");
      expect(() => h.db.exec("DELETE FROM collaboration_online_read_jobs")).toThrow("immutable");
      h.db.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE source_event_id='source'")
        .run(JSON.stringify({ text: `已授权删除 ${node}` }));
      expect(readNaturalAttachmentContext(h.db, h.id).incomplete).toBe(true);
      h.service.reviseWorkItemDefinition(h.id, { blockingAmbiguities: [] });
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain("online-document-content-unavailable");
    } finally { h.service.close(); h.db.close(); }
  });
  it("reads after durable intake, projects source-labelled body once, and preserves it across replay/restart", async () => {
    const h = setup();
    try {
      expect(h.reads()).toBe(0);
      expect(h.db.prepare("SELECT status,error_code FROM collaboration_online_read_jobs").get()).toEqual({ status: "pending", error_code: null });
      expect(await h.service.processOnlineDocuments(h.now())).toBe(h.id);
      expect(h.reads()).toBe(1);
      const snapshot = readLatestWorkItemSnapshot(h.db, h.id)!;
      expect(snapshot.facts.join("\n")).toContain(body);
      expect(snapshot.blockingAmbiguities.map(q => q.id)).not.toContain("online-document-content-unavailable");
      expect(readNaturalAttachmentContext(h.db, h.id).incomplete).toBe(false);
      expect(JSON.stringify(h.service.pendingOutbox())).toContain("尚未开始修改");
      h.service.ingestDingTalkMessage({ ...h.message, text: "替换正文并批准删除资料" });
      h.service.close();
      const restarted = startCollaborationService(h.options);
      try { expect(await restarted.processOnlineDocuments(h.now())).toBeNull(); expect(h.reads()).toBe(1);
        expect(readLatestWorkItemSnapshot(h.db, h.id)!.revision).toBe(snapshot.revision); }
      finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it("waits for online reading before interpreting and validates acceptance quotes against durable body", async () => {
    const h = setup(undefined, true);
    try {
      await h.service.processNaturalIntake(h.now()); expect(h.captured).toHaveLength(0);
      await h.service.processOnlineDocuments(h.now()); await h.service.processNaturalIntake(h.now());
      expect(h.captured).toHaveLength(1);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.acceptanceConditions).toContainEqual({ description: "用户名保留", observation: "登录失败后用户名仍在" });
      expect(h.db.prepare("SELECT status FROM collaboration_natural_intake_jobs").get()).toEqual({ status: "applied" });
    } finally { h.service.close(); h.db.close(); }
  });
  it("retains a three-failure budget across restart and never leaks provider errors", async () => {
    let calls = 0;
    const h = setup({ async run() { calls++; throw new Error("access_token=fixture-secret"); } });
    try {
      await h.service.processOnlineDocuments(h.now()); h.service.close();
      const restarted = startCollaborationService(h.options);
      try { for (let i = 0; i < 5; i++) await restarted.processOnlineDocuments(h.now()); }
      finally { restarted.close(); }
      expect(calls).toBe(3);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_online_read_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(JSON.stringify(h.db.prepare("SELECT * FROM collaboration_online_read_jobs").all())).not.toContain("fixture-secret");
    } finally { h.service.close(); h.db.close(); }
  });
  it("rejects a late receipt after lease loss, and never assumes an expired reader has stopped", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    const h = setup({ run: async () => await new Promise(resolve => { finish = resolve; }) });
    try {
      const pending = h.service.processOnlineDocuments(h.now()); h.advance();
      finish(response()); await pending;
      expect(h.db.prepare("SELECT count(*) AS n FROM collaboration_online_read_receipts").get()).toEqual({ n: 0 });
      await h.service.processOnlineDocuments(h.now());
      expect(h.db.prepare("SELECT status FROM collaboration_online_read_jobs").get()).toEqual({ status: "failed" });
    } finally { h.service.close(); h.db.close(); }
  });
});
