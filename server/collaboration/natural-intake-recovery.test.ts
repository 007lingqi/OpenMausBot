import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { recoverNaturalIntake, isCurrentNaturalIntakeFailureNotice } from "./natural-intake-recovery.ts";
import { recoverAttachmentProjection } from "./attachment-projection-recovery.ts";
import { openCollaborationLedger } from "./db.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import type { NaturalIntakeRequest } from "./natural-intake.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { proactiveDestination } from "./delivery-routing.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function message(id: string, text: string, replyToSourceEventId?: string): DingTalkInboundMessage {
  return { sourceEventId: id, transportMessageId: `transport-${id}`, conversationId: "external-group", addressedToBot: true, text,
    ...(replyToSourceEventId ? { replyToSourceEventId } : {}), receivedAt: 1000,
    sender: { senderCorpId: "synthetic-corp", senderStaffId: "owner", senderId: "owner", displayName: "合成负责人" } };
}
async function fixture(count = 1, separate = false) {
  const directory = mkdtempSync(join(tmpdir(), "natural-owner-recovery-")); scratch.push(directory);
  let fail = true;
  const options = { dataDirectory: directory, planning: { policy, planner: { propose: validProposal },
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] },
    naturalIntake: { async interpret(request: NaturalIntakeRequest) {
      if (fail) throw new Error("synthetic provider failure");
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision, goal: null,
        acceptance: [{ description: request.event.text, observation: request.event.text, quote: request.event.text }], answers: [], questions: [] };
    } } } };
  const service = startCollaborationService(options);
  const file = join(directory, "collaboration", "collaboration.sqlite");
  const registry = new LocalOwnerRegistry(file); registry.bootstrap({ senderCorpId: "synthetic-corp", senderStaffId: "owner", now: 1000 }); registry.close();
  const db = new DatabaseSync(file); db.exec("PRAGMA foreign_keys=ON");
  const first = service.ingestDingTalkMessage(message("input-0", "修复保存失败"));
  for (let i = 1; i < count; i++) service.ingestDingTalkMessage(message(`input-${i}`, separate ? `新任务：其他问题 ${i}` : `补充要求 ${i}`, separate ? undefined : "input-0"));
  for (let i = 0; i < count * 3 + 1; i++) await service.processNaturalIntake();
  const request = message("owner-recovery-1", "继续整理需求");
  return { directory, file, options, service, db, first, request,
    recover: (input = request) => recoverNaturalIntake(db, input, Date.now(), () => {}),
    succeed: () => { fail = false; }, close: () => { service.close(); db.close(); } };
}

