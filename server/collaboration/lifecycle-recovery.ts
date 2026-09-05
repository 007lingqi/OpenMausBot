import type { DatabaseSync } from "node:sqlite";
import { verifyContainmentProof, type ContainmentBinding, type ContainmentPort, type ContainmentProof } from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

export interface LifecycleRecoveryInput {
  kind: "execution" | "verification";
  sessionId: string;
  instance: Pick<InstanceLease, "ownerId" | "fence">;
  containment: ContainmentPort;
  now: () => number;
  signal?: AbortSignal;
}
export interface LifecycleRecoveryOutcome {
  state: "recovered" | "already_settled" | "blocked";
  reason: string;
  workItemId: string | null;
}

/** Passive recovery: no kill, deletion, retry, approval, or trust in terminal Run labels. */
export async function recoverLifecycleSession(db: DatabaseSync, input: LifecycleRecoveryInput): Promise<LifecycleRecoveryOutcome> {
  const kind = input.kind === "execution" ? "execution" : "verification";
  const table = `collaboration_${kind}`;
  let workItemId: string | null = null;
  const blocked = (reason: string): LifecycleRecoveryOutcome => ({ state: "blocked", reason, workItemId });
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    assertLedgerArmed(db);
    assertCurrentInstanceLease(db, input.instance, input.now());
  };
  try {
    assertCurrent();
    const row = db.prepare(kind === "execution"
      ? `SELECT s.instance_owner,s.instance_fence,s.work_item_id,s.id AS run_id FROM ${table}_sessions s WHERE s.id=?`
      : `SELECT s.instance_owner,s.instance_fence,r.work_item_id,s.candidate_run_id AS run_id FROM ${table}_sessions s JOIN collaboration_runs r ON r.id=s.candidate_run_id WHERE s.id=?`)
      .get(input.sessionId) as { instance_owner: string; instance_fence: number; work_item_id: string; run_id: string } | undefined;
    if (!row) return blocked("session_missing");
    workItemId = row.work_item_id;
    const isSettled = () => !!db.prepare(`SELECT 1 FROM ${table}_settlements WHERE session_id=?`).get(input.sessionId);
    if (isSettled()) return { state: "already_settled", reason: "already_settled", workItemId };
    if (row.instance_owner === input.instance.ownerId && row.instance_fence === input.instance.fence) return blocked("original_instance_current");
    const commands = db.prepare(`SELECT c.ordinal,c.binding_json,p.proof_json FROM ${table}_commands c LEFT JOIN ${table}_proofs p ON p.session_id=c.session_id AND p.ordinal=c.ordinal WHERE c.session_id=? ORDER BY c.ordinal`)
      .all(input.sessionId) as unknown as Array<{ ordinal: number; binding_json: string; proof_json: string | null }>;
    if (kind === "execution" || commands.length > 0) {
      const intent = db.prepare(`SELECT command_count FROM ${table}_finalization_intents WHERE session_id=?`).get(input.sessionId) as { command_count: number } | undefined;
      if (!intent || intent.command_count !== commands.length) return blocked("coordinator_work_not_confirmed_finished");
    }
    const evidence: Array<{ ordinal: number; fingerprint: string; state: "empty" }> = [];
    for (const command of commands) {
      assertCurrent();
      if (!command.proof_json) return blocked("process_proof_missing");
      const binding = JSON.parse(command.binding_json) as ContainmentBinding;
      const proof = JSON.parse(command.proof_json) as ContainmentProof;
      if (binding.instanceOwner !== row.instance_owner || binding.instanceFence !== row.instance_fence ||
        (kind === "execution" ? binding.runId !== row.run_id : !binding.runId.startsWith(`${row.run_id}:verifier:`))) return blocked("process_binding_mismatch");
      const verified = await verifyContainmentProof(input.containment, proof, binding);
      assertCurrent();
      if (!verified.verified) return blocked("process_proof_rejected");
      const state = await input.containment.inspect(proof.identity);
      assertCurrent();
      if (state.state !== "empty" || state.fingerprint !== verified.fingerprint) return blocked("process_exit_unconfirmed");
      evidence.push({ ordinal: command.ordinal, fingerprint: verified.fingerprint, state: "empty" });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      assertCurrent();
      if (isSettled()) { db.exec("COMMIT"); return { state: "already_settled", reason: "already_settled", workItemId }; }
      const count = db.prepare(`SELECT count(*) AS n FROM ${table}_commands WHERE session_id=?`).get(input.sessionId) as { n: number };
      if (count.n !== commands.length) { db.exec("ROLLBACK"); return blocked("process_set_changed"); }
      db.prepare(`INSERT INTO ${table}_settlements(session_id,evidence_json,created_at) VALUES(?,?,?)`).run(input.sessionId,
        JSON.stringify({ version: 1, recoveredBy: input.instance, evidence }), input.now());
      db.exec("COMMIT");
      return { state: "recovered", reason: "all_processes_confirmed_empty", workItemId };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch {
    return blocked(input.signal?.aborted ? "recovery_cancelled" : "recovery_evidence_unavailable");
  }
}
