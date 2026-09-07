import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationHeadlessRuntime } from "./runtime.ts";
import type { CoordinatorAuthority } from "../coordinator-lifecycle.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runtime-coordinator-")); roots.push(root);
  const authority: CoordinatorAuthority = { capture: vi.fn(async () => ({ synthetic: true })), inspect: vi.fn(async () => ({ state: "active" as const, fingerprint: "a".repeat(64) })) };
  return { root, authority, create(probeOnly = false) { return new CollaborationHeadlessRuntime({ dataDirectory: root, coordinator: authority, probeOnly }); } };
}
describe("headless coordinator startup registration", () => {
  it("cannot become ready until current coordinator proof is durably registered", async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.authority.capture = vi.fn(async () => new Promise(done => { resolve = done; }));
    const runtime = f.create(), started = runtime.start();
    try {
      await vi.waitFor(() => expect(resolve).toBeDefined()); expect(runtime.health().state).toBe("starting");
      resolve({ synthetic: true }); expect((await started).state).toBe("running");
      const db = new DatabaseSync(join(f.root, "collaboration/collaboration.sqlite"));
      try { expect(db.prepare("SELECT count(*) AS n FROM collaboration_coordinator_proofs").get()).toEqual({ n: 1 }); }
      finally { db.close(); }
    } finally { await runtime.stop(); }
  });
  it("fails closed when coordinator identity cannot be independently confirmed", async () => {
    const f = fixture(); f.authority.inspect = async () => ({ state: "unknown", reason: "unconfirmed" });
    const runtime = f.create();
    try { await expect(runtime.start()).rejects.toThrow("coordinator_start_unconfirmed"); expect(runtime.health().ready).toBe(false); }
    finally { await runtime.stop(); }
  });
  it("does not execute diagnostics or issue coordinator proof from a health-only process", async () => {
    const f = fixture(), runtime = f.create(true);
    try { await runtime.start(); expect(f.authority.capture).not.toHaveBeenCalled(); expect(f.authority.inspect).not.toHaveBeenCalled(); }
    finally { await runtime.stop(); }
  });
  it("cannot publish a late coordinator registration after shutdown", async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.authority.capture = async () => new Promise(done => { resolve = done; });
    const runtime = f.create(), started = runtime.start(), rejected = expect(started).rejects.toThrow();
    await vi.waitFor(() => expect(resolve).toBeDefined()); await runtime.stop(); resolve({ synthetic: true }); await rejected;
    const db = new DatabaseSync(join(f.root, "collaboration/collaboration.sqlite"));
    try { expect(db.prepare("SELECT * FROM collaboration_coordinator_proofs").all()).toEqual([]); }
    finally { db.close(); }
  });
});
