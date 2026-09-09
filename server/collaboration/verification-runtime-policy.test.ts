import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { publishVerificationRuntimePolicy, verificationRuntimePolicyAllows, verificationRuntimePolicyHash } from "./verification-runtime-policy.ts";
import { acceptanceEvidencePolicySchema } from "./acceptance-evidence.ts";
const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})); });
const commands = { cases: { argv: ["node", "--test", "case.test.mjs"] as const, timeoutMs: 1000,
  maxOutputBytes: 32000, assertionReporter: "node-test-v1" as const, acceptanceSourceFiles: ["src/value.mjs"] } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-runtime-policy-")); roots.push(root);
  const ledger = openCollaborationLedger(root); ledger.close(); const db = new DatabaseSync(ledger.filePath); databases.push(db);
  const leases = new InstanceLeaseCoordinator(db, "first"); const instance = leases.acquire(1000, 1000)!;
  return { db, leases, instance, path: ledger.filePath };
}
it("hashes test definitions, source context and model policy independently of command-key insertion order", () => {
  expect(verificationRuntimePolicyHash(commands, "model-v1")).not.toBe(verificationRuntimePolicyHash(commands, "model-v2"));
  expect(verificationRuntimePolicyHash(commands)).not.toBe(verificationRuntimePolicyHash({ cases: { ...commands.cases, acceptanceSourceFiles: [] } }));
  expect(verificationRuntimePolicyHash({ a: commands.cases, b: commands.cases })).toBe(verificationRuntimePolicyHash({ b: commands.cases, a: commands.cases }));
});
it("binds the entire trusted evidence policy list and requires publication for typed evidence", () => {
  const evidencePolicy = acceptanceEvidencePolicySchema.parse({ version: 1, policyId: "policy-v1", specIdentityHash: "a".repeat(64),
    conditions: [{ conditionHash: "b".repeat(64), requirements: [{ type: "assertions" }] }] });
  const another = { ...evidencePolicy, specIdentityHash: "c".repeat(64), policyId: "another" };
  expect(verificationRuntimePolicyHash(commands, undefined, [evidencePolicy])).not.toBe(verificationRuntimePolicyHash(commands));
  expect(verificationRuntimePolicyHash(commands, undefined, [evidencePolicy, another]))
    .toBe(verificationRuntimePolicyHash(commands, undefined, [another, evidencePolicy]));
  expect(() => verificationRuntimePolicyHash(commands, undefined, [evidencePolicy, evidencePolicy])).toThrow();
  const { db, instance } = fixture();
  const hash = verificationRuntimePolicyHash(commands, undefined, [evidencePolicy]);
  expect(verificationRuntimePolicyAllows(db, "/repo", hash, true)).toBe(false);
  publishVerificationRuntimePolicy(db, { instance, now: 1000, repositories: { "/repo": { targetCommands: commands } }, acceptanceEvidencePolicies: [evidencePolicy] });
  expect(verificationRuntimePolicyAllows(db, "/repo", hash, true)).toBe(true);
  expect(verificationRuntimePolicyAllows(db, "/repo", verificationRuntimePolicyHash(commands), true)).toBe(false);
});
it("binds discovery roots and exact exclusions while preserving legacy policy hashes", () => {
  expect(verificationRuntimePolicyHash(commands)).toBe("97b1eb4143f080f69eb1154ef7adb0b47571197c544f26eb856381fd0f5a0673");
  const discovered = { cases: { ...commands.cases, nodeTestDiscovery: { directories: ["tests"] } } };
  const excluded = { cases: { ...discovered.cases,
    nodeTestDiscovery: { directories: ["tests"], excludeFiles: ["tests/rendered-html.test.mjs"] } } };
  expect(verificationRuntimePolicyHash(discovered)).not.toBe(verificationRuntimePolicyHash(commands));
  expect(verificationRuntimePolicyHash(discovered)).not.toBe(verificationRuntimePolicyHash(excluded));
});
it("publishes fenced immutable configuration and rejects stale instances, removed repositories and missing receipts", () => {
  const { db, leases, instance } = fixture();
  const input = { instance, now: 1000, repositories: { "/repo": { targetCommands: commands } }, mappingPolicy: "model-v1" };
  const hash = verificationRuntimePolicyHash(commands, "model-v1");
  publishVerificationRuntimePolicy(db, input);
  expect(verificationRuntimePolicyAllows(db, "/repo", hash)).toBe(true);
  expect(verificationRuntimePolicyAllows(db, "/elsewhere", hash)).toBe(false);
  expect(verificationRuntimePolicyAllows(db, "/repo", undefined)).toBe(false);
  publishVerificationRuntimePolicy(db, input);
  expect(() => publishVerificationRuntimePolicy(db, { ...input, mappingPolicy: "changed" })).toThrow();
  leases.release(instance, 1500);
  const next = new InstanceLeaseCoordinator(db, "second").acquire(1600, 1000)!;
  expect(verificationRuntimePolicyAllows(db, "/repo", hash)).toBe(false);
  expect(() => publishVerificationRuntimePolicy(db, { ...input, now: 1600 })).toThrow();
  publishVerificationRuntimePolicy(db, { instance: next, now: 1600, repositories: {} });
  expect(verificationRuntimePolicyAllows(db, "/repo", hash)).toBe(false);
  expect(() => db.exec("DELETE FROM collaboration_verification_runtime_policies")).toThrow();
});
it("shares policy with independent connections and revokes old-model approval after restart", () => {
  const { db, leases, instance, path } = fixture();
  publishVerificationRuntimePolicy(db, { instance, now: 1000, repositories: { "/repo": { targetCommands: commands } }, mappingPolicy: "model-v1" });
  const other = new DatabaseSync(path); databases.push(other);
  expect(verificationRuntimePolicyAllows(other, "/repo", verificationRuntimePolicyHash(commands, "model-v1"))).toBe(true);
  leases.release(instance, 1500);
  const next = new InstanceLeaseCoordinator(db, "second").acquire(1600, 1000)!;
  publishVerificationRuntimePolicy(db, { instance: next, now: 1600, repositories: { "/repo": { targetCommands: commands } }, mappingPolicy: "model-v2" });
  expect(verificationRuntimePolicyAllows(other, "/repo", verificationRuntimePolicyHash(commands, "model-v1"))).toBe(false);
  expect(verificationRuntimePolicyAllows(other, "/repo", verificationRuntimePolicyHash(commands, "model-v2"))).toBe(true);
});
