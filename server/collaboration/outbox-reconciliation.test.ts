import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator, StaleFenceError } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { enqueueInboundCard, type OutboxDeliveryPort } from "./outbox.ts";
import { resultDeliveryFixture } from "./outbox-result.test-fixtures.ts";
import { readVerifiedCandidateResultReply } from "./candidate-result-evidence.ts";
import { seedIssuedCandidateRevision } from "./candidate-revision.test-fixtures.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(reconcile: NonNullable<OutboxDeliveryPort["reconcile"]>) {
  const root = mkdtempSync(join(tmpdir(), "outbox-query-")); roots.push(root);
  const ledger = openCollaborationLedger(root); const path = ledger.filePath; ledger.close();
  const db = new DatabaseSync(path);
  const id = enqueueInboundCard(db, { sourceEventId: "source", aggregateType: "work_item", aggregateId: "WI-TEST", aggregateVersion: 1,
    card: { type: "primary_status_card", headline: "已接收", workItemId: "WI-TEST", acknowledgement: "已记录", workItemStatus: "collecting", workItemVersion: 1, association: "created" }, now: 1000 }).id;
  db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',last_error='proactive_delivery_unconfirmed',attempt=1 WHERE id=?").run(id);
  const lease = new InstanceLeaseCoordinator(db, "first").acquire(1000, 100000)!;
  const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
  const transport: OutboxDeliveryPort = { retryPolicy: "only-confirmed-unsent", deliver, reconcile };
  const build = () => new OutboxDispatcher(db, transport, { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
  return { db, path, id, lease, deliver, build };
}
describe("durable query-only delivery reconciliation", () => {
  it.each(["before", "during"])("does not use a parent receipt after revision %s reconciliation", async timing => {
    const root = mkdtempSync(join(tmpdir(), "outbox-query-revision-")); roots.push(root);
    const f = resultDeliveryFixture(root);
    f.db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1 WHERE id=?").run(f.outbox.id);
    const revise = () => seedIssuedCandidateRevision(f.db, { runId: f.target.candidateRunId, candidateSha: f.target.candidateSha, stage: "reserved" });
    if (timing === "before") revise();
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const reconcile = vi.fn(async () => { if (timing === "during") revise(); return { outcome: "sent" as const, candidateResultDelivery: f.proof("proactive", "accepted_receipt") }; });
    try {
      expect(await new OutboxDispatcher(f.db, { deliver, reconcile }, { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 10, maxBackoffMs: 100 }).dispatchOne(f.lease, 4001))
        .toMatchObject({ state: "superseded", operation: "reconcile" });
      expect(reconcile).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
      expect(deliver).not.toHaveBeenCalled();
      expect(readVerifiedCandidateResultReply(f.db, f.target)).toBeNull();
      expect(f.db.prepare("SELECT accepted_candidate_sha FROM collaboration_work_items WHERE id=?").get(f.workItemId)).toEqual({ accepted_candidate_sha: null });
    } finally { f.db.close(); }
  });

  it("records an exact accepted candidate receipt in the sent transaction without resend or duplicate confirmation",async()=>{
    const root=mkdtempSync(join(tmpdir(),"outbox-result-query-"));roots.push(root);const f=resultDeliveryFixture(root);
    f.db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1,last_error='proactive_delivery_unconfirmed' WHERE id=?").run(f.outbox.id);
    const deliver=vi.fn(async()=>({outcome:"sent" as const}));
    const reconcile=vi.fn(async()=>({outcome:"sent" as const,candidateResultDelivery:f.proof("proactive","accepted_receipt")}));
    const dispatcher=new OutboxDispatcher(f.db,{deliver,reconcile},{maxAttempts:3,claimTtlMs:1000,baseBackoffMs:10,maxBackoffMs:100});
    try{
      expect(await dispatcher.dispatchOne(f.lease,4001)).toMatchObject({state:"sent",operation:"reconcile"});
      expect(readVerifiedCandidateResultReply(f.db,f.target)).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.db.prepare("SELECT o.sent_at=d.sent_at AS same_time,o.delivery_sequence=d.delivery_sequence AS same_sequence,d.confirmation_kind FROM collaboration_outbox o JOIN collaboration_candidate_result_deliveries d ON d.outbox_id=o.id WHERE o.id=?").get(f.outbox.id))
        .toEqual({same_time:1,same_sequence:1,confirmation_kind:"accepted_receipt"});
      expect(await dispatcher.dispatchOne(f.lease,4002)).toBeNull();expect(reconcile).toHaveBeenCalledTimes(1);expect(deliver).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it.each(["before","during"])("rejects candidate receipt reconciliation if cancellation occurs %s its query",async timing=>{
    const root=mkdtempSync(join(tmpdir(),"outbox-result-query-cancel-"));roots.push(root);const f=resultDeliveryFixture(root);
    f.db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1 WHERE id=?").run(f.outbox.id);
    const cancel=()=>f.db.prepare("UPDATE collaboration_work_items SET control_state='cancelled',status='cancelled' WHERE id=?").run(f.workItemId);
    if(timing==="before")cancel();
    const deliver=vi.fn(async()=>({outcome:"sent" as const}));const reconcile=vi.fn(async()=>{cancel();return{outcome:"sent" as const,candidateResultDelivery:f.proof("proactive","accepted_receipt")};});
    try{
      expect(await new OutboxDispatcher(f.db,{deliver,reconcile},{maxAttempts:3,claimTtlMs:1000,baseBackoffMs:10,maxBackoffMs:100}).dispatchOne(f.lease,4001)).toMatchObject({state:"superseded",operation:"reconcile"});
      expect(reconcile).toHaveBeenCalledTimes(timing==="before"?0:1);expect(deliver).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT sent_at FROM collaboration_outbox WHERE id=?").get(f.outbox.id)).toEqual({sent_at:null});
      expect(readVerifiedCandidateResultReply(f.db,f.target)).toBeNull();
    }finally{f.db.close();}
  });
  it("automatically confirms an accepted message and never sends it again", async () => {
    const query = vi.fn(async () => ({ outcome: "sent" as const })); const f = fixture(query);
    try {
      expect(await f.build().dispatchOne(f.lease, 1001)).toMatchObject({ state: "sent", operation: "reconcile" });
      expect(f.db.prepare("SELECT delivery_state,attempt FROM collaboration_outbox WHERE id=?").get(f.id)).toEqual({ delivery_state: "sent", attempt: 1 });
      expect(await f.build().dispatchOne(f.lease, 1002)).toBeNull();
      expect(query).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("retains backoff and a three-query budget across reconstruction", async () => {
    const query = vi.fn(async () => ({ outcome: "unknown" as const, error: "private-query-error" })); const f = fixture(query);
    try {
      await f.build().dispatchOne(f.lease, 1001);
      expect(await f.build().dispatchOne(f.lease, 1002)).toBeNull();
      await f.build().dispatchOne(f.lease, 2000); await f.build().dispatchOne(f.lease, 4000);
      expect(await f.build().dispatchOne(f.lease, 8000)).toBeNull();
      expect(query).toHaveBeenCalledTimes(3); expect(f.deliver).not.toHaveBeenCalled();
      expect(JSON.stringify(f.db.prepare("SELECT * FROM collaboration_delivery_queries").all())).not.toContain("private-query-error");
    } finally { f.db.close(); }
  });
  it("stops when there is no receipt, without treating that as unsent", async () => {
    const query = vi.fn(async () => null); const f = fixture(query);
    try {
      await f.build().dispatchOne(f.lease, 1001); expect(await f.build().dispatchOne(f.lease, 9000)).toBeNull();
      expect(query).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT delivery_state,sent_at FROM collaboration_outbox").get()).toEqual({ delivery_state: "dead_letter", sent_at: null });
    } finally { f.db.close(); }
  });
  it.each(["superseded", "payload"])("does not apply a late query after %s changes", async mode => {
    let finish!: (value: { outcome: "sent" }) => void;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = f.build().dispatchOne(f.lease, 1001); await Promise.resolve();
      if (mode === "superseded") f.db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=1002 WHERE id=?").run(f.id);
      else f.db.prepare("UPDATE collaboration_outbox SET payload_json='{}' WHERE id=?").run(f.id);
      finish({ outcome: "sent" }); await pending;
      expect(f.db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    } finally { f.db.close(); }
  });
  it("rejects an elapsed claim even without an instance takeover", async () => {
    let finish!: (value: { outcome: "sent" }) => void; let wall = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = f.build().dispatchOne(f.lease, 1001); await Promise.resolve(); wall = 1001; finish({ outcome: "sent" });
      await expect(pending).rejects.toThrow(StaleFenceError);
      expect(f.db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    } finally { f.db.close(); }
  });
  it("recovers an expired query without resetting its budget and rejects the old response", async () => {
    let finish!: (value: { outcome: "sent" }) => void; let calls = 0;
    const f = fixture(() => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ outcome: "sent" }));
    try {
      const pending = f.build().dispatchOne(f.lease, 1001); await Promise.resolve();
      expect(await f.build().dispatchOne(f.lease, 1500)).toBeNull();
      expect(await f.build().dispatchOne(f.lease, 2002)).toMatchObject({ state: "sent", attempt: 2, operation: "reconcile" });
      finish({ outcome: "sent" }); await expect(pending).rejects.toThrow(StaleFenceError);
      expect(f.db.prepare("SELECT attempt,outcome FROM collaboration_delivery_queries ORDER BY attempt").all()).toEqual([
        { attempt: 1, outcome: null }, { attempt: 2, outcome: "confirmed" },
      ]);
      expect(f.deliver).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("rejects a replaced instance and preserves the pending query evidence", async () => {
    let finish!: (value: { outcome: "sent" }) => void;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = f.build().dispatchOne(f.lease, 1001); await Promise.resolve();
      new InstanceLeaseCoordinator(f.db, "replacement").acquire(101001, 10000);
      finish({ outcome: "sent" }); await expect(pending).rejects.toThrow(StaleFenceError);
      expect(f.db.prepare("SELECT outcome FROM collaboration_delivery_queries").get()).toEqual({ outcome: null });
      expect(f.db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    } finally { f.db.close(); }
  });
  it("alternates fresh sends and queries while keeping the query budget immutable", async () => {
    const query = vi.fn(async () => ({ outcome: "unknown" as const, error: "not-yet" })); const f = fixture(query);
    try {
      for (let i = 0; i < 2; i++) enqueueInboundCard(f.db, { sourceEventId: `fresh-${i}`, aggregateType: "association", aggregateId: "unrelated", aggregateVersion: 1,
        card: { type: "clarification_card", headline: "需要澄清", workItemId: "", snapshotRevision: 0, questions: [] }, now: 1000 });
      const dispatcher = f.build();
      expect(await dispatcher.dispatchOne(f.lease, 1001)).toMatchObject({ state: "sent" });
      expect(await dispatcher.dispatchOne(f.lease, 1002)).toMatchObject({ operation: "reconcile" });
      expect(await dispatcher.dispatchOne(f.lease, 1003)).toMatchObject({ state: "sent" });
      expect(f.deliver).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(1);
      expect(() => f.db.exec("DELETE FROM collaboration_delivery_queries")).toThrow();
      expect(() => f.db.exec("UPDATE collaboration_delivery_queries SET attempt=1,completed_at=NULL,outcome=NULL")).toThrow();
    } finally { f.db.close(); }
  });
});
