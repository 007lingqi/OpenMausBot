import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { verifyContainmentProof, type ContainmentBinding, type ContainmentPort, type ContainmentProof } from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";

type Lease = Pick<InstanceLease,"ownerId"|"fence">;
const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };

export function hasUnsettledVerification(db: DatabaseSync, repository: string): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_verification_sessions s LEFT JOIN collaboration_verification_settlements f ON f.session_id=s.id WHERE s.repository_path=? AND f.session_id IS NULL LIMIT 1")
    .get(canonical(repository));
}

function transaction<T>(db: DatabaseSync, lease: Lease, now: number, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { assertCurrentInstanceLease(db,lease,now); const value=operation(); db.exec("COMMIT"); return value; }
  catch(error) {db.exec("ROLLBACK");throw error;}
}

export function reserveVerification(db: DatabaseSync, runId: string, lease: Lease, now: number): string {
  return transaction(db,lease,now,()=>{
    const row=db.prepare("SELECT r.repository_path,r.plan_revision,p.snapshot_revision,c.result_sha FROM collaboration_runs r " +
      "JOIN collaboration_work_items w ON w.id=r.work_item_id AND w.current_plan_revision=r.plan_revision " +
      "JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=r.plan_revision " +
      "JOIN collaboration_candidates c ON c.run_id=r.id WHERE r.id=? AND w.control_state='active' AND r.status='succeeded'")
      .get(runId) as {repository_path:string;plan_revision:number;snapshot_revision:number;result_sha:string}|undefined;
    if(!row) throw new Error("verification_target_unavailable");
    const repository=canonical(row.repository_path);
    if(hasUnsettledVerification(db,repository)) throw new Error("verification_repository_unsettled");
    const id=randomUUID();
    db.prepare("INSERT INTO collaboration_verification_sessions(id,candidate_run_id,repository_path,plan_revision,snapshot_revision,candidate_sha,instance_owner,instance_fence,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id,runId,repository,row.plan_revision,row.snapshot_revision,row.result_sha,lease.ownerId,lease.fence,now);
    return id;
  });
}

function assertSession(db: DatabaseSync,id: string,lease: Lease): void {
  if(!db.prepare("SELECT 1 FROM collaboration_verification_sessions s WHERE s.id=? AND s.instance_owner=? AND s.instance_fence=? AND NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=s.id)")
    .get(id,lease.ownerId,lease.fence)) throw new Error("verification_session_unavailable");
}

export function recordVerificationCommand(db: DatabaseSync,id: string,ordinal: number,binding: ContainmentBinding,lease: Lease,now: number): void {
  transaction(db,lease,now,()=>{
    assertSession(db,id,lease);
    if(binding.instanceOwner!==lease.ownerId || binding.instanceFence!==lease.fence) throw new Error("verification_binding_stale");
    db.prepare("INSERT INTO collaboration_verification_commands(session_id,ordinal,binding_json,created_at) VALUES(?,?,?,?)").run(id,ordinal,JSON.stringify(binding),now);
  });
}

/** The caller first verifies this proof through the quality gate's registration callback. */
export function recordVerificationProof(db: DatabaseSync,id: string,ordinal: number,proof: ContainmentProof,lease: Lease,now: number): void {
  transaction(db,lease,now,()=>{
    assertSession(db,id,lease);
    db.prepare("INSERT INTO collaboration_verification_proofs(session_id,ordinal,proof_json,created_at) VALUES(?,?,?,?)").run(id,ordinal,JSON.stringify(proof),now);
  });
}

export async function settleVerification(db: DatabaseSync,id: string,lease: Lease,containment: ContainmentPort,now: () => number,canPersist: () => boolean): Promise<boolean> {
  if(!canPersist()) return false;
  const rows=db.prepare("SELECT c.ordinal,c.binding_json,p.proof_json FROM collaboration_verification_commands c LEFT JOIN collaboration_verification_proofs p ON p.session_id=c.session_id AND p.ordinal=c.ordinal WHERE c.session_id=? ORDER BY c.ordinal")
    .all(id) as unknown as Array<{ordinal:number;binding_json:string;proof_json:string|null}>;
  const evidence: Array<{ordinal:number;fingerprint:string;state:"empty"}>=[];
  for(const row of rows) {
    if(!row.proof_json) return false;
    const proof=JSON.parse(row.proof_json) as ContainmentProof;
    const binding=JSON.parse(row.binding_json) as ContainmentBinding;
    const verified=await verifyContainmentProof(containment,proof,binding);
    if(!verified.verified) return false;
    const state=await containment.inspect(proof.identity);
    if(state.state!=="empty" || state.fingerprint!==verified.fingerprint) return false;
    evidence.push({ordinal:row.ordinal,fingerprint:verified.fingerprint,state:"empty"});
  }
  if(!canPersist()) return false;
  return transaction(db,lease,now(),()=>{
    assertSession(db,id,lease);
    const count=db.prepare("SELECT count(*) AS n FROM collaboration_verification_commands WHERE session_id=?").get(id) as {n:number};
    if(count.n!==rows.length) return false;
    db.prepare("INSERT INTO collaboration_verification_settlements(session_id,evidence_json,created_at) VALUES(?,?,?)").run(id,JSON.stringify(evidence),now());
    return true;
  });
}
