import type { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

export type CoordinatorInstance = Pick<InstanceLease, "ownerId" | "fence">;
export type CoordinatorObservation = { state: "active" | "stopped"; fingerprint: string } | { state: "unknown"; reason: string };
export interface CoordinatorAuthority {
  capture(instance: CoordinatorInstance): Promise<unknown>;
  /** Passive independent observation of the exact signed startup epoch, not a PID. */
  inspect(proof: unknown, expected: CoordinatorInstance): Promise<CoordinatorObservation>;
}

/** Must complete BEFORE any session/native repository operation can start. */
export async function registerCoordinator(db: DatabaseSync, instance: CoordinatorInstance, authority: CoordinatorAuthority, now: () => number): Promise<void> {
  const current = () => { assertLedgerArmed(db); assertCurrentInstanceLease(db, instance, now()); };
  current();
  const proof = await authority.capture(instance); current();
  const state = await authority.inspect(proof, instance); current();
  if (state.state !== "active") throw Error("coordinator_start_unconfirmed");
  const serialized = JSON.stringify(proof);
  if (!serialized || Buffer.byteLength(serialized) > 32 * 1024 || !/^[a-f0-9]{64}$/u.test(state.fingerprint)) throw Error("coordinator_proof_invalid");
  db.exec("BEGIN IMMEDIATE");
  try {
    current();
    db.prepare("INSERT INTO collaboration_coordinator_proofs(instance_owner,instance_fence,proof_json,created_at) VALUES(?,?,?,?)")
      .run(instance.ownerId, instance.fence, serialized, now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
