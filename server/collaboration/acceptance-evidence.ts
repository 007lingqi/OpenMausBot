import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { acceptanceConditionHash, assertionCoverage, type CoverageCommand, type CoverageItem } from "./acceptance-assertions.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u);
function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
const commandIdentifier = z.string().min(1).max(256).refine(value => value.trim().length > 0 && !hasControlCharacters(value));
const pathPattern = z.string().min(1).max(2000).refine(value =>
  !hasControlCharacters(value) && ![...value].some(character => "\\?[]{}".includes(character)) && !value.startsWith("/") &&
  value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..") &&
  !value.includes("***"));
const pathPatterns = z.array(pathPattern).max(64).refine(values => new Set(values).size === values.length);
export const acceptanceEvidenceRequirementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assertions") }).strict(),
  z.object({ type: z.literal("git_scope"), allowedPaths: pathPatterns.refine(values => values.length > 0), deniedPaths: pathPatterns }).strict(),
  z.object({ type: z.literal("regression"), commandIds: z.array(commandIdentifier).min(1).max(64).refine(values => new Set(values).size === values.length) }).strict(),
  z.object({ type: z.literal("reply"), minSentences: z.literal(2), maxSentences: z.literal(3) }).strict(),
]);
export type AcceptanceEvidenceRequirement = z.infer<typeof acceptanceEvidenceRequirementSchema>;
export const acceptanceEvidencePolicySchema = z.object({
  version: z.literal(1), policyId: identifier, specIdentityHash: hash,
  conditions: z.array(z.object({ conditionHash: hash,
    requirements: z.array(acceptanceEvidenceRequirementSchema).min(1).max(4)
      .refine(values => new Set(values.map(value => value.type)).size === values.length),
  }).strict()).min(1).max(50).refine(values => new Set(values.map(value => value.conditionHash)).size === values.length),
}).strict();
export type AcceptanceEvidencePolicy = z.infer<typeof acceptanceEvidencePolicySchema>;
export const acceptanceEvidencePoliciesSchema = z.array(acceptanceEvidencePolicySchema).max(64)
  .refine(policies => new Set(policies.map(policy => policy.specIdentityHash)).size === policies.length);
export interface AcceptanceCondition { description: string; observation: string }
export interface CurrentAcceptanceIdentity { conditions: readonly AcceptanceCondition[]; specIdentityHash: string }

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Trusted configuration must be parsed before use; model output is never a policy source.
export function validateAcceptanceEvidencePolicy(policy: unknown, current: CurrentAcceptanceIdentity): AcceptanceEvidencePolicy | undefined {
  const parsed = acceptanceEvidencePolicySchema.safeParse(policy);
  if (!parsed.success || parsed.data.specIdentityHash !== current.specIdentityHash || !current.conditions.length) return undefined;
  const hashes = current.conditions.map(acceptanceConditionHash);
  if (new Set(hashes).size !== hashes.length || parsed.data.conditions.length !== hashes.length ||
    parsed.data.conditions.some(condition => !hashes.includes(condition.conditionHash))) return undefined;
  return parsed.data;
}

/** Canonical policy identity: ordering does not change an all-requirements contract. */
export function acceptanceEvidencePolicyHash(policy: AcceptanceEvidencePolicy): string {
  const parsed = acceptanceEvidencePolicySchema.parse(policy);
  const conditions = parsed.conditions.map(condition => ({ ...condition,
    requirements: condition.requirements.map(requirement => {
      if (requirement.type === "git_scope") return { ...requirement, allowedPaths: [...requirement.allowedPaths].sort(), deniedPaths: [...requirement.deniedPaths].sort() };
      if (requirement.type === "regression") return { ...requirement, commandIds: [...requirement.commandIds].sort() };
      return requirement;
    }).sort((left, right) => left.type.localeCompare(right.type)),
  })).sort((left, right) => left.conditionHash.localeCompare(right.conditionHash));
  return createHash("sha256").update(JSON.stringify({ ...parsed, conditions })).digest("hex");
}

export function acceptanceEvidencePoliciesHash(policies: readonly AcceptanceEvidencePolicy[]): string {
  return createHash("sha256").update(JSON.stringify(acceptanceEvidencePoliciesSchema.parse(policies).map(acceptanceEvidencePolicyHash).sort())).digest("hex");
}

