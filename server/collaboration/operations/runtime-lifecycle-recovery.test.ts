import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollaborationService } from "../service.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";
import { ExecutionLifecycle } from "../execution-lifecycle.ts";
import { recoverLifecycleSession } from "../lifecycle-recovery.ts";
import { containmentBindingHash, runtimeIdentityFingerprint, type ContainmentPort, type ContainmentInspection } from "../containment.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";
import { renderDingTalkSessionMessage } from "../../integrations/dingtalk/session-message.ts";
import { OutboxDispatcher } from "../outbox-dispatcher.ts";
import { currentInstanceLease } from "../leases.ts";
import { createDingTalkDelivery } from "../../collaboration-headless.ts";
import { DingTalkSessionReplyRegistry } from "../../integrations/dingtalk/reply-router.ts";
import type { OutboxDeliveryPort } from "../outbox.ts";
import { enqueueInboundCard } from "../outbox.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(unactivated = false) {
  const root = mkdtempSync(join(tmpdir(), "runtime-lifecycle-recovery-")); roots.push(root);
  const service = startCollaborationService({ dataDirectory: root, planning: {
    planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [root] },
  } });
  const item = service.ingestDingTalkMessage({ sourceEventId: "recovery", transportMessageId: "recovery", conversationId: "test",
    addressedToBot: true, text: "修正保存提示", sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Test" }, receivedAt: 1000 });
  service.reviseWorkItemDefinition(item.workItemId!, { goal: "修正保存提示", goalConfirmed: true, repository: root,
    acceptanceConditions: [{ description: "提示清晰", observation: "pnpm test target" }], blockingAmbiguities: [] }, 2000);
  service.close();
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const leases = new InstanceLeaseCoordinator(db, "old");
  const lease = leases.acquire(Date.now(), 60000)!;
  if (unactivated) db.prepare("INSERT INTO collaboration_coordinator_proofs(instance_owner,instance_fence,proof_json,created_at) VALUES(?,?,?,?)")
    .run(lease.ownerId, lease.fence, JSON.stringify({ ownerId: lease.ownerId, fence: lease.fence }), Date.now());
  const session = new ExecutionLifecycle(db, "runtime-recovery-execution", lease);
  session.reserve({ workItemId: item.workItemId!, planRevision: 1, repository: root, baseSha: "a".repeat(40), attempt: 1 });
  const binding = { runId: session.id, canonicalWorktreePath: root, instanceOwner: lease.ownerId, instanceFence: lease.fence, nonce: "a".repeat(64) };
  const proof = { identity: { backend: "test_verified_runtime", opaqueId: "recovery-runtime-0001", hostGeneration: "generation-1", verifierVersion: "test-v1" }, receipt: containmentBindingHash(binding) };
  const containment: ContainmentPort = {
    async verifyProof(p, b) { return { verified: true, fingerprint: runtimeIdentityFingerprint(p.identity), bindingHash: containmentBindingHash(b) }; },
    async inspect(identity) { return { state: "active", fingerprint: runtimeIdentityFingerprint(identity) }; },
    async terminateAndWaitEmpty() { throw new Error("recovery_must_not_kill"); },
  };
  session.command(1, binding); if (!unactivated) session.proof(1, proof);
  await session.settle(containment);
  leases.release(lease, Date.now());
  const runtime = (lifecycleRecoveryTimeoutMs = 5000) => new CollaborationHeadlessRuntime({ dataDirectory: root, containment, shutdownTimeoutMs: 25, platform: "linux", lifecycleRecoveryTimeoutMs,
    ...(unactivated ? { coordinator: { capture: async (instance: { ownerId: string; fence: number }) => instance,
      inspect: async (_proof: unknown, instance: { ownerId: string; fence: number }) => ({ state: instance.ownerId === "old" ? "stopped" as const : "active" as const, fingerprint: "f".repeat(64) }) },
    unactivatedLaunchRecovery: { async recover() { return { state: "aborted_before_activation" as const, bindingHash: containmentBindingHash(binding), containerId: "c".repeat(64), launchHash: "a".repeat(64), deniedGateHash: "d".repeat(64) }; } } } : {}) });
  const notices = () => db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id LIKE 'lifecycle-recovery:%'").all() as Array<{payload_json:string}>;
  const settled = () => !!db.prepare("SELECT 1 FROM collaboration_execution_settlements WHERE session_id=?").get(session.id);
  return { root, db, session, binding, proof, containment, runtime, notices, settled, workItemId: item.workItemId! };
}

describe("runtime passive lifecycle recovery", () => {
  it("explains that an aborted launch never began and replays no success or duplicate reply", async () => {
    const f = await fixture(true), runtime = f.runtime();
    try {
      await runtime.start(); await vi.waitFor(() => expect(f.settled()).toBe(true));
      await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      expect(f.notices()[0].payload_json).toContain("上次修改尚未开始");
      expect(f.notices()[0].payload_json).not.toContain("已确认上次处理彻底结束");
      expect(f.notices()[0].payload_json).toContain("这不代表修改完成");
      await runtime.stop(); const second = f.runtime();
      try { await second.start(); await second.drainOnce(); expect(f.notices()).toHaveLength(1); }
      finally { await second.stop(); }
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("unblocks the next queued reply after a real sender stalls without resending the uncertain one", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let first = true;
    const fetcher = vi.fn(async () => {
      if (first) { first = false; return new Response(new ReadableStream()); }
      return new Response(JSON.stringify({ errcode: 0 }));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      f.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1");
      const sessions = new DingTalkSessionReplyRegistry();
      for (const [index, id] of ["deadline-first", "deadline-next"].entries()) {
        enqueueInboundCard(f.db, { sourceEventId: id, aggregateType: "work_item", aggregateId: f.workItemId, aggregateVersion: 1,
          card: { type: "primary_status_card", headline: "已接收", acknowledgement: "原消息已保存", workItemId: f.workItemId, workItemVersion: 1, workItemStatus: "collecting", association: "created" },
          now: Date.now()+index });
        sessions.capture({ sourceEventId: id, webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
      }
      const lease = new InstanceLeaseCoordinator(f.db, "deadline-test").acquire(Date.now(), 60000)!;
      const options = { maxAttempts: 3, claimTtlMs: 30000, baseBackoffMs: 1, maxBackoffMs: 10 };
      const dispatcher = new OutboxDispatcher(f.db, createDingTalkDelivery(sessions, {}, f.root), options);
      const stalled = dispatcher.dispatchOne(lease, Date.now());
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await stalled).toMatchObject({ state: "dead_letter" });
      expect(await dispatcher.dispatchOne(lease, Date.now())).toMatchObject({ state: "dead_letter", operation: "reconcile" });
      expect(await dispatcher.dispatchOne(lease, Date.now())).toMatchObject({ state: "sent" });
      const restarted = new OutboxDispatcher(f.db, createDingTalkDelivery(sessions, {}, f.root), options);
      expect(await restarted.dispatchOne(lease, Date.now())).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(f.db.prepare("SELECT sent_at,last_error FROM collaboration_outbox WHERE source_event_id='deadline-first'").get())
        .toEqual({ sent_at: null, last_error: "session_delivery_unconfirmed" });
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); f.db.close(); }
  });
  it.each(["lost business receipt", JSON.stringify({ errcode: 0, success: false }), JSON.stringify({ errcode: 310000, success: true })])("wires uncertain real-adapter delivery into a durable no-resend state: %s", async body => {
    const f = await fixture();
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const row = f.db.prepare("SELECT id FROM collaboration_outbox WHERE source_event_id='recovery'").get() as { id: string };
      f.db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1 WHERE id<>?").run(row.id);
      const sessions = new DingTalkSessionReplyRegistry();
      sessions.capture({ sourceEventId: "recovery", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now()+60000 });
      const delivery = createDingTalkDelivery(sessions, {}, f.root);
      expect(delivery.retryPolicy).toBe("only-confirmed-unsent");
      const lease = new InstanceLeaseCoordinator(f.db, "delivery-test").acquire(Date.now(), 60000)!;
      const options = { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 1, maxBackoffMs: 10 };
      expect(await new OutboxDispatcher(f.db, delivery, options).dispatchOne(lease, Date.now())).toMatchObject({ state: "dead_letter" });
      const restarted = createDingTalkDelivery(new DingTalkSessionReplyRegistry(), {}, f.root);
      expect(await new OutboxDispatcher(f.db, restarted, options).dispatchOne(lease, Date.now()+100)).toMatchObject({ state: "dead_letter", operation: "reconcile" });
      expect(await new OutboxDispatcher(f.db, restarted, options).dispatchOne(lease, Date.now()+200)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT sent_at,last_error FROM collaboration_outbox WHERE id=?").get(row.id))
        .toEqual({ sent_at: null, last_error: "session_delivery_unconfirmed" });
    } finally { vi.unstubAllGlobals(); f.db.close(); }
  });
  it.each(["unchanged", "pause", "cancel", "new_contribution", "settled", "retry_pause", "expired_claim", "recovered", "new_activity"] as const)("revalidates recovery notice at delivery: %s", async change => {
    const f = await fixture(); const runtime = f.runtime(); let sends = 0;
    try {
      if (change === "recovered" || change === "new_activity") f.containment.inspect = async identity => ({ state: "empty", fingerprint: runtimeIdentityFingerprint(identity) });
      await runtime.start(); await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      f.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1 WHERE source_event_id NOT LIKE 'lifecycle-recovery:%'");
      const lease = currentInstanceLease(f.db)!;
      const dispatcher = new OutboxDispatcher(f.db, { async deliver() { sends++; return change === "retry_pause" ? { outcome: "retryable", error: "try_later" } : { outcome: "sent" }; } },
        { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 1, maxBackoffMs: 10 });
      if (change === "retry_pause") expect((await dispatcher.dispatchOne(lease, Date.now()))?.state).toBe("retry_scheduled");
      if (change === "pause" || change === "retry_pause" || change === "expired_claim") f.db.prepare("UPDATE collaboration_work_items SET control_state='paused',version=version+1 WHERE id=?").run(f.workItemId);
      if (change === "expired_claim") f.db.prepare("UPDATE collaboration_outbox SET delivery_state='claimed',claim_owner='expired',claim_fence=1,claim_expires_at=? WHERE source_event_id LIKE 'lifecycle-recovery:%'").run(Date.now()-1);
      if (change === "new_activity") new ExecutionLifecycle(f.db, "next-execution", lease).reserve({ workItemId: f.workItemId, planRevision: 1, repository: f.root, baseSha: "a".repeat(40), attempt: 2 });
      if (change === "cancel") f.db.prepare("UPDATE collaboration_work_items SET status='cancelled',control_state='cancelled',version=version+1 WHERE id=?").run(f.workItemId);
      if (change === "new_contribution") f.db.prepare("UPDATE collaboration_work_items SET version=version+1 WHERE id=?").run(f.workItemId);
      if (change === "settled") {
        f.containment.inspect = async identity => ({ state: "empty", fingerprint: runtimeIdentityFingerprint(identity) });
        await recoverLifecycleSession(f.db, { kind: "execution", sessionId: f.session.id, instance: lease, containment: f.containment, now: Date.now });
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      const shouldSend = change === "unchanged" || change === "recovered";
      expect(await dispatcher.dispatchOne(lease, Date.now())).toMatchObject({ state: shouldSend ? "sent" : "superseded" });
      expect(sends).toBe(shouldSend || change === "retry_pause" ? 1 : 0);
    } finally { await runtime.stop(); f.db.close(); }
  });

  it.each(["current", "previous"] as const)("routes a %s synthetic recovery event through the real task session without credentials or a card template", async version => {
    const f = await fixture(); const runtime = f.runtime();
    const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await runtime.start(); await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      const row = f.db.prepare("SELECT id,aggregate_type,aggregate_id,aggregate_version,kind,dedupe_key,payload_json FROM collaboration_outbox WHERE source_event_id LIKE 'lifecycle-recovery:%'").get() as {
        id:string; aggregate_type:"work_item"|"plan"; aggregate_id:string; aggregate_version:number; kind:"command_status_card"; dedupe_key:string; payload_json:string;
      };
      const sessions = new DingTalkSessionReplyRegistry();
      sessions.capture({ sourceEventId: "recovery", webhookUrl: "https://api.dingtalk.com/session-fixture", expiresAt: Date.now() + 60000 });
      const message: Parameters<OutboxDeliveryPort["deliver"]>[0] = { id: row.id, source: "dingtalk", dedupeKey: row.dedupe_key, aggregateType: version === "previous" ? "work_item" : row.aggregate_type,
        aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, kind: row.kind, payload: JSON.parse(row.payload_json) };
      expect(await createDingTalkDelivery(sessions, {}, f.root).deliver(message)).toEqual({ outcome: "sent" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.dingtalk.com/session-fixture");
    } finally { vi.unstubAllGlobals(); await runtime.stop(); f.db.close(); }
  });

  it("repairs the notification gap after settlement persisted but the previous process stopped before enqueue", async () => {
    const f = await fixture(); const runtime = f.runtime();
    f.containment.inspect = async identity => ({ state: "empty", fingerprint: runtimeIdentityFingerprint(identity) });
    const leases = new InstanceLeaseCoordinator(f.db, "settled-before-crash"); const lease = leases.acquire(Date.now(), 60000)!;
    expect((await recoverLifecycleSession(f.db, { kind: "execution", sessionId: f.session.id, instance: lease, containment: f.containment, now: Date.now })).state).toBe("recovered");
    leases.release(lease, Date.now());
    const inspect = vi.spyOn(f.containment, "inspect");
    try {
      expect(f.notices()).toHaveLength(0);
      await runtime.start();
      await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      expect(inspect).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 1 });
    } finally { await runtime.stop(); f.db.close(); }
  });
  it("starts and maintains the service while inspection waits, then recovers once", async () => {
    const f = await fixture(); const runtime = f.runtime();
    let finish!: (state: ContainmentInspection) => void;
    const inspection = new Promise<ContainmentInspection>(resolve => { finish = resolve; });
    const inspect = vi.spyOn(f.containment, "inspect").mockReturnValue(inspection);
    try {
      expect((await runtime.start()).ready).toBe(true);
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
      await runtime.drainOnce();
      expect(f.settled()).toBe(false);
      finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) });
      await vi.waitFor(() => expect(f.settled()).toBe(true));
      expect(f.notices()).toHaveLength(1);
      expect(f.notices()[0].payload_json).not.toContain("修改完成");
      await runtime.drainOnce();
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally { finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) }); await runtime.stop(); f.db.close(); }
  });

  it("notifies about unconfirmed work once across repeated drains and service restarts", async () => {
    const f = await fixture(); const first = f.runtime(); const second = f.runtime();
    try {
      await first.start();
      await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      expect(f.settled()).toBe(false);
      const notice = JSON.parse(f.notices()[0].payload_json);
      expect(notice.summary).toContain("为避免重复修改");
      expect(notice.summary).toContain("负责人");
      expect(notice.summary).not.toMatch(/WI-|execution_|fingerprint|provider_/);
      const rendered = JSON.stringify(renderDingTalkSessionMessage(notice));
      expect(rendered).toContain("为避免重复修改");
      expect(rendered).not.toMatch(/WI-|任务编号|控制状态|业务状态/);
      await first.drainOnce(); await first.drainOnce();
      await first.stop(); await second.start(); await second.drainOnce();
      expect(f.notices()).toHaveLength(1);
    } finally { await first.stop(); await second.stop(); f.db.close(); }
  });

  it.each(["stop", "lease_lost", "paused"] as const)("does not publish stale recovery results after %s", async change => {
    const f = await fixture(); const runtime = f.runtime();
    let finish!: (state: ContainmentInspection) => void;
    const inspect = vi.spyOn(f.containment, "inspect").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    try {
      await runtime.start(); await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
      if (change === "stop") {
        await runtime.stop();
        expect(runtime.health().state).toBe("stopped");
      } else if (change === "lease_lost") f.db.exec("UPDATE collaboration_instance_lease SET fencing_token=fencing_token+1");
      else f.db.prepare("UPDATE collaboration_work_items SET control_state='paused' WHERE id=?").run(f.workItemId);
      finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(f.notices()).toHaveLength(0);
      expect(f.settled()).toBe(change === "paused");
    } finally { finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) }); await runtime.stop(); f.db.close(); }
  });

  it("times out an unresponsive inspection, sends a bounded notice and ignores late success", async () => {
    const f = await fixture(); const runtime = f.runtime(20);
    let finish!: (state: ContainmentInspection) => void;
    vi.spyOn(f.containment, "inspect").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    try {
      await runtime.start();
      await vi.waitFor(() => expect(f.notices()).toHaveLength(1));
      expect(f.settled()).toBe(false);
      finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) });
      await runtime.drainOnce();
      expect(f.settled()).toBe(false);
      expect(runtime.health().ready).toBe(true);
    } finally { finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) }); await runtime.stop(); f.db.close(); }
  });

  it("does not route a durable running execution through blocking legacy startup inspection", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const node = f.db.prepare("SELECT node_id,assigned_agent_id FROM collaboration_work_nodes WHERE work_item_id=? AND node_type='modify'").get(f.workItemId) as {node_id:string;assigned_agent_id:string};
    f.db.prepare("INSERT INTO collaboration_runs (id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,started_at,instance_owner,instance_fence,containment_binding_json,runtime_identity_json,containment_fingerprint) VALUES (?,?,1,?,1,?,'thread','turn','running',?,?,'candidate',?,3000,?,?,?,?,?)")
      .run(f.session.id, f.workItemId, node.node_id, node.assigned_agent_id, f.root, f.root, "a".repeat(40), f.binding.instanceOwner, f.binding.instanceFence, JSON.stringify(f.binding), JSON.stringify(f.proof), runtimeIdentityFingerprint(f.proof.identity));
    let finish!: (state: ContainmentInspection) => void;
    const inspect = vi.spyOn(f.containment, "inspect").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    let started = false; const starting = runtime.start().then(() => { started = true; });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
      expect(runtime.recovery()).toEqual([]);
    } finally { finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) }); await starting; await runtime.stop(); f.db.close(); }
  });

  it("recovers another repository while the first repository inspection is waiting", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const otherRepository = join(f.root, "other");
    const service = startCollaborationService({ dataDirectory: f.root, planning: { planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [f.root, otherRepository] } } });
    const item = service.ingestDingTalkMessage({ sourceEventId: "other", transportMessageId: "other", conversationId: "other", addressedToBot: true, text: "修正另一个提示", sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Test" }, receivedAt: 4000 });
    service.reviseWorkItemDefinition(item.workItemId!, { goal: "修正另一个提示", goalConfirmed: true, repository: otherRepository, acceptanceConditions: [{ description: "提示清晰", observation: "pnpm test target" }], blockingAmbiguities: [] }, 4100);
    service.close();
    const leases = new InstanceLeaseCoordinator(f.db, "another-old-instance"); const lease = leases.acquire(Date.now(), 60000)!;
    const session = new ExecutionLifecycle(f.db, "other-recovery-session", lease);
    session.reserve({ workItemId: item.workItemId!, planRevision: 1, repository: otherRepository, baseSha: "a".repeat(40), attempt: 1 });
    const binding = { ...f.binding, runId: session.id, canonicalWorktreePath: otherRepository, instanceOwner: lease.ownerId, instanceFence: lease.fence };
    const proof = { identity: { ...f.proof.identity, opaqueId: "other-runtime-00001" }, receipt: containmentBindingHash(binding) };
    session.command(1, binding); session.proof(1, proof); await session.settle(f.containment); leases.release(lease, Date.now());
    let finish!: (state: ContainmentInspection) => void;
    const pending = new Promise<ContainmentInspection>(resolve => { finish = resolve; });
    f.containment.inspect = async identity => identity.opaqueId === f.proof.identity.opaqueId ? pending : { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) };
    try {
      await runtime.start();
      await vi.waitFor(() => expect(f.db.prepare("SELECT 1 FROM collaboration_execution_settlements WHERE session_id=?").get(session.id)).toBeDefined());
      expect(f.settled()).toBe(false);
    } finally { finish({ state: "empty", fingerprint: runtimeIdentityFingerprint(f.proof.identity) }); await runtime.stop(); f.db.close(); }
  });
});
