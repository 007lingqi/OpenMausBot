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
function setup(port?: DwsReadCommandPort, natural = false, initialOnline = true) {
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
          acceptance: request.onlineDocuments?.sources.some(source => source.bodyStatus === "ready")
            ? [{ description: "用户名保留", observation: "登录失败后用户名仍在", quote: "不得清空已填写的用户名" }] : [] }; } } } : {}) } };
  const service = startCollaborationService({ ...options, ...(initialOnline ? {} : { onlineDocuments: undefined }) });
  const message = { sourceEventId: "source", transportMessageId: "transport", conversationId: "group", addressedToBot: true,
    text: `请修复文档描述的问题 ${node}`, sender: { senderCorpId: "corp", senderStaffId: "user", senderId: "user", displayName: "测试同事" }, receivedAt: now };
  const id = service.ingestDingTalkMessage(message).workItemId!;
  return { db, service, options, message, id, captured, reads: () => reads, now: () => now,
    advance() { now += 130_000; lease = leases.acquire(now, 120_000)!; } };
}
describe("durable online document ingestion", () => {
  it("reinterprets newly read material after an earlier interpretation without overwriting its provenance or replaying the read", async () => {
    // Historical intake before the online reader was configured: the model can see a link, not its body.
    const h = setup(undefined, true, false);
    try {
      await h.service.processNaturalIntake(h.now());
      expect(h.captured).toHaveLength(1);
      expect(h.captured[0].onlineDocuments?.sources[0].bodyStatus).toBe("unavailable");
      const original = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs WHERE source_event_id='source'").get();
      expect(original).toMatchObject({ status: "applied", attempts: 1 });
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.acceptanceConditions).toEqual([]);
      h.service.close();
      // Reconstruct v32 without touching the original successful input or its Spec.
      h.db.exec("DROP TABLE collaboration_online_read_recoveries; DROP TRIGGER online_read_jobs_binding; ALTER TABLE collaboration_online_read_jobs DROP COLUMN recovery_generation; CREATE TRIGGER online_read_jobs_binding BEFORE UPDATE ON collaboration_online_read_jobs WHEN NEW.id<>OLD.id OR NEW.work_item_id<>OLD.work_item_id OR NEW.source_event_id<>OLD.source_event_id OR NEW.normalized_hash<>OLD.normalized_hash OR NEW.reference_hash<>OLD.reference_hash OR NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.attempts<OLD.attempts OR NEW.projection_attempts<OLD.projection_attempts BEGIN SELECT RAISE(ABORT,'online source and budget are immutable'); END; DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DELETE FROM collaboration_schema_migrations WHERE version>=33; PRAGMA user_version=32");
      const restarted = startCollaborationService(h.options);
      try {
        expect(h.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 35 });
        expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs WHERE source_event_id='source'").get()).toEqual(original);
        expect(await restarted.processOnlineDocuments(h.now())).toBe(h.id);
        await restarted.processNaturalIntake(h.now());
        expect(h.captured).toHaveLength(2);
        expect(h.captured[1].event.sourceEventId).toBe("source");
        expect(h.captured[1].onlineDocuments?.sources[0].bodyStatus).toBe("ready");
        expect(readLatestWorkItemSnapshot(h.db, h.id)!.acceptanceConditions).toContainEqual({ description: "用户名保留", observation: "登录失败后用户名仍在" });
        expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs WHERE source_event_id='source'").get()).toEqual(original);
        const snapshot = readLatestWorkItemSnapshot(h.db, h.id)!;
        restarted.ingestDingTalkMessage(h.message);
        await restarted.processOnlineDocuments(h.now());
        await restarted.processNaturalIntake(h.now());
        expect(h.captured).toHaveLength(2);
        expect(h.reads()).toBe(1);
        expect(readLatestWorkItemSnapshot(h.db, h.id)!.revision).toBe(snapshot.revision);
        expect(() => h.db.exec("UPDATE collaboration_natural_material_jobs SET proposal_json='{}'")).toThrow("immutable");
        expect(() => h.db.exec("DELETE FROM collaboration_natural_material_jobs")).toThrow("immutable");
      } finally { restarted.close(); }
    } finally { h.service.close(); h.db.close(); }
  });
  it("discovers a previously projected body when interpretation is enabled later, without redownloading", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    const readerOnly = startCollaborationService({ ...h.options, planning: { ...h.options.planning, naturalIntake: undefined } });
    try { await readerOnly.processOnlineDocuments(h.now());
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_material_jobs").get()).toEqual({ n: 0 });
    } finally { readerOnly.close(); }
    const restarted = startCollaborationService(h.options);
    try { await restarted.processNaturalIntake(h.now());
      expect(h.captured).toHaveLength(2); expect(h.reads()).toBe(1);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.acceptanceConditions).toContainEqual({ description: "用户名保留", observation: "登录失败后用户名仍在" });
    } finally { restarted.close(); h.db.close(); }
  });
  it("quarantines a changed material source without starving another item or starting a model call", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    const restarted = startCollaborationService(h.options);
    try {
      await restarted.processOnlineDocuments(h.now());
      h.db.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE source_event_id='source'")
        .run(JSON.stringify({ text: "source changed" }));
      const next = restarted.ingestDingTalkMessage({ ...h.message, sourceEventId: "other", transportMessageId: "other",
        text: "新任务：请修复另一个登录错误" }).workItemId!;
      expect(next).toMatch(/^WI-/u);
      expect(next).not.toBe(h.id);
      const outcomes = [await restarted.processNaturalIntake(h.now()), await restarted.processNaturalIntake(h.now())];
      expect(outcomes.filter(outcome => outcome === next)).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome === null)).toHaveLength(1);
      expect(h.db.prepare("SELECT status,error_code,attempts FROM collaboration_natural_material_jobs").get())
        .toEqual({ status: "failed", error_code: "natural_material_source_changed", attempts: 0 });
      expect(h.captured).toHaveLength(2); expect(h.reads()).toBe(1);
    } finally { restarted.close(); h.db.close(); }
  });
  it.each(["paused", "cancelled"])("does not begin late interpretation for a %s item", async control => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    const restarted = startCollaborationService(h.options);
    try {
      await restarted.processOnlineDocuments(h.now());
      if (control === "paused") h.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(h.id);
      else h.db.prepare("UPDATE collaboration_work_items SET status='cancelled',control_state='cancelled' WHERE id=?").run(h.id);
      expect(await restarted.processNaturalIntake(h.now())).toBeNull();
      expect(h.captured).toHaveLength(1); expect(h.reads()).toBe(1);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "pending", attempts: 0 });
    } finally { restarted.close(); h.db.close(); }
  });
  it("retries a rolled-back material projection from durable input without rereading", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    let service = startCollaborationService(h.options);
    try {
      await service.processOnlineDocuments(h.now());
      h.db.exec("CREATE TRIGGER fail_material_projection BEFORE INSERT ON collaboration_work_item_snapshots BEGIN SELECT RAISE(ABORT,'fixture_material_projection_failed'); END");
      expect(await service.processNaturalIntake(h.now())).toBeNull();
      expect(h.db.prepare("SELECT status,attempts,result_revision FROM collaboration_natural_material_jobs").get())
        .toEqual({ status: "pending", attempts: 1, result_revision: null });
      h.db.exec("DROP TRIGGER fail_material_projection"); service.close(); service = startCollaborationService(h.options);
      expect(await service.processNaturalIntake(h.now())).toBe(h.id);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "applied", attempts: 2 });
      expect(h.reads()).toBe(1);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).not.toContain("online-document-interpretation-pending");
    } finally { service.close(); h.db.close(); }
  });
  it("does not turn three failed original interpretations into a new budget when a body is read", async () => {
    const h = setup(undefined, true, false); h.service.close();
    const interpret = vi.fn(async () => { throw new Error("fixture-model-failed"); });
    const failing = startCollaborationService({ ...h.options, onlineDocuments: undefined,
      planning: { ...h.options.planning, naturalIntake: { interpret } } });
    try { for (let i = 0; i < 3; i++) await failing.processNaturalIntake(h.now()); }
    finally { failing.close(); }
    const original = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").get();
    expect(original).toMatchObject({ status: "failed", attempts: 3 });
    const service = startCollaborationService(h.options);
    try { await service.processOnlineDocuments(h.now()); await service.processNaturalIntake(h.now());
      expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").get()).toEqual(original);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_material_jobs").get()).toEqual({ n: 0 });
      expect(h.captured).toHaveLength(0); expect(h.reads()).toBe(1);
    } finally { service.close(); h.db.close(); }
  });
  it("rejects a late material interpretation after the current Spec changes", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    let finish!: (value: unknown) => void; let captured!: NaturalIntakeRequest;
    const service = startCollaborationService({ ...h.options, planning: { ...h.options.planning,
      naturalIntake: { async interpret(request: NaturalIntakeRequest) { captured = request; return await new Promise(resolve => { finish = resolve; }); } } } });
    try {
      await service.processOnlineDocuments(h.now());
      const pending = service.processNaturalIntake(h.now()); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      service.reviseWorkItemDefinition(h.id, { assumptions: ["新补充：还要核对移动端"] }, h.now());
      const current = readLatestWorkItemSnapshot(h.db, h.id)!;
      finish({ version: 1, sourceEventId: captured.event.sourceEventId, baseRevision: captured.snapshot.revision,
        goal: null, answers: [], questions: [], acceptance: [{ description: "旧结论", observation: "旧断言", quote: body }] });
      expect(await pending).toBeNull();
      expect(readLatestWorkItemSnapshot(h.db, h.id)).toEqual(current);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "pending", attempts: 1 });
    } finally { service.close(); h.db.close(); }
  });
  it("keeps late material interpretation pending across restart and does not invoke another interpreter concurrently", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    let finish!: (value: unknown) => void;
    const interpret = vi.fn(async (_request: NaturalIntakeRequest) => await new Promise(resolve => { finish = resolve; }));
    const options = { ...h.options, planning: { ...h.options.planning, naturalIntake: { interpret } } };
    const first = startCollaborationService(options), second = startCollaborationService(options);
    try {
      await first.processOnlineDocuments(h.now());
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain("online-document-interpretation-pending");
      const pending = first.processNaturalIntake(h.now());
      await vi.waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      expect(await second.processNaturalIntake(h.now())).toBeNull();
      first.close();
      const request = interpret.mock.calls[0][0];
      finish({ version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, answers: [], questions: [], acceptance: [] });
      expect(await pending).toBeNull();
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain("online-document-interpretation-pending");
      expect(h.reads()).toBe(1);
    } finally { first.close(); second.close(); h.db.close(); }
  });
  it("stops three failed late interpretations durably without rereading or overwriting original success", async () => {
    const h = setup(undefined, true, false);
    await h.service.processNaturalIntake(h.now()); h.service.close();
    const interpret = vi.fn(async () => { throw new Error("access_token=fixture-private-failure"); });
    const options = { ...h.options, planning: { ...h.options.planning, naturalIntake: { interpret } } };
    let service = startCollaborationService(options);
    try {
      await service.processOnlineDocuments(h.now());
      for (let i = 0; i < 5; i++) { await service.processNaturalIntake(h.now()); service.close(); service = startCollaborationService(options); }
      expect(interpret).toHaveBeenCalledTimes(3);
      expect(h.reads()).toBe(1);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.blockingAmbiguities.map(q => q.id)).toContain("online-document-interpretation-pending");
      expect(JSON.stringify(service.pendingOutbox())).toContain("已停止自动重试");
      expect(JSON.stringify(service.pendingOutbox())).not.toContain("fixture-private-failure");
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs").get()).toEqual({ status: "applied", attempts: 1 });
    } finally { service.close(); h.db.close(); }
  });
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
