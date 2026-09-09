import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";
import { validateTargetCommandSpec, type TargetCommandSpec } from "./quality-gate.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { acceptanceEvidencePoliciesHash, acceptanceEvidencePoliciesSchema, type AcceptanceEvidencePolicy } from "./acceptance-evidence.ts";

export function verificationRuntimePolicyHash(commands: Readonly<Record<string, TargetCommandSpec>>, mappingPolicy?: string,
  acceptanceEvidencePolicies?: readonly AcceptanceEvidencePolicy[]): string {
  const selected = Object.keys(commands).sort().map(id => {
    const command = commands[id];
    validateTargetCommandSpec(id, command);
    const definition = { id, argv: [...command.argv], cwd: command.cwd ?? null, timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes, assertionContract: command.assertionContract ?? null,
      assertionReporter: command.assertionReporter ?? null, acceptanceSourceFiles: command.acceptanceSourceFiles ?? null };
    if (command.nodeTestDiscovery) return { ...definition, nodeTestDiscovery: {
      directories: [...command.nodeTestDiscovery.directories].sort(), excludeFiles: [...(command.nodeTestDiscovery.excludeFiles ?? [])].sort(),
    } };
    return definition;
  });
  const contract = { version: 1, mappingPolicy: mappingPolicy ?? null, commands: selected };
  return createHash("sha256").update(JSON.stringify(acceptanceEvidencePolicies?.length
    ? { ...contract, acceptanceEvidencePoliciesHash: acceptanceEvidencePoliciesHash(acceptanceEvidencePolicies) } : contract)).digest("hex");
}
/** Trusted startup only: immutable per fenced instance, no raw commands or credentials in the journal. */
export function publishVerificationRuntimePolicy(db: DatabaseSync, input: {
  instance: Pick<InstanceLease, "ownerId" | "fence">; now: number;
  repositories: Readonly<Record<string, { targetCommands: Readonly<Record<string, TargetCommandSpec>> }>>;
  mappingPolicy?: string;
  acceptanceEvidencePolicies?: readonly AcceptanceEvidencePolicy[];
}): void {
  const repositories = Object.keys(input.repositories).sort();
  if (repositories.length > 64 || repositories.some(path => !isAbsolute(path) || path.length > 4096 || path.includes("\0")))
    throw new Error("verification_runtime_policy_invalid");
  const evidencePolicies = acceptanceEvidencePoliciesSchema.parse(input.acceptanceEvidencePolicies ?? []);
  const repositoryHashes = Object.fromEntries(repositories.map(repository => [repository,
    verificationRuntimePolicyHash(input.repositories[repository].targetCommands, input.mappingPolicy, evidencePolicies)]));
  const policies = JSON.stringify(evidencePolicies.length ? { ...repositoryHashes, acceptanceEvidencePolicies: evidencePolicies } : repositoryHashes);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertLedgerArmed(db);
    assertCurrentInstanceLease(db, input.instance, input.now);
    const existing = db.prepare("SELECT instance_owner,policies_json FROM collaboration_verification_runtime_policies WHERE instance_fence=?")
      .get(input.instance.fence) as { instance_owner: string; policies_json: string } | undefined;
    if (existing && (existing.instance_owner !== input.instance.ownerId || existing.policies_json !== policies))
      throw new Error("verification_runtime_policy_requires_restart");
    if (!existing) db.prepare("INSERT INTO collaboration_verification_runtime_policies(instance_fence,instance_owner,policies_json,configured_at) VALUES(?,?,?,?)")
      .run(input.instance.fence, input.instance.ownerId, policies, input.now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** The fenced startup journal, never a review or model response, supplies current policy authority. */
export function readPublishedAcceptanceEvidencePolicies(db: DatabaseSync, repository: string): AcceptanceEvidencePolicy[] | null {
  // SAFETY: This query selects the single immutable publication matching the currently held instance fence.
  const row = db.prepare("SELECT p.policies_json FROM collaboration_verification_runtime_policies p " +
    "JOIN collaboration_instance_lease l ON l.singleton=1 AND p.instance_fence=l.fencing_token AND p.instance_owner=l.owner_id")
    .get() as { policies_json: string } | undefined;
  if (!row) return null;
  try {
    const values = JSON.parse(row.policies_json);
    if (!values || !Object.hasOwn(values, repository)) return null;
    const parsed = acceptanceEvidencePoliciesSchema.safeParse(values.acceptanceEvidencePolicies ?? []);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the persisted receipt boundary: validate the untrusted hash grammar here, then compare it with the fenced publication.
export function verificationRuntimePolicyAllows(db: DatabaseSync, repository: string, policyHash: unknown, requirePublished = false): boolean {
  // Standalone historical evidence readers have no runtime configuration. Every
  // non-probe headless start publishes a snapshot, even when execution is disabled.
  if (!db.prepare("SELECT 1 FROM collaboration_verification_runtime_policies LIMIT 1").get()) return !requirePublished;
  if (typeof policyHash !== "string" || !/^[a-f0-9]{64}$/u.test(policyHash)) return false;
  const current = db.prepare("SELECT p.policies_json FROM collaboration_verification_runtime_policies p " +
    "JOIN collaboration_instance_lease l ON l.singleton=1 AND p.instance_fence=l.fencing_token AND p.instance_owner=l.owner_id")
    .get() as { policies_json: string } | undefined;
  if (!current) return false;
  try {
    const policies = JSON.parse(current.policies_json) as Record<string, unknown>;
    return Object.hasOwn(policies, repository) && policies[repository] === policyHash;
  } catch { return false; }
}
