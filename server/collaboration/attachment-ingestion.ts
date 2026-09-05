import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkAttachmentCapabilityVault } from "../integrations/dingtalk/attachment-capability-vault.ts";
import type { DingTalkAttachmentDownloadResult } from "../integrations/dingtalk/attachment-downloader.ts";
import type { DingTalkPrivateResourceCapability } from "../integrations/dingtalk/types.ts";
import {
  extractAttachmentText,
  MAX_EXTRACTED_CHARACTERS,
  type AttachmentTextChunk,
  type AttachmentTextExtraction,
  type AttachmentTextExtractionInput,
  type AttachmentTextFormat,
} from "./attachment-text-extractor.ts";
import { AttachmentStore, type StoredAttachment } from "./attachment-store.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

const STALE_CLAIM_MILLISECONDS = 5 * 60 * 1_000;
const BASE_RETRY_MILLISECONDS = 60 * 1_000;
const MAX_RETRY_MILLISECONDS = 60 * 60 * 1_000;
const PROCESS_LIMIT = 50;
const PROJECTION_CLAIM_MILLISECONDS = 60_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const UNSUPPORTED_EXTRACTION_ERRORS = new Set([
  "attachment_charset_unsupported",
  "attachment_extension_media_type_conflict",
  "attachment_extension_unsupported",
  "attachment_format_unknown",
  "attachment_media_type_unsupported",
]);

interface AttachmentDownloader {
  download(capability: DingTalkPrivateResourceCapability, signal?: AbortSignal): Promise<DingTalkAttachmentDownloadResult>;
}

export interface AttachmentEvidenceSource {
  provider: "dingtalk";
  externalEventId: string;
  sourceEventId: string;
  attachmentId: string;
  displayName: string | null;
  mediaType: string;
  contentHash: string;
}

export interface AttachmentEvidenceNotification {
  workItemId: string;
  source: AttachmentEvidenceSource;
  format: AttachmentTextFormat;
  chunks: AttachmentTextChunk[];
}

export interface AttachmentIngestionCoordinatorInput {
  signal?: AbortSignal;
  assertActive?: () => void;
  databaseFile: string;
  dataDirectory: string;
  vault: DingTalkAttachmentCapabilityVault;
  downloader: AttachmentDownloader;
  extract?: (input: AttachmentTextExtractionInput) => AttachmentTextExtraction | Promise<AttachmentTextExtraction>;
  onEvidence?: (notification: AttachmentEvidenceNotification) => void | Promise<void>;
}

export interface AttachmentIngestionProcessResult {
  processed: number;
  ready: number;
  unsupported: number;
  pending: number;
  failed: number;
}

interface TerminalCounts {
  ready: number;
  unsupported: number;
  pending: number;
  failed: number;
}

interface StaleAttachmentIdRow {
  id: string;
}

interface AttachmentStateRow {
  ingest_state: StoredAttachment["ingestState"];
}

interface WorkItemRow {
  work_item_id: string | null;
  source_event_id: string;
}

interface ProjectionRow {
  id: string;
}

interface ExtractionProjectionRow {
  id: string;
  metadata_json: string;
  source_hash: string;
}

interface ChunkProjectionRow {
  ordinal: number;
  content: string;
  content_hash: string;
}

interface ProjectionChunkMetadata {
  ordinal: number;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  warnings: string[];
  untrusted: true;
}

interface ProjectionMetadata {
  format: AttachmentTextFormat;
  mediaType: string;
  chunks: ProjectionChunkMetadata[];
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function retryAt(now: number, attempt: number): number {
  const exponent = Math.max(0, Math.min(6, attempt - 1));
  return now + Math.min(MAX_RETRY_MILLISECONDS, BASE_RETRY_MILLISECONDS * (2 ** exponent));
}

function extractionErrorCode(error: unknown): string {
  if (!(error instanceof Error) || !/^attachment_[a-z0-9_:-]+$/u.test(error.message)) {
    return "attachment_extraction_failed";
  }
  return error.message;
}

function emptyCounts(): TerminalCounts {
  return { ready: 0, unsupported: 0, pending: 0, failed: 0 };
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attachment_storage_directory_invalid");
  chmodSync(path, 0o700);
}

function verifyExistingContent(path: string, expectedHash: string, expectedBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) {
    throw new Error("attachment_storage_collision");
  }
  if (digest(readFileSync(path)) !== expectedHash) throw new Error("attachment_storage_collision");
  chmodSync(path, 0o600);
}

