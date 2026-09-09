import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_SCHEMA_VERSION } from "./migrations.ts";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { DwsOnlineDocumentReader } from "./operations/dws-online-reader.ts";
import { recoverNaturalIntake, isCurrentNaturalIntakeFailureNotice } from "./natural-intake-recovery.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import type { NaturalIntakeRequest } from "./natural-intake.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { CollaborationHeadlessRuntime, type RuntimeDingTalkSinks } from "./operations/runtime.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function stripCandidateRevisionSchema(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'candidate_revision_%'").all()) {
    const name = String(row.name);
    if (!/^candidate_revision_[a-z_]+$/u.test(name)) throw new Error("invalid candidate revision fixture trigger");
    db.exec(`DROP TRIGGER "${name}"`);
  }
  db.exec("DROP TABLE collaboration_candidate_revision_stages; DROP TABLE collaboration_candidate_revision_requests");
}
async function fixture(materialCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "material-owner-recovery-")); roots.push(root);
  const file = join(root, "collaboration", "collaboration.sqlite");
  const node = "https://alidocs.dingtalk.com/i/nodes/fixture";
  const grants = Array.from({ length: materialCount }, (_, i) => ({ id: `grant-${i}`, profile: "corp:user", conversationId: "group",
    node: i ? `${node}-${i}` : node, canonicalId: i ? `fixture-${i}` : "fixture", product: "doc" as const }));
  let fail = false, reads = 0;
  const planning = { policy, planner: { propose: validProposal },
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] },
    naturalIntake: { async interpret(request: NaturalIntakeRequest) {
      if (fail) throw new Error("fixture-material-model-failure");
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision,
        goal: null, answers: [], questions: [], acceptance: request.onlineDocuments?.sources.some(s => s.bodyStatus === "ready")
          ? [{ description: "保留用户名", observation: "失败后仍可见用户名", quote: "保留用户名" }] : [] };
    } } };
  const first = startCollaborationService({ dataDirectory: root, planning });
  const db = new DatabaseSync(file); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const now = Date.now();
  const leases = new InstanceLeaseCoordinator(db, "reader");
  let lease = leases.acquire(now, 120000)!;
  const owner = new LocalOwnerRegistry(file); owner.bootstrap({ senderCorpId: "corp", senderStaffId: "owner", now }); owner.close();
  const message: DingTalkInboundMessage = { sourceEventId: "source", transportMessageId: "source", conversationId: "group", addressedToBot: true,
    text: `请修复 ${grants.map(grant => grant.node).join(" ")} 中的问题`, receivedAt: now, sender: { senderCorpId: "corp", senderStaffId: "owner", senderId: "owner", displayName: "负责人" } };
  const id = first.ingestDingTalkMessage(message).workItemId!;
  await first.processNaturalIntake(now); first.close(); fail = true;
  const options = { dataDirectory: root, planning, onlineDocuments: { currentLease: () => lease,
    reader: new DwsOnlineDocumentReader(grants,
      { async run(args) { reads++; const grant = grants.find(value => value.node === args[args.indexOf("--node") + 1])!;
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ contractVersion: "doc.content.v1", status: "success", complete: true,
        target: { product: "doc", canonicalId: grant.canonicalId }, content: "登录失败后保留用户名" })), stderr: Buffer.alloc(0), timedOut: false, outputLimitExceeded: false }; } }) } };
  const service = startCollaborationService(options);
  for (let i = 0; i < materialCount; i++) await service.processOnlineDocuments(now);
  for (let i = 0; i < materialCount * 3; i++) await service.processNaturalIntake(now);
  expect(db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").all())
    .toEqual(Array.from({ length: materialCount }, () => ({ status: "failed", attempts: 3 })));
  const request = { ...message, sourceEventId: "owner-recovery", transportMessageId: "owner-recovery", text: "继续整理需求", replyToSourceEventId: "source" };
  return { db, service, options, request, id, now, reads: () => reads, succeed: () => { fail = false; },
    releaseLease: () => leases.release(lease, Date.now()),
    reacquireLease: () => { const priorFence = lease.fence; lease = leases.acquire(Date.now(), 120000)!; expect(lease.fence).toBeGreaterThan(priorFence); },
    recover: (input = request) => recoverNaturalIntake(db, input, now, () => {}), close: () => { service.close(); db.close(); } };
}

