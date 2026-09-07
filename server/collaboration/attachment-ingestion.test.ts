import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DingTalkAttachmentCapabilityVault } from "../integrations/dingtalk/attachment-capability-vault.ts";
import type { DingTalkAttachmentDownloadResult } from "../integrations/dingtalk/attachment-downloader.ts";
import type { DingTalkPrivateResourceCapability } from "../integrations/dingtalk/types.ts";
import { AttachmentIngestionCoordinator, type AttachmentEvidenceNotification } from "./attachment-ingestion.ts";
import { AttachmentStore, type PublicAttachmentResource } from "./attachment-store.ts";
import { openCollaborationLedger } from "./db.ts";
import { extractAttachmentText } from "./attachment-text-extractor.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { createDingTalkDelivery, runCollaborationHeadless } from "../collaboration-headless.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./operations/runtime.ts";
import { NodeDockerCommandPort } from "./operations/docker-containment.ts";
import { DocumentResourceJournal } from "./operations/document-resource-journal.ts";
import { FetchDingTalkAttachmentDownloader } from "../integrations/dingtalk/attachment-downloader.ts";
import { DingTalkSessionReplyRegistry } from "../integrations/dingtalk/reply-router.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { recoverAttachmentProjection } from "./attachment-projection-recovery.ts";
import { claimAttachmentProjection, finishAttachmentProjection, isCurrentProjectionFeedback } from "./attachment-projection-retry.ts";
import { InboundMessageProcessor } from "./inbound.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { proactiveDestination } from "./delivery-routing.ts";

const VAULT_SECRET = "attachment-ingestion-test-secret-at-least-32-bytes";
const WORK_ITEM_ID = "WI-attachment-ingestion";
const EVENT_ID = "EV-attachment-ingestion";
const REF_A = "a".repeat(64);
const REF_B = "b".repeat(64);

const scratchDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function context(resources: PublicAttachmentResource[]) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "omb-attachment-ingestion-"));
  scratchDirectories.push(dataDirectory);
  const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
  const databaseFile = ledger.filePath;
  ledger.close();
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare(
    "INSERT INTO collaboration_principals " +
      "(id, source, resolution, display_name, created_at, updated_at) VALUES ('P1', 'dingtalk', 'resolved', 'Tester', 1, 1)",
  ).run();
  database.prepare("INSERT INTO collaboration_conversations (id, created_at) VALUES ('C1', 1)").run();
  database.prepare(
    "INSERT INTO collaboration_work_items " +
      "(id, conversation_id, title, status, version, created_by, created_at, updated_at) " +
      "VALUES (?, 'C1', 'attachment ingestion', 'collecting', 1, 'P1', 1, 1)",
  ).run(WORK_ITEM_ID);
  database.prepare(
    "INSERT INTO collaboration_external_events " +
      "(id, source, source_event_id, transport_message_id, conversation_id, principal_id, kind, normalized_json, " +
      "raw_hash, association_state, work_item_id, received_at) " +
      "VALUES (?, 'dingtalk', 'source-event-1', 'transport-1', 'C1', 'P1', 'message', '{}', ?, 'created', ?, 1)",
  ).run(EVENT_ID, "c".repeat(64), WORK_ITEM_ID);
  new AttachmentStore(database).registerPublicResources({ externalEventId: EVENT_ID, resources, now: 10 });
  database.close();
  return {
    dataDirectory,
    databaseFile,
    vault: new DingTalkAttachmentCapabilityVault(join(dataDirectory, "capability-vault"), VAULT_SECRET),
  };
}

function resource(overrides: Partial<PublicAttachmentResource> = {}): PublicAttachmentResource {
  return {
    capabilityRef: REF_A,
    kind: "file",
    name: "bug.md",
    mimeType: "text/markdown",
    ...overrides,
  };
}

function capability(ref = REF_A, code = "private-download-code"): DingTalkPrivateResourceCapability {
  return { capabilityRef: ref, downloadCode: code, robotCode: "robot-app" };
}

function row(databaseFile: string, ref = REF_A): Record<string, unknown> {
  const database = new DatabaseSync(databaseFile);
  const result = database.prepare(
    "SELECT ingest_state, content_hash, managed_storage_key, error_code, evidence_projected_at, " +
      "attempt_count, next_attempt_at " +
      "FROM collaboration_attachments WHERE capability_ref = ?",
  ).get(ref) as Record<string, unknown>;
  database.close();
  return result;
}