/** Preserve the original condition objects and ordering; never rewrite a compound condition. */
export function assertionAcceptanceConditions(policy: AcceptanceEvidencePolicy, conditions: readonly AcceptanceCondition[]): AcceptanceCondition[] {
  const validated = validateAcceptanceEvidencePolicy(policy, { conditions, specIdentityHash: policy.specIdentityHash });
  if (!validated) throw new Error("acceptance_evidence_policy_invalid");
  const selected = new Set(validated.conditions.filter(condition => condition.requirements.some(requirement => requirement.type === "assertions"))
    .map(condition => condition.conditionHash));
  return conditions.filter(condition => selected.has(acceptanceConditionHash(condition)));
}

export interface GitScopeEntry { path: string; status: "A" | "D" | "M"; oldMode: string; newMode: string; oldObject: string; newObject: string }
export interface GitScopeEvidence {
  version: 1; repositoryPath: string; baseSha: string; candidateSha: string; scopeHash: string; entries: GitScopeEntry[]; proofHash: string;
}
export interface GitScopeEvidenceRequest {
  repositoryPath: string; baseSha: string; candidateSha: string;
  allowedPaths: readonly string[]; deniedPaths: readonly string[];
  maxOutputBytes?: number; timeoutMs?: number;
}
const fullSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).refine(value => !/^0+$/u.test(value));
const gitScopeSchema = z.object({ allowedPaths: pathPatterns.refine(values => values.length > 0), deniedPaths: pathPatterns }).strict();
const gitPath = z.string().min(1).max(4096).refine(value => !hasControlCharacters(value) && !value.includes("\\") && !value.startsWith("/") &&
  value.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git"));

function scopeHash(allowedPaths: readonly string[], deniedPaths: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({ allowedPaths: [...allowedPaths].sort(), deniedPaths: [...deniedPaths].sort() })).digest("hex");
}

function scopeMatches(path: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (character === "*") expression += "[^/]*";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(path);
}

function pathWithinScope(path: string, allowedPaths: readonly string[], deniedPaths: readonly string[]): boolean {
  const segments = path.split("/");
  return gitPath.safeParse(path).success && allowedPaths.some(pattern => scopeMatches(path, pattern)) &&
    !segments.some((_, index) => deniedPaths.some(pattern => scopeMatches(segments.slice(0, index + 1).join("/"), pattern)));
}

function gitEvidenceHash(evidence: Omit<GitScopeEvidence, "proofHash">): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/** Read complete immutable Git objects, never a preview, path-filtered diff or mutable worktree.
 * A stored proof is not authority: final callers must invoke this reader again. */
export function readGitScopeEvidence(input: GitScopeEvidenceRequest): GitScopeEvidence | undefined {
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!fullSha.safeParse(input.baseSha).success || !fullSha.safeParse(input.candidateSha).success ||
    input.baseSha.length !== input.candidateSha.length || input.baseSha === input.candidateSha ||
    !isAbsolute(input.repositoryPath) || input.repositoryPath.includes("\0") ||
    !gitScopeSchema.safeParse({ allowedPaths: input.allowedPaths, deniedPaths: input.deniedPaths }).success ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return undefined;
  try {
    const repositoryPath = realpathSync(input.repositoryPath);
    // Deliberately do not inherit GIT_*, credential or user config environment.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: repositoryPath,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    const git = (args: string[], limit = 4096) => execFileSync("git", ["--no-replace-objects", "--literal-pathspecs", "-C", repositoryPath, ...args],
      { env, timeout: timeoutMs, maxBuffer: limit, stdio: ["ignore", "pipe", "pipe"] });
    const topLevel = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    if (realpathSync(topLevel) !== repositoryPath) return undefined;
    for (const sha of [input.baseSha, input.candidateSha]) {
      if (git(["cat-file", "-t", sha]).toString("utf8").trim() !== "commit") return undefined;
    }
    git(["merge-base", "--is-ancestor", input.baseSha, input.candidateSha]);
    const raw = git(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-relative",
      "--ignore-submodules=none", "--no-color", input.baseSha, input.candidateSha, "--"], maxOutputBytes);
    if (!raw.length || raw.length > maxOutputBytes || raw.at(-1) !== 0) return undefined;
    const parts = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
    parts.pop();
    if (parts.length % 2 !== 0 || parts.length > 20_000) return undefined;
    const entries: GitScopeEntry[] = [];
    for (let index = 0; index < parts.length; index += 2) {
      const match = /^:(000000|100644|100755) (000000|100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ADM])$/u.exec(parts[index]);
      const path = parts[index + 1];
      if (!match || !pathWithinScope(path, input.allowedPaths, input.deniedPaths)) return undefined;
      const [, oldMode, newMode, oldObject, newObject, status] = match;
      if (oldObject.length !== input.baseSha.length || newObject.length !== input.baseSha.length ||
        (oldMode === "000000") !== /^0+$/u.test(oldObject) || (newMode === "000000") !== /^0+$/u.test(newObject)) return undefined;
      if (status === "A" && oldMode === "000000" && newMode !== "000000") entries.push({ path, status, oldMode, newMode, oldObject, newObject });
      else if (status === "D" && oldMode !== "000000" && newMode === "000000") entries.push({ path, status, oldMode, newMode, oldObject, newObject });
      else if (status === "M" && oldMode !== "000000" && newMode !== "000000" && (oldMode !== newMode || oldObject !== newObject)) entries.push({ path, status, oldMode, newMode, oldObject, newObject });
      else return undefined;
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (!entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length) return undefined;
    const evidence: Omit<GitScopeEvidence, "proofHash"> = { version: 1, repositoryPath, baseSha: input.baseSha,
      candidateSha: input.candidateSha, scopeHash: scopeHash(input.allowedPaths, input.deniedPaths), entries };
    return { ...evidence, proofHash: gitEvidenceHash(evidence) };
  } catch {
    // Missing objects, timeout and maxBuffer errors must never become an empty successful diff.
    return undefined;
  }
}

