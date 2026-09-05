import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { enqueueInboundCard } from "../outbox.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";
import { readDeliveryHealth } from "./delivery-health.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), "delivery-health-")); roots.push(value); return value; }
function enqueue(database: DatabaseSync, id: string) {
  return enqueueInboundCard(database, { sourceEventId: id, aggregateType: "work_item", aggregateId: "WI-PRIVATE", aggregateVersion: 1,
    card: { type: "primary_status_card", headline: "已接收", acknowledgement: "private-business-text", workItemId: "WI-PRIVATE", workItemVersion: 1,
      workItemStatus: "collecting", association: "created" }, now: 1000 }).id;
}

describe("read-only delivery visibility", () => {
  it("reports a missing ledger as unknown rather than an empty healthy queue", () => {
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: root() });
    expect(runtime.health()).toMatchObject({ delivery: { status: "unavailable", counts: null } });
  });

  it("shows an empty readable queue without claiming that any message was delivered", async () => {
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: root(), probeOnly: true });
    try {
      expect(await runtime.start()).toMatchObject({ delivery: { status: "clear", counts: { queued: 0, sending: 0, retrying: 0, needsReview: 0 } } });
      expect(JSON.stringify(runtime.health())).not.toContain("全部送达");
    } finally { await runtime.stop(); }
    expect(runtime.health()).toMatchObject({ delivery: { status: "unavailable", counts: null } });
  });

  it("counts review, sending and proven-unsent retries without disclosing contents or mutating records", async () => {
    const directory = root();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: directory, probeOnly: true, clock: { now: () => 10000 } });
    await runtime.start();
    const database = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
    try {
      enqueue(database, "queued");
      for (const [id, error] of [["safe-retry", "delivery_confirmed_unsent:token_failed"], ["legacy-retry", "private-provider-error"], ["missing-error", null]]) {
        database.prepare("UPDATE collaboration_outbox SET attempt=1,last_error=? WHERE id=?").run(error, enqueue(database, id!));
      }
      for (const [id, expiry] of [["sending", 11000], ["expired", 10000]] as const) {
        database.prepare("UPDATE collaboration_outbox SET delivery_state='claimed',attempt=1,claim_owner='private-owner',claim_fence=1,claim_expires_at=? WHERE id=?")
          .run(expiry, enqueue(database, id));
      }
      for (const [id, error] of [["unconfirmed", "session_delivery_unconfirmed"], ["rejected", "permanent_failure"], ["restore", "restore_review_required"]]) {
        database.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',last_error=? WHERE id=?").run(error, enqueue(database, id));
      }
      database.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1001 WHERE id=?").run(enqueue(database, "sent"));
      database.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=1001 WHERE id=?").run(enqueue(database, "superseded"));
      const before = database.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      const health = runtime.health();
      expect(health).toMatchObject({ ready: true, status: "healthy", delivery: {
        status: "needs_attention", counts: { queued: 1, sending: 1, retrying: 1, needsReview: 6 },
        summary: expect.stringContaining("6 条回复需要核查"),
      } });
      for (const value of ["private-business-text", "private-provider-error", "private-owner", "WI-PRIVATE", "session_delivery_unconfirmed", "restore_review_required"]) {
        expect(JSON.stringify(health)).not.toContain(value);
      }
      expect(database.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(before);
    } finally { database.close(); await runtime.stop(); }
  });

  it("does not report zero when the queue cannot be read", async () => {
    const directory = root();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: directory, probeOnly: true });
    await runtime.start();
    const database = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
    try {
      database.exec("ALTER TABLE collaboration_outbox RENAME TO fixture_missing_outbox");
      expect(runtime.health()).toMatchObject({ delivery: { status: "unavailable", counts: null } });
    } finally { database.exec("ALTER TABLE fixture_missing_outbox RENAME TO collaboration_outbox"); database.close(); await runtime.stop(); }
  });

  it("shows active work as pending and promotes an expired sending claim to review without writing", async () => {
    const directory = root();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: directory, probeOnly: true });
    await runtime.start();
    const database = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
    try {
      const id = enqueue(database, "clock-boundary");
      expect(readDeliveryHealth(database, 1000)).toMatchObject({ status: "pending", counts: { queued: 1, needsReview: 0 } });
      database.prepare("UPDATE collaboration_outbox SET delivery_state='claimed',attempt=1,claim_owner='owner',claim_fence=1,claim_expires_at=2000 WHERE id=?").run(id);
      expect(readDeliveryHealth(database, 1999)).toMatchObject({ status: "pending", counts: { sending: 1, needsReview: 0 } });
      expect(readDeliveryHealth(database, 2000)).toMatchObject({ status: "needs_attention", counts: { sending: 0, needsReview: 1 } });
      expect(database.prepare("SELECT delivery_state FROM collaboration_outbox WHERE id=?").get(id)).toEqual({ delivery_state: "claimed" });
      for (const now of [NaN, Infinity, -1]) expect(readDeliveryHealth(database, now)).toMatchObject({ status: "unavailable", counts: null });
    } finally { database.close(); await runtime.stop(); }
    expect(readDeliveryHealth(database, 1000)).toMatchObject({ status: "unavailable", counts: null });
  });

  it("keeps normal delivery moving while an uncertain reply remains visible across restart", async () => {
    const directory = root();
    let calls = 0;
    const options = { dataDirectory: directory, platform: "linux" as const, outboxDelivery: {
      retryPolicy: "only-confirmed-unsent" as const,
      async deliver() { return ++calls === 1 ? { outcome: "unknown" as const, error: "session_delivery_unconfirmed" } : { outcome: "sent" as const }; },
    } };
    const runtime = new CollaborationHeadlessRuntime(options);
    await runtime.start();
    const database = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
    try {
      enqueue(database, "first");
      expect((await runtime.drainOnce()).dispatched?.state).toBe("dead_letter");
      expect(runtime.health()).toMatchObject({ ready: true, status: "healthy", delivery: { status: "needs_attention", counts: { needsReview: 1 } } });
      enqueue(database, "next");
      expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
      expect(calls).toBe(2);
    } finally { database.close(); await runtime.stop(); }
    const restarted = new CollaborationHeadlessRuntime(options);
    try {
      expect(await restarted.start()).toMatchObject({ ready: true, delivery: { status: "needs_attention", counts: { needsReview: 1 } } });
      expect((await restarted.drainOnce()).dispatched).toBeNull();
      expect(calls).toBe(2);
    } finally { await restarted.stop(); }
  });
});
