import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { ExecutionLifecycle } from "./execution-lifecycle.ts";
import { recoverLifecycleSession } from "./lifecycle-recovery.ts";
import { hasUnsettledExecution } from "./repository-occupancy.ts";
import { hasUnsettledVerification, recordVerificationCommand, recordVerificationProof, reserveVerification, settleVerification } from "./verification-lifecycle.ts";
import { applyCollaborationMigrations } from "./migrations.ts";
import { containmentBindingHash, runtimeIdentityFingerprint, type ContainmentPort, type ContainmentProof } from "./containment.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-recovery-")); roots.push(root);
  const service = startCollaborationService({ dataDirectory: root, planning: {
    planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [root] },
  } });
  const item = service.ingestDingTalkMessage({ sourceEventId: "recovery", transportMessageId: "recovery", conversationId: "test",
    addressedToBot: true, text: "修改提示", sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Test" }, receivedAt: 1000 });
  service.reviseWorkItemDefinition(item.workItemId!, { goal: "修改提示", goalConfirmed: true, repository: root,
    acceptanceConditions: [{ description: "提示清晰", observation: "pnpm test target" }], blockingAmbiguities: [] }, 2000);
  service.close();
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  const leases = new InstanceLeaseCoordinator(db, "old");
  const lease = leases.acquire(Date.now(), 60000)!;
  const session = new ExecutionLifecycle(db, "recovery-execution", lease);
  session.reserve({ workItemId: item.workItemId!, planRevision: 1, repository: root, baseSha: "a".repeat(40), attempt: 1 });
  let state: "active" | "empty" = "active";
  const containment: ContainmentPort = {
    async verifyProof(proof, binding) { return proof.receipt === containmentBindingHash(binding)
      ? { verified: true, fingerprint: runtimeIdentityFingerprint(proof.identity), bindingHash: containmentBindingHash(binding) }
      : { verified: false, reason: "bad_proof" }; },
    async inspect(identity) { return { state, fingerprint: runtimeIdentityFingerprint(identity) }; },
    async terminateAndWaitEmpty() { throw new Error("recovery_must_not_kill"); },
  };
  const binding = { runId: session.id, canonicalWorktreePath: root, instanceOwner: lease.ownerId, instanceFence: lease.fence, nonce: "a".repeat(64) };
  const proof: ContainmentProof = { identity: { backend: "test_verified_runtime", opaqueId: "recovery-runtime-0001", hostGeneration: "generation-1", verifierVersion: "test-v1" }, receipt: containmentBindingHash(binding) };
  const takeover = () => { leases.release(lease, Date.now()); return new InstanceLeaseCoordinator(db, "new").acquire(Date.now(), 60000)!; };
  return { root, db, session, sessionId: session.id, binding, proof, lease, containment, takeover, workItemId: item.workItemId!,
    command(ordinal = 1) { session.command(ordinal, binding); },
    recordProof() { session.proof(1, proof); },
    settle() { return session.settle(containment); },
    empty() { state = "empty"; },
  };
}

async function verificationFixture() {
  const f = fixture();
  await f.session.settle(f.containment);
  const node = f.db.prepare("SELECT node_id,assigned_agent_id FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=1 AND node_type='modify'")
    .get(f.workItemId) as { node_id: string; assigned_agent_id: string };
  const runId = "candidate-for-recovery";
  f.db.prepare("INSERT INTO collaboration_runs (id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES (?,?,1,?,1,?,'thread','turn','succeeded',?,?,'candidate',?,?,3000,3100)")
    .run(runId, f.workItemId, node.node_id, node.assigned_agent_id, f.root, f.root, "a".repeat(40), "b".repeat(40));
  f.db.prepare("INSERT INTO collaboration_candidates (id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES ('recovery-candidate',?,'target_tests_passed',?,?,'[]','[]','{}',3100)")
    .run(runId, "a".repeat(40), "b".repeat(40));
  const sessionId = reserveVerification(f.db, runId, f.lease, Date.now());
  const binding = { ...f.binding, runId: `${runId}:verifier:1` };
  const proof = { ...f.proof, receipt: containmentBindingHash(binding) };
  return { ...f, sessionId, binding, proof,
    command(ordinal = 1) { recordVerificationCommand(f.db, sessionId, ordinal, binding, f.lease, Date.now()); },
    recordProof() { recordVerificationProof(f.db, sessionId, 1, proof, f.lease, Date.now()); },
    settle() { return settleVerification(f.db, sessionId, f.lease, f.containment, Date.now, () => true); },
  };
}

describe("passive lifecycle recovery", () => {
  it("recovers a finalized verifier without changing candidate, reviews or task status", async () => {
    const f = await verificationFixture();
    try {
      f.command(); f.recordProof();
      expect(await f.settle()).toBe(false);
      const readResults = () => ["work_items", "runs", "candidates", "candidate_reviews"].map(table =>
        f.db.prepare(`SELECT * FROM collaboration_${table}`).all());
      const before = readResults();
      const lease = f.takeover(); f.empty();
      const input = { kind: "verification" as const, sessionId: f.sessionId, instance: lease, now: Date.now, containment: f.containment };
      expect((await recoverLifecycleSession(f.db, input)).state).toBe("recovered");
      expect(hasUnsettledVerification(f.db, f.root)).toBe(false);
      expect(readResults()).toEqual(before);
      expect((await recoverLifecycleSession(f.db, input)).state).toBe("already_settled");
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_verification_settlements").get()).toEqual({ n: 1 });
    } finally { f.db.close(); }
  });

  it("recovers a verifier with no reserved commands, fencing all future old-instance commands", async () => {
    const f = await verificationFixture();
    try {
      const lease = f.takeover();
      expect((await recoverLifecycleSession(f.db, { kind: "verification", sessionId: f.sessionId, instance: lease, now: Date.now, containment: f.containment })).state).toBe("recovered");
      expect(() => f.command()).toThrow();
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_verification_commands").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });

  it("does not recover an empty verifier whose coordinator might still launch a reserved command", async () => {
    const f = await verificationFixture();
    try {
      f.command(); f.recordProof(); f.empty();
      expect(await recoverLifecycleSession(f.db, { kind: "verification", sessionId: f.sessionId, instance: f.takeover(), now: Date.now, containment: f.containment }))
        .toMatchObject({ state: "blocked", reason: "coordinator_work_not_confirmed_finished" });
      expect(hasUnsettledVerification(f.db, f.root)).toBe(true);
    } finally { f.db.close(); }
  });

  it.each(["execution", "verification"] as const)("freezes command and proof reservations once %s finalization starts", async kind => {
    const f = kind === "execution" ? fixture() : await verificationFixture();
    try {
      const id = f.sessionId;
      f.command(); await f.settle();
      expect(() => f.db.prepare(`INSERT INTO collaboration_${kind}_commands VALUES(?,2,?,1)`).run(id, JSON.stringify(f.binding))).toThrow("finalizing");
      expect(() => f.db.prepare(`INSERT INTO collaboration_${kind}_proofs VALUES(?,1,?,1)`).run(id, JSON.stringify(f.proof))).toThrow("finalizing");
      expect(() => f.db.prepare(`UPDATE collaboration_${kind}_finalization_intents SET command_count=0 WHERE session_id=?`).run(id)).toThrow("immutable");
      expect(() => f.db.prepare(`DELETE FROM collaboration_${kind}_finalization_intents WHERE session_id=?`).run(id)).toThrow("immutable");
    } finally { f.db.close(); }
  });

  it.each(["execution", "verification"] as const)("does not persist %s recovery after cancellation during inspection", async kind => {
    const f = kind === "execution" ? fixture() : await verificationFixture();
    try {
      const id = f.sessionId;
      f.command(); f.recordProof(); await f.settle();
      const controller = new AbortController();
      f.containment.inspect = async identity => { controller.abort(); return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) }; };
      expect(await recoverLifecycleSession(f.db, { kind, sessionId: id, instance: f.takeover(), now: Date.now, containment: f.containment, signal: controller.signal }))
        .toMatchObject({ state: "blocked", reason: "recovery_cancelled" });
      expect(f.db.prepare(`SELECT 1 FROM collaboration_${kind}_settlements WHERE session_id=?`).get(id)).toBeUndefined();
    } finally { f.db.close(); }
  });

  it("upgrades v20 without fabricating finalization evidence or losing process reservations", async () => {
    const f = fixture();
    try {
      f.session.command(1, f.binding); f.session.proof(1, f.proof);
      const before = ["sessions", "commands", "proofs"].map(table => f.db.prepare(`SELECT * FROM collaboration_execution_${table}`).all());
      for (const kind of ["execution", "verification"]) {
        for (const table of ["commands", "proofs"]) f.db.exec(`DROP TRIGGER ${kind}_${table}_finalizing`);
        f.db.exec(`DROP TABLE collaboration_${kind}_finalization_intents`);
      }
      f.db.exec("DROP VIEW collaboration_mapping_all_results; DROP VIEW collaboration_mapping_all_attempts; DROP TABLE collaboration_mapping_recovery_results; DROP TABLE collaboration_mapping_recovery_attempts; DROP TABLE collaboration_verification_runtime_policies; DROP TABLE collaboration_delivery_queries; DROP TABLE collaboration_document_resources; DROP TABLE collaboration_natural_intake_recoveries; DROP TABLE collaboration_natural_intake_recovery_requests; DROP TABLE collaboration_attachment_recovery_requests; DROP TABLE collaboration_attachment_projection_recoveries; DROP TABLE collaboration_attachment_projection_failures; DROP TABLE collaboration_attachment_failures; DELETE FROM collaboration_schema_migrations WHERE version>=21; PRAGMA user_version=20");
      expect(applyCollaborationMigrations(f.db)).toEqual({ schemaVersion: 30, appliedMigrations: 30 });
      expect(["sessions", "commands", "proofs"].map(table => f.db.prepare(`SELECT * FROM collaboration_execution_${table}`).all())).toEqual(before);
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_execution_finalization_intents").get()).toEqual({ n: 0 });
      f.empty();
      expect((await recoverLifecycleSession(f.db, { kind: "execution", sessionId: f.session.id, instance: f.takeover(), now: Date.now, containment: f.containment })).state).toBe("blocked");
    } finally { f.db.close(); }
  });

  describe.each(["execution", "verification"] as const)("%s evidence boundaries", kind => {
    it.each(["missing_proof", "active", "unknown", "rejected_proof", "fingerprint_mismatch", "same_instance", "lease_lost"] as const)("keeps occupation when %s", async reason => {
      const f = kind === "execution" ? fixture() : await verificationFixture();
      try {
        f.command();
        if (reason !== "missing_proof") f.recordProof();
        expect(await f.settle()).toBe(false);
        const lease = reason === "same_instance" ? f.lease : f.takeover();
        if (reason !== "active") f.empty();
        if (reason === "unknown") f.containment.inspect = async () => ({ state: "unknown", reason: "authority_unavailable" });
        if (reason === "rejected_proof") f.containment.verifyProof = async () => ({ verified: false, reason: "registration_unavailable" });
        if (reason === "fingerprint_mismatch") f.containment.inspect = async () => ({ state: "empty", fingerprint: "different-runtime" });
        if (reason === "lease_lost") f.containment.inspect = async identity => {
          f.db.exec("UPDATE collaboration_instance_lease SET fencing_token=fencing_token+1");
          return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) };
        };
        expect((await recoverLifecycleSession(f.db, { kind, sessionId: f.sessionId, instance: lease, now: Date.now, containment: f.containment })).state).toBe("blocked");
        expect(f.db.prepare(`SELECT 1 FROM collaboration_${kind}_settlements WHERE session_id=?`).get(f.sessionId)).toBeUndefined();
      } finally { f.db.close(); }
    });

    it("competing recovery connections produce only one settlement", async () => {
      const f = kind === "execution" ? fixture() : await verificationFixture();
      const other = new DatabaseSync(join(f.root, "collaboration", "collaboration.sqlite"));
      try {
        f.command(); f.recordProof(); await f.settle(); f.empty();
        const input = { kind, sessionId: f.sessionId, instance: f.takeover(), now: Date.now, containment: f.containment };
        const outcomes = await Promise.all([recoverLifecycleSession(f.db, input), recoverLifecycleSession(other, input)]);
        expect(outcomes.map(result => result.state).sort()).toEqual(["already_settled", "recovered"]);
        expect(other.prepare(`SELECT count(*) AS n FROM collaboration_${kind}_settlements WHERE session_id=?`).get(f.sessionId)).toEqual({ n: 1 });
      } finally { other.close(); f.db.close(); }
    });

    it("does not write late recovery evidence after the database closes", async () => {
      const f = kind === "execution" ? fixture() : await verificationFixture();
      f.command(); f.recordProof(); await f.settle();
      const input = { kind, sessionId: f.sessionId, instance: f.takeover(), now: Date.now, containment: f.containment };
      f.containment.inspect = async identity => {
        f.db.close();
        return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) };
      };
      expect((await recoverLifecycleSession(f.db, input)).state).toBe("blocked");
      const reopened = new DatabaseSync(join(f.root, "collaboration", "collaboration.sqlite"));
      try { expect(reopened.prepare(`SELECT 1 FROM collaboration_${kind}_settlements WHERE session_id=?`).get(f.sessionId)).toBeUndefined(); }
      finally { reopened.close(); }
    });
  });

  it("recovers only finalized execution with complete empty-process evidence, idempotently", async () => {
    const f = fixture();
    try {
      f.session.command(1, f.binding); f.session.proof(1, f.proof);
      expect(await f.session.settle(f.containment)).toBe(false);
      const lease = f.takeover(); f.empty();
      const input = { kind: "execution" as const, sessionId: f.session.id, instance: lease, now: Date.now, containment: f.containment };
      expect((await recoverLifecycleSession(f.db, input)).state).toBe("recovered");
      expect(hasUnsettledExecution(f.db, f.root)).toBe(false);
      expect((await recoverLifecycleSession(f.db, input)).state).toBe("already_settled");
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()).toEqual({ n: 1 });
    } finally { f.db.close(); }
  });

  it.each(["native_unfinished", "missing_proof", "active", "same_instance", "lease_lost"] as const)("does not unlock %s execution", async reason => {
    const f = fixture();
    try {
      if (reason !== "native_unfinished") {
        f.session.command(1, f.binding);
        if (reason !== "missing_proof") f.session.proof(1, f.proof);
        expect(await f.session.settle(f.containment)).toBe(false);
      }
      const lease = reason === "same_instance" ? f.lease : f.takeover();
      if (reason !== "active") f.empty();
      if (reason === "lease_lost") f.containment.inspect = async identity => {
        f.db.exec("UPDATE collaboration_instance_lease SET fencing_token=fencing_token+1");
        return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) };
      };
      const input = { kind: "execution" as const, sessionId: f.session.id, instance: lease, now: Date.now, containment: f.containment };
      await expect(recoverLifecycleSession(f.db, input)).resolves.toMatchObject({ state: "blocked" });
      expect(hasUnsettledExecution(f.db, f.root)).toBe(true);
    } finally { f.db.close(); }
  });
});
