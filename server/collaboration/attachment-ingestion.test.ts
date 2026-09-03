import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

const VAULT_SECRET = "attachment-ingestion-test-secret-at-least-32-bytes";
const WORK_ITEM_ID = "WI-attachment-ingestion";
const EVENT_ID = "EV-attachment-ingestion";
const REF_A = "a".repeat(64);
const REF_B = "b".repeat(64);

const scratchDirectories: string[] = [];

afterEach(() => {
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
      onEvidence: (notification) => notifications.push(notification),
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
      onEvidence: (notification) => replayed.push(notification),
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
