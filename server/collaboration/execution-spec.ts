import { z } from "zod";
import type { WorkItemSnapshot } from "./snapshot.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

const text = z.string().min(1).max(2000);
const schema = z.object({
  version: z.literal(1), workItemId: z.string().min(1).max(256),
  snapshotRevision: z.number().int().positive(), sourceWorkItemVersion: z.number().int().positive(),
  goal: text,
  acceptanceConditions: z.array(z.object({ description: text, observation: text }).strict()).min(1).max(50),
}).strict();

/** Current requirement data, not permission or verification evidence. Historical
 * utterances intentionally stay in the ledger, outside this execution contract. */
export type ExecutionRequirementSpec = z.infer<typeof schema>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Schema boundary for persisted/serialized task data; the first statement parses the complete named domain contract.
export function parseExecutionSpec(value: unknown, workItemId: string): ExecutionRequirementSpec {
  const spec = schema.parse(value);
  if (spec.workItemId !== workItemId) throw Error("execution_spec_work_item_mismatch");
  // Do not silently turn a redacted or incomplete requirement into an executable
  // one. The source stays private; report only a stable safe error code.
  if ([spec.goal, ...spec.acceptanceConditions.flatMap(c => [c.description, c.observation])]
    .some(value => value !== redactSensitiveText(value))) throw Error("execution_spec_sensitive_content");
  return spec;
}

export function executionSpec(snapshot: WorkItemSnapshot): ExecutionRequirementSpec {
  if (!snapshot.goalConfirmed || snapshot.blockingAmbiguities.length) throw Error("execution_spec_unsettled");
  return parseExecutionSpec({ version: 1, workItemId: snapshot.workItemId, snapshotRevision: snapshot.revision,
    sourceWorkItemVersion: snapshot.sourceWorkItemVersion, goal: snapshot.goal,
    acceptanceConditions: snapshot.acceptanceConditions }, snapshot.workItemId);
}