describe("Owner recovery of late document interpretation", () => {
  it("preserves a schema33 failed material job and its evidence while upgrading, then requires Owner recovery", async () => {
    const h = await fixture();
    try {
      h.service.close();
      const { recovery_generation: generation, ...original } = h.db.prepare("SELECT * FROM collaboration_natural_material_jobs").get()!;
      expect(generation).toBe(0);
      const bodies = h.db.prepare("SELECT * FROM collaboration_online_read_receipts").all();
      const inputs = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all();
      h.releaseLease();
      stripCandidateRevisionSchema(h.db);
      h.db.exec(`DROP TABLE IF EXISTS collaboration_candidate_result_deliveries; DROP TABLE IF EXISTS collaboration_candidate_result_bindings; DROP TABLE IF EXISTS collaboration_candidate_recheck_attempts; DROP TABLE collaboration_approval_presentations; DROP TABLE collaboration_conversation_intents; DROP TABLE collaboration_online_read_recoveries; DROP TRIGGER online_read_jobs_binding; ALTER TABLE collaboration_online_read_jobs DROP COLUMN recovery_generation; CREATE TRIGGER online_read_jobs_binding BEFORE UPDATE ON collaboration_online_read_jobs WHEN NEW.id<>OLD.id OR NEW.work_item_id<>OLD.work_item_id OR NEW.source_event_id<>OLD.source_event_id OR NEW.normalized_hash<>OLD.normalized_hash OR NEW.reference_hash<>OLD.reference_hash OR NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.attempts<OLD.attempts OR NEW.projection_attempts<OLD.projection_attempts BEGIN SELECT RAISE(ABORT,'online source and budget are immutable'); END; DROP TABLE collaboration_natural_material_recoveries; DROP TRIGGER natural_material_immutable;
        ALTER TABLE collaboration_natural_material_jobs DROP COLUMN recovery_generation;
        CREATE TRIGGER natural_material_immutable BEFORE UPDATE ON collaboration_natural_material_jobs
          WHEN OLD.status='applied' OR NEW.id<>OLD.id OR NEW.source_event_id<>OLD.source_event_id OR NEW.work_item_id<>OLD.work_item_id
            OR NEW.receipt_hash<>OLD.receipt_hash OR NEW.base_revision<>OLD.base_revision OR NEW.created_at<>OLD.created_at OR NEW.attempts<OLD.attempts
          BEGIN SELECT RAISE(ABORT,'material interpretation history is immutable'); END;
        DELETE FROM collaboration_schema_migrations WHERE version>=34; PRAGMA user_version=33`);
      const upgraded = startCollaborationService(h.options);
      try {
        h.reacquireLease();
        expect(h.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: COLLABORATION_SCHEMA_VERSION });
        expect(h.db.prepare("SELECT * FROM collaboration_natural_material_jobs").get()).toEqual({ ...original, recovery_generation: 0 });
        expect(h.db.prepare("SELECT * FROM collaboration_online_read_receipts").all()).toEqual(bodies);
        expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all()).toEqual(inputs);
        expect(await upgraded.processNaturalIntake(h.now)).toBeNull();
        expect(h.recover()).toMatchObject({ allowed: true, recoveredInputs: 1 });
        expect(h.reads()).toBe(1);
      } finally { upgraded.close(); }
    } finally { h.close(); }
  });
  it("recovers multiple materials and a failed message in the same item without repeating its original success", async () => {
    const h = await fixture(2);
    try {
      const original = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs WHERE source_event_id='source'").get();
      expect(h.service.ingestDingTalkMessage({ ...h.request, sourceEventId: "supplement", transportMessageId: "supplement", text: "补充：不要清空密码" }).workItemId).toBe(h.id);
      for (let i = 0; i < 3; i++) await h.service.processNaturalIntake(h.now);
      expect(h.recover()).toMatchObject({ allowed: true, recoveredInputs: 3 });
      expect(h.recover()).toMatchObject({ duplicate: true, recoveredInputs: 3 });
      expect(h.db.prepare("SELECT status,attempts,recovery_generation FROM collaboration_natural_material_jobs").all())
        .toEqual([{ status: "pending", attempts: 0, recovery_generation: 1 }, { status: "pending", attempts: 0, recovery_generation: 1 }]);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_material_recoveries").get()).toEqual({ n: 2 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_recoveries").get()).toEqual({ n: 1 });
      expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs WHERE source_event_id='source'").get()).toEqual(original);
      h.succeed();
      for (let i = 0; i < 4; i++) await h.service.processNaturalIntake(h.now);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_all_jobs WHERE status<>'applied'").get()).toEqual({ n: 0 });
      expect(h.reads()).toBe(2);
    } finally { h.close(); }
  });
  it("restores through the runtime's group-message sink and delivers one plain-language receipt, suppressing the stale failure", async () => {
    const h = await fixture(); h.service.close();
    h.db.exec("UPDATE collaboration_instance_lease SET expires_at=1,heartbeat_at=0");
    let sinks!: RuntimeDingTalkSinks;
    const delivered: string[] = [];
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: h.options.dataDirectory, platform: "linux", logger: { write() {} },
      planner: h.options.planning.planner, planningPolicy: policy, planningDefaultDefinition: h.options.planning.defaultDefinition,
      naturalIntake: h.options.planning.naturalIntake, onlineDocuments: h.options.onlineDocuments.reader,
      outboxDelivery: { async deliver(message) { delivered.push(JSON.stringify(renderDingTalkSessionMessage(message.payload))); return { outcome: "sent" }; } },
      dingTalk: { enabled: true, credentials: { load: () => ({ clientId: "fixture", clientSecret: "fixture" }) },
        createStream: (_credentials, captured) => { sinks = captured; return { start: async () => "connected", stop() {}, state: () => "connected" }; } } });
    try {
      await runtime.start();
      expect(sinks.recoverRequirements(h.request)).toMatchObject({ allowed: true, duplicate: false, recoveredInputs: 1 });
      expect(sinks.recoverRequirements(h.request)).toMatchObject({ duplicate: true });
      h.succeed(); await runtime.drainOnce();
      await vi.waitFor(() => expect(h.db.prepare("SELECT status FROM collaboration_natural_material_jobs").get()).toEqual({ status: "applied" }));
      for (let i = 0; i < 10; i++) await runtime.drainOnce();
      expect(delivered.filter(text => text.includes("已恢复需求整理"))).toHaveLength(1);
      expect(delivered.find(text => text.includes("已恢复需求整理"))).toContain("这不代表代码修改已完成");
      expect(delivered.some(text => text.includes("尚未能可靠地核对新增要求"))).toBe(false);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_work_items").get()).toEqual({ n: 1 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 0 });
      expect(h.reads()).toBe(1);
    } finally { await runtime.stop(); h.close(); }
  });
  it("recovers once with original source and body preserved, then resumes after restart without rereading", async () => {
    const h = await fixture();
    try {
      const sources = h.db.prepare("SELECT * FROM collaboration_external_events").all();
      const originals = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all();
      const bodies = h.db.prepare("SELECT * FROM collaboration_online_read_receipts").all();
      expect(() => h.db.exec("UPDATE collaboration_natural_material_jobs SET attempts=0")).toThrow("immutable");
      expect(h.recover()).toMatchObject({ allowed: true, duplicate: false, workItemId: h.id, recoveredInputs: 1 });
      expect(h.recover()).toMatchObject({ allowed: true, duplicate: true, recoveredInputs: 1 });
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "pending", attempts: 0 });
      expect(h.db.prepare("SELECT * FROM collaboration_external_events").all()).toEqual(sources);
      expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all()).toEqual(originals);
      expect(h.db.prepare("SELECT * FROM collaboration_online_read_receipts").all()).toEqual(bodies);
      expect(h.db.prepare("SELECT generation,prior_attempts,owner_generation FROM collaboration_natural_material_recoveries").all())
        .toEqual([{ generation: 1, prior_attempts: 3, owner_generation: 1 }]);
      expect(() => h.db.exec("UPDATE collaboration_natural_material_recoveries SET generation=2")).toThrow("immutable");
      expect(() => h.db.exec("DELETE FROM collaboration_natural_material_recoveries")).toThrow("immutable");
      h.succeed(); h.service.close(); const resumed = startCollaborationService(h.options);
      try { expect(await resumed.processNaturalIntake(h.now)).toBe(h.id);
        expect(h.reads()).toBe(1);
        expect(readLatestWorkItemSnapshot(h.db, h.id)!.acceptanceConditions).toContainEqual({ description: "保留用户名", observation: "失败后仍可见用户名" });
      } finally { resumed.close(); }
    } finally { h.close(); }
  });
  it("requires a fresh Owner decision after three more failures and emits a current failure notice", async () => {
    const h = await fixture();
    try { expect(h.recover().allowed).toBe(true);
      for (let i = 0; i < 4; i++) await h.service.processNaturalIntake(h.now);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(h.recover().duplicate).toBe(true);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(() => h.db.exec("UPDATE collaboration_natural_material_jobs SET attempts=0")).toThrow("immutable");
      const notices = h.db.prepare("SELECT source_event_id,aggregate_id,aggregate_version FROM collaboration_outbox WHERE source_event_id LIKE 'material-intake-failed:%'")
        .all() as Array<{ source_event_id: string; aggregate_id: string; aggregate_version: number }>;
      expect(notices).toHaveLength(2);
      expect(notices.filter(row => isCurrentNaturalIntakeFailureNotice(h.db, row))).toHaveLength(1);
      expect(h.recover({ ...h.request, sourceEventId: "new-owner-decision" }).allowed).toBe(true);
      expect(h.reads()).toBe(1);
    } finally { h.close(); }
  });
  it.each(["member", "cross-group", "wrong-reply", "paused", "cancelled", "running", "source-changed"])("does not recover %s", async mode => {
    const h = await fixture();
    try {
      if (mode === "member") h.request.sender = { ...h.request.sender, senderStaffId: "member" };
      if (mode === "cross-group") h.request.conversationId = "foreign";
      if (mode === "wrong-reply") h.request.replyToSourceEventId = "foreign";
      if (mode === "paused") h.db.exec("UPDATE collaboration_work_items SET control_state='paused'");
      if (mode === "cancelled") h.db.exec("UPDATE collaboration_work_items SET status='cancelled'");
      if (mode === "running") h.db.prepare("UPDATE collaboration_natural_material_jobs SET status='running',lease_until=?").run(h.now + 60000);
      if (mode === "source-changed") h.db.exec("UPDATE collaboration_external_events SET normalized_json='{}'");
      const before = h.db.prepare("SELECT * FROM collaboration_natural_material_jobs").all();
      expect(h.recover().allowed).toBe(false);
      expect(h.db.prepare("SELECT * FROM collaboration_natural_material_jobs").all()).toEqual(before);
    } finally { h.close(); }
  });
  it("rolls recovery back when its reply cannot be saved and rejects a lost instance guard", async () => {
    const h = await fixture();
    try {
      expect(() => recoverNaturalIntake(h.db, h.request, h.now, () => { throw new Error("fixture_lease_lost"); })).toThrow("fixture_lease_lost");
      h.db.exec("CREATE TRIGGER fail_material_recovery_reply BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_reply_failed'); END");
      expect(() => h.recover()).toThrow("fixture_reply_failed");
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_material_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_recovery_requests").get()).toEqual({ n: 0 });
    } finally { h.close(); }
  });
});
