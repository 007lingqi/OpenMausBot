import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator, StaleFenceError } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { enqueueInboundCard, type OutboxDeliveryPort } from "./outbox.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-outbox-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

function enqueue(db: DatabaseSync, version: number, now: number): string {
  return enqueueInboundCard(db, {
    sourceEventId: `event-${version}`,
    aggregateType: "plan",
    aggregateId: "WI-1",
    aggregateVersion: version,
    supersessionKey: "plan:WI-1",
    card: {
      type: "plan_status_card",
      headline: "计划已发布",
      workItemId: "WI-1",
      planRevision: version,
      status: "ready_for_execution",
      sequence: ["analyze", "modify", "validate", "report"],
    },
    now,
  }).id;
}

describe("fenced outbox dispatcher", () => {
  it.each(["claim", "instance"])("rejects a successful send returned after its %s expires without a takeover", async boundary => {
    const db = database(); enqueue(db, 1, 1000);
    const lease = new InstanceLeaseCoordinator(db, "late-sender").acquire(1000, boundary === "instance" ? 100 : 10000)!;
    let wall = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => wall);
    const dispatcher = new OutboxDispatcher(db, { async deliver() { wall = 101; return { outcome: "sent" }; } },
      { maxAttempts: 3, claimTtlMs: boundary === "claim" ? 100 : 10000, baseBackoffMs: 10, maxBackoffMs: 100 });
    try {
      await expect(dispatcher.dispatchOne(lease, 1000)).rejects.toThrow(StaleFenceError);
      expect(db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    } finally { clock.mockRestore(); db.close(); }
  });
  it("does not replay legacy pending attempts without proof of non-delivery", async () => {
    const db = database();
    const id = enqueue(db, 1, 1000);
    db.prepare("UPDATE collaboration_outbox SET attempt=1,last_error='session_transport_error' WHERE id=?").run(id);
    const lease = new InstanceLeaseCoordinator(db, "replacement").acquire(2000, 10000)!;
    let calls = 0;
    const transport = { retryPolicy: "only-confirmed-unsent" as const, async deliver() { calls++; return { outcome: "sent" as const }; } };
    expect(await new OutboxDispatcher(db, transport, { maxAttempts: 3, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 }).dispatchOne(lease, 2000)).toBeNull();
    expect(calls).toBe(0);
    expect(db.prepare("SELECT delivery_state,last_error FROM collaboration_outbox WHERE id=?").get(id))
      .toEqual({ delivery_state: "dead_letter", last_error: "delivery_unconfirmed_after_restart" });
    db.close();
  });
  it("retains a proven-unsent retry across restart for non-idempotent transport", async () => {
    const db = database();
    const id = enqueue(db, 1, 1000);
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1000, 10000)!;
    let calls = 0;
    const transport = { retryPolicy: "only-confirmed-unsent" as const, async deliver() {
      calls++; return calls === 1 ? { outcome: "retryable" as const, error: "credentials_not_loaded" } : { outcome: "sent" as const };
    } };
    const options = { maxAttempts: 3, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 };
    expect(await new OutboxDispatcher(db, transport, options).dispatchOne(lease, 1001)).toMatchObject({ state: "retry_scheduled" });
    expect(await new OutboxDispatcher(db, transport, options).dispatchOne(lease, 2000)).toMatchObject({ state: "sent" });
    expect(calls).toBe(2);
    expect(db.prepare("SELECT last_error FROM collaboration_outbox WHERE id=?").get(id)).toEqual({ last_error: null });
    db.close();
  });
  it("does not retry an uncertain non-idempotent delivery after a dispatcher restart", async () => {
    const db = database();
    const id = enqueue(db, 1, 1000);
    let calls = 0;
    const transport = { retryPolicy: "only-confirmed-unsent" as const, async deliver() { calls++; return { outcome: "unknown" as const, error: "delivery_unconfirmed" }; } };
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1000, 10000)!;
    const options = { maxAttempts: 3, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 };
    expect(await new OutboxDispatcher(db, transport, options).dispatchOne(lease, 1001)).toMatchObject({ state: "dead_letter" });
    expect(await new OutboxDispatcher(db, transport, options).dispatchOne(lease, 2000)).toBeNull();
    expect(calls).toBe(1);
    expect(db.prepare("SELECT sent_at,delivery_state,last_error FROM collaboration_outbox WHERE id=?").get(id))
      .toEqual({ sent_at: null, delivery_state: "dead_letter", last_error: "delivery_unconfirmed" });
    db.close();
  });
  it("does not retransmit a crashed non-idempotent send whose claim expired", async () => {
    const db = database();
    const id = enqueue(db, 1, 1000);
    let calls = 0;
    const transport = { retryPolicy: "only-confirmed-unsent" as const, async deliver() { calls++; return { outcome: "sent" as const }; } };
    const lease = new InstanceLeaseCoordinator(db, "replacement").acquire(2000, 10000)!;
    db.prepare("UPDATE collaboration_outbox SET delivery_state='claimed',claim_owner='crashed',claim_fence=1,claim_expires_at=1500,attempt=1 WHERE id=?").run(id);
    const dispatcher = new OutboxDispatcher(db, transport, { maxAttempts: 3, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 });
    expect(await dispatcher.dispatchOne(lease, 2000)).toBeNull();
    expect(calls).toBe(0);
    expect(db.prepare("SELECT delivery_state,last_error FROM collaboration_outbox WHERE id=?").get(id))
      .toEqual({ delivery_state: "dead_letter", last_error: "delivery_unconfirmed_after_restart" });
    db.close();
  });
  it("does not record a displayed choice when delivery was rejected", async () => {
    const db = database();
    enqueueInboundCard(db, { sourceEventId: "failed-choice", aggregateType: "association", aggregateId: "unrelated", aggregateVersion: 1,
      card: { type: "association_choice_card", headline: "请选择问题归属", acknowledgement: "", candidateWorkItemIds: [], candidateWorkItems: [] }, now: 1000 });
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1000, 1000)!;
    const dispatcher = new OutboxDispatcher(db, { async deliver() { return { outcome: "permanent_failure", error: "business_rejected" }; } },
      { maxAttempts: 3, claimTtlMs: 100, baseBackoffMs: 10, maxBackoffMs: 100 });
    expect(await dispatcher.dispatchOne(lease, 1001)).toMatchObject({ state: "dead_letter" });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_sent_association_choices").get()).toEqual({ count: 0 });
    db.close();
  });
  it("suppresses obsolete aggregate versions and delivers only the newest", async () => {
    const db = database();
    const oldId = enqueue(db, 1, 1_000);
    const newId = enqueue(db, 2, 1_001);
    const delivered: number[] = [];
    const transport: OutboxDeliveryPort = {
      async deliver(message) {
        delivered.push(message.aggregateVersion);
        return { outcome: "sent" };
      },
    };
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_001, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 3,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    expect(await dispatcher.dispatchOne(lease, 1_002)).toEqual({ id: newId, state: "sent", attempt: 1 });
    expect(delivered).toEqual([2]);
    expect(db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE id = ?").get(oldId)).toEqual({
      delivery_state: "superseded",
    });
    db.close();
  });

  it("persists bounded retry/backoff and dead-letters after the maximum", async () => {
    const db = database();
    const id = enqueue(db, 1, 1_000);
    const transport: OutboxDeliveryPort = {
      async deliver() {
        return { outcome: "retryable", error: "rate_limited" };
      },
    };
    const leases = new InstanceLeaseCoordinator(db, "scheduler");
    let lease = leases.acquire(1_000, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 2,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      jitter: () => 3,
    });
    expect(await dispatcher.dispatchOne(lease, 1_000)).toEqual({ id, state: "retry_scheduled", attempt: 1 });
    expect(db.prepare("SELECT next_attempt_at FROM collaboration_outbox WHERE id = ?").get(id)).toEqual({
      next_attempt_at: 1_013,
    });
    lease = leases.renew(lease, 1_013, 1_000);
    expect(await dispatcher.dispatchOne(lease, 1_013)).toEqual({ id, state: "dead_letter", attempt: 2 });
    expect(db.prepare("SELECT delivery_state, attempt FROM collaboration_outbox WHERE id = ?").get(id)).toEqual({
      delivery_state: "dead_letter",
      attempt: 2,
    });
    db.close();
  });

  it("does not let an obsolete scheduler mark a claimed message sent", async () => {
    const db = database();
    enqueue(db, 1, 1_000);
    let resolveDelivery: ((value: { outcome: "sent" }) => void) | undefined;
    const transport: OutboxDeliveryPort = {
      deliver: () => new Promise((resolve) => (resolveDelivery = resolve)),
    };
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const leaseA = first.acquire(1_000, 50)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 2,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    const pending = dispatcher.dispatchOne(leaseA, 1_000);
    await Promise.resolve();
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 100);
    resolveDelivery!({ outcome: "sent" });
    await expect(pending).rejects.toThrow(StaleFenceError);
    expect(db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    db.close();
  });

  it("serializes superseding versions behind an in-flight older delivery", async () => {
    const db = database();
    const oldId = enqueue(db, 1, 1_000);
    let resolveOld: ((value: { outcome: "sent" }) => void) | undefined;
    const versions: number[] = [];
    const transport: OutboxDeliveryPort = {
      deliver(message) {
        versions.push(message.aggregateVersion);
        if (message.aggregateVersion === 1) return new Promise((resolve) => (resolveOld = resolve));
        return Promise.resolve({ outcome: "sent" });
      },
    };
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 3,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    const inFlight = dispatcher.dispatchOne(lease, 1_000);
    await Promise.resolve();
    const newId = enqueue(db, 2, 1_001);
    expect(await dispatcher.dispatchOne(lease, 1_001)).toBeNull();
    resolveOld!({ outcome: "sent" });
    expect(await inFlight).toEqual({ id: oldId, state: "superseded", attempt: 1 });
    expect(await dispatcher.dispatchOne(lease, 1_002)).toEqual({ id: newId, state: "sent", attempt: 1 });
    expect(versions).toEqual([1, 2]);
    db.close();
  });
});
