import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { canonicalRepository } from "./repository-occupancy.ts";

export interface CandidateRecheckReservation {
  sessionId: string;
  candidateRunId: string;
  candidateSha: string;
  contractHash: string;
  attempt: number;
  verifierAttempt: number;
  instanceOwner: string;
  instanceFence: number;
  createdAt: number;
}

export interface CandidateRecheckReservationInput {
  sessionId: string;
  candidateRunId: string;
  candidateSha: string;
  contractHash: string;
  verifierAttempt: number;
  instance: Pick<InstanceLease, "ownerId" | "fence">;
  now: number;
  /** Trusted synchronous reader, called inside the reservation transaction. */
  readCurrentContractHash(): string | null;
}

const identifierSchema = z.string().min(1).max(512).refine(value => value.trim().length > 0 &&
  [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127));
const reservationInputSchema = z.object({
  sessionId: identifierSchema, candidateRunId: identifierSchema,
  candidateSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  verifierAttempt: z.number().int().positive(),
  instance: z.object({ ownerId: identifierSchema, fence: z.number().int().positive() }),
  now: z.number().int().nonnegative(), readCurrentContractHash: z.function(),
});

/** Count is contract-local; the attempt high-water mark is run-wide because review attempts are run-wide. */
export function readCandidateRecheckBudget(db: DatabaseSync, candidateRunId: string, contractHash: string): {
  count: number; maxVerifierAttempt: number;
} {
  // SAFETY: The aggregate projection always returns one row of integer counts, including for an empty table.
  return db.prepare("SELECT count(CASE WHEN contract_hash=? THEN 1 END) AS count, COALESCE(MAX(verifier_attempt),0) AS maxVerifierAttempt FROM collaboration_candidate_recheck_attempts WHERE candidate_run_id=?")
    .get(contractHash, candidateRunId) as { count: number; maxVerifierAttempt: number };
}

export function reserveCandidateRecheck(db: DatabaseSync, input: CandidateRecheckReservationInput): CandidateRecheckReservation {
  if (!reservationInputSchema.safeParse(input).success) throw new Error("candidate_recheck_input_invalid");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(db);
    assertCurrentInstanceLease(db, input.instance, input.now);
    // SAFETY: Every alias names a NOT NULL column in the strict immutable reservation table.
    const existing = db.prepare("SELECT session_id AS sessionId,candidate_run_id AS candidateRunId,candidate_sha AS candidateSha,contract_hash AS contractHash,attempt,verifier_attempt AS verifierAttempt,instance_owner AS instanceOwner,instance_fence AS instanceFence,created_at AS createdAt FROM collaboration_candidate_recheck_attempts WHERE session_id=?")
      .get(input.sessionId) as CandidateRecheckReservation | undefined;
    if (existing) {
      if (existing.candidateRunId !== input.candidateRunId || existing.candidateSha !== input.candidateSha ||
        existing.contractHash !== input.contractHash || existing.verifierAttempt !== input.verifierAttempt ||
        existing.instanceOwner !== input.instance.ownerId || existing.instanceFence !== input.instance.fence)
        throw new Error("candidate_recheck_binding_mismatch");
    }
    // The immutable session must still describe the live candidate under the current plan and instance.
    // SAFETY: Both path aliases are NOT NULL text columns; all identity predicates are bound parameters.
    const target = db.prepare(`SELECT s.repository_path AS sessionPath,r.repository_path AS runPath
      FROM collaboration_verification_sessions s
      JOIN collaboration_runs r ON r.id=s.candidate_run_id AND r.plan_revision=s.plan_revision
      JOIN collaboration_work_items w ON w.id=r.work_item_id AND w.current_plan_revision=r.plan_revision
      JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=r.plan_revision
        AND p.snapshot_revision=s.snapshot_revision AND p.status='published'
      JOIN collaboration_candidates c ON c.run_id=r.id AND c.result_sha=s.candidate_sha
      WHERE s.id=? AND s.candidate_run_id=? AND s.candidate_sha=? AND s.instance_owner=? AND s.instance_fence=?
        AND r.status='succeeded' AND r.result_sha=s.candidate_sha AND c.state='target_tests_passed'
        AND w.control_state='active' AND w.definition_status='ready_for_execution'
        AND w.status NOT IN ('accepted','cancelled') AND w.accepted_candidate_sha IS NULL
        AND NOT EXISTS(SELECT 1 FROM collaboration_runs newer WHERE newer.work_item_id=r.work_item_id
          AND newer.plan_revision=r.plan_revision AND newer.attempt>r.attempt)
        AND NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM collaboration_verification_finalization_intents f WHERE f.session_id=s.id)`)
      .get(input.sessionId, input.candidateRunId, input.candidateSha, input.instance.ownerId, input.instance.fence) as
      { sessionPath: string; runPath: string } | undefined;
    if (!target || target.sessionPath !== canonicalRepository(target.runPath)) throw new Error("candidate_recheck_target_changed");
    let currentHash: string | null;
    try { currentHash = input.readCurrentContractHash(); }
    catch { throw new Error("candidate_recheck_target_changed"); }
    if (currentHash !== input.contractHash) throw new Error("candidate_recheck_target_changed");
    if (existing) {
      db.exec("COMMIT");
      return existing;
    }
    if (db.prepare("SELECT 1 FROM collaboration_verification_commands WHERE session_id=? LIMIT 1").get(input.sessionId))
      throw new Error("candidate_recheck_commands_started");
    const budget = readCandidateRecheckBudget(db, input.candidateRunId, input.contractHash);
    if (budget.count >= 3) throw new Error("candidate_recheck_attempt_limit_exhausted");
    if (input.verifierAttempt <= budget.maxVerifierAttempt) throw new Error("candidate_recheck_verifier_attempt_stale");
    const receipt: CandidateRecheckReservation = { sessionId: input.sessionId, candidateRunId: input.candidateRunId,
      candidateSha: input.candidateSha, contractHash: input.contractHash, attempt: budget.count + 1,
      verifierAttempt: input.verifierAttempt, instanceOwner: input.instance.ownerId, instanceFence: input.instance.fence, createdAt: input.now };
    db.prepare("INSERT INTO collaboration_candidate_recheck_attempts(session_id,candidate_run_id,candidate_sha,contract_hash,attempt,verifier_attempt,instance_owner,instance_fence,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(receipt.sessionId, receipt.candidateRunId, receipt.candidateSha, receipt.contractHash, receipt.attempt,
        receipt.verifierAttempt, receipt.instanceOwner, receipt.instanceFence, receipt.createdAt);
    db.exec("COMMIT");
    return receipt;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
