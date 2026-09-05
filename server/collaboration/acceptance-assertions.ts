import { createHash } from "node:crypto";
import { z } from "zod";

const assertionId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u);
export const assertionContractSchema = z.object({
  format: z.literal("omb-assertions-v1"),
  bindings: z.array(z.object({ conditionHash: z.string().regex(/^[a-f0-9]{64}$/u),
    assertionIds: z.array(assertionId).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  }).strict()).min(1).max(50).refine(bindings => new Set(bindings.map(binding => binding.conditionHash)).size === bindings.length),
}).strict();
export type AssertionContract = z.infer<typeof assertionContractSchema>;
const assertionsSchema = z.array(z.object({ id: assertionId, state: z.enum(["passed", "failed", "skipped"]) }).strict())
  .max(500).refine(values => new Set(values.map(value => value.id)).size === values.length);
const reportSchema = z.object({ version: z.literal(1), runId: z.string().min(1).max(256), nonce: z.string().min(1).max(256),
  assertions: assertionsSchema }).strict();
export type AssertionResult = z.infer<typeof assertionsSchema>[number];

export function acceptanceConditionHash(condition: { description: string; observation: string }): string {
  return createHash("sha256").update(JSON.stringify({ description: condition.description.trim(), observation: condition.observation.trim() })).digest("hex");
}

export function readAssertionReport(stdout: string, binding: { runId: string; nonce: string }): AssertionResult[] | undefined {
  if (Buffer.byteLength(stdout, "utf8") > 256 * 1024) return undefined;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(stdout));
    return parsed.success && parsed.data.runId === binding.runId && parsed.data.nonce === binding.nonce
      ? parsed.data.assertions : undefined;
  } catch { return undefined; }
}

export interface CoverageItem { conditionIndex: number; conditionHash: string; state: "passed" | "missing"; evidenceRefs: string[]; reason: string }
export interface CoverageCommand {
  commandId: string; state: string; assertions?: AssertionResult[]; assertionContract?: AssertionContract;
}

export function assertionCoverage(conditions: readonly { description: string; observation: string }[], commands: readonly CoverageCommand[]): CoverageItem[] {
  const commandsPassed = commands.length > 0 && new Set(commands.map(command => command.commandId)).size === commands.length && commands.every(command => {
    if (command.state !== "target_passed") return false;
    if (command.assertions === undefined) return command.assertionContract === undefined;
    const results = assertionsSchema.safeParse(command.assertions);
    return results.success && !results.data.some(result => result.state === "failed");
  });
  return conditions.map((condition, conditionIndex) => {
    const conditionHash = acceptanceConditionHash(condition);
    const bound = commands.flatMap(command => {
      const contract = assertionContractSchema.safeParse(command.assertionContract);
      const binding = contract.success ? contract.data.bindings.find(value => value.conditionHash === conditionHash) : undefined;
      return binding ? [{ command, binding }] : [];
    });
    const evidenceRefs: string[] = [];
    const complete = commandsPassed && bound.length > 0 && bound.every(({ command, binding }) => {
      const results = assertionsSchema.safeParse(command.assertions);
      if (command.state !== "target_passed" || !results.success) return false;
      const passed = new Set(results.data.filter(value => value.state === "passed").map(value => value.id));
      for (const id of binding.assertionIds) if (passed.has(id)) evidenceRefs.push(`${command.commandId}#${id}`);
      return binding.assertionIds.every(id => passed.has(id));
    });
    return { conditionIndex, conditionHash, state: complete ? "passed" : "missing", evidenceRefs,
      reason: !bound.length ? "acceptance_assertion_binding_missing" : complete ? "bound_assertions_passed" : "bound_assertions_not_passed" };
  });
}
