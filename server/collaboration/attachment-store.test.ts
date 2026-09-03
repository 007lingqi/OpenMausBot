import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachmentStore, type PublicAttachmentResource } from "./attachment-store.ts";
import { applyCollaborationMigrations } from "./migrations.ts";

const EVENT_ID = "EV-attachment-test";
const WORK_ITEM_ID = "WI-attachment-test";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function publicFile(overrides: Partial<PublicAttachmentResource> = {}): PublicAttachmentResource {
  return {
    capabilityRef: HASH_A,
    kind: "file",
    name: "bug-report.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 128,
    ...overrides,
  };
}

function seedEvent(database: DatabaseSync): void {
  database
    .prepare(
      "INSERT INTO collaboration_principals " +
        "(id, source, resolution, display_name, created_at, updated_at) VALUES ('P1', 'dingtalk', 'resolved', 'Tester', 1, 1)",
    )
    .run();
  database.prepare("INSERT INTO collaboration_conversations (id, created_at) VALUES ('C1', 1)").run();
  database
    .prepare(
      "INSERT INTO collaboration_work_items " +
        "(id, conversation_id, title, status, version, created_by, created_at, updated_at) " +
        "VALUES (?, 'C1', 'attachment ingestion', 'collecting', 1, 'P1', 1, 1)",
    )
    .run(WORK_ITEM_ID);
  database
    .prepare(
      "INSERT INTO collaboration_external_events " +
        "(id, source, source_event_id, transport_message_id, conversation_id, principal_id, kind, normalized_json, " +
        "raw_hash, association_state, work_item_id, received_at) " +
        "VALUES (?, 'dingtalk', 'source-event-1', 'transport-1', 'C1', 'P1', 'message', '{}', ?, 'created', ?, 1)",
    )
    .run(EVENT_ID, "c".repeat(64), WORK_ITEM_ID);
}

