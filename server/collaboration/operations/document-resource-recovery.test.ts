import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCollaborationLedger } from "../db.ts";
import { assertCurrentInstanceLease, InstanceLeaseCoordinator } from "../leases.ts";
import { DocumentResourceJournal } from "./document-resource-journal.ts";
import { DocumentResourceRecovery } from "./document-resource-recovery.ts";
import type { DockerCommandPort } from "./docker-containment.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const name = "omb-document-00000000-0000-4000-8000-000000000001";
const id = "b".repeat(64), image = `sha256:${"a".repeat(64)}`;
function setup(fault = "") {
  const dir = mkdtempSync(join(tmpdir(), "document-recovery-")); dirs.push(dir);
  const ledger = openCollaborationLedger(dir), path = ledger.filePath; ledger.close();
  const db = new DatabaseSync(path);
  const prior = new InstanceLeaseCoordinator(db, "old").acquire(1000, 10)!;
  const oldJournal = new DocumentResourceJournal(path, "pilot", prior);
  oldJournal.reserve(name, image, "c".repeat(64));
  if (fault !== "no_id") oldJournal.created(name, id);
  const current = new InstanceLeaseCoordinator(db, "new").acquire(2000, 1000)!;
  const journal = new DocumentResourceJournal(path, "pilot", current);
  let removed = false;
  const run = vi.fn<DockerCommandPort["run"]>(async args => {
    if (fault === "offline") throw new Error("private daemon failure");
    if (args[0] === "inspect") {
      if (fault === "missing") return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (fault === "stale") new InstanceLeaseCoordinator(db, "replacement").acquire(4000, 1000);
      return { exitCode: 0, stdout: Buffer.from(fault === "malformed" ? "not JSON" : JSON.stringify([{
        Id: fault === "wrong_id" ? "f".repeat(64) : id,
        Name: fault === "wrong_name" ? "/unrelated" : `/${name}`,
        Image: fault === "wrong_image" ? `sha256:${"f".repeat(64)}` : image,
        Config: { Image: image, Labels: { "com.openmausbot.document.resource": fault === "mismatch" ? "other" : name } } }])), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "rm" && fault === "rm_failed") return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (args[0] === "rm") removed = true;
    return { exitCode: args[0] === "container" && fault === "query_failed" ? 1 : 0,
      stdout: Buffer.from(args[0] === "container" && ((!removed && fault !== "missing") || fault === "still_present") ? id : ""), stderr: Buffer.alloc(0) };
  });
  return { db, path, current, prior, journal, run, recovery: new DocumentResourceRecovery(journal, { run }) };
}
describe("fenced document resource recovery", () => {
  it("discovers a lost create receipt by its exact reserved name and persists the verified ID before removal", async () => {
    const f = setup("no_id");
    const run = vi.fn<DockerCommandPort["run"]>(async (args, options) => {
      if (args[0] === "rm") expect(f.journal.readUnresolved()[0]).toMatchObject({ container_id: id, recovery_attempts: 1 });
      return f.run(args, options);
    });
    try {
      await new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => {});
      expect(run.mock.calls.map(c => c[0])).toEqual([
        ["inspect", "--type", "container", name], ["rm", "--force", id],
        ["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"],
      ]);
      expect(f.journal.readUnresolved()).toEqual([]);
      await f.recovery.run(f.current, 2001, () => {});
      expect(run).toHaveBeenCalledTimes(3);
    } finally { f.db.close(); }
  });
  it("never treats a missing unknown ID as verified absent, and retains its three-query budget after reconstruction", async () => {
    const f = setup("no_id");
    const run = vi.fn<DockerCommandPort["run"]>(async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not available") }));
    try {
      for (let i = 0; i < 5; i++) await new DocumentResourceRecovery(new DocumentResourceJournal(f.path, "pilot", f.current), { run }).run(f.current, 2000, () => {});
      expect(run).toHaveBeenCalledTimes(3);
      expect(run.mock.calls.every(c => c[0].join(" ") === `inspect --type container ${name}`)).toBe(true);
      expect(f.journal.readUnresolved()[0]).toMatchObject({ container_id: null, recovery_attempts: 3, cleanup_acknowledged: 0, recovery_verified_absent: 0 });
    } finally { f.db.close(); }
  });
  it.each(["id", "name", "image", "label", "multiple"])("refuses unproven discovered %s identity", async fault => {
    const f = setup("no_id");
    const run = vi.fn<DockerCommandPort["run"]>(async (args, options) => {
      const result = await f.run(args, options);
      if (args[0] === "inspect") {
        const rows = JSON.parse(result.stdout.toString());
        if (fault === "id") rows[0].Id = "short-id";
        if (fault === "name") rows[0].Name = "/other";
        if (fault === "image") rows[0].Image = `sha256:${"f".repeat(64)}`;
        if (fault === "label") rows[0].Config.Labels = {};
        if (fault === "multiple") rows.push(rows[0]);
        result.stdout = Buffer.from(JSON.stringify(rows));
      }
      return result;
    });
    try {
      await new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => {});
      expect(run.mock.calls.map(c => c[0])).toEqual([["inspect", "--type", "container", name]]);
      expect(f.journal.readUnresolved()[0]).toMatchObject({ container_id: null, cleanup_acknowledged: 0 });
    } finally { f.db.close(); }
  });
  it.each(["write_failed", "late_receipt", "newer_attempt", "cancel", "takeover"])("does not delete discovered resources after %s", async fault => {
    const f = setup("no_id"), controller = new AbortController();
    if (fault === "write_failed") f.db.exec("CREATE TRIGGER fixture_fault BEFORE UPDATE OF container_id ON collaboration_document_resources BEGIN SELECT RAISE(ABORT,'write failed'); END");
    const run = vi.fn<DockerCommandPort["run"]>(async (args, options) => {
      const result = await f.run(args, options);
      if (args[0] === "inspect") {
        if (fault === "late_receipt") new DocumentResourceJournal(f.path, "pilot", f.prior).created(name, "d".repeat(64));
        if (fault === "newer_attempt") f.journal.claimRecovery(name, f.current, 2000);
        if (fault === "cancel") controller.abort();
        if (fault === "takeover") new InstanceLeaseCoordinator(f.db, "replacement").acquire(4000, 1000);
      }
      return result;
    });
    try {
      const pending = new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => {}, controller.signal);
      if (fault === "cancel" || fault === "takeover") await expect(pending).rejects.toThrow(); else await pending;
      expect(run.mock.calls.map(c => c[0][0])).toEqual(["inspect"]);
      expect(f.journal.readUnresolved()[0]).toMatchObject({ container_id: fault === "late_receipt" ? "d".repeat(64) : null, cleanup_acknowledged: 0 });
    } finally { f.db.close(); }
  });
  it("removes only a verified old-instance ID and independently confirms absence before recording recovery", async () => {
    const f = setup();
    try {
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["inspect", "rm", "container"]);
      expect(f.run.mock.calls[1][0]).toEqual(["rm", "--force", id]);
      expect(f.journal.readUnresolved()).toEqual([]);
      await new DocumentResourceRecovery(new DocumentResourceJournal(f.path, "pilot", f.current), { run: f.run }).run(f.current, 2001, () => {});
      expect(f.run).toHaveBeenCalledTimes(3);
    } finally { f.db.close(); }
  });
  it.each(["mismatch", "malformed", "wrong_id", "wrong_name", "wrong_image"])("does not remove an unproven %s container", async fault => {
    const f = setup(fault);
    try {
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.run.mock.calls.some(c => c[0][0] === "rm")).toBe(false);
      expect(f.journal.readUnresolved()).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it.each(["rm_failed", "still_present", "query_failed"])("does not acknowledge recovery after %s", async fault => {
    const f = setup(fault);
    try {
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.journal.readUnresolved()[0]).toMatchObject({ cleanup_acknowledged: 0, recovery_verified_absent: 0, recovery_attempts: 1 });
    } finally { f.db.close(); }
  });
  it("confirms a missing fixed ID without attempting blind deletion", async () => {
    const f = setup("missing");
    try {
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["inspect", "container"]);
      expect(f.db.prepare("SELECT cleanup_acknowledged,recovery_verified_absent FROM collaboration_document_resources").get())
        .toEqual({ cleanup_acknowledged: 1, recovery_verified_absent: 1 });
    } finally { f.db.close(); }
  });
  it.each(["inspect", "rm", "container"])("propagates cancellation after %s and never records unverified completion", async boundary => {
    const f = setup(), controller = new AbortController();
    const run = vi.fn<DockerCommandPort["run"]>(async (args, options) => {
      const result = await f.run(args, options);
      if (args[0] === boundary) controller.abort();
      return result;
    });
    try {
      await expect(new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => {}, controller.signal))
        .rejects.toThrow("attachment_document_inactive");
      expect(f.journal.readUnresolved()).toHaveLength(1);
      if (boundary === "inspect") expect(run.mock.calls.some(c => c[0][0] === "rm")).toBe(false);
    } finally { f.db.close(); }
  });
  it("stops before removal when another instance takes over during inspection", async () => {
    const f = setup("stale");
    try {
      await expect(f.recovery.run(f.current, 2000, () => {})).rejects.toThrow();
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["inspect"]);
      expect(f.journal.readUnresolved()).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it("uses the runtime's current-time guard after a long Docker operation", async () => {
    const f = setup(); let clock = 2000;
    const run: DockerCommandPort["run"] = async (args, options) => { const result = await f.run(args, options); clock = 4000; return result; };
    try {
      await expect(new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => assertCurrentInstanceLease(f.db, f.current, clock))).rejects.toThrow();
      expect(f.run.mock.calls.map(c => c[0][0])).toEqual(["inspect"]);
      expect(f.journal.readUnresolved()).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it("leaves legacy ownerless resources and late creation receipts unresolved", async () => {
    const f = setup("no_id");
    try {
      const legacy = new DocumentResourceJournal(f.path, "pilot"), legacyName = name.replace(/1$/, "3");
      legacy.reserve(legacyName, image, "c".repeat(64)); legacy.created(legacyName, "d".repeat(64));
      f.run.mockResolvedValueOnce({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.run.mock.calls.map(c => c[0])).toEqual([["inspect", "--type", "container", name]]);
      expect(f.journal.readUnresolved()).toHaveLength(2);
      new DocumentResourceJournal(f.path, "pilot", f.prior).created(name, id);
      await f.recovery.run(f.current, 2001, () => {});
      expect(f.journal.readUnresolved().map(r => r.container_name)).toEqual([legacyName]);
    } finally { f.db.close(); }
  });
  it("does not recover its own live instance or switch Docker contexts", async () => {
    const f = setup();
    try {
      const liveName = name.replace(/1$/, "2"); f.journal.reserve(liveName, image, "c".repeat(64)); f.journal.created(liveName, "d".repeat(64));
      await new DocumentResourceRecovery(new DocumentResourceJournal(f.path, "other", f.current), { run: f.run }).run(f.current, 2000, () => {});
      expect(f.run).not.toHaveBeenCalled();
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.journal.readUnresolved().map(r => r.container_name)).toEqual([liveName]);
    } finally { f.db.close(); }
  });
  it("stops repeating an unavailable cleanup after three persisted attempts", async () => {
    const f = setup("offline");
    try {
      for (let i = 0; i < 5; i++) await new DocumentResourceRecovery(new DocumentResourceJournal(f.path, "pilot", f.current), { run: f.run }).run(f.current, 2000, () => {});
      expect(f.run).toHaveBeenCalledTimes(3);
      expect(f.journal.readUnresolved()[0].recovery_attempts).toBe(3);
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET recovery_attempts=0")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET recovery_attempts=4")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET instance_owner='other'")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_document_resources SET instance_fence=NULL")).toThrow();
    } finally { f.db.close(); }
  });
  it("does not issue commands or consume attempts when already cancelled", async () => {
    const f = setup(), controller = new AbortController(); controller.abort();
    try {
      await expect(f.recovery.run(f.current, 2000, () => {}, controller.signal)).rejects.toThrow("attachment_document_inactive");
      expect(f.run).not.toHaveBeenCalled();
      expect(f.journal.readUnresolved()[0].recovery_attempts).toBe(0);
    } finally { f.db.close(); }
  });
  it("retains unresolved evidence when the acknowledgment transaction fails", async () => {
    const f = setup();
    try {
      f.db.exec("CREATE TRIGGER fixture_fault BEFORE UPDATE OF cleanup_acknowledged ON collaboration_document_resources BEGIN SELECT RAISE(ABORT,'private failure'); END");
      await f.recovery.run(f.current, 2000, () => {});
      expect(f.journal.readUnresolved()[0]).toMatchObject({ recovery_attempts: 1, recovery_verified_absent: 0 });
    } finally { f.db.close(); }
  });
  it.each([true, false])("checks repository digest identity before recovery (matches=%s)", async valid => {
    const f = setup("no_id"), digestName = name.replace(/1$/, "4"), digestId = "d".repeat(64);
    f.journal.cleanupAcknowledged(name);
    const digest = `example.test/parser@sha256:${"f".repeat(64)}`;
    const old = new DocumentResourceJournal(f.path, "pilot", f.prior);
    old.reserve(digestName, digest, "c".repeat(64)); old.created(digestName, digestId);
    const run = vi.fn<DockerCommandPort["run"]>(async args => ({ exitCode: 0, stderr: Buffer.alloc(0),
      stdout: args[0] === "inspect" ? Buffer.from(JSON.stringify([{ Id: digestId, Name: `/${digestName}`, Image: image,
        Config: { Image: valid ? digest : "example.test/parser:latest", Labels: { "com.openmausbot.document.resource": digestName } } }])) : Buffer.alloc(0),
    }));
    try {
      await new DocumentResourceRecovery(f.journal, { run }).run(f.current, 2000, () => {});
      expect(run.mock.calls.map(c => c[0][0])).toEqual(valid ? ["inspect", "rm", "container"] : ["inspect"]);
      expect(f.journal.readUnresolved()).toHaveLength(valid ? 0 : 1);
      if (valid) expect(() => f.db.exec("UPDATE collaboration_document_resources SET recovery_verified_absent=0 WHERE recovery_verified_absent=1")).toThrow();
    } finally { f.db.close(); }
  });
});
