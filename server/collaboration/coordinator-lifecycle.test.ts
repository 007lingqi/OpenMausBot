import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { registerCoordinator, type CoordinatorAuthority } from "./coordinator-lifecycle.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coordinator-ledger-")); roots.push(root);
  const ledger = openCollaborationLedger(root); const db = new DatabaseSync(ledger.filePath); ledger.close();
  const leases = new InstanceLeaseCoordinator(db, "headless:epoch"), lease = leases.acquire(Date.now(), 60000)!;
  const authority: CoordinatorAuthority = { capture: vi.fn(async () => ({ test: true })), inspect: vi.fn(async () => ({ state: "active" as const, fingerprint: "a".repeat(64) })) };
  return { db, lease, leases, authority };
}
describe("coordinator registration", () => {
  it("persists one immutable epoch before work and rejects replacing or deleting it", async () => {
    const f = fixture(); try {
      await registerCoordinator(f.db, f.lease, f.authority, Date.now);
      expect(f.db.prepare("SELECT instance_owner,instance_fence FROM collaboration_coordinator_proofs").get()).toEqual({ instance_owner: f.lease.ownerId, instance_fence: f.lease.fence });
      expect(() => f.db.exec("UPDATE collaboration_coordinator_proofs SET proof_json='{}'")).toThrow("immutable");
      expect(() => f.db.exec("DELETE FROM collaboration_coordinator_proofs")).toThrow("immutable");
      await expect(registerCoordinator(f.db, f.lease, f.authority, Date.now)).rejects.toThrow();
    } finally { f.db.close(); }
  });
  it.each(["inactive", "stale-lease", "invalid-fingerprint"])("does not register %s", async mode => {
    const f = fixture(); try {
      if (mode === "inactive") f.authority.inspect = async () => ({ state: "stopped", fingerprint: "a".repeat(64) });
      if (mode === "stale-lease") f.authority.capture = async () => { f.leases.release(f.lease, Date.now()); return {}; };
      if (mode === "invalid-fingerprint") f.authority.inspect = async () => ({ state: "active", fingerprint: "invalid" });
      await expect(registerCoordinator(f.db, f.lease, f.authority, Date.now)).rejects.toThrow();
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_coordinator_proofs").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });
});