export interface RegressionCommandEvidence { commandId: string; state: string }
export interface AcceptanceRequirementCoverage {
  type: AcceptanceEvidenceRequirement["type"]; state: "passed" | "missing"; evidenceRefs: string[]; reason: string;
}
export interface AcceptanceEvidenceCoverageItem extends CoverageItem { requirements: AcceptanceRequirementCoverage[] }
export interface AcceptanceEvidenceAggregateInput extends CurrentAcceptanceIdentity {
  policy: AcceptanceEvidencePolicy; repositoryPath: string; baseSha: string; candidateSha: string;
  assertionCommands: readonly CoverageCommand[]; regressionCommands: readonly RegressionCommandEvidence[];
  gitScopeEvidence?: readonly GitScopeEvidence[];
  /** Only the trusted caller may supply this, after binding and checking actual serialization AND business-confirmed delivery. */
  verifiedReplyEvidenceHash?: string;
}
export interface AcceptanceEvidenceAggregate {
  technicalPassed: boolean; finalPassed: boolean; coverage: AcceptanceEvidenceCoverageItem[];
}

const gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const gitMode = z.enum(["000000", "100644", "100755"]);
export const gitScopeEvidenceSchema = z.object({
  version: z.literal(1), repositoryPath: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0")),
  baseSha: fullSha, candidateSha: fullSha, scopeHash: hash,
  entries: z.array(z.object({ path: gitPath, status: z.enum(["A", "D", "M"]),
    oldMode: gitMode, newMode: gitMode, oldObject: gitObject, newObject: gitObject,
  }).strict().refine(entry => {
    if (entry.oldObject.length !== entry.newObject.length ||
      (entry.oldMode === "000000") !== /^0+$/u.test(entry.oldObject) || (entry.newMode === "000000") !== /^0+$/u.test(entry.newObject)) return false;
    if (entry.status === "A") return entry.oldMode === "000000" && entry.newMode !== "000000";
    if (entry.status === "D") return entry.oldMode !== "000000" && entry.newMode === "000000";
    return entry.oldMode !== "000000" && entry.newMode !== "000000" && (entry.oldMode !== entry.newMode || entry.oldObject !== entry.newObject);
  })).min(1).max(10_000).refine(entries => entries.every((entry, index) => index === 0 || entries[index - 1].path < entry.path)),
  proofHash: hash,
}).strict();

function matchingGitEvidence(input: AcceptanceEvidenceAggregateInput, requirement: Extract<AcceptanceEvidenceRequirement, { type: "git_scope" }>): GitScopeEvidence | undefined {
  const expectedScopeHash = scopeHash(requirement.allowedPaths, requirement.deniedPaths);
  const matches = (input.gitScopeEvidence ?? []).filter(evidence => evidence.scopeHash === expectedScopeHash);
  if (matches.length !== 1) return undefined;
  const parsed = gitScopeEvidenceSchema.safeParse(matches[0]);
  if (!parsed.success) return undefined;
  const { proofHash, ...evidence } = parsed.data;
  if (evidence.repositoryPath !== input.repositoryPath || evidence.baseSha !== input.baseSha || evidence.candidateSha !== input.candidateSha ||
    evidence.entries.some(entry => entry.oldObject.length !== input.baseSha.length || !pathWithinScope(entry.path, requirement.allowedPaths, requirement.deniedPaths)) ||
    gitEvidenceHash(evidence) !== proofHash) return undefined;
  return parsed.data;
}