function writeContentAddressed(directory: string, contentHash: string, bytes: Uint8Array): void {
  if (!SHA256.test(contentHash)) throw new Error("attachment_content_hash_invalid");
  const destination = join(directory, contentHash);
  if (existsSync(destination)) {
    verifyExistingContent(destination, contentHash, bytes.byteLength);
    return;
  }

  const temporary = join(directory, `.${contentHash}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, destination);
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") throw error;
      verifyExistingContent(destination, contentHash, bytes.byteLength);
    }
    rmSync(temporary, { force: true });
    chmodSync(destination, 0o600);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup; the stable error below never includes a path.
      }
    }
    rmSync(temporary, { force: true });
    throw new Error("attachment_storage_write_failed");
  }
}

function readAttachment(database: DatabaseSync, id: string): StoredAttachment | null {
  const row = database.prepare(
    "SELECT id, external_event_id, ordinal, provider, capability_ref, resource_kind, display_name, media_type, " +
      "size_bytes, ingest_state, content_hash, managed_storage_key, error_code, evidence_projected_at, " +
      "evidence_projection_owner, evidence_projection_expires_at, attempt_count, " +
      "next_attempt_at, created_at, updated_at FROM collaboration_attachments WHERE id = ?",
  ).get(id) as {
    id: string;
    external_event_id: string;
    ordinal: number;
    provider: "dingtalk";
    capability_ref: string;
    resource_kind: StoredAttachment["kind"];
    display_name: string | null;
    media_type: string | null;
    size_bytes: number | null;
    ingest_state: StoredAttachment["ingestState"];
    content_hash: string | null;
    managed_storage_key: string | null;
    error_code: string | null;
    evidence_projected_at: number | null;
    evidence_projection_owner: string | null;
    evidence_projection_expires_at: number | null;
    attempt_count: number;
    next_attempt_at: number;
    created_at: number;
    updated_at: number;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    externalEventId: row.external_event_id,
    ordinal: row.ordinal,
    provider: row.provider,
    capabilityRef: row.capability_ref,
    kind: row.resource_kind,
    name: row.display_name,
    mimeType: row.media_type,
    sizeBytes: row.size_bytes,
    ingestState: row.ingest_state,
    contentHash: row.content_hash,
    managedStorageKey: row.managed_storage_key,
    errorCode: row.error_code,
    evidenceProjectedAt: row.evidence_projected_at,
    evidenceProjectionOwner: row.evidence_projection_owner,
    evidenceProjectionExpiresAt: row.evidence_projection_expires_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function staleAttachments(database: DatabaseSync, now: number): StoredAttachment[] {
  const rows = database.prepare(
    "SELECT id FROM collaboration_attachments WHERE ingest_state = 'downloading' AND updated_at <= ? " +
      "ORDER BY updated_at, created_at, external_event_id, ordinal LIMIT ?",
  ).all(now - STALE_CLAIM_MILLISECONDS, PROCESS_LIMIT) as unknown as StaleAttachmentIdRow[];
  return rows.flatMap((row) => {
    const attachment = readAttachment(database, row.id);
    return attachment ? [attachment] : [];
  });
}

function claim(database: DatabaseSync, attachment: StoredAttachment, now: number): number | null {
  const result = database.prepare(
    "UPDATE collaboration_attachments SET ingest_state = 'downloading', attempt_count = attempt_count + 1, " +
      "error_code = NULL, updated_at = ? WHERE id = ? AND " +
      "((ingest_state = 'pending' AND next_attempt_at <= ?) OR " +
      "(ingest_state = 'downloading' AND updated_at <= ?))",
  ).run(now, attachment.id, now, now - STALE_CLAIM_MILLISECONDS);
  return result.changes === 1 ? attachment.attemptCount + 1 : null;
}

function setDownloadFailure(
  database: DatabaseSync,
  attachmentId: string,
  attempt: number,
  now: number,
  result: Extract<DingTalkAttachmentDownloadResult, { ok: false }>,
): "pending" | "failed" {
  if (result.kind === "retryable") {
    database.prepare(
      "UPDATE collaboration_attachments SET ingest_state = 'pending', error_code = ?, next_attempt_at = ?, " +
        "updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
    ).run(result.code, retryAt(now, attempt), now, attachmentId, attempt);
    return "pending";
  }
  database.prepare(
    "UPDATE collaboration_attachments SET ingest_state = 'failed', error_code = ?, next_attempt_at = ?, " +
      "updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
  ).run(result.code, now, now, attachmentId, attempt);
  return "failed";
}

function setIntegrityFailure(
  database: DatabaseSync,
  attachmentId: string,
  attempt: number,
  now: number,
  errorCode: string,
): void {
  database.prepare(
    "UPDATE collaboration_attachments SET ingest_state = 'failed', error_code = ?, next_attempt_at = ?, " +
      "updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
  ).run(errorCode, now, now, attachmentId, attempt);
}

function extractionMetadata(extraction: AttachmentTextExtraction, mediaType: string): string {
  return JSON.stringify({
    format: extraction.format,
    mediaType,
    lineCount: extraction.lineCount,
    truncated: extraction.truncated,
    warnings: extraction.warnings,
    untrusted: true,
    chunks: extraction.chunks.map((chunk) => ({
      ordinal: chunk.ordinal,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      truncated: chunk.truncated,
      warnings: chunk.warnings,
      untrusted: true,
    })),
  });
}

function extractionEvidenceHash(sourceHash: string, extraction: AttachmentTextExtraction): string {
  return digest(JSON.stringify({
    extractor: extraction.extractor?.name ?? "bounded-text",
    extractorVersion: extraction.extractor?.version ?? "1",
    sourceHash,
    format: extraction.format,
    characterCount: extraction.characterCount,
    chunks: extraction.chunks.map((chunk) => chunk.textHash),
  }));
}

function workItemContext(
  database: DatabaseSync,
  attachment: StoredAttachment,
): { workItemId: string; sourceEventId: string } {
  const row = database.prepare(
    "SELECT event.work_item_id, event.source_event_id FROM collaboration_external_events event WHERE event.id = ?",
  ).get(attachment.externalEventId) as WorkItemRow | undefined;
  if (!row?.work_item_id) throw new Error("attachment_work_item_missing");
  return { workItemId: row.work_item_id, sourceEventId: row.source_event_id };
}

function commitSuccessfulExtraction(input: {
  assertActive: () => void;
  database: DatabaseSync;
  attachment: StoredAttachment;
  attempt: number;
  now: number;
  contentHash: string;
  storageKey: string;
  mediaType: string;
  extraction: AttachmentTextExtraction;
}): { workItemId: string; sourceEventId: string; extractionId: string } {
  const extractionId = randomUUID();
  const context = workItemContext(input.database, input.attachment);
  input.database.exec("BEGIN IMMEDIATE");
  try {
    input.assertActive();
    const claimed = input.database.prepare(
      "UPDATE collaboration_attachments SET ingest_state = 'extracting', content_hash = ?, managed_storage_key = ?, " +
        "error_code = NULL, updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
    ).run(input.contentHash, input.storageKey, input.now, input.attachment.id, input.attempt);
    if (claimed.changes !== 1) throw new Error("attachment_claim_superseded");
    input.database.prepare(
      "INSERT INTO collaboration_attachment_extractions " +
        "(id, attachment_id, attempt, extractor, extractor_version, source_hash, status, extracted_characters, " +
        "metadata_json, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, NULL, ?)",
    ).run(
      extractionId,
      input.attachment.id,
      input.attempt,
      input.extraction.extractor?.name ?? "bounded-text",
      input.extraction.extractor?.version ?? "1",
      input.contentHash,
      input.extraction.characterCount,
      extractionMetadata(input.extraction, input.mediaType),
      input.now,
    );

    let characterOffset = 0;
    const insertChunk = input.database.prepare(
      "INSERT INTO collaboration_attachment_chunks " +
        "(id, extraction_id, ordinal, content, content_hash, character_start, character_end, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEvidence = input.database.prepare(
      "INSERT OR IGNORE INTO collaboration_work_item_evidence " +
        "(id, work_item_id, attachment_id, extraction_id, evidence_kind, chunk_ordinal, evidence_hash, label, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertEvidence.run(
      randomUUID(), context.workItemId, input.attachment.id, null, "attachment", null,
      input.contentHash, "附件原文件", input.now,
    );
    insertEvidence.run(
      randomUUID(), context.workItemId, input.attachment.id, extractionId, "extraction", null,
      extractionEvidenceHash(input.contentHash, input.extraction), "附件文字提取", input.now,
    );
    for (const chunk of input.extraction.chunks) {
      const characterEnd = characterOffset + chunk.text.length;
      insertChunk.run(
        randomUUID(), extractionId, chunk.ordinal, chunk.text, chunk.textHash,
        characterOffset, characterEnd, input.now,
      );
      insertEvidence.run(
        randomUUID(), context.workItemId, input.attachment.id, extractionId, "chunk", chunk.ordinal,
        chunk.textHash, `附件内容 ${chunk.ordinal + 1}`, input.now,
      );
      characterOffset = characterEnd;
    }
    input.database.prepare(
      "UPDATE collaboration_attachments SET ingest_state = 'ready', error_code = NULL, updated_at = ? " +
        "WHERE id = ? AND ingest_state = 'extracting' AND attempt_count = ?",
    ).run(input.now, input.attachment.id, input.attempt);
    input.database.exec("COMMIT");
    return { ...context, extractionId };
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
}

function commitExtractionFailure(input: {
  assertActive: () => void;
  database: DatabaseSync;
  attachment: StoredAttachment;
  attempt: number;
  now: number;
  contentHash: string;
  storageKey: string;
  errorCode: string;
  unsupported: boolean;
  extractor: string;
}): void {
  input.database.exec("BEGIN IMMEDIATE");
  try {
    input.assertActive();
    if (!input.database.prepare("SELECT 1 FROM collaboration_attachments WHERE id=? AND ingest_state='downloading' AND attempt_count=?")
      .get(input.attachment.id, input.attempt)) throw new Error("attachment_claim_superseded");
    input.database.prepare(
      "INSERT INTO collaboration_attachment_extractions " +
        "(id, attachment_id, attempt, extractor, extractor_version, source_hash, status, extracted_characters, " +
        "metadata_json, error_code, created_at) VALUES (?, ?, ?, ?, '1', ?, ?, 0, ?, ?, ?)",
    ).run(
      randomUUID(),
      input.attachment.id,
      input.attempt,
      input.extractor,
      input.contentHash,
      input.unsupported ? "unsupported" : "failed",
      JSON.stringify({ untrusted: true }),
      input.errorCode,
      input.now,
    );
    input.database.prepare(
      "UPDATE collaboration_attachments SET ingest_state = ?, content_hash = ?, managed_storage_key = ?, " +
        "error_code = ?, next_attempt_at = ?, updated_at = ? " +
        "WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
    ).run(
      input.unsupported ? "unsupported" : "failed",
      input.contentHash,
      input.storageKey,
      input.errorCode,
      input.now,
      input.now,
      input.attachment.id,
      input.attempt,
    );
    input.database.exec("COMMIT");
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
}

function projectionFailure(): Error {
  return new Error("attachment_projection_evidence_invalid");
}

function projectionRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function projectionWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((warning) => typeof warning !== "string" || warning.length > 256)) {
    return null;
  }
  return [...value] as string[];
}

function parseProjectionMetadata(value: string): ProjectionMetadata {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw projectionFailure();
  }
  const root = projectionRecord(decoded);
  const format = root?.format;
  const mediaType = root?.mediaType;
  const rawChunks = root?.chunks;
  const rootWarnings = projectionWarnings(root?.warnings);
  if (
    (format !== "text" && format !== "markdown" && format !== "csv" && format !== "docx" && format !== "xlsx" && format !== "pdf") ||
    typeof mediaType !== "string" ||
    !mediaType ||
    mediaType.length > 255 ||
    root?.untrusted !== true || typeof root.truncated !== "boolean" || rootWarnings === null ||
    !Array.isArray(rawChunks) || rawChunks.length < 1 || rawChunks.length > 5000
  ) throw projectionFailure();

  const chunks: ProjectionChunkMetadata[] = [];
  for (const [index, rawChunk] of rawChunks.entries()) {
    const chunk = projectionRecord(rawChunk);
    const warnings = projectionWarnings(chunk?.warnings);
    if (
      chunk?.ordinal !== index ||
      !Number.isSafeInteger(chunk.lineStart) ||
      Number(chunk.lineStart) < 1 ||
      !Number.isSafeInteger(chunk.lineEnd) ||
      Number(chunk.lineEnd) < Number(chunk.lineStart) ||
      typeof chunk.truncated !== "boolean" ||
      chunk.untrusted !== true ||
      warnings === null
    ) throw projectionFailure();
    chunks.push({
      ordinal: index,
      lineStart: Number(chunk.lineStart),
      lineEnd: Number(chunk.lineEnd),
      truncated: root.truncated || chunk.truncated,
      warnings: [...new Set([...rootWarnings, ...warnings])],
      untrusted: true,
    });
  }
  return { format, mediaType, chunks };
}

export function readAttachmentEvidenceNotification(database: DatabaseSync, attachmentId: string): AttachmentEvidenceNotification {
  const attachment = readAttachment(database, attachmentId);
  if (
    !attachment ||
    attachment.ingestState !== "ready" ||
    !attachment.contentHash ||
    !SHA256.test(attachment.contentHash)
  ) throw projectionFailure();
  const extraction = database.prepare(
    "SELECT id, metadata_json, source_hash FROM collaboration_attachment_extractions " +
      "WHERE attachment_id = ? AND status = 'succeeded' ORDER BY attempt DESC LIMIT 1",
  ).get(attachment.id) as ExtractionProjectionRow | undefined;
  if (!extraction || extraction.source_hash !== attachment.contentHash || extraction.metadata_json.length > 1024 * 1024) throw projectionFailure();
  const metadata = parseProjectionMetadata(extraction.metadata_json);
  const bounds = database.prepare("SELECT count(*) AS count, coalesce(sum(length(content)),0) AS characters FROM collaboration_attachment_chunks WHERE extraction_id=?")
    .get(extraction.id) as { count: number; characters: number };
  if (bounds.count !== metadata.chunks.length || bounds.characters > MAX_EXTRACTED_CHARACTERS) throw projectionFailure();
  const rows = database.prepare(
    "SELECT ordinal, content, content_hash FROM collaboration_attachment_chunks " +
      "WHERE extraction_id = ? ORDER BY ordinal",
  ).all(extraction.id) as unknown as ChunkProjectionRow[];
  if (rows.length !== metadata.chunks.length) throw projectionFailure();
  const chunks = rows.map((row, index): AttachmentTextChunk => {
    const persisted = metadata.chunks[index];
    if (
      !persisted ||
      row.ordinal !== persisted.ordinal ||
      !SHA256.test(row.content_hash) ||
      digest(row.content) !== row.content_hash
    ) throw projectionFailure();
    return {
      ordinal: persisted.ordinal,
      lineStart: persisted.lineStart,
      lineEnd: persisted.lineEnd,
      text: row.content,
      textHash: row.content_hash,
      untrusted: true,
      truncated: persisted.truncated,
      warnings: [...persisted.warnings],
    };
  });
  const context = workItemContext(database, attachment);
  return {
    workItemId: context.workItemId,
    source: {
      provider: "dingtalk",
      externalEventId: attachment.externalEventId,
      sourceEventId: context.sourceEventId,
      attachmentId: attachment.id,
      displayName: attachment.name === null ? null : redactSensitiveText(attachment.name),
      mediaType: metadata.mediaType,
      contentHash: attachment.contentHash,
    },
    format: metadata.format,
    chunks,
  };
}

export class AttachmentIngestionCoordinator {
  private readonly signal: AbortSignal | undefined;
  private readonly activeGuard: (() => void) | undefined;
  private readonly databaseFile: string;
  private readonly attachmentDirectory: string;
  private readonly vault: DingTalkAttachmentCapabilityVault;
  private readonly downloader: AttachmentDownloader;
  private readonly extract: NonNullable<AttachmentIngestionCoordinatorInput["extract"]>;
  private readonly onEvidence: ((notification: AttachmentEvidenceNotification) => void | Promise<void>) | undefined;
  private readonly projectionOwner = randomUUID();

  constructor(input: AttachmentIngestionCoordinatorInput) {
    this.signal = input.signal;
    this.activeGuard = input.assertActive;
    this.databaseFile = input.databaseFile;
    this.vault = input.vault;
    this.downloader = input.downloader;
    this.extract = input.extract ?? extractAttachmentText;
    this.onEvidence = input.onEvidence;
    const collaborationDirectory = join(resolve(input.dataDirectory), "collaboration");
    this.attachmentDirectory = join(collaborationDirectory, "attachments");
    try {
      secureDirectory(collaborationDirectory);
      secureDirectory(this.attachmentDirectory);
    } catch {
      throw new Error("attachment_storage_directory_invalid");
    }
  }

  private assertActive(): void {
    if (this.signal?.aborted) throw new Error("attachment_ingestion_inactive");
    this.activeGuard?.();
  }

  persist(privateCapabilities: readonly DingTalkPrivateResourceCapability[], now: number): void {
    this.assertActive();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("attachment_timestamp_invalid");
    const database = new DatabaseSync(this.databaseFile);
    try { this.persistActiveCapabilities(database, privateCapabilities); }
    finally { database.close(); }
  }

  async process(
    privateCapabilities: readonly DingTalkPrivateResourceCapability[],
    now: number,
  ): Promise<AttachmentIngestionProcessResult> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("attachment_timestamp_invalid");
    const database = new DatabaseSync(this.databaseFile);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    try {
      this.assertActive();
      this.persistActiveCapabilities(database, privateCapabilities);
      await this.projectUnprojectedEvidence(database, now);
      this.assertActive();
      const pending = new AttachmentStore(database).readPending({ now, limit: PROCESS_LIMIT });
      const stale = staleAttachments(database, now);
      const candidates = [...stale, ...pending]
        .filter((attachment) => this.hasWorkItem(database, attachment))
        .slice(0, PROCESS_LIMIT);
      const counts = emptyCounts();
      let processed = 0;
      for (const attachment of candidates) {
        this.assertActive();
        const attempt = claim(database, attachment, now);
        if (attempt === null) continue;
        processed += 1;
        await this.processClaimed(database, attachment, attempt, now, counts);
      }
      await this.projectUnprojectedEvidence(database, now);
      this.assertActive();
      return { processed, ...counts };
    } finally {
      database.close();
    }
  }

  private hasWorkItem(database: DatabaseSync, attachment: StoredAttachment): boolean {
    return Boolean(database.prepare(
      "SELECT 1 FROM collaboration_external_events WHERE id = ? AND work_item_id IS NOT NULL",
    ).get(attachment.externalEventId));
  }

  private persistActiveCapabilities(
    database: DatabaseSync,
    privateCapabilities: readonly DingTalkPrivateResourceCapability[],
  ): void {
    const active: DingTalkPrivateResourceCapability[] = [];
    for (const capability of privateCapabilities) {
      const rows = database.prepare(
        "SELECT ingest_state FROM collaboration_attachments WHERE capability_ref = ?",
      ).all(capability.capabilityRef) as unknown as AttachmentStateRow[];
      if (rows.length === 0) throw new Error("attachment_capability_unregistered");
      if (rows.some((row) => row.ingest_state === "pending" || row.ingest_state === "downloading")) {
        active.push(capability);
      } else {
        this.vault.remove(capability.capabilityRef);
      }
    }
    if (active.length > 0) this.vault.store(active);
  }

  private async projectUnprojectedEvidence(database: DatabaseSync, now: number): Promise<void> {
    if (!this.onEvidence) return;
    const rows = database.prepare(
      "SELECT id FROM collaboration_attachments " +
        "WHERE ingest_state = 'ready' AND evidence_projected_at IS NULL " +
        "ORDER BY updated_at, created_at, external_event_id, ordinal LIMIT ?",
    ).all(PROCESS_LIMIT) as unknown as ProjectionRow[];
    for (const row of rows) {
      this.assertActive();
      const claimed = database.prepare(
        "UPDATE collaboration_attachments SET evidence_projection_owner = ?, " +
          "evidence_projection_expires_at = ? WHERE id = ? AND ingest_state = 'ready' " +
          "AND evidence_projected_at IS NULL AND (evidence_projection_owner IS NULL OR evidence_projection_expires_at <= ?)",
      ).run(this.projectionOwner, now + PROJECTION_CLAIM_MILLISECONDS, row.id, now);
      if (claimed.changes !== 1) continue;
      const notification = readAttachmentEvidenceNotification(database, row.id);
      try {
        this.assertActive();
        await this.onEvidence(notification);
        this.assertActive();
        database.prepare(
          "UPDATE collaboration_attachments SET evidence_projected_at = ?, evidence_projection_owner = NULL, " +
            "evidence_projection_expires_at = NULL WHERE id = ? AND ingest_state = 'ready' " +
            "AND evidence_projected_at IS NULL AND evidence_projection_owner = ?",
        ).run(now, row.id, this.projectionOwner);
      } catch (error) {
        this.assertActive();
        database.prepare(
          "UPDATE collaboration_attachments SET evidence_projection_owner = NULL, evidence_projection_expires_at = NULL " +
            "WHERE id = ? AND evidence_projected_at IS NULL AND evidence_projection_owner = ?",
        ).run(row.id, this.projectionOwner);
        throw error;
      }
    }
  }

  private async processClaimed(
    database: DatabaseSync,
    attachment: StoredAttachment,
    attempt: number,
    now: number,
    counts: TerminalCounts,
  ): Promise<void> {
    const assertClaim = () => {
      this.assertActive();
      if (!database.prepare("SELECT 1 FROM collaboration_attachments WHERE id=? AND ingest_state='downloading' AND attempt_count=?")
        .get(attachment.id, attempt)) throw new Error("attachment_claim_superseded");
    };
    assertClaim();
    let capability: DingTalkPrivateResourceCapability;
    try {
      capability = this.vault.read(attachment.capabilityRef);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "dingtalk_attachment_capability_corrupt") {
        setIntegrityFailure(database, attachment.id, attempt, now, "attachment_capability_corrupt");
        this.vault.remove(attachment.capabilityRef);
        counts.failed += 1;
        return;
      }
      database.prepare(
        "UPDATE collaboration_attachments SET ingest_state = 'pending', error_code = ?, next_attempt_at = ?, " +
          "updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
      ).run("attachment_capability_unavailable", retryAt(now, attempt), now, attachment.id, attempt);
      counts.pending += 1;
      return;
    }

    const downloaded = await this.downloader.download(capability, this.signal);
    assertClaim();
    if (!downloaded.ok) {
      const state = setDownloadFailure(database, attachment.id, attempt, now, downloaded);
      counts[state] += 1;
      if (state === "failed") this.vault.remove(attachment.capabilityRef);
      return;
    }
    const actualHash = digest(downloaded.bytes);
    if (
      downloaded.sha256 !== actualHash ||
      !SHA256.test(downloaded.sha256) ||
      (attachment.sizeBytes !== null && attachment.sizeBytes !== downloaded.bytes.byteLength)
    ) {
      setIntegrityFailure(database, attachment.id, attempt, now, "attachment_integrity_mismatch");
      this.vault.remove(attachment.capabilityRef);
      counts.failed += 1;
      return;
    }

    try {
      writeContentAddressed(this.attachmentDirectory, actualHash, downloaded.bytes);
    } catch {
      database.prepare(
        "UPDATE collaboration_attachments SET ingest_state = 'pending', error_code = ?, next_attempt_at = ?, " +
          "updated_at = ? WHERE id = ? AND ingest_state = 'downloading' AND attempt_count = ?",
      ).run("attachment_storage_write_failed", retryAt(now, attempt), now, attachment.id, attempt);
      counts.pending += 1;
      return;
    }

    const storageKey = `attachments/${actualHash}`;
    const mediaType = downloaded.mediaType ?? attachment.mimeType ?? "application/octet-stream";
    const displayName = attachment.name ?? "attachment";
    let extraction: AttachmentTextExtraction;
    try {
      extraction = await this.extract({ bytes: downloaded.bytes, mediaType, displayName });
    } catch (error) {
      assertClaim();
      const errorCode = extractionErrorCode(error);
      const unsupported = UNSUPPORTED_EXTRACTION_ERRORS.has(errorCode);
      commitExtractionFailure({
        assertActive: () => this.assertActive(),
        database,
        attachment,
        attempt,
        now,
        contentHash: actualHash,
        storageKey,
        errorCode,
        unsupported,
        extractor: this.extract === extractAttachmentText ? "bounded-text" : "configured-extractor",
      });
      this.vault.remove(attachment.capabilityRef);
      counts[unsupported ? "unsupported" : "failed"] += 1;
      return;
    }

    assertClaim();
    commitSuccessfulExtraction({
      assertActive: () => this.assertActive(),
      database,
      attachment,
      attempt,
      now,
      contentHash: actualHash,
      storageKey,
      mediaType,
      extraction,
    });
    this.vault.remove(attachment.capabilityRef);
    counts.ready += 1;
  }
}
