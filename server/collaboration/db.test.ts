import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { COLLABORATION_DATABASE_NAME, openCollaborationLedger } from "./db.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-collaboration-ledger-"));
  scratch.push(directory);
  return directory;
}

describe("collaboration ledger", () => {
  it("upgrades v21 without fabricating historical attachment failures", () => {
    const directory = temporaryDirectory();
    const store = openCollaborationLedger(directory); store.close();
    const db = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    db.exec("DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=22; PRAGMA user_version=21");
    const before = db.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 23, appliedMigrations: 23 });
    upgraded.close();
    const after = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(before);
    expect(after.prepare("SELECT count(*) AS n FROM collaboration_attachment_failures").get()).toEqual({ n: 0 });
    after.close();
  });
  it("upgrades v19 without losing existing reservations and creates immutable execution lifecycle tables", () => {
    const directory = temporaryDirectory(); const store = openCollaborationLedger(directory); store.close();
    const db = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    db.prepare("INSERT INTO collaboration_acceptance_mapping_attempts VALUES('v19-preserved',1,'{}',1000)").run();
    for (const kind of ["execution", "verification"]) {
      for (const table of ["commands", "proofs"]) db.exec(`DROP TRIGGER ${kind}_${table}_finalizing`);
      db.exec(`DROP TABLE collaboration_${kind}_finalization_intents`);
    }
    for (const table of ["proofs", "commands", "settlements", "sessions"]) db.exec(`DROP TABLE collaboration_execution_${table}`);
    db.exec("DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=20; PRAGMA user_version=19"); db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState.schemaVersion).toBe(23); upgraded.close();
    const after = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    try {
      expect(after.prepare("SELECT request_key FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ request_key: "v19-preserved" });
      expect(after.prepare("SELECT count(*) AS n FROM collaboration_execution_sessions").get()).toEqual({ n: 0 });
      expect(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'execution_%_no_%'").get()).toEqual({ n: 10 });
    } finally { after.close(); }
  });
  it("upgrades an existing v18 ledger without losing mapping reservations", () => {
    const directory=temporaryDirectory(); const store=openCollaborationLedger(directory); store.close();
    const db=new DatabaseSync(join(directory,COLLABORATION_DATABASE_NAME));
    db.prepare("INSERT INTO collaboration_acceptance_mapping_attempts VALUES('preserved',1,'{}',1000)").run();
    for (const kind of ["execution", "verification"]) {
      for (const table of ["commands", "proofs"]) db.exec(`DROP TRIGGER ${kind}_${table}_finalizing`);
      db.exec(`DROP TABLE collaboration_${kind}_finalization_intents`);
    }
    for(const table of ["proofs","commands","settlements","sessions"]) db.exec(`DROP TABLE collaboration_execution_${table}`);
    for(const table of ["proofs","commands","settlements","sessions"]) db.exec(`DROP TABLE collaboration_verification_${table}`);
    db.exec("DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=19; PRAGMA user_version=18"); db.close();
    const upgraded=openCollaborationLedger(directory);
    expect(upgraded.migrationState.schemaVersion).toBe(23); upgraded.close();
    const after=new DatabaseSync(join(directory,COLLABORATION_DATABASE_NAME));
    try {
      expect(after.prepare("SELECT request_key,attempt FROM collaboration_acceptance_mapping_attempts").all()).toEqual([{request_key:"preserved",attempt:1}]);
      expect(after.prepare("SELECT count(*) AS n FROM collaboration_verification_sessions").get()).toEqual({n:0});
    } finally {after.close();}
  });
  it("creates a private, versioned WAL database", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory);
    expect(ledger.databaseHealth()).toEqual({
      file: COLLABORATION_DATABASE_NAME,
      schemaVersion: 23,
      appliedMigrations: 23,
      journalMode: "wal",
      foreignKeys: true,
    });
    expect(statSync(ledger.filePath).mode & 0o777).toBe(0o600);
    ledger.close();

    const database = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME), { readOnly: true });
    const metadata = database.prepare("SELECT format, source_baseline FROM collaboration_ledger_metadata").get();
    expect(metadata).toEqual({
      format: "openmausbot-collaboration",
      source_baseline: OPENMAUSBOT_SOURCE_BASELINE,
    });
    database.close();
  });

  it("reopens without duplicating or recreating schema state", () => {
    const directory = temporaryDirectory();
    const first = openCollaborationLedger(directory);
    first.close();

    const before = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    const initialMigration = before
      .prepare("SELECT version, name, checksum, applied_at FROM collaboration_schema_migrations")
      .all();
    const initialMetadata = before.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    before.close();

    const second = openCollaborationLedger(directory);
    expect(second.migrationState).toEqual({ schemaVersion: 23, appliedMigrations: 23 });
    second.close();

    const after = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    expect(after.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get()).toEqual({ count: 23 });
    expect(after.prepare("SELECT version, name, checksum, applied_at FROM collaboration_schema_migrations").all()).toEqual(
      initialMigration,
    );
    expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(initialMetadata);
    after.close();
  });

  it("creates attachment provenance without replayable download capabilities", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory);
    ledger.close();
    const database = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME), { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(collaboration_attachments)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "external_event_id",
        "ordinal",
        "capability_ref",
        "ingest_state",
        "content_hash",
        "managed_storage_key",
        "error_code",
        "evidence_projected_at",
        "evidence_projection_owner",
        "evidence_projection_expires_at",
        "attempt_count",
      ]),
    );
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["download_code", "robot_code", "download_url"]),
    );
    database.close();
  });

  it("refuses a migration record that does not match the running build", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory);
    ledger.close();
    const database = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    database.prepare("UPDATE collaboration_schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    database.close();

    expect(() => openCollaborationLedger(directory)).toThrow("does not match this service build");
  });
});