describe("Owner-bound natural requirement recovery", () => {
  it("does not send a stale failure after Owner recovery and does not bypass a lost runtime guard", async () => {
    const h = await fixture();
    try {
      expect(() => recoverNaturalIntake(h.db, h.request, Date.now(), () => { throw new Error("fixture_lease_lost"); })).toThrow("fixture_lease_lost");
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_recovery_requests").get()).toEqual({ n: 0 });
      h.recover();
      const delivered: string[] = [];
      const now = Date.now();
      const lease = new InstanceLeaseCoordinator(h.db, "fixture-delivery").acquire(now, 60000)!;
      const dispatcher = new OutboxDispatcher(h.db, { async deliver(message) { delivered.push(JSON.stringify(message.payload)); return { outcome: "sent" }; } },
        { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 10, maxBackoffMs: 100 });
      for (let i = 0; i < 10; i++) if (!await dispatcher.dispatchOne(lease, now + i)) break;
      expect(delivered.some(text => text.includes("已允许继续整理"))).toBe(true);
      expect(delivered.some(text => text.includes("暂时没能可靠地整理"))).toBe(false);
      expect(h.db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE source_event_id LIKE 'natural-intake-failed:%'").all()).toEqual([{ delivery_state: "superseded" }]);
    } finally { h.close(); }
  });
  it("refreshes a still-relevant failure notice after later input changes the Spec", async () => {
    const h = await fixture();
    try {
      h.succeed();
      h.service.ingestDingTalkMessage(message("later", "补充另一项结果", "input-0"));
      await h.service.processNaturalIntake(); await h.service.processNaturalIntake();
      const snapshot = readLatestWorkItemSnapshot(h.db, h.first.workItemId!)!;
      const notices = h.db.prepare("SELECT source_event_id,aggregate_id,aggregate_version FROM collaboration_outbox WHERE source_event_id LIKE 'natural-intake-failed:input-0%' AND aggregate_version=?")
        .all(snapshot.revision) as Array<{ source_event_id: string; aggregate_id: string; aggregate_version: number }>;
      expect(notices).toHaveLength(1);
      expect(isCurrentNaturalIntakeFailureNotice(h.db, notices[0])).toBe(true);
    } finally { h.close(); }
  });
  it("recovers every failed contribution in one item, preserving evidence and resuming after restart", async () => {
    const h = await fixture(2);
    try {
      const snapshot = readLatestWorkItemSnapshot(h.db, h.first.workItemId!)!;
      const work = h.db.prepare("SELECT * FROM collaboration_work_items").all();
      const sources = h.db.prepare("SELECT * FROM collaboration_external_events").all();
      expect(h.recover()).toMatchObject({ allowed: true, duplicate: false, workItemId: h.first.workItemId, recoveredInputs: 2 });
      expect(proactiveDestination(h.file, h.request.sourceEventId, new Map([["external-group", "open-group"]]))).toBe("open-group");
      expect(h.recover()).toMatchObject({ allowed: true, duplicate: true, recoveredInputs: 2 });
      expect(h.db.prepare("SELECT * FROM collaboration_work_items").all()).toEqual(work);
      expect(h.db.prepare("SELECT * FROM collaboration_external_events").all()).toEqual(sources);
      expect(readLatestWorkItemSnapshot(h.db, h.first.workItemId!)).toEqual(snapshot);
      expect(h.db.prepare("SELECT prior_attempts,prior_error_code,generation,owner_generation FROM collaboration_natural_intake_recoveries").all()).toEqual([
        { prior_attempts: 3, prior_error_code: "natural_intake_unavailable", generation: 1, owner_generation: 1 },
        { prior_attempts: 3, prior_error_code: "natural_intake_unavailable", generation: 1, owner_generation: 1 }]);
      expect(isCurrentNaturalIntakeFailureNotice(h.db, { source_event_id: "natural-intake-failed:input-1", aggregate_id: h.first.workItemId!, aggregate_version: snapshot.revision })).toBe(false);
      expect(() => h.db.exec("DELETE FROM collaboration_natural_intake_recoveries")).toThrow("immutable");
      expect(() => h.db.exec("UPDATE collaboration_natural_intake_recovery_requests SET outcome_json='{}'")).toThrow("immutable");
      h.succeed(); h.service.close();
      const resumed = startCollaborationService(h.options);
      try {
        await resumed.processNaturalIntake(); await resumed.processNaturalIntake();
        expect(readLatestWorkItemSnapshot(h.db, h.first.workItemId!)!.acceptanceConditions).toHaveLength(2);
        expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_jobs WHERE status='applied'").get()).toEqual({ n: 2 });
        expect(resumed.ownerBinding()?.generation).toBe(1);
      } finally { resumed.close(); }
    } finally { h.close(); }
  });
  it("stops again, sends a fresh failure notice, and will not reopen on an old request replay", async () => {
    const h = await fixture();
    try {
      h.recover();
      for (let i = 0; i < 4; i++) await h.service.processNaturalIntake();
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      const notices = h.db.prepare("SELECT source_event_id FROM collaboration_outbox WHERE source_event_id LIKE 'natural-intake-failed:%' ORDER BY source_event_id").all() as Array<{ source_event_id: string }>;
      expect(notices).toHaveLength(2);
      expect(notices.map(row => row.source_event_id)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^natural-intake-failed:input-0:snapshot:\d+$/), expect.stringMatching(/^natural-intake-failed:input-0:recovery:1:snapshot:\d+$/)]));
      expect(h.recover().duplicate).toBe(true);
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(h.recover({ ...h.request, sourceEventId: "new-owner-decision" }).allowed).toBe(true);
      expect(h.db.prepare("SELECT generation FROM collaboration_natural_intake_recoveries ORDER BY generation").all()).toEqual([{ generation: 1 }, { generation: 2 }]);
    } finally { h.close(); }
  });
  it("clarifies multiple items and uses the original message reply to select exactly one", async () => {
    const h = await fixture(2, true);
    try {
      expect(h.recover()).toMatchObject({ allowed: false, recoveredInputs: 0, reason: "natural_intake_recovery_ambiguous" });
      expect(h.recover({ ...h.request, sourceEventId: "choice", replyToSourceEventId: "input-0" })).toMatchObject({ allowed: true, workItemId: h.first.workItemId, recoveredInputs: 1 });
      expect(h.db.prepare("SELECT status FROM collaboration_natural_intake_jobs WHERE source_event_id='input-1'").get()).toEqual({ status: "failed" });
    } finally { h.close(); }
  });
  it.each(["member", "cross-group", "wrong-reply", "paused", "cancelled", "accepted", "running", "unknown-failure"])("does not recover %s", async mode => {
    const h = await fixture();
    try {
      if (mode === "member") h.request.sender = Object.assign({}, h.request.sender, { senderStaffId: "member", isAdmin: true });
      if (mode === "cross-group") h.request.conversationId = "unrelated-group";
      if (mode === "wrong-reply") h.request.replyToSourceEventId = "unrelated-message";
      if (mode === "paused") h.db.exec("UPDATE collaboration_work_items SET control_state='paused'");
      if (mode === "accepted" || mode === "cancelled") h.db.prepare("UPDATE collaboration_work_items SET status=?").run(mode);
      if (mode === "running") h.db.prepare("UPDATE collaboration_natural_intake_jobs SET status='running',claim_token='live',lease_until=?").run(Date.now() + 60000);
      if (mode === "unknown-failure") h.db.exec("UPDATE collaboration_natural_intake_jobs SET error_code='unknown'");
      expect(h.recover().allowed).toBe(false);
      expect(h.db.prepare("SELECT count(*) n FROM collaboration_natural_intake_recoveries").get()).toEqual({ n: 0 });
    } finally { h.close(); }
  });
  it("rejects changed and cross-entry replay, and rolls back if reply persistence fails", async () => {
    const h = await fixture();
    try {
      const audits = h.db.prepare("SELECT * FROM collaboration_audit_events").all();
      h.db.exec("CREATE TRIGGER reject_recovery_reply BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_reply_failed'); END");
      expect(() => h.recover()).toThrow("fixture_reply_failed");
      expect(h.db.prepare("SELECT status,attempts FROM collaboration_natural_intake_jobs").get()).toEqual({ status: "failed", attempts: 3 });
      expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_recoveries").all()).toEqual([]);
      expect(h.db.prepare("SELECT * FROM collaboration_natural_intake_recovery_requests").all()).toEqual([]);
      expect(h.db.prepare("SELECT * FROM collaboration_audit_events").all()).toEqual(audits);
      h.db.exec("DROP TRIGGER reject_recovery_reply"); h.recover();
      expect(() => h.recover({ ...h.request, text: "重新整理需求" })).toThrow("natural_intake_recovery_event_conflict");
      expect(() => h.service.ingestDingTalkMessage({ ...h.request, text: "创建新任务" })).toThrow("natural_intake_recovery_event_conflict");
      expect(() => recoverAttachmentProjection(h.db, { ...h.request, text: "继续整理附件" }, Date.now(), () => {})).toThrow("natural_intake_recovery_event_conflict");
    } finally { h.close(); }
  });
  it("upgrades v24 without inventing Owner authorization or releasing failed work", async () => {
    const h = await fixture();
    const jobs = h.db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all();
    h.service.close();
    h.db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DELETE FROM collaboration_schema_migrations WHERE version>=25; PRAGMA user_version=24");
    h.db.close();
    const upgraded = openCollaborationLedger(join(h.directory, "collaboration"));
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 }); upgraded.close();
    const db = new DatabaseSync(h.file);
    try {
      expect(db.prepare("SELECT * FROM collaboration_natural_intake_jobs").all()).toEqual(jobs);
      expect(db.prepare("SELECT * FROM collaboration_natural_intake_recoveries").all()).toEqual([]);
    } finally { db.close(); }
  });
});