describe("AttachmentIngestionCoordinator", () => {
  it.each(["complete", "partial", "failed", "disabled", "cancelled", "recovered"] as const)("uses the headless document pipeline with %s evidence", async mode => {
    const setup = context([resource({ name: "bugs.pdf", mimeType: "application/pdf" })]);
    const credentialFile = join(setup.dataDirectory, "credentials.json");
    writeFileSync(credentialFile, JSON.stringify({ clientId: "fixture-app", clientSecret: VAULT_SECRET }), { mode: 0o600 });
    const image = `sha256:${"d".repeat(64)}`;
    const container = "e".repeat(64);
    const oldName = "omb-document-00000000-0000-4000-8000-000000000001", oldId = "f".repeat(64);
    const leaseDb = new DatabaseSync(setup.databaseFile);
    if (mode === "recovered") {
      const prior = new InstanceLeaseCoordinator(leaseDb, "old").acquire(100, 10)!;
      const journal = new DocumentResourceJournal(setup.databaseFile, "fixture-nonproduction", prior);
      journal.reserve(oldName, image, "c".repeat(64)); journal.created(oldName, oldId);
    }
    const instance = new InstanceLeaseCoordinator(leaseDb, "current").acquire(1000, 10_000)!;
    leaseDb.close();
    const source = Buffer.from("synthetic PDF fixture, never sent to a real parser");
    const controller = new AbortController();
    const download = vi.spyOn(FetchDingTalkAttachmentDownloader.prototype, "download").mockResolvedValue({ ok: true, bytes: source, sha256: hash(source), mediaType: "application/pdf" });
    const docker = vi.spyOn(NodeDockerCommandPort.prototype, "run").mockImplementation(async (args, options) => {
      if (args[0] === "inspect") return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify([
        { Id: oldId, Name: `/${oldName}`, Image: image, Config: { Labels: { "com.openmausbot.document.resource": oldName } } },
      ])) };
      if (args[0] === "container") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (args[0] === "create") {
        const journalDb = new DatabaseSync(setup.databaseFile);
        try {
          expect(journalDb.prepare("SELECT container_name,docker_context,instance_owner,instance_fence FROM collaboration_document_resources WHERE container_name=?").get(args[args.indexOf("--name") + 1]))
            .toEqual({ container_name: args[args.indexOf("--name") + 1], docker_context: "fixture-nonproduction", instance_owner: instance.ownerId, instance_fence: instance.fence });
          if (mode === "recovered") expect(journalDb.prepare("SELECT recovery_verified_absent FROM collaboration_document_resources WHERE container_name=?").get(oldName)).toEqual({ recovery_verified_absent: 1 });
        }
        finally { journalDb.close(); }
        return { exitCode: 0, stdout: Buffer.from(container), stderr: Buffer.alloc(0) };
      }
      if (args[0] === "rm") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (mode === "failed") throw new Error("private parser stderr must not escape");
      if (mode === "cancelled") {
        expect(options?.signal).toBe(controller.signal);
        controller.abort();
      }
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({ version: 1, format: "pdf",
        records: [{ location: "page:2", text: "登录失败 access_token=never-persist-this" }],
        truncated: mode === "partial", warnings: mode === "partial" ? ["unread_images"] : [],
      })) };
    });
    let options!: CollaborationHeadlessRuntimeOptions;
    await runCollaborationHeadless(["--health", "--data-dir", setup.dataDirectory], {
      OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_CREDENTIAL_FILE: credentialFile,
      OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "fixture-group",
      OMB_DOCUMENT_EXTRACTOR_ENABLED: mode === "disabled" ? "0" : "1",
      OMB_DOCUMENT_EXTRACTOR_IMAGE: image, OMB_DOCKER_CONTEXT: "fixture-nonproduction",
    }, { io: { stdin: Readable.from([]), stdout: { write() {} }, stderr: { write() {} }, once() {}, off() {} },
      createRuntime(input) { options = input; return new CollaborationHeadlessRuntime({ dataDirectory: setup.dataDirectory, probeOnly: true }); } });
    expect(docker).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    const onEvidence = vi.fn();
    const factoryContext = { databaseFile: setup.databaseFile, dataDirectory: setup.dataDirectory, signal: controller.signal, assertActive() {}, onEvidence, instance };
    const coordinator = options.attachmentIngestionFactory!(factoryContext);
    if (mode === "cancelled") {
      await expect(coordinator.process([capability()], 1000)).rejects.toThrow("attachment_ingestion_inactive");
      expect(onEvidence).not.toHaveBeenCalled();
      expect(row(setup.databaseFile).ingest_state).toBe("downloading");
    } else {
      await coordinator.process([capability()], 1000);
      await options.attachmentIngestionFactory!(factoryContext).process([], 2000);
      if (mode === "complete" || mode === "partial" || mode === "recovered") {
        expect(onEvidence).toHaveBeenCalledTimes(1);
        expect(onEvidence).toHaveBeenCalledWith(WORK_ITEM_ID, expect.objectContaining({ sourceEventId: "source-event-1", contentHash: hash(source),
          format: "pdf", truncated: mode === "partial", warnings: mode === "partial" ? ["unread_images"] : [],
          chunks: [expect.objectContaining({ untrusted: true, text: expect.stringContaining("page:2") })] }));
        const db = new DatabaseSync(setup.databaseFile);
        try {
          expect(db.prepare("SELECT extractor, extractor_version, source_hash FROM collaboration_attachment_extractions").get()).toEqual({ extractor: "docker-document", extractor_version: `1:${image}`, source_hash: hash(source) });
          expect(JSON.stringify(db.prepare("SELECT content FROM collaboration_attachment_chunks").all())).not.toContain("never-persist-this");
        } finally { db.close(); }
      } else {
        expect(onEvidence).not.toHaveBeenCalled();
        expect(row(setup.databaseFile).ingest_state).toBe(mode === "disabled" ? "unsupported" : "failed");
        expect(JSON.stringify(row(setup.databaseFile))).not.toContain("private parser");
      }
    }
    expect(download).toHaveBeenCalledTimes(1);
    if (mode === "disabled") expect(docker).not.toHaveBeenCalled();
    else {
      expect(docker).toHaveBeenCalledTimes(mode === "recovered" ? 6 : 3);
      expect(docker.mock.calls[mode === "recovered" ? 3 : 0][0]).toContain(image);
      expect(docker.mock.calls.at(-1)![0]).toEqual(["rm", "--force", container]);
      if (mode === "recovered") expect(docker.mock.calls.map(c => c[0][0])).toEqual(["inspect", "rm", "container", "create", "start", "rm"]);
    }
  });
  async function recoveryFixture(count = 1) {
    const setup = context(Array.from({ length: count }, (_, ordinal) => resource({ capabilityRef: ordinal ? REF_B : REF_A })));
    const bytes = Buffer.from("original bug evidence");
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } }).process([capability(), ...(count > 1 ? [capability(REF_B)] : [])], 1000);
    const registry = new LocalOwnerRegistry(setup.databaseFile);
    registry.bootstrap({ senderCorpId: "test-corp", senderStaffId: "test-owner", now: 1000 });
    registry.close();
    const db = new DatabaseSync(setup.databaseFile);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("INSERT INTO collaboration_conversation_aliases(source,external_id,conversation_id,created_at) VALUES('dingtalk','external-C1','C1',1000)");
    const attachments = db.prepare("SELECT id FROM collaboration_attachments ORDER BY ordinal").all() as Array<{ id: string }>;
    for (const attachment of attachments) for (let i = 0; i < 3; i++) db.prepare("INSERT INTO collaboration_attachment_projection_failures(attachment_id,claim_token,error_code,created_at,retry_after) VALUES(?,?,?,?,?)")
      .run(attachment.id, `${attachment.id}:${i}`, "attachment_projection_unavailable", 2000 + i, 3000);
    const message: DingTalkInboundMessage = { sourceEventId: "recover-1", transportMessageId: "recover-transport", conversationId: "external-C1", addressedToBot: true,
      text: "继续整理附件", sender: { senderCorpId: "test-corp", senderStaffId: "test-owner", senderId: "test-sender", displayName: "Owner" }, receivedAt: 4000 };
    return { ...setup, db, download, attachments, message, recover: (input = message) => recoverAttachmentProjection(db, input, 4000, () => {}) };
  }

  it("Owner resumes saved evidence once without re-download, task mutation or losing failure history", async () => {
    const f = await recoveryFixture();
    try {
      const work = f.db.prepare("SELECT * FROM collaboration_work_items").all();
      const before = f.db.prepare("SELECT * FROM collaboration_attachment_extractions").all();
      expect(f.recover()).toMatchObject({ allowed: true, duplicate: false, workItemId: WORK_ITEM_ID });
      expect(proactiveDestination(f.databaseFile, f.message.sourceEventId, new Map([["external-C1", "open-C1"]]))).toBe("open-C1");
      expect(f.recover()).toMatchObject({ allowed: true, duplicate: true });
      const ingress = new InboundMessageProcessor(f.databaseFile);
      try { expect(() => ingress.processDingTalkMessage({ ...f.message, text: "创建另一项任务" })).toThrow("attachment_recovery_event_conflict"); }
      finally { ingress.close(); }
      expect(f.db.prepare("SELECT * FROM collaboration_work_items").all()).toEqual(work);
      expect(f.db.prepare("SELECT owner_generation FROM collaboration_attachment_projection_recoveries").all()).toEqual([{ owner_generation: 1 }]);
      expect(() => f.recover({ ...f.message, text: "重新整理附件" })).toThrow("attachment_recovery_event_conflict");
      const onEvidence = vi.fn();
      await new AttachmentIngestionCoordinator({ ...f, downloader: { download: f.download }, onEvidence }).process([], 5000);
      expect(onEvidence).toHaveBeenCalledTimes(1);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT * FROM collaboration_attachment_extractions").all()).toEqual(before);
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 3 });
      expect(row(f.databaseFile).evidence_projected_at).toBe(5000);
      const notices = f.db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id='recover-1'").all() as Array<{ payload_json: string }>;
      expect(notices).toHaveLength(1);
      expect(JSON.stringify(renderDingTalkSessionMessage(JSON.parse(notices[0]!.payload_json)))).toContain("不代表代码修改已完成");
      expect(() => f.db.exec("DELETE FROM collaboration_attachment_projection_recoveries")).toThrow();
      expect(() => f.db.exec("DELETE FROM collaboration_attachment_recovery_requests")).toThrow();
    } finally { f.db.close(); }
  });

  it("a new window stops after three failures and replay cannot reopen it", async () => {
    const f = await recoveryFixture();
    try {
      f.recover();
      const onEvidence = vi.fn(() => { throw new Error("synthetic failure"); });
      for (const now of [5000, 10000, 15000]) await expect(new AttachmentIngestionCoordinator({ ...f, downloader: { download: f.download }, onEvidence }).process([], now)).rejects.toThrow("synthetic failure");
      expect(f.recover().duplicate).toBe(true);
      await new AttachmentIngestionCoordinator({ ...f, downloader: { download: f.download }, onEvidence }).process([], 20000);
      expect(onEvidence).toHaveBeenCalledTimes(3);
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 6 });
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_recoveries").get()).toEqual({ n: 1 });
      expect(isCurrentProjectionFeedback(f.db, { source_event_id: `attachment-feedback:${f.attachments[0]!.id}:projection:${f.attachments[0]!.id}:2`, aggregate_id: WORK_ITEM_ID, aggregate_version: 1 })).toBe(false);
    } finally { f.db.close(); }
  });

  it("clarifies multiple attachments and selects only the original message ordinal", async () => {
    const f = await recoveryFixture(2);
    try {
      expect(f.recover()).toMatchObject({ allowed: false, reason: "attachment_projection_recovery_ambiguous" });
      expect(f.recover({ ...f.message, sourceEventId: "recover-2", replyToSourceEventId: "source-event-1", text: "继续整理第二份附件" })).toMatchObject({ allowed: true });
      expect(f.db.prepare("SELECT attachment_id FROM collaboration_attachment_projection_recoveries").all()).toEqual([{ attachment_id: f.attachments[1]!.id }]);
    } finally { f.db.close(); }
  });

  it.each(["member", "cross-group", "wrong-reply", "paused", "cancelled", "accepted", "live-claim", "already-projected"])("does not reopen %s", async mode => {
    const f = await recoveryFixture();
    try {
      if (mode === "member") f.message.sender = Object.assign({}, f.message.sender, { senderStaffId: "member", isAdmin: true });
      if (mode === "cross-group") f.message.conversationId = "C2";
      if (mode === "wrong-reply") f.message.replyToSourceEventId = "unrelated-source";
      if (mode === "paused") f.db.exec("UPDATE collaboration_work_items SET control_state='paused'");
      if (mode === "cancelled" || mode === "accepted") f.db.prepare("UPDATE collaboration_work_items SET status=?").run(mode);
      if (mode === "live-claim") f.db.exec("UPDATE collaboration_attachments SET evidence_projection_owner='another-worker',evidence_projection_expires_at=9000");
      if (mode === "already-projected") f.db.exec("UPDATE collaboration_attachments SET evidence_projected_at=3000");
      expect(f.recover().allowed).toBe(false);
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_recoveries").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });

  it("atomically rolls back recovery and audit when reply persistence fails", async () => {
    const f = await recoveryFixture();
    try {
      const audits = f.db.prepare("SELECT * FROM collaboration_audit_events").all();
      f.db.exec("CREATE TRIGGER reject_recovery_reply BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_outbox_failed'); END");
      expect(() => f.recover()).toThrow("fixture_outbox_failed");
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_recoveries").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_attachment_recovery_requests").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT * FROM collaboration_audit_events").all()).toEqual(audits);
      f.db.exec("DROP TRIGGER reject_recovery_reply");
      expect(f.recover().allowed).toBe(true);
    } finally { f.db.close(); }
  });
  it("upgrades v22 preserving download failure receipts without inventing projection failures", async () => {
    // All later additive tables are removed to model a real v22 database.
    const setup = context([resource()]);
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: false, kind: "retryable", code: "dingtalk_attachment_timeout" }) } }).process([capability()], 1000);
    const db = new DatabaseSync(setup.databaseFile);
    const failures = db.prepare("SELECT * FROM collaboration_attachment_failures").all();
    const outbox = db.prepare("SELECT * FROM collaboration_outbox").all();
    db.exec("DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DELETE FROM collaboration_schema_migrations WHERE version>=23; PRAGMA user_version=22");
    db.close();
    const upgraded = openCollaborationLedger(join(setup.dataDirectory, "collaboration"));
    expect(upgraded.migrationState).toEqual({ schemaVersion: 30, appliedMigrations: 30 });
    upgraded.close();
    const after = new DatabaseSync(setup.databaseFile);
    expect(after.prepare("SELECT * FROM collaboration_attachment_failures").all()).toEqual(failures);
    expect(after.prepare("SELECT * FROM collaboration_outbox").all()).toEqual(outbox);
    expect(after.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 0 });
    after.close();
  });
  it("upgrades v23 preserving stopped projection receipts without inventing recovery authorization", async () => {
    const f = await recoveryFixture();
    const failures = f.db.prepare("SELECT * FROM collaboration_attachment_projection_failures").all();
    f.db.exec("DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DELETE FROM collaboration_schema_migrations WHERE version>=24; PRAGMA user_version=23");
    f.db.close();
    const upgraded = openCollaborationLedger(join(f.dataDirectory, "collaboration"));
    expect(upgraded.migrationState).toEqual({ schemaVersion: 30, appliedMigrations: 30 });
    upgraded.close();
    const db = new DatabaseSync(f.databaseFile);
    try {
      expect(db.prepare("SELECT * FROM collaboration_attachment_projection_failures").all()).toEqual(failures);
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_recoveries").get()).toEqual({ n: 0 });
      const onEvidence = vi.fn();
      await new AttachmentIngestionCoordinator({ ...f, downloader: { download: f.download }, onEvidence }).process([], 9000);
      expect(onEvidence).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("does not starve healthy projection behind a full batch of stopped attachments", async () => {
    const resources = Array.from({ length: 51 }, (_, i) => resource({ capabilityRef: (i + 1).toString(16).padStart(64, "0") }));
    const setup = context(resources);
    const bytes = Buffer.from("stored source");
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    const ingest = new AttachmentIngestionCoordinator({ ...setup, downloader: { download } });
    await ingest.process(resources.map(r => capability(r.capabilityRef)), 1000);
    await ingest.process([], 1001);
    const db = new DatabaseSync(setup.databaseFile);
    const stopped = db.prepare("SELECT id FROM collaboration_attachments ORDER BY ordinal LIMIT 50").all() as Array<{ id: string }>;
    for (const attachment of stopped) for (let attempt = 1; attempt <= 3; attempt++) {
      db.prepare("INSERT INTO collaboration_attachment_projection_failures(attachment_id,claim_token,error_code,created_at,retry_after) VALUES(?,?,?,?,?)")
        .run(attachment.id, `${attachment.id}:${attempt}`, "attachment_projection_unavailable", attempt, 1000);
    }
    const onEvidence = vi.fn();
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([], 10000);
    expect(onEvidence).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT ordinal FROM collaboration_attachments WHERE evidence_projected_at IS NOT NULL").all()).toEqual([{ ordinal: 50 }]);
    expect(download).toHaveBeenCalledTimes(51);
    db.close();
  });

  it.each(["superseded", "aborted"])("does not record a late projection failure after it is %s", async mode => {
    const setup = context([resource()]);
    const bytes = Buffer.from("retained evidence");
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const callback = vi.fn(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    const first = new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence: callback, signal: controller.signal });
    const pending = first.process([capability()], 1000);
    const rejected = expect(pending).rejects.toThrow(mode === "aborted" ? "attachment_ingestion_inactive" : "attachment_projection_claim_superseded");
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    if (mode === "aborted") controller.abort();
    else await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence() {} }).process([], 62000);
    reject(new Error("late secret detail"));
    await rejected;
    const db = new DatabaseSync(setup.databaseFile);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: mode === "aborted" ? 0 : 1 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_outbox").get()).toEqual({ n: mode === "aborted" ? 0 : 1 });
    expect(row(setup.databaseFile).evidence_projected_at).toBeNull();
    if (mode === "superseded") {
      await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence() {} }).process([], 63000);
      expect(row(setup.databaseFile).evidence_projected_at).toBe(63000);
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 1 });
    }
    db.close();
  });

  it("rolls back projection failure receipts if the notification cannot be saved", async () => {
    const setup = context([resource()]);
    const bytes = Buffer.from("stored source");
    const db = new DatabaseSync(setup.databaseFile);
    db.exec("CREATE TRIGGER reject_projection_feedback BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_outbox_failed'); END");
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: true, bytes, sha256: hash(bytes) }) }, onEvidence() { throw new Error("callback failed"); } });
    await expect(coordinator.process([capability()], 1000)).rejects.toThrow("fixture_outbox_failed");
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 0 });
    expect(row(setup.databaseFile).evidence_projected_at).toBeNull();
    db.exec("DROP TRIGGER reject_projection_feedback");
    await coordinator.process([], 62000);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 1 });
    await expect(coordinator.process([], 63000)).rejects.toThrow("callback failed");
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 2 });
    expect(() => db.exec("DELETE FROM collaboration_attachment_projection_failures")).toThrow();
    db.close();
  });

  it("stops repeated projection failures across restarts while preserving extracted content and truthful feedback", async () => {
    const setup = context([resource()]);
    const bytes = Buffer.from("a useful bug description");
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    const onEvidence = vi.fn(() => { throw new Error("private projection detail must not leak"); });
    for (const now of [1000, 6000, 11000]) {
      await expect(new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([capability()], now)).rejects.toThrow();
    }
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([], 16000);
    expect(onEvidence).toHaveBeenCalledTimes(3);
    expect(download).toHaveBeenCalledTimes(1);
    expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "ready", evidence_projected_at: null });
    const db = new DatabaseSync(setup.databaseFile);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_extractions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 3 });
    const notices = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE '%:projection:%'").all() as Array<{ payload_json: string }>;
    expect(notices).toHaveLength(2);
    const text = JSON.stringify(notices);
    expect(text).toContain("连续 3 次");
    expect(text).toContain("已保留");
    expect(text).not.toMatch(/尚未读到|读取失败|private projection detail|修改完成/);
    const rendered = JSON.stringify(renderDingTalkSessionMessage(JSON.parse(notices[1]!.payload_json)));
    expect(rendered).toContain("需求整理未完成");
    expect(rendered).not.toContain(WORK_ITEM_ID);
    db.close();
  });

  it("counts interrupted projection claims across restarts and stops after three without rereading the attachment", async () => {
    const setup = context([resource()]), bytes = Buffer.from("persisted bug description");
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } }).process([capability()], 1000);
    const db = new DatabaseSync(setup.databaseFile), onEvidence = vi.fn();
    try {
      const id = (db.prepare("SELECT id FROM collaboration_attachments").get() as { id: string }).id;
      const claims: string[] = [];
      for (const now of [2000, 64000, 128000]) {
        const token = claimAttachmentProjection(db, id, now, () => {});
        expect(token).not.toBeNull(); claims.push(token!);
        // Simulate process exit by leaving its durable claim without a callback result.
        await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([], now + 60000);
        expect(onEvidence).not.toHaveBeenCalled();
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: claims.length });
        expect(() => finishAttachmentProjection(db, { attachmentId: id, token: token!, now: now + 60000, assertActive() {} })).toThrow("attachment_projection_claim_superseded");
      }
      for (const now of [200000, 300000]) await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([], now);
      expect(claimAttachmentProjection(db, id, 300000, () => {})).toBeNull();
      expect(onEvidence).not.toHaveBeenCalled(); expect(download).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT claim_token FROM collaboration_attachment_projection_failures ORDER BY sequence").all())
        .toEqual(claims.map(claim_token => ({ claim_token })));
      const notices = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE '%:projection:%'").all() as Array<{ payload_json: string }>;
      expect(notices).toHaveLength(2);
      const reply = JSON.stringify(renderDingTalkSessionMessage(JSON.parse(notices[1]!.payload_json)));
      expect(reply).toContain("连续 3 次"); expect(reply).toContain("已保留");
      expect(reply).not.toMatch(/修改完成|读取失败|WI-/);
      expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "ready", evidence_projected_at: null });
      const registry = new LocalOwnerRegistry(setup.databaseFile);
      registry.bootstrap({ senderCorpId: "test-corp", senderStaffId: "test-owner", now: 300000 }); registry.close();
      db.exec("INSERT INTO collaboration_conversation_aliases(source,external_id,conversation_id,created_at) VALUES('dingtalk','external-C1','C1',300000)");
      const message: DingTalkInboundMessage = { sourceEventId: "resume-expired", transportMessageId: "transport-resume-expired", conversationId: "external-C1", addressedToBot: true,
        text: "继续整理附件", sender: { senderCorpId: "test-corp", senderStaffId: "test-owner", senderId: "test-sender", displayName: "Owner" }, receivedAt: 300001 };
      expect(recoverAttachmentProjection(db, { ...message, sourceEventId: "member-resume", sender: { ...message.sender, senderStaffId: "member" } }, 300001, () => {})).toMatchObject({ allowed: false });
      expect(recoverAttachmentProjection(db, message, 300001, () => {})).toMatchObject({ allowed: true, duplicate: false });
      expect(recoverAttachmentProjection(db, message, 300001, () => {})).toMatchObject({ allowed: true, duplicate: true });
      await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence }).process([], 300002);
      expect(onEvidence).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(1);
      expect(row(setup.databaseFile).evidence_projected_at).toBe(300002);
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 3 });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_recoveries").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it("does not reclaim a live projection and atomically rolls back expired-claim feedback failures", async () => {
    const setup = context([resource()]), bytes = Buffer.from("already extracted");
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: true, bytes, sha256: hash(bytes) }) } }).process([capability()], 1000);
    const db = new DatabaseSync(setup.databaseFile);
    try {
      const id = (db.prepare("SELECT id FROM collaboration_attachments").get() as { id: string }).id;
      const token = claimAttachmentProjection(db, id, 2000, () => {})!;
      expect(claimAttachmentProjection(db, id, 61999, () => {})).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 0 });
      db.exec("CREATE TRIGGER reject_expired_notice BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'notice_failed'); END");
      expect(() => claimAttachmentProjection(db, id, 62000, () => {})).toThrow("notice_failed");
      expect(db.prepare("SELECT evidence_projection_owner FROM collaboration_attachments").get()).toEqual({ evidence_projection_owner: token });
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER reject_expired_notice");
      expect(claimAttachmentProjection(db, id, 62000, () => {})).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_projection_failures").get()).toEqual({ n: 1 });
      expect(claimAttachmentProjection(db, id, 62001, () => {})).toBeNull();
      expect(claimAttachmentProjection(db, id, 63000, () => {})).not.toBeNull();
    } finally { db.close(); }
  });

  it("backs off projection retries, then suppresses obsolete feedback after successful projection", async () => {
    const setup = context([resource()]);
    const bytes = Buffer.from("recoverable projection");
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes, sha256: hash(bytes) }));
    const onEvidence = vi.fn().mockImplementationOnce(() => { throw new Error("temporary"); });
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence });
    await expect(coordinator.process([capability()], 1000)).rejects.toThrow();
    await coordinator.process([], 1001);
    expect(onEvidence).toHaveBeenCalledTimes(1);
    await coordinator.process([], 2000);
    expect(onEvidence).toHaveBeenCalledTimes(2);
    expect(row(setup.databaseFile).evidence_projected_at).toBe(2000);
    const db = new DatabaseSync(setup.databaseFile);
    const lease = new InstanceLeaseCoordinator(db, "projection-delivery").acquire(2000, 30000)!;
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const dispatcher = new OutboxDispatcher(db, { deliver }, { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 1, maxBackoffMs: 100 });
    expect(await dispatcher.dispatchOne(lease, 2000)).toMatchObject({ state: "superseded" });
    expect(deliver).not.toHaveBeenCalled();
    db.close();
  });

  it("rolls back failure evidence and state together when feedback persistence fails", async () => {
    const setup = context([resource()]);
    const db = new DatabaseSync(setup.databaseFile);
    db.exec("CREATE TRIGGER reject_feedback BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_feedback_unavailable'); END");
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: false, kind: "retryable", code: "dingtalk_attachment_timeout" }) } });
    await expect(coordinator.process([capability()], 1000)).rejects.toThrow("fixture_feedback_unavailable");
    expect(row(setup.databaseFile).ingest_state).toBe("downloading");
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_failures").get()).toEqual({ n: 0 });
    expect(setup.vault.read(REF_A)).toEqual(capability());
    db.exec("DROP TRIGGER reject_feedback");
    await coordinator.process([], 301001);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_failures").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_outbox").get()).toEqual({ n: 1 });
    db.close();
  });

  it("delivers attachment feedback to the original source session, not a newer task message", async () => {
    const setup = context([resource()]);
    const db = new DatabaseSync(setup.databaseFile);
    db.prepare("INSERT INTO collaboration_external_events(id,source,source_event_id,transport_message_id,conversation_id,principal_id,kind,normalized_json,raw_hash,association_state,work_item_id,received_at) " +
      "SELECT 'newer','dingtalk','newer-event','newer-transport',conversation_id,principal_id,kind,normalized_json,raw_hash,association_state,work_item_id,999 FROM collaboration_external_events WHERE id=?").run(EVENT_ID);
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: false, kind: "permanent", code: "dingtalk_attachment_resolve_rejected" }) } }).process([capability()], 1000);
    const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const sessions = new DingTalkSessionReplyRegistry();
    sessions.capture({ sourceEventId: "source-event-1", webhookUrl: "https://api.dingtalk.com/original-fixture", expiresAt: Date.now() + 60000 });
    sessions.capture({ sourceEventId: "newer-event", webhookUrl: "https://api.dingtalk.com/newer-fixture", expiresAt: Date.now() + 60000 });
    const lease = new InstanceLeaseCoordinator(db, "source-test").acquire(1000, 30000)!;
    const dispatcher = new OutboxDispatcher(db, createDingTalkDelivery(sessions, {}, setup.dataDirectory), { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 1, maxBackoffMs: 100 });
    expect(await dispatcher.dispatchOne(lease, 1000)).toMatchObject({ state: "sent" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.dingtalk.com/original-fixture");
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => { throw new Error("must not run"); } } }).process([], 2000);
    expect(await dispatcher.dispatchOne(lease, 2000)).toBeNull();
    db.close();
  });

  it("stops the third identical download failure across restarts and durably explains it once", async () => {
    const setup = context([resource()]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: false, kind: "retryable", code: "dingtalk_attachment_timeout" }));
    let now = 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } }).process([capability()], now);
      now = Number(row(setup.databaseFile).next_attempt_at);
    }
    expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "failed", attempt_count: 3 });
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } }).process([capability()], now + 1000000);
    expect(download).toHaveBeenCalledTimes(3);
    const db = new DatabaseSync(setup.databaseFile);
    const notices = db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE 'attachment-feedback:%' ORDER BY created_at").all() as Array<{ payload_json: string }>;
    expect(notices).toHaveLength(2);
    expect(JSON.stringify(notices)).toContain("连续 3 次");
    expect(JSON.stringify(notices)).not.toMatch(/private-download-code|dingtalk_attachment_timeout/);
    const rendered = JSON.stringify(renderDingTalkSessionMessage(JSON.parse(notices[1]!.payload_json)));
    expect(rendered).toContain("连续 3 次");
    expect(rendered).not.toContain(WORK_ITEM_ID);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_failures").get()).toEqual({ n: 3 });
    expect(() => db.exec("DELETE FROM collaboration_attachment_failures")).toThrow();
    db.close();
  });

  it("counts consecutive failure reasons rather than total attempts", async () => {
    const setup = context([resource()]);
    const codes = ["dingtalk_attachment_timeout", "dingtalk_attachment_timeout", "dingtalk_attachment_download_transport", "dingtalk_attachment_timeout", "dingtalk_attachment_timeout", "dingtalk_attachment_timeout"];
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: false, kind: "retryable", code: codes.shift()! }));
    let now = 1000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } }).process([capability()], now);
      expect(row(setup.databaseFile).ingest_state).toBe(attempt === 6 ? "failed" : "pending");
      now = Number(row(setup.databaseFile).next_attempt_at);
    }
  });

  it("suppresses queued retry feedback after attachment recovery", async () => {
    const setup = context([resource()]);
    let now = 1000;
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: false, kind: "retryable", code: "dingtalk_attachment_timeout" }) } }).process([capability()], now);
    now = Number(row(setup.databaseFile).next_attempt_at);
    const bytes = Buffer.from("recovered");
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download: async () => ({ ok: true, bytes, sha256: hash(bytes) }) } }).process([], now);
    const db = new DatabaseSync(setup.databaseFile);
    const lease = new InstanceLeaseCoordinator(db, "feedback-test").acquire(now, 30000)!;
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const dispatcher = new OutboxDispatcher(db, { deliver }, { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 1, maxBackoffMs: 100 });
    expect(await dispatcher.dispatchOne(lease, now)).toMatchObject({ state: "superseded" });
    expect(deliver).not.toHaveBeenCalled();
    db.close();
  });

  it.each(["download", "extract-success", "extract-failure"])("fences a superseded attempt after delayed %s without changing evidence or removing capabilities", async (stage) => {
    const setup = context([resource()]);
    const bytes = Buffer.from("delayed content");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    const onEvidence = vi.fn();
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, onEvidence,
      downloader: { async download() {
        if (stage === "download") { waiting = true; await gate; }
        return { ok: true, bytes, sha256: hash(bytes), mediaType: "text/plain" };
      } },
      async extract(input) {
        if (stage !== "download") { waiting = true; await gate; }
        if (stage === "extract-failure") throw new Error("attachment_fixture_failure");
        return extractAttachmentText(input);
      },
    });
    const pending = coordinator.process([capability()], 1000);
    const rejected = expect(pending).rejects.toThrow("attachment_claim_superseded");
    await vi.waitFor(() => expect(waiting).toBe(true));
    const db = new DatabaseSync(setup.databaseFile);
    db.prepare("UPDATE collaboration_attachments SET attempt_count=attempt_count+1,updated_at=2000").run();
    const before = row(setup.databaseFile);
    release();
    await rejected;
    expect(row(setup.databaseFile)).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_extractions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_work_item_evidence").get()).toEqual({ n: 0 });
    expect(setup.vault.read(REF_A)).toEqual(capability());
    expect(onEvidence).not.toHaveBeenCalled();
    db.close();
  });

  it("persists a capability without downloading and refuses a late result after cancellation", async () => {
    const setup = context([resource()]);
    const controller = new AbortController();
    let release!: (value: DingTalkAttachmentDownloadResult) => void;
    const download = vi.fn(() => new Promise<DingTalkAttachmentDownloadResult>(resolve => { release = resolve; }));
    const onEvidence = vi.fn();
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, signal: controller.signal, downloader: { download }, onEvidence });
    coordinator.persist([capability()], 1000);
    expect(download).not.toHaveBeenCalled();
    expect(setup.vault.read(REF_A).downloadCode).toBe("private-download-code");
    const pending = coordinator.process([], 1000);
    const rejected = expect(pending).rejects.toThrow("attachment_ingestion_inactive");
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    controller.abort();
    const bytes = Buffer.from("late source");
    release({ ok: true, bytes, sha256: hash(bytes), mediaType: "text/plain" });
    await rejected;
    expect(onEvidence).not.toHaveBeenCalled();
    expect(row(setup.databaseFile).ingest_state).toBe("downloading");
    const db = new DatabaseSync(setup.databaseFile);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_attachment_extractions").get()).toEqual({ n: 0 });
    db.close();
  });
  it("does not attribute a configured document parser failure to bounded-text", async () => {
    const source = Buffer.from("fake document");
    const setup = context([resource({ name: "bug.pdf", mimeType: "application/pdf" })]);
    const result = await new AttachmentIngestionCoordinator({ ...setup,
      downloader: { download: async () => ({ ok: true, bytes: source, sha256: hash(source), mediaType: "application/pdf" }) },
      extract: async () => { throw new Error("attachment_document_extraction_failed"); },
    }).process([capability()], 1000);
    expect(result.failed).toBe(1);
    const db = new DatabaseSync(setup.databaseFile);
    expect(db.prepare("SELECT extractor FROM collaboration_attachment_extractions").get()).toEqual({ extractor: "configured-extractor" });
    db.close();
  });
  it("persists async document parser provenance and replays partial source chunks after restart", async () => {
    const source = Buffer.from("fake document bytes");
    const setup = context([resource({ name: "bugs.pdf", mimeType: "application/pdf" })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({ ok: true, bytes: source, sha256: hash(source), mediaType: "application/pdf" }));
    const parsed = extractAttachmentText({ bytes: Buffer.from("page:1 登录失败"), displayName: "parsed.txt", mediaType: "text/plain" });
    const extract = vi.fn(async () => ({ ...parsed, format: "pdf" as const, truncated: true,
      extractor: { name: "docker-document", version: "1:sha256:test-fixture" },
      chunks: parsed.chunks.map(chunk => ({ ...chunk, truncated: true, warnings: ["unread_images"] })) }));
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, extract }).process([capability()], 1000);
    const notifications: AttachmentEvidenceNotification[] = [];
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence: notice => { notifications.push(notice); } }).process([], 2000);
    expect(download).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(notifications[0]).toMatchObject({ format: "pdf", chunks: [{ truncated: true, warnings: ["unread_images"], untrusted: true }] });
    const db = new DatabaseSync(setup.databaseFile);
    expect(db.prepare("SELECT extractor, extractor_version FROM collaboration_attachment_extractions").get()).toEqual({ extractor: "docker-document", extractor_version: "1:sha256:test-fixture" });
    db.close();
  });
  it("stores, extracts, and commits redacted immutable evidence before marking ready", async () => {
    const source = new TextEncoder().encode("复现步骤\naccess_token=never-expose-this\n点击登录");
    const setup = context([resource({ sizeBytes: source.byteLength })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "text/markdown",
    }));
    const notifications: AttachmentEvidenceNotification[] = [];
    const coordinator = new AttachmentIngestionCoordinator({
      ...setup,
      downloader: { download },
      onEvidence: (notification) => { notifications.push(notification); },
    });

    await expect(coordinator.process([capability()], 1_000)).resolves.toEqual({
      processed: 1,
      ready: 1,
      unsupported: 0,
      pending: 0,
      failed: 0,
    });

    const contentHash = hash(source);
    expect(row(setup.databaseFile)).toMatchObject({
      ingest_state: "ready",
      content_hash: contentHash,
      managed_storage_key: `attachments/${contentHash}`,
      error_code: null,
      attempt_count: 1,
    });
    const attachmentDirectory = join(setup.dataDirectory, "collaboration", "attachments");
    const attachmentPath = join(attachmentDirectory, contentHash);
    expect(readFileSync(attachmentPath)).toEqual(Buffer.from(source));
    if (process.platform !== "win32") {
      expect(statSync(attachmentDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(attachmentPath).mode & 0o777).toBe(0o600);
    }

    const database = new DatabaseSync(setup.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachment_extractions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachment_chunks").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_work_item_evidence").get()).toEqual({ count: 3 });
    const persisted = JSON.stringify({
      extraction: database.prepare("SELECT * FROM collaboration_attachment_extractions").all(),
      chunks: database.prepare("SELECT * FROM collaboration_attachment_chunks").all(),
      evidence: database.prepare("SELECT * FROM collaboration_work_item_evidence").all(),
    });
    database.close();
    expect(persisted).toContain("[敏感信息已隐藏]");
    expect(persisted).not.toContain("never-expose-this");
    expect(persisted).not.toContain("private-download-code");
    expect(JSON.stringify(notifications)).not.toContain("never-expose-this");
    expect(JSON.stringify(notifications)).not.toContain("private-download-code");
    expect(JSON.stringify(notifications)).not.toContain("downloadCode");
    expect(notifications[0]).toMatchObject({
      workItemId: WORK_ITEM_ID,
      source: {
        provider: "dingtalk",
        externalEventId: EVENT_ID,
        sourceEventId: "source-event-1",
        contentHash,
      },
      format: "markdown",
      chunks: [{ untrusted: true }],
    });
    expect(row(setup.databaseFile)).toMatchObject({ evidence_projected_at: 1_000 });
    expect(() => setup.vault.read(REF_A)).toThrow("dingtalk_attachment_capability_not_found");
  });

  it("does not download or duplicate evidence when a ready capability is replayed", async () => {
    const source = new TextEncoder().encode("one line");
    const setup = context([resource({ sizeBytes: source.byteLength })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "text/markdown",
    }));
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download } });
    await coordinator.process([capability()], 1_000);
    await coordinator.process([capability()], 2_000);

    expect(download).toHaveBeenCalledTimes(1);
    const database = new DatabaseSync(setup.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachment_extractions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_work_item_evidence").get()).toEqual({ count: 3 });
    database.close();
    expect(() => setup.vault.read(REF_A)).toThrow("dingtalk_attachment_capability_not_found");
  });

  it("replays an unprojected ready attachment after callback failure without downloading or duplicating evidence", async () => {
    const source = new TextEncoder().encode("recover projection\naccess_token=never-project-this");
    const setup = context([resource({ sizeBytes: source.byteLength })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "text/markdown",
    }));
    let firstNotification: AttachmentEvidenceNotification | undefined;
    const first = new AttachmentIngestionCoordinator({
      ...setup,
      downloader: { download },
      onEvidence: (notification) => {
        firstNotification = notification;
        throw new Error("projection temporarily unavailable");
      },
    });

    await expect(first.process([capability()], 1_000)).rejects.toThrow("projection temporarily unavailable");
    expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "ready", evidence_projected_at: null });
    expect(download).toHaveBeenCalledTimes(1);

    const replayed: AttachmentEvidenceNotification[] = [];
    const restarted = new AttachmentIngestionCoordinator({
      ...setup,
      downloader: { download },
      onEvidence: (notification) => { replayed.push(notification); },
    });
    await expect(restarted.process([], 2_000)).resolves.toEqual({
      processed: 0,
      ready: 0,
      unsupported: 0,
      pending: 0,
      failed: 0,
    });
    expect(replayed).toEqual([firstNotification]);
    expect(JSON.stringify(replayed)).not.toContain("never-project-this");
    expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "ready", evidence_projected_at: 2_000 });
    expect(download).toHaveBeenCalledTimes(1);
    const database = new DatabaseSync(setup.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachment_extractions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_work_item_evidence").get()).toEqual({ count: 3 });
    database.close();

    await restarted.process([], 3_000);
    expect(replayed).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("claims an unprojected attachment atomically across concurrent coordinators", async () => {
    const source = new TextEncoder().encode("single projection");
    const setup = context([resource({ sizeBytes: source.byteLength })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "text/markdown",
    }));
    await new AttachmentIngestionCoordinator({ ...setup, downloader: { download } })
      .process([capability()], 1_000);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notifications: AttachmentEvidenceNotification[] = [];
    const onEvidence = vi.fn(async (notification: AttachmentEvidenceNotification) => {
      notifications.push(notification);
      await gate;
    });
    const first = new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence });
    const second = new AttachmentIngestionCoordinator({ ...setup, downloader: { download }, onEvidence });
    const firstRun = first.process([], 2_000);
    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledTimes(1));
    await expect(second.process([], 2_000)).resolves.toMatchObject({ processed: 0 });
    expect(onEvidence).toHaveBeenCalledTimes(1);
    release?.();
    await firstRun;
    expect(notifications).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(row(setup.databaseFile)).toMatchObject({ evidence_projected_at: 2_000 });
  });

  it("keeps retryable capabilities with backoff and removes permanent failures", async () => {
    const setup = context([
      resource({ capabilityRef: REF_A, name: "a.txt", mimeType: "text/plain" }),
      resource({ capabilityRef: REF_B, name: "b.txt", mimeType: "text/plain" }),
    ]);
    const download = vi.fn(async (privateCapability: DingTalkPrivateResourceCapability): Promise<DingTalkAttachmentDownloadResult> =>
      privateCapability.capabilityRef === REF_A
        ? { ok: false, kind: "retryable", code: "dingtalk_attachment_download_transport" }
        : { ok: false, kind: "permanent", code: "dingtalk_attachment_download_url_unsafe" });
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download } });

    await expect(coordinator.process([capability(REF_A, "private-a"), capability(REF_B, "private-b")], 10_000))
      .resolves.toEqual({ processed: 2, ready: 0, unsupported: 0, pending: 1, failed: 1 });
    expect(row(setup.databaseFile, REF_A)).toMatchObject({
      ingest_state: "pending",
      error_code: "dingtalk_attachment_download_transport",
      attempt_count: 1,
    });
    expect(Number(row(setup.databaseFile, REF_A).next_attempt_at)).toBeGreaterThan(10_000);
    expect(setup.vault.read(REF_A)).toMatchObject({ capabilityRef: REF_A, downloadCode: "private-a" });
    expect(row(setup.databaseFile, REF_B)).toMatchObject({
      ingest_state: "failed",
      error_code: "dingtalk_attachment_download_url_unsafe",
      attempt_count: 1,
    });
    expect(() => setup.vault.read(REF_B)).toThrow("dingtalk_attachment_capability_not_found");
  });

  it("stores a downloaded unsupported format but creates no chunk evidence", async () => {
    const source = new TextEncoder().encode("%PDF-test");
    const setup = context([resource({ name: "report.pdf", mimeType: "application/pdf", sizeBytes: source.byteLength })]);
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "application/pdf",
    }));
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download } });

    await expect(coordinator.process([capability()], 1_000)).resolves.toMatchObject({
      processed: 1,
      unsupported: 1,
    });
    expect(row(setup.databaseFile)).toMatchObject({
      ingest_state: "unsupported",
      content_hash: hash(source),
      managed_storage_key: `attachments/${hash(source)}`,
      error_code: "attachment_extension_unsupported",
    });
    const database = new DatabaseSync(setup.databaseFile);
    expect(database.prepare("SELECT status, error_code FROM collaboration_attachment_extractions").get()).toEqual({
      status: "unsupported",
      error_code: "attachment_extension_unsupported",
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachment_chunks").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_work_item_evidence").get()).toEqual({ count: 0 });
    database.close();
    expect(existsSync(join(setup.dataDirectory, "collaboration", "attachments", hash(source)))).toBe(true);
    expect(() => setup.vault.read(REF_A)).toThrow("dingtalk_attachment_capability_not_found");
  });

  it("reclaims a downloading attachment only after its five-minute claim is stale", async () => {
    const source = new TextEncoder().encode("recovered");
    const setup = context([resource({ sizeBytes: source.byteLength })]);
    setup.vault.store([capability()]);
    const database = new DatabaseSync(setup.databaseFile);
    database.prepare(
      "UPDATE collaboration_attachments SET ingest_state = 'downloading', attempt_count = 1, updated_at = ?",
    ).run(1_000);
    database.close();
    const download = vi.fn(async (): Promise<DingTalkAttachmentDownloadResult> => ({
      ok: true,
      bytes: source,
      sha256: hash(source),
      mediaType: "text/markdown",
    }));
    const coordinator = new AttachmentIngestionCoordinator({ ...setup, downloader: { download } });

    await expect(coordinator.process([], 300_999)).resolves.toMatchObject({ processed: 0 });
    await expect(coordinator.process([], 301_000)).resolves.toMatchObject({ processed: 1, ready: 1 });
    expect(download).toHaveBeenCalledTimes(1);
    expect(row(setup.databaseFile)).toMatchObject({ ingest_state: "ready", attempt_count: 2 });
  });
});
