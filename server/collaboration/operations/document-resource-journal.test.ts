import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCollaborationLedger } from "../db.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";
import { DockerDocumentExtractor } from "./document-extractor.ts";
import { DocumentResourceJournal } from "./document-resource-journal.ts";
import { DocumentResourceRecovery } from "./document-resource-recovery.ts";
import type { DockerCommandPort } from "./docker-containment.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const image = `sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const input = { bytes: Buffer.from("synthetic document"), displayName: "bugs.pdf", mediaType: "application/pdf" };
function fixture(fault = "") {
  const dir = mkdtempSync(join(tmpdir(), "document-resources-")); dirs.push(dir);
  const ledger = openCollaborationLedger(dir); const path = ledger.filePath; ledger.close();
  const db = new DatabaseSync(path);
  const journal = new DocumentResourceJournal(path, "fixture-context");
  const run = vi.fn<DockerCommandPort["run"]>(async args => {
    const records = db.prepare("SELECT * FROM collaboration_document_resources").all();
    expect(records).toHaveLength(1);
    if (args[0] === "create") {
      expect(records[0]).toMatchObject({ container_name: args[args.indexOf("--name") + 1], image, docker_context: "fixture-context", container_id: null });
      expect(args).toContain(`com.openmausbot.document.resource=${records[0].container_name}`);
      if (fault === "lost") throw new Error("lost receipt");
      return { exitCode: 0, stdout: Buffer.from(id), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "rm") return { exitCode: fault === "cleanup" || fault === "lost" ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    expect(records[0].container_id).toBe(id);
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ version: 1, format: "pdf", records: [{ location: "page:1", text: "fixture" }], truncated: false, warnings: [] })), stderr: Buffer.alloc(0) };
  });
  return { db, path, run, extractor: new DockerDocumentExtractor({ image, docker: { run }, journal }) };
}
describe("persistent document resource ownership", () => {
  it("recovers a real extractor's lost creation receipt after instance replacement without parsing again", async () => {
    const f = fixture("lost");
    const prior = new InstanceLeaseCoordinator(f.db, "old-parser").acquire(1000, 10)!;
    const extractor = new DockerDocumentExtractor({ image, docker: { run: f.run },
      journal: new DocumentResourceJournal(f.path, "fixture-context", prior) });
    try {
      await expect(extractor.extract(input)).rejects.toThrow("attachment_document_cleanup_failed");
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["create", "rm"]);
      const owner = new InstanceLeaseCoordinator(f.db, "new-parser").acquire(2000, 1000)!;
      const journal = new DocumentResourceJournal(f.path, "fixture-context", owner);
      const [row] = journal.readUnresolved();
      expect(row).toMatchObject({ container_id: null, instance_owner: prior.ownerId, instance_fence: prior.fence });
      const run = vi.fn<DockerCommandPort["run"]>(async args => {
        if (args[0] === "rm") expect(journal.readUnresolved()[0].container_id).toBe(id);
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "inspect"
          ? Buffer.from(JSON.stringify([{ Id: id, Name: `/${row.container_name}`, Image: image,
            Config: { Labels: { "com.openmausbot.document.resource": row.container_name } } }])) : Buffer.alloc(0) };
      });
      await new DocumentResourceRecovery(journal, { run }).run(owner, 2000, () => {});
      expect(run.mock.calls.map(c => c[0][0])).toEqual(["inspect", "rm", "container"]);
      expect(run.mock.calls[0][0][3]).toBe(row.container_name);
      expect(journal.readUnresolved()).toEqual([]);
      expect(f.db.prepare("SELECT recovery_verified_absent FROM collaboration_document_resources").get()).toEqual({ recovery_verified_absent: 1 });
    } finally { f.db.close(); }
  });
  it("records ownership before create, ID before start and cleanup acknowledgement across reopening", async () => {
    const f = fixture();
    try {
      await f.extractor.extract(input);
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["create", "start", "rm"]);
      const rows = new DocumentResourceJournal(f.path, "fixture-context").readUnresolved();
      expect(rows).toEqual([]);
      expect(f.db.prepare("SELECT container_id, cleanup_acknowledged FROM collaboration_document_resources").get()).toEqual({ container_id: id, cleanup_acknowledged: 1 });
      expect(() => f.db.exec("DELETE FROM collaboration_document_resources")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET image='other'")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET cleanup_acknowledged=0")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET container_id=NULL")).toThrow();
    } finally { f.db.close(); }
  });
  it.each(["cleanup", "lost"])("preserves unresolved %s resources after rebuilding the journal", async fault => {
    const f = fixture(fault);
    try {
      await expect(f.extractor.extract(input)).rejects.toThrow("attachment_document_cleanup_failed");
      expect(new DocumentResourceJournal(f.path, "fixture-context").readUnresolved()).toEqual([
        expect.objectContaining({ image, docker_context: "fixture-context", container_id: fault === "lost" ? null : id, cleanup_acknowledged: 0 }),
      ]);
      expect(new DocumentResourceJournal(f.path, "other-context").readUnresolved()).toEqual([]);
    } finally { f.db.close(); }
  });
  it.each(["reserve", "created", "ack"])("does not advance past a failed %s journal write", async fault => {
    const f = fixture();
    try {
      f.db.exec(fault === "reserve"
        ? "CREATE TRIGGER fixture_fault BEFORE INSERT ON collaboration_document_resources BEGIN SELECT RAISE(ABORT,'private failure'); END"
        : `CREATE TRIGGER fixture_fault BEFORE UPDATE OF ${fault === "created" ? "container_id" : "cleanup_acknowledged"} ON collaboration_document_resources BEGIN SELECT RAISE(ABORT,'private failure'); END`);
      await expect(f.extractor.extract(input)).rejects.toThrow(/attachment_document_/);
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(fault === "reserve" ? [] : fault === "created" ? ["create", "rm"] : ["create", "start", "rm"]);
      if (fault === "ack") expect(new DocumentResourceJournal(f.path, "fixture-context").readUnresolved()).toHaveLength(1);
    } finally { f.db.close(); }
  });
});