describe("AttachmentStore", () => {
  let database: DatabaseSync;
  let store: AttachmentStore;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyCollaborationMigrations(database);
    seedEvent(database);
    store = new AttachmentStore(database);
  });

  afterEach(() => database.close());

  it("registers public resource provenance idempotently by event ordinal", () => {
    const first = store.registerPublicResources({ externalEventId: EVENT_ID, resources: [publicFile()], now: 10 });
    const replay = store.registerPublicResources({ externalEventId: EVENT_ID, resources: [publicFile()], now: 20 });

    expect(first).toHaveLength(1);
    expect(replay).toEqual(first);
    expect(first[0]).toMatchObject({
      externalEventId: EVENT_ID,
      ordinal: 0,
      capabilityRef: HASH_A,
      kind: "file",
      ingestState: "pending",
      attemptCount: 0,
      nextAttemptAt: 10,
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachments").get()).toEqual({ count: 1 });
  });

  it("rejects a changed replay instead of mutating persisted provenance", () => {
    store.registerPublicResources({ externalEventId: EVENT_ID, resources: [publicFile()], now: 10 });

    expect(() =>
      store.registerPublicResources({
        externalEventId: EVENT_ID,
        resources: [publicFile({ capabilityRef: HASH_B })],
        now: 20,
      }),
    ).toThrow("attachment_reference_conflict");
    expect(database.prepare("SELECT capability_ref FROM collaboration_attachments").get()).toEqual({
      capability_ref: HASH_A,
    });
  });

  it.each(["downloadCode", "robotCode", "downloadUrl", "accessToken", "secret"])(
    "rejects private capability field %s without persisting it",
    (field) => {
      const resource = { ...publicFile(), [field]: "replayable-secret" } as PublicAttachmentResource;
      expect(() =>
        store.registerPublicResources({ externalEventId: EVENT_ID, resources: [resource], now: 10 }),
      ).toThrow(`attachment_sensitive_capability_rejected:${field}`);
      expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachments").get()).toEqual({ count: 0 });
    },
  );

  it("validates the complete batch before writing any public rows", () => {
    const privateResource = { ...publicFile({ capabilityRef: HASH_B }), downloadCode: "secret" } as PublicAttachmentResource;
    expect(() =>
      store.registerPublicResources({
        externalEventId: EVENT_ID,
        resources: [publicFile(), privateResource],
        now: 10,
      }),
    ).toThrow("attachment_sensitive_capability_rejected:downloadCode");
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachments").get()).toEqual({ count: 0 });
  });

  it("rejects capability containers passed beside the public resource list", () => {
    const input = {
      externalEventId: EVENT_ID,
      resources: [publicFile()],
      now: 10,
      privateCapabilities: [{ capabilityRef: HASH_A, downloadCode: "secret" }],
    } as Parameters<AttachmentStore["registerPublicResources"]>[0];
    expect(() => store.registerPublicResources(input)).toThrow(
      "attachment_sensitive_capability_rejected:privateCapabilities",
    );
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachments").get()).toEqual({ count: 0 });
  });

  it("participates in the caller transaction so an inbound rollback removes attachment rows", () => {
    database.exec("BEGIN IMMEDIATE");
    store.registerPublicResources({ externalEventId: EVENT_ID, resources: [publicFile()], now: 10 });
    database.exec("ROLLBACK");

    expect(database.prepare("SELECT count(*) AS count FROM collaboration_attachments").get()).toEqual({ count: 0 });
  });

  it("reads only due pending resources in deterministic order", () => {
    store.registerPublicResources({
      externalEventId: EVENT_ID,
      resources: [publicFile(), publicFile({ capabilityRef: HASH_B, name: "screen.png", kind: "picture", mimeType: "image/png" })],
      now: 10,
    });
    database
      .prepare("UPDATE collaboration_attachments SET next_attempt_at = 30 WHERE ordinal = 0")
      .run();

    expect(store.readPending({ now: 20 }).map((entry) => entry.ordinal)).toEqual([1]);
    expect(store.readPending({ now: 30, limit: 1 }).map((entry) => entry.ordinal)).toEqual([1]);
  });

  it("keeps extraction, chunk, and work-item evidence immutable", () => {
    const [attachment] = store.registerPublicResources({
      externalEventId: EVENT_ID,
      resources: [publicFile()],
      now: 10,
    });
    database
      .prepare(
        "INSERT INTO collaboration_attachment_extractions " +
          "(id, attachment_id, attempt, extractor, extractor_version, source_hash, status, extracted_characters, " +
          "metadata_json, error_code, created_at) VALUES ('X1', ?, 1, 'xlsx', '1', ?, 'succeeded', 4, '{}', NULL, 11)",
      )
      .run(attachment.id, HASH_A);
    database
      .prepare(
        "INSERT INTO collaboration_attachment_chunks " +
          "(id, extraction_id, ordinal, content, content_hash, character_start, character_end, created_at) " +
          "VALUES ('CH1', 'X1', 0, 'test', ?, 0, 4, 12)",
      )
      .run(HASH_B);
    database
      .prepare(
        "INSERT INTO collaboration_work_item_evidence " +
          "(id, work_item_id, attachment_id, extraction_id, evidence_kind, chunk_ordinal, evidence_hash, label, created_at) " +
          "VALUES ('E1', ?, ?, 'X1', 'chunk', 0, ?, 'Bug row', 13)",
      )
      .run(WORK_ITEM_ID, attachment.id, HASH_B);

    expect(() => database.prepare("UPDATE collaboration_attachment_extractions SET metadata_json = '{}' WHERE id = 'X1'").run()).toThrow(
      "attachment extractions are immutable",
    );
    expect(() => database.prepare("DELETE FROM collaboration_attachment_chunks WHERE id = 'CH1'").run()).toThrow(
      "attachment chunks are immutable",
    );
    expect(() => database.prepare("DELETE FROM collaboration_work_item_evidence WHERE id = 'E1'").run()).toThrow(
      "work item evidence is immutable",
    );
  });
});
