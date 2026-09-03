import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ATTACHMENT_RESOURCE_KINDS = ["file", "picture", "audio", "video"] as const;

export type AttachmentResourceKind = (typeof ATTACHMENT_RESOURCE_KINDS)[number];

/** Public, non-replayable metadata safe to persist in the collaboration Ledger. */
export interface PublicAttachmentResource {
  capabilityRef: string;
  kind: AttachmentResourceKind;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface RegisterPublicResourcesInput {
  externalEventId: string;
  resources: readonly PublicAttachmentResource[];
  now: number;
}

export interface StoredAttachment {
  id: string;
  externalEventId: string;
  ordinal: number;
  provider: "dingtalk";
  capabilityRef: string;
  kind: AttachmentResourceKind;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  ingestState: "pending" | "downloading" | "stored" | "extracting" | "ready" | "unsupported" | "failed";
  contentHash: string | null;
  managedStorageKey: string | null;
  errorCode: string | null;
  evidenceProjectedAt: number | null;
  evidenceProjectionOwner: string | null;
  evidenceProjectionExpiresAt: number | null;
  attemptCount: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

interface AttachmentRow {
  id: string;
  external_event_id: string;
  ordinal: number;
  provider: "dingtalk";
  capability_ref: string;
  resource_kind: AttachmentResourceKind;
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
}

const ALLOWED_RESOURCE_KEYS = new Set(["capabilityRef", "kind", "name", "mimeType", "sizeBytes"]);
const ALLOWED_REGISTER_KEYS = new Set(["externalEventId", "resources", "now"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/u;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`attachment_${field}_invalid`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  const text = requiredText(value, field);
  if (text.length > 1024 || text.includes("\u0000")) throw new Error(`attachment_${field}_invalid`);
  return text;
}

function validatePublicResource(resource: PublicAttachmentResource): Required<Pick<PublicAttachmentResource, "capabilityRef" | "kind">> & {
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
} {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new Error("attachment_resource_invalid");
  }
  for (const key of Object.keys(resource)) {
    if (!ALLOWED_RESOURCE_KEYS.has(key)) throw new Error(`attachment_sensitive_capability_rejected:${key}`);
  }

  const capabilityRef = requiredText(resource.capabilityRef, "capability_ref");
  if (!SHA256.test(capabilityRef)) throw new Error("attachment_capability_ref_invalid");
  if (!(ATTACHMENT_RESOURCE_KINDS as readonly unknown[]).includes(resource.kind)) {
    throw new Error("attachment_resource_kind_invalid");
  }
  const name = optionalText(resource.name, "name");
  const mimeType = optionalText(resource.mimeType, "mime_type");
  if (mimeType !== null && !SAFE_MEDIA_TYPE.test(mimeType)) throw new Error("attachment_mime_type_invalid");
  if (
    resource.sizeBytes !== undefined &&
    (!Number.isSafeInteger(resource.sizeBytes) || resource.sizeBytes < 0)
  ) {
    throw new Error("attachment_size_bytes_invalid");
  }
  return {
    capabilityRef,
    kind: resource.kind,
    name,
    mimeType,
    sizeBytes: resource.sizeBytes ?? null,
  };
}

function toStoredAttachment(row: AttachmentRow): StoredAttachment {
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

const ATTACHMENT_COLUMNS =
  "id, external_event_id, ordinal, provider, capability_ref, resource_kind, display_name, media_type, " +
  "size_bytes, ingest_state, content_hash, managed_storage_key, error_code, evidence_projected_at, " +
  "evidence_projection_owner, evidence_projection_expires_at, attempt_count, " +
  "next_attempt_at, created_at, updated_at";

/**
 * Stores only public attachment provenance. This method deliberately does not open a transaction,
 * so inbound processing can atomically persist the event and its attachment references together.
 */
export class AttachmentStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  registerPublicResources(input: RegisterPublicResourcesInput): StoredAttachment[] {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("attachment_registration_invalid");
    for (const key of Object.keys(input)) {
      if (!ALLOWED_REGISTER_KEYS.has(key)) throw new Error(`attachment_sensitive_capability_rejected:${key}`);
    }
    const externalEventId = requiredText(input.externalEventId, "external_event_id");
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("attachment_timestamp_invalid");
    if (!Array.isArray(input.resources)) throw new Error("attachment_resources_invalid");
    const resources = input.resources.map(validatePublicResource);
    if (new Set(resources.map((resource) => resource.capabilityRef)).size !== resources.length) {
      throw new Error("attachment_capability_ref_duplicate");
    }

    const existingByOrdinal = this.database.prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM collaboration_attachments WHERE external_event_id = ? AND ordinal = ?`,
    );
    const insert = this.database.prepare(
      "INSERT INTO collaboration_attachments " +
        "(id, external_event_id, ordinal, provider, capability_ref, resource_kind, display_name, media_type, " +
        "size_bytes, ingest_state, next_attempt_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'dingtalk', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    );
    const result: StoredAttachment[] = [];

    for (const [ordinal, resource] of resources.entries()) {
      const existing = existingByOrdinal.get(externalEventId, ordinal) as AttachmentRow | undefined;
      if (existing) {
        if (
          existing.capability_ref !== resource.capabilityRef ||
          existing.resource_kind !== resource.kind ||
          existing.display_name !== resource.name ||
          existing.media_type !== resource.mimeType ||
          existing.size_bytes !== resource.sizeBytes
        ) {
          throw new Error("attachment_reference_conflict");
        }
        result.push(toStoredAttachment(existing));
        continue;
      }

      const id = randomUUID();
      insert.run(
        id,
        externalEventId,
        ordinal,
        resource.capabilityRef,
        resource.kind,
        resource.name,
        resource.mimeType,
        resource.sizeBytes,
        input.now,
        input.now,
        input.now,
      );
      const inserted = this.database
        .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM collaboration_attachments WHERE id = ?`)
        .get(id) as unknown as AttachmentRow;
      result.push(toStoredAttachment(inserted));
    }
    return result;
  }

  readPending(input: { now: number; limit?: number }): StoredAttachment[] {
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("attachment_timestamp_invalid");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("attachment_pending_limit_invalid");
    const rows = this.database
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS} FROM collaboration_attachments ` +
          "WHERE ingest_state = 'pending' AND next_attempt_at <= ? " +
          "ORDER BY next_attempt_at, created_at, external_event_id, ordinal LIMIT ?",
      )
      .all(input.now, limit) as unknown as AttachmentRow[];
    return rows.map(toStoredAttachment);
  }
}
