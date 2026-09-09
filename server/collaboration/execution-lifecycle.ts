import type { DatabaseSync } from "node:sqlite";
import { verifyContainmentProof, type ContainmentBinding, type ContainmentPort, type ContainmentProof } from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { canonicalRepository, hasUnsettledRepositoryActivity } from "./repository-occupancy.ts";
import { consumeExecutionRecoveryStart } from "./execution-recovery-authorization.ts";

type Lease = Pick<InstanceLease, "ownerId" | "fence">;

/** An immutable reservation is not released by a lease timeout or a terminal run label. */
export class ExecutionLifecycle {
  private readonly db: DatabaseSync;
  readonly id: string;
  private readonly lease: Lease;

  constructor(db: DatabaseSync, id: string, lease: Lease) {
    this.db = db;
    this.id = id;
    this.lease = lease;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertLedgerArmed(this.db);
      assertCurrentInstanceLease(this.db, this.lease, Date.now());
      const result = operation(); this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  reserve(input: { workItemId: string; planRevision: number; repository: string; baseSha: string; attempt: number; maxAttempts?: number }): void {
    this.transaction(() => {
      const repository = canonicalRepository(input.repository);
      if (hasUnsettledRepositoryActivity(this.db, repository)) throw new Error("execution_repository_unsettled");
      if (!this.db.prepare("SELECT 1 FROM collaboration_work_items WHERE id=? AND current_plan_revision=? AND control_state='active' AND definition_status='ready_for_execution' AND status NOT IN ('accepted','cancelled')")
        .get(input.workItemId, input.planRevision)) throw new Error("execution_target_unavailable");
      if (input.maxAttempts !== undefined && input.attempt > input.maxAttempts) {
        consumeExecutionRecoveryStart(this.db, { workItemId: input.workItemId, attempt: input.attempt,
          maxAttempts: input.maxAttempts, lease: this.lease, baseSha: input.baseSha, sessionId: this.id, now: Date.now() });
      }
      this.db.prepare("INSERT INTO collaboration_execution_sessions(id,work_item_id,plan_revision,repository_path,base_sha,attempt,instance_owner,instance_fence,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(this.id, input.workItemId, input.planRevision, repository, input.baseSha, input.attempt, this.lease.ownerId, this.lease.fence, Date.now());
    });
  }

  private assertOpen(): void {
    if (!this.db.prepare("SELECT 1 FROM collaboration_execution_sessions s WHERE s.id=? AND s.instance_owner=? AND s.instance_fence=? AND NOT EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=s.id)")
      .get(this.id, this.lease.ownerId, this.lease.fence)) throw new Error("execution_session_unavailable");
  }

  command(ordinal: number, binding: ContainmentBinding): void {
    this.transaction(() => {
      this.assertOpen();
      if (binding.runId !== this.id || binding.instanceOwner !== this.lease.ownerId || binding.instanceFence !== this.lease.fence) throw new Error("execution_binding_stale");
      this.db.prepare("INSERT INTO collaboration_execution_commands(session_id,ordinal,binding_json,created_at) VALUES(?,?,?,?)")
        .run(this.id, ordinal, JSON.stringify(binding), Date.now());
    });
  }

  proof(ordinal: number, proof: ContainmentProof): void {
    this.transaction(() => {
      this.assertOpen();
      this.db.prepare("INSERT INTO collaboration_execution_proofs(session_id,ordinal,proof_json,created_at) VALUES(?,?,?,?)")
        .run(this.id, ordinal, JSON.stringify(proof), Date.now());
    });
  }

  async settle(containment: ContainmentPort): Promise<boolean> {
    // Called only after the executor has stopped issuing native worktree operations.
    // A new instance must not infer this boundary just from empty Agent containers.
    this.transaction(() => {
      this.assertOpen();
      this.db.prepare("INSERT OR IGNORE INTO collaboration_execution_finalization_intents(session_id,command_count,created_at) SELECT ?,count(*),? FROM collaboration_execution_commands WHERE session_id=?")
        .run(this.id, Date.now(), this.id);
    });
    const rows = this.db.prepare("SELECT c.ordinal,c.binding_json,p.proof_json FROM collaboration_execution_commands c LEFT JOIN collaboration_execution_proofs p ON p.session_id=c.session_id AND p.ordinal=c.ordinal WHERE c.session_id=? ORDER BY c.ordinal")
      .all(this.id) as unknown as Array<{ ordinal: number; binding_json: string; proof_json: string | null }>;
    const evidence: Array<{ ordinal: number; fingerprint: string; state: "empty" }> = [];
    for (const row of rows) {
      if (!row.proof_json) return false;
      const proof = JSON.parse(row.proof_json) as ContainmentProof;
      const binding = JSON.parse(row.binding_json) as ContainmentBinding;
      const verified = await verifyContainmentProof(containment, proof, binding);
      if (!verified.verified) return false;
      const state = await containment.inspect(proof.identity);
      if (state.state !== "empty" || state.fingerprint !== verified.fingerprint) return false;
      evidence.push({ ordinal: row.ordinal, fingerprint: verified.fingerprint, state: "empty" });
    }
    return this.transaction(() => {
      this.assertOpen();
      const count = this.db.prepare("SELECT count(*) AS n FROM collaboration_execution_commands WHERE session_id=?").get(this.id) as { n: number };
      if (count.n !== rows.length) return false;
      this.db.prepare("INSERT INTO collaboration_execution_settlements(session_id,evidence_json,created_at) VALUES(?,?,?)")
        .run(this.id, JSON.stringify(evidence), Date.now());
      return true;
    });
  }
}
