import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { acceptanceConditionHash, assertionCoverage, type CoverageCommand } from "./acceptance-assertions.ts";

/** Synthetic v3 reviews for policy-only tests; not evidence from a real verification run. */
export function assertionReviewFixture(database: DatabaseSync, workItemId: string, commandId: string, runtimePolicyHash?: string) {
  const row = database.prepare("SELECT p.revision AS plan_revision,p.snapshot_revision,p.proposal_hash," +
    "v.read_scope_json,v.deny_scope_json,s.goal,s.facts_json,s.assumptions_json,s.acceptance_json,s.blocking_ambiguities_json " +
    "FROM collaboration_work_items w JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision " +
    "JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision " +
    "JOIN collaboration_work_nodes v ON v.work_item_id=w.id AND v.plan_revision=p.revision AND v.node_type='validate' AND v.active=1 " +
    "WHERE w.id=?").get(workItemId) as { plan_revision: number; snapshot_revision: number; proposal_hash: string;
      read_scope_json: string; deny_scope_json: string; goal: string | null; facts_json: string; assumptions_json: string;
      acceptance_json: string; blocking_ambiguities_json: string };
  const specIdentityHash = createHash("sha256").update(JSON.stringify({ workItemId, planRevision: row.plan_revision,
    snapshotRevision: row.snapshot_revision, proposalHash: row.proposal_hash,
    verifierReadScope: JSON.parse(row.read_scope_json), verifierDenyScope: JSON.parse(row.deny_scope_json), goal: row.goal,
    facts: JSON.parse(row.facts_json), assumptions: JSON.parse(row.assumptions_json), acceptance: JSON.parse(row.acceptance_json),
    blockingAmbiguities: JSON.parse(row.blocking_ambiguities_json) })).digest("hex");
  const conditions = JSON.parse(row.acceptance_json) as Array<{ description: string; observation: string }>;
  const commands: CoverageCommand[] = [{ commandId, state: "target_passed",
    assertionContract: { format: "omb-assertions-v1", bindings: conditions.map((condition, index) => ({ conditionHash: acceptanceConditionHash(condition), assertionIds: [`criterion-${index}`] })) },
    assertions: conditions.map((_, index) => ({ id: `criterion-${index}`, state: "passed" })) }];
  const runtime = runtimePolicyHash ? { runtimePolicyHash } : {};
  return { verifier: { contractSchemaVersion: 3, specIdentityHash, ...runtime, commands },
    meta: { contractSchemaVersion: 3, specIdentityHash, ...runtime, verifierAttempt: 1, coverage: assertionCoverage(conditions, commands),
      selfCommands: commands, selfCoverage: assertionCoverage(conditions, commands) } };
}