function requirementCoverage(input: AcceptanceEvidenceAggregateInput, requirement: AcceptanceEvidenceRequirement,
  assertion: CoverageItem | undefined): AcceptanceRequirementCoverage {
  if (requirement.type === "assertions") return { type: requirement.type, state: assertion?.state ?? "missing",
    evidenceRefs: assertion?.evidenceRefs ?? [], reason: assertion?.reason ?? "acceptance_assertion_binding_missing" };
  if (requirement.type === "git_scope") {
    const evidence = matchingGitEvidence(input, requirement);
    return { type: requirement.type, state: evidence ? "passed" : "missing", evidenceRefs: evidence ? [`git_scope:${evidence.proofHash}`] : [],
      reason: evidence ? "fixed_git_scope_passed" : "fixed_git_scope_missing" };
  }
  if (requirement.type === "regression") {
    const commands = input.regressionCommands;
    const valid = commands.length > 0 && commands.length <= 64 && new Set(commands.map(command => command.commandId)).size === commands.length &&
      commands.every(command => commandIdentifier.safeParse(command.commandId).success && command.state === "target_passed");
    const passed = valid && requirement.commandIds.every(id => commands.some(command => command.commandId === id && command.state === "target_passed"));
    return { type: requirement.type, state: passed ? "passed" : "missing", evidenceRefs: passed ? requirement.commandIds.map(id => `regression:${id}`) : [],
      reason: passed ? "required_regression_passed" : "required_regression_missing" };
  }
  const passed = hash.safeParse(input.verifiedReplyEvidenceHash).success;
  return { type: requirement.type, state: passed ? "passed" : "missing", evidenceRefs: passed ? [`reply:${input.verifiedReplyEvidenceHash}`] : [],
    reason: passed ? "verified_reply_delivered" : "verified_reply_missing" };
}

/** Pure aggregation of trusted evidence. It cannot authenticate model-supplied hashes.
 * The caller must use the CURRENT published policy, reconstruct Git proofs and verify
 * actual serialized delivery against this exact candidate before supplying reply evidence.
 * technicalPassed is ONLY pre-delivery readiness; finalPassed is the completion gate. */
export function aggregateAcceptanceEvidence(input: AcceptanceEvidenceAggregateInput): AcceptanceEvidenceAggregate {
  const policy = validateAcceptanceEvidencePolicy(input.policy, input);
  if (!policy || !fullSha.safeParse(input.baseSha).success || !fullSha.safeParse(input.candidateSha).success ||
    input.baseSha.length !== input.candidateSha.length || input.baseSha === input.candidateSha ||
    !isAbsolute(input.repositoryPath) || input.repositoryPath.includes("\0")) {
    return { technicalPassed: false, finalPassed: false, coverage: input.conditions.map((condition, conditionIndex) => ({
      conditionIndex, conditionHash: acceptanceConditionHash(condition), state: "missing", evidenceRefs: [],
      reason: "acceptance_evidence_identity_invalid", requirements: [],
    })) };
  }
  const assertions = assertionCoverage(assertionAcceptanceConditions(policy, input.conditions), input.assertionCommands);
  const coverage = input.conditions.map((condition, conditionIndex): AcceptanceEvidenceCoverageItem => {
    const conditionHash = acceptanceConditionHash(condition);
    const selected = policy.conditions.find(value => value.conditionHash === conditionHash);
    // validateAcceptanceEvidencePolicy guarantees one entry for every original condition.
    if (!selected) throw new Error("acceptance_evidence_policy_invalid");
    const requirements = selected.requirements.map(requirement => requirementCoverage(input, requirement,
      assertions.find(assertion => assertion.conditionHash === conditionHash)));
    const passed = requirements.every(requirement => requirement.state === "passed");
    return { conditionIndex, conditionHash, state: passed ? "passed" : "missing",
      evidenceRefs: [...new Set(requirements.flatMap(requirement => requirement.evidenceRefs))], requirements,
      reason: passed ? "all_acceptance_requirements_passed" : "acceptance_requirement_missing" };
  });
  return {
    technicalPassed: coverage.every(item => item.requirements.every(requirement => requirement.type === "reply" || requirement.state === "passed")),
    finalPassed: coverage.every(item => item.state === "passed"), coverage,
  };
}
