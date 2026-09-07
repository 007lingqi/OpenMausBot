import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { COLLABORATION_DATABASE_NAME, openCollaborationLedger } from "./db.ts";

const scratch: string[] = [];
const dropMappingRecovery = `DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts;
  DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts;`;

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-collaboration-ledger-"));
  scratch.push(directory);
  return directory;
}

describe("collaboration ledger", () => {
  it("upgrades v31 additively without fabricating online body evidence", () => {
    const root = temporaryDirectory(), ledger = openCollaborationLedger(root), path = ledger.filePath; ledger.close();
    const db = new DatabaseSync(path);
    const before = db.prepare("SELECT * FROM collaboration_ledger_metadata").all();
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DELETE FROM collaboration_schema_migrations WHERE version>=32; PRAGMA user_version=31"); db.close();
    const upgraded = openCollaborationLedger(root); expect(upgraded.migrationState.schemaVersion).toBe(34); upgraded.close();
    const after = new DatabaseSync(path);
    try { expect(after.prepare("SELECT * FROM collaboration_online_read_receipts").all()).toEqual([]);
      expect(after.prepare("SELECT * FROM collaboration_online_read_jobs").all()).toEqual([]);
      expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").all()).toEqual(before); }
    finally { after.close(); }
  });
  it("upgrades v30 without inventing coordinator proofs or modifying existing rows", () => {
    const root = temporaryDirectory(), ledger = openCollaborationLedger(root), path = ledger.filePath; ledger.close();
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO collaboration_acceptance_mapping_attempts VALUES('preserve-v30',1,'{}',1000)").run();
    const before = db.prepare("SELECT * FROM collaboration_acceptance_mapping_attempts").all();
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DELETE FROM collaboration_schema_migrations WHERE version>=31; PRAGMA user_version=30"); db.close();
    const upgraded = openCollaborationLedger(root); expect(upgraded.migrationState.schemaVersion).toBe(34); upgraded.close();
    const after = new DatabaseSync(path);
    try { expect(after.prepare("SELECT * FROM collaboration_coordinator_proofs").all()).toEqual([]);
      expect(after.prepare("SELECT * FROM collaboration_acceptance_mapping_attempts").all()).toEqual(before); }
    finally { after.close(); }
  });
  it("upgrades v29 additively while retaining the three-attempt constraint and all mapping history", () => {
    const directory = temporaryDirectory(), ledger = openCollaborationLedger(directory), path = ledger.filePath; ledger.close();
    const db = new DatabaseSync(path);
    for (let attempt = 1; attempt <= 3; attempt++) {
      db.prepare("INSERT INTO collaboration_acceptance_mapping_attempts VALUES('old',?,'{}',1000)").run(attempt);
      db.prepare("INSERT INTO collaboration_acceptance_mapping_results VALUES('old',?,'{}',1001)").run(attempt);
    }
    const before = db.prepare("SELECT * FROM collaboration_acceptance_mapping_attempts").all();
    const results = db.prepare("SELECT * FROM collaboration_acceptance_mapping_results").all();
    const metadata = db.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    db.exec(dropMappingRecovery + "DELETE FROM collaboration_schema_migrations WHERE version>=30; PRAGMA user_version=29"); db.close();
    const upgraded = openCollaborationLedger(directory); expect(upgraded.migrationState.schemaVersion).toBe(34); upgraded.close();
    const after = new DatabaseSync(path); after.exec("PRAGMA foreign_keys=ON");
    try {
      expect(after.prepare("SELECT * FROM collaboration_acceptance_mapping_attempts").all()).toEqual(before);
      expect(after.prepare("SELECT * FROM collaboration_acceptance_mapping_results").all()).toEqual(results);
      expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(metadata);
      expect(after.prepare("SELECT * FROM collaboration_mapping_recovery_attempts").all()).toEqual([]);
      expect(() => after.exec("INSERT INTO collaboration_acceptance_mapping_attempts VALUES('old',4,'{}',1002)")).toThrow("CHECK");
      expect(() => after.exec("INSERT INTO collaboration_mapping_recovery_attempts(request_key,attempt,request_json,created_at) VALUES('old',4,'{}',1002)")).toThrow("CHECK");
      const payload = JSON.stringify({ ownerAuthorizedRecovery: { afterAttempt: 3, referenceHash: "a".repeat(64) } });
      after.prepare("INSERT INTO collaboration_mapping_recovery_attempts(request_key,attempt,request_json,created_at) VALUES('old',4,?,1002)").run(payload);
      expect(() => after.exec("DELETE FROM collaboration_mapping_recovery_attempts")).toThrow("immutable");
      expect(() => after.exec("UPDATE collaboration_mapping_recovery_attempts SET created_at=2")).toThrow("immutable");
      expect(() => after.prepare("INSERT INTO collaboration_mapping_recovery_attempts(request_key,attempt,request_json,created_at) VALUES('old',5,?,1003)").run(payload)).toThrow("CHECK");
      expect(() => after.prepare("INSERT INTO collaboration_mapping_recovery_attempts(request_key,attempt,request_json,created_at) VALUES('missing',4,?,1003)").run(payload)).toThrow("FOREIGN KEY");
    } finally { after.close(); }
  });
  it("upgrades v28 without inventing a previously authorized runtime policy", () => {
    const directory = temporaryDirectory(); const ledger = openCollaborationLedger(directory); const path = ledger.filePath; ledger.close();
    const db = new DatabaseSync(path); const before = db.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DELETE FROM collaboration_schema_migrations WHERE version>=29; PRAGMA user_version=28"); db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 }); upgraded.close();
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT * FROM collaboration_verification_runtime_policies").all()).toEqual([]);
      expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(before);
    } finally { after.close(); }
  });
  it("upgrades v27 without inventing historical delivery query results", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory); const path = ledger.filePath; ledger.close();
    const db = new DatabaseSync(path);
    const before = db.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DELETE FROM collaboration_schema_migrations WHERE version>=28; PRAGMA user_version=27"); db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 }); upgraded.close();
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(before);
      expect(after.prepare("SELECT * FROM collaboration_delivery_queries").all()).toEqual([]);
    } finally { after.close(); }
  });
  it("upgrades v26 retaining legacy resources without inventing instance ownership or recovery evidence", () => {
    const directory = temporaryDirectory();
    const store = openCollaborationLedger(directory); const path = store.filePath; store.close();
    const before = new DatabaseSync(path);
    before.exec(`DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TRIGGER document_resources_recovery_immutable;
      ALTER TABLE collaboration_document_resources DROP COLUMN instance_owner;
      ALTER TABLE collaboration_document_resources DROP COLUMN instance_fence;
      ALTER TABLE collaboration_document_resources DROP COLUMN recovery_attempts;
      ALTER TABLE collaboration_document_resources DROP COLUMN recovery_verified_absent;
      DELETE FROM collaboration_schema_migrations WHERE version>=27; PRAGMA user_version=26;`);
    before.prepare("INSERT INTO collaboration_document_resources VALUES(?,?,?,?,?,?,?)")
      .run("legacy-document", "fixed-image", "pilot", "source-hash", "known-container", 0, 1000);
    const preserved = before.prepare("SELECT * FROM collaboration_document_resources").get(); before.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 }); upgraded.close();
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT * FROM collaboration_document_resources").get()).toEqual({
        ...preserved, instance_owner: null, instance_fence: null, recovery_attempts: 0, recovery_verified_absent: 0,
      });
      expect(() => after.exec("UPDATE collaboration_document_resources SET instance_owner='invented',instance_fence=1")).toThrow();
    } finally { after.close(); }
  });
  it("upgrades v25 without inventing ownership for historical document containers", () => {
    const directory = temporaryDirectory();
    const store = openCollaborationLedger(directory); const path = store.filePath; store.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DELETE FROM collaboration_schema_migrations WHERE version>=26; PRAGMA user_version=25");
    const metadata = db.prepare("SELECT * FROM collaboration_ledger_metadata").get(); db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 }); upgraded.close();
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(metadata);
      expect(after.prepare("SELECT count(*) AS n FROM collaboration_document_resources").get()).toEqual({ n: 0 });
    } finally { after.close(); }
  });
  it("upgrades v21 without fabricating historical attachment failures", () => {
    const directory = temporaryDirectory();
    const store = openCollaborationLedger(directory); store.close();
    const db = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=22; PRAGMA user_version=21");
    const before = db.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 });
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
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=20; PRAGMA user_version=19"); db.close();
    const upgraded = openCollaborationLedger(directory);
    expect(upgraded.migrationState.schemaVersion).toBe(34); upgraded.close();
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
    db.exec("DROP TABLE collaboration_natural_material_recoveries; DROP VIEW collaboration_natural_all_jobs; DROP TABLE collaboration_natural_material_jobs; DROP TABLE collaboration_online_read_receipts; DROP TABLE collaboration_online_read_jobs; DROP TABLE collaboration_coordinator_proofs; DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=19; PRAGMA user_version=18"); db.close();
    const upgraded=openCollaborationLedger(directory);
    expect(upgraded.migrationState.schemaVersion).toBe(34); upgraded.close();
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
      schemaVersion: 34,
      appliedMigrations: 34,
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
    expect(second.migrationState).toEqual({ schemaVersion: 34, appliedMigrations: 34 });
    second.close();

    const after = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    expect(after.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get()).toEqual({ count: 34 });
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
