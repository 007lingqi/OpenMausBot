import type { DatabaseSync } from "node:sqlite";
import { acceptanceConditionHash, assertionCoverage, type CoverageCommand } from "./acceptance-assertions.ts";

/** Synthetic v2 reviews for policy-only tests; not evidence from a real verification run. */
export function assertionReviewFixture(database: DatabaseSync, workItemId: string, commandId: string) {
  const row = database.prepare("SELECT acceptance_json FROM collaboration_work_item_snapshots WHERE work_item_id=? ORDER BY revision DESC LIMIT 1").get(workItemId) as { acceptance_json: string };
  const conditions = JSON.parse(row.acceptance_json) as Array<{ description: string; observation: string }>;
  const commands: CoverageCommand[] = [{ commandId, state: "target_passed",
    assertionContract: { format: "omb-assertions-v1", bindings: conditions.map((condition, index) => ({ conditionHash: acceptanceConditionHash(condition), assertionIds: [`criterion-${index}`] })) },
    assertions: conditions.map((_, index) => ({ id: `criterion-${index}`, state: "passed" })) }];
  return { verifier: { contractSchemaVersion: 2, commands },
    meta: { contractSchemaVersion: 2, verifierAttempt: 1, coverage: assertionCoverage(conditions, commands),
      selfCommands: commands, selfCoverage: assertionCoverage(conditions, commands) } };
}
