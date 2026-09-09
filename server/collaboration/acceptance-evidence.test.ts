import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptanceConditionHash } from "./acceptance-assertions.ts";
import {
  acceptanceEvidencePolicySchema,
  acceptanceEvidencePoliciesSchema,
  acceptanceEvidencePolicyHash,
  assertionAcceptanceConditions,
  aggregateAcceptanceEvidence,
  readGitScopeEvidence,
  validateAcceptanceEvidencePolicy,
} from "./acceptance-evidence.ts";

const conditions = [
  { description: "按优先级筛选", observation: "筛选结果符合选择" },
  { description: "仅修改验收室", observation: "所有修改均在允许范围" },
  { description: "完成后进行自动回归，并用两三句话反馈变更内容和验证结果。", observation: "交付反馈包含本次修改内容及自动回归是否通过的实际结果，长度为两三句话。" },
];
const specIdentityHash = "a".repeat(64);
function policy() {
  return {
    version: 1,
    policyId: "release-board-v1",
    specIdentityHash,
    conditions: [
      { conditionHash: acceptanceConditionHash(conditions[0]), requirements: [{ type: "assertions" }] },
      { conditionHash: acceptanceConditionHash(conditions[1]), requirements: [{ type: "git_scope", allowedPaths: ["src/**", "test/**"], deniedPaths: ["src/private/**"] }] },
      { conditionHash: acceptanceConditionHash(conditions[2]), requirements: [
        { type: "regression", commandIds: ["regression"] },
        { type: "reply", minSentences: 2, maxSentences: 3 },
      ] },
    ],
  };
}

describe("trusted acceptance evidence policy", () => {
  it("accepts bounded ordinary command IDs but rejects duplicate Spec policies", () => {
    const value = policy();
    value.conditions[2].requirements = [{ type: "regression", commandIds: ["pnpm test target"] }, { type: "reply", minSentences: 2, maxSentences: 3 }];
    expect(acceptanceEvidencePolicySchema.safeParse(value).success).toBe(true);
    expect(acceptanceEvidencePoliciesSchema.safeParse([value]).success).toBe(true);
    expect(acceptanceEvidencePoliciesSchema.safeParse([value, { ...value, policyId: "second" }]).success).toBe(false);
    for (const commandId of ["", "   ", "bad\ncommand", "x".repeat(257)]) {
      value.conditions[2].requirements = [{ type: "regression", commandIds: [commandId] }];
      expect(acceptanceEvidencePolicySchema.safeParse(value).success).toBe(false);
    }
  });
  it("accepts a complete policy without rewriting the original compound condition", () => {
    const original = structuredClone(conditions);
    const accepted = validateAcceptanceEvidencePolicy(policy(), { conditions, specIdentityHash });
    expect(accepted).toEqual(policy());
    expect(accepted?.conditions[2].requirements).toHaveLength(2);
    expect(conditions).toEqual(original);
  });

  it("rejects missing, duplicate, unknown and stale condition identities", () => {
    const valid = policy();
    for (const value of [
      { ...valid, conditions: valid.conditions.slice(0, 2) },
      { ...valid, conditions: [...valid.conditions, valid.conditions[0]] },
      { ...valid, conditions: valid.conditions.map((condition, index) => index === 1 ? { ...condition, conditionHash: "b".repeat(64) } : condition) },
      { ...valid, specIdentityHash: "b".repeat(64) },
    ]) expect(validateAcceptanceEvidencePolicy(value, { conditions, specIdentityHash })).toBeUndefined();
    expect(validateAcceptanceEvidencePolicy(valid, { conditions: [...conditions, conditions[0]], specIdentityHash })).toBeUndefined();
    expect(validateAcceptanceEvidencePolicy(valid, { conditions: [], specIdentityHash })).toBeUndefined();
  });

  it("rejects skip, empty or repeated requirements, model fields and relaxed reply limits", () => {
    const valid = policy();
    for (const requirements of [[], [{ type: "skip" }], [{ type: "assertions" }, { type: "assertions" }],
      [{ type: "reply", minSentences: 1, maxSentences: 3 }], [{ type: "reply", minSentences: 2, maxSentences: 4 }],
      [{ type: "regression", commandIds: [] }], [{ type: "regression", commandIds: ["test", "test"] }],
      [{ type: "assertions", skip: true }],
    ]) {
      expect(acceptanceEvidencePolicySchema.safeParse({ ...valid, conditions: [{ ...valid.conditions[0], requirements }] }).success).toBe(false);
    }
    for (const value of [{ ...valid, version: 2 }, { ...valid, policyId: "" }, { ...valid, specIdentityHash: undefined }, { ...valid, skip: true }]) {
      expect(acceptanceEvidencePolicySchema.safeParse(value).success).toBe(false);
    }
  });

  it("hashes every requirement and returns only original assertion conditions in original order", () => {
    const accepted = acceptanceEvidencePolicySchema.parse(policy());
    const selected = assertionAcceptanceConditions(accepted, conditions);
    expect(selected).toEqual([conditions[0]]);
    expect(selected[0]).toBe(conditions[0]);
    const reordered = structuredClone(accepted);
    reordered.conditions.reverse();
    reordered.conditions.forEach(condition => condition.requirements.reverse());
    expect(acceptanceEvidencePolicyHash(reordered)).toBe(acceptanceEvidencePolicyHash(accepted));
    const changed = structuredClone(accepted);
    changed.conditions[2].requirements = [{ type: "assertions" }];
    expect(acceptanceEvidencePolicyHash(changed)).not.toBe(acceptanceEvidencePolicyHash(accepted));
    expect(() => assertionAcceptanceConditions(accepted, conditions.slice(0, 2))).toThrow("acceptance_evidence_policy_invalid");
  });

  it.each(["/src/**", "src/../private/**", "src//**", "src\\**", "src/***", "src/[a-z]", "src/\n*"])("rejects ambiguous scope %s", pattern => {
    const value = policy();
    value.conditions[1].requirements = [{ type: "git_scope", allowedPaths: [pattern], deniedPaths: [] }];
    expect(acceptanceEvidencePolicySchema.safeParse(value).success).toBe(false);
  });
});

const temporaryRepositories: string[] = [];
afterEach(() => temporaryRepositories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function repository() {
  const repositoryPath = realpathSync(mkdtempSync(join(tmpdir(), "acceptance-evidence-")));
  temporaryRepositories.push(repositoryPath);
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("config", "user.email", "evidence@example.invalid");
  git("config", "user.name", "Evidence Test");
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(repositoryPath, path)), { recursive: true });
    writeFileSync(join(repositoryPath, path), contents);
  };
  const commit = () => { git("add", "--all"); git("commit", "--quiet", "-m", "test fixture"); return git("rev-parse", "HEAD"); };
  write("src/board.ts", "export const value = 1;\n");
  write("outside.txt", "out of scope\n");
  const baseSha = commit();
  return { repositoryPath, baseSha, git, write, commit };
}
const scope = { allowedPaths: ["src/**", "test/**"], deniedPaths: ["src/private/**"] };

describe("fixed Git acceptance scope evidence", () => {
  it("reads the complete fixed base-to-candidate difference and ignores mutable worktree changes", () => {
    const repo = repository();
    repo.write("src/board.ts", "export const value = 2;\n");
    repo.commit();
    repo.write("test/board test.ts", "test fixture\n");
    const candidateSha = repo.commit();
    repo.write("outside.txt", "mutable uncommitted content is not the candidate\n");
    const proof = readGitScopeEvidence({ ...repo, candidateSha, ...scope });
    expect(proof).toMatchObject({ version: 1, repositoryPath: repo.repositoryPath, baseSha: repo.baseSha, candidateSha });
    expect(proof?.entries.map(entry => [entry.path, entry.status])).toEqual([["src/board.ts", "M"], ["test/board test.ts", "A"]]);
    expect(proof?.proofHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an earlier out-of-scope commit even when the final commit is in scope", () => {
    const repo = repository();
    repo.write("outside.txt", "earlier forbidden modification\n");
    repo.commit();
    repo.write("src/board.ts", "later allowed modification\n");
    expect(readGitScopeEvidence({ ...repo, candidateSha: repo.commit(), ...scope })).toBeUndefined();
  });

  it.each(["delete", "rename-in", "rename-out", "denied"] as const)("rejects forbidden %s paths in the complete raw diff", action => {
    const repo = repository();
    if (action === "delete") rmSync(join(repo.repositoryPath, "outside.txt"));
    if (action === "rename-in") renameSync(join(repo.repositoryPath, "outside.txt"), join(repo.repositoryPath, "src/moved.txt"));
    if (action === "rename-out") renameSync(join(repo.repositoryPath, "src/board.ts"), join(repo.repositoryPath, "moved.ts"));
    if (action === "denied") repo.write("src/private/secret.ts", "denied path\n");
    expect(readGitScopeEvidence({ ...repo, candidateSha: repo.commit(), ...scope })).toBeUndefined();
  });

  it.each(["symlink", "gitlink"] as const)("rejects %s entries even within an allowed path", special => {
    const repo = repository();
    if (special === "symlink") symlinkSync("board.ts", join(repo.repositoryPath, "src/link"));
    else repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.baseSha},src/link`);
    if (special === "symlink") repo.git("add", "--all");
    repo.git("commit", "--quiet", "-m", "special entry");
    expect(readGitScopeEvidence({ ...repo, candidateSha: repo.git("rev-parse", "HEAD"), ...scope })).toBeUndefined();
  });

  it("records regular file mode changes and still rejects forbidden mode-only changes", () => {
    const repo = repository();
    chmodSync(join(repo.repositoryPath, "src/board.ts"), 0o755);
    const candidateSha = repo.commit();
    expect(readGitScopeEvidence({ ...repo, candidateSha, ...scope })?.entries[0]).toMatchObject({ oldMode: "100644", newMode: "100755", status: "M" });
    chmodSync(join(repo.repositoryPath, "outside.txt"), 0o755);
    expect(readGitScopeEvidence({ ...repo, candidateSha: repo.commit(), ...scope })).toBeUndefined();
  });

  it("does not silently use an ancestor repository when the trusted repository path is a nested directory", () => {
    const repo = repository();
    repo.write("src/board.ts", "changed\n");
    const candidateSha = repo.commit();
    expect(readGitScopeEvidence({ ...repo, repositoryPath: join(repo.repositoryPath, "src"), candidateSha, ...scope })).toBeUndefined();
  });

  it("records both endpoints of an in-scope rename, including the removed original path", () => {
    const repo = repository();
    renameSync(join(repo.repositoryPath, "src/board.ts"), join(repo.repositoryPath, "src/renamed.ts"));
    const proof = readGitScopeEvidence({ ...repo, candidateSha: repo.commit(), ...scope });
    expect(proof?.entries.map(entry => [entry.path, entry.status])).toEqual([["src/board.ts", "D"], ["src/renamed.ts", "A"]]);
  });

  it.each(["symlink", "gitlink"] as const)("rejects deletion of a base %s, not only addition in the candidate", special => {
    const repo = repository();
    if (special === "symlink") {
      symlinkSync("board.ts", join(repo.repositoryPath, "src/link"));
      repo.git("add", "--all");
    } else repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.baseSha},src/link`);
    repo.git("commit", "--quiet", "-m", "base special entry");
    const baseSha = repo.git("rev-parse", "HEAD");
    repo.git("rm", "--cached", "src/link");
    repo.git("commit", "--quiet", "-m", "remove special entry");
    expect(readGitScopeEvidence({ ...repo, baseSha, candidateSha: repo.git("rev-parse", "HEAD"), ...scope })).toBeUndefined();
  });

  it("overrides local diff-relative and rename settings and checks denied ancestor paths", () => {
    const repo = repository();
    repo.git("config", "diff.relative", "true");
    repo.git("config", "diff.renames", "copies");
    repo.write("src/private/deep/file.ts", "private\n");
    const candidateSha = repo.commit();
    expect(readGitScopeEvidence({ ...repo, candidateSha, allowedPaths: ["src/**"], deniedPaths: ["src/private"] })).toBeUndefined();
    expect(readGitScopeEvidence({ ...repo, candidateSha, allowedPaths: ["src/**/*.ts"], deniedPaths: [] })?.entries.map(entry => entry.path))
      .toEqual(["src/private/deep/file.ts"]);
  });

  it("rejects truncated output, invalid limits, empty diffs, missing objects and non-commit endpoints", () => {
    const repo = repository();
    repo.write("src/board.ts", "changed\n");
    const candidateSha = repo.commit();
    const input = { ...repo, candidateSha, ...scope };
    expect(readGitScopeEvidence({ ...input, maxOutputBytes: 10 })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, maxOutputBytes: 0 })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, timeoutMs: 0 })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, candidateSha: repo.baseSha })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, baseSha: "HEAD~1" })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, candidateSha: candidateSha.slice(0, 12) })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, candidateSha: "f".repeat(40) })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, candidateSha: repo.git("rev-parse", "HEAD:src/board.ts") })).toBeUndefined();
    expect(readGitScopeEvidence({ ...input, baseSha: candidateSha, candidateSha: repo.baseSha })).toBeUndefined();
  });
});

function aggregationFixture() {
  const repo = repository();
  repo.write("src/board.ts", "export const value = 2;\n");
  const candidateSha = repo.commit();
  const proof = readGitScopeEvidence({ ...repo, candidateSha, ...scope });
  if (!proof) throw new Error("valid fixture must produce Git evidence");
  return {
    policy: acceptanceEvidencePolicySchema.parse(policy()), conditions, specIdentityHash,
    repositoryPath: repo.repositoryPath, baseSha: repo.baseSha, candidateSha,
    assertionCommands: [{ commandId: "behavior", state: "target_passed", assertions: [{ id: "filter", state: "passed" as const }],
      assertionContract: { format: "omb-assertions-v1" as const, bindings: [{ conditionHash: acceptanceConditionHash(conditions[0]), assertionIds: ["filter"] }] } }],
    regressionCommands: [{ commandId: "regression", state: "target_passed" }], gitScopeEvidence: [proof],
  };
}

describe("all-condition acceptance evidence aggregation", () => {
  it("keeps compound feedback acceptance incomplete while only the technical gate can pass before delivery", () => {
    const input = aggregationFixture();
    const technical = aggregateAcceptanceEvidence(input);
    expect(technical.technicalPassed).toBe(true);
    expect(technical.finalPassed).toBe(false);
    expect(technical.coverage.map(item => item.state)).toEqual(["passed", "passed", "missing"]);
    expect(technical.coverage[2]).toMatchObject({ conditionIndex: 2, conditionHash: acceptanceConditionHash(conditions[2]),
      requirements: [{ type: "regression", state: "passed" }, { type: "reply", state: "missing" }] });
    const final = aggregateAcceptanceEvidence({ ...input, verifiedReplyEvidenceHash: "e".repeat(64) });
    expect(final.technicalPassed).toBe(true);
    expect(final.finalPassed).toBe(true);
    expect(final.coverage.map(item => item.state)).toEqual(["passed", "passed", "passed"]);
    expect(final.coverage[2].evidenceRefs).toEqual(["regression:regression", `reply:${"e".repeat(64)}`]);
  });

  it.each(["missing", "failed", "duplicate", "other-failed"] as const)("requires all actual regression command evidence: %s", mode => {
    const input = aggregationFixture();
    const regressionCommands = mode === "missing" ? [] : mode === "failed" ? [{ commandId: "regression", state: "failed" }]
      : mode === "duplicate" ? [...input.regressionCommands, ...input.regressionCommands]
      : [...input.regressionCommands, { commandId: "other", state: "failed" }];
    const result = aggregateAcceptanceEvidence({ ...input, regressionCommands, verifiedReplyEvidenceHash: "e".repeat(64) });
    expect(result.technicalPassed).toBe(false);
    expect(result.finalPassed).toBe(false);
    expect(result.coverage[2].state).toBe("missing");
  });

  it("still requires real bound assertion results for assertion conditions", () => {
    const input = aggregationFixture();
    const result = aggregateAcceptanceEvidence({ ...input,
      assertionCommands: [{ ...input.assertionCommands[0], assertions: [{ id: "filter", state: "skipped" }] }],
      verifiedReplyEvidenceHash: "e".repeat(64),
    });
    expect(result.technicalPassed).toBe(false);
    expect(result.finalPassed).toBe(false);
    expect(result.coverage[0].state).toBe("missing");
  });

  it("fails closed on stale Spec, changed policy and changed candidate identities", () => {
    const input = aggregationFixture();
    for (const update of [{ specIdentityHash: "b".repeat(64) }, { candidateSha: "b".repeat(40) }, { baseSha: "b".repeat(40) },
      { repositoryPath: `${input.repositoryPath}/other` }, { conditions: [{ ...conditions[0], observation: "changed" }, ...conditions.slice(1)] },
    ]) {
      const result = aggregateAcceptanceEvidence({ ...input, ...update, verifiedReplyEvidenceHash: "e".repeat(64) });
      expect(result.technicalPassed).toBe(false);
      expect(result.finalPassed).toBe(false);
    }
    const changedPolicy = structuredClone(input.policy);
    changedPolicy.conditions[1].requirements = [{ type: "git_scope", allowedPaths: ["test/**"], deniedPaths: [] }];
    expect(aggregateAcceptanceEvidence({ ...input, policy: changedPolicy, verifiedReplyEvidenceHash: "e".repeat(64) }).finalPassed).toBe(false);
  });

  it.each(["missing", "empty", "changed-hash", "changed-entry", "duplicate"] as const)("rejects %s Git evidence", mode => {
    const input = aggregationFixture();
    const original = input.gitScopeEvidence[0];
    const gitScopeEvidence = mode === "missing" ? [] : mode === "empty" ? [{ ...original, entries: [] }]
      : mode === "changed-hash" ? [{ ...original, proofHash: "e".repeat(64) }]
      : mode === "changed-entry" ? [{ ...original, entries: [{ ...original.entries[0], path: "src/other.ts" }] }]
      : [original, original];
    const result = aggregateAcceptanceEvidence({ ...input, gitScopeEvidence, verifiedReplyEvidenceHash: "e".repeat(64) });
    expect(result.technicalPassed).toBe(false);
    expect(result.finalPassed).toBe(false);
    expect(result.coverage[1].state).toBe("missing");
  });

  it("does not interpret model text or a generic sent flag as verified reply evidence", () => {
    const input = aggregationFixture();
    for (const verifiedReplyEvidenceHash of ["sent", "HTTP 200", "已修改。回归通过。", "", "e".repeat(63)]) {
      const result = aggregateAcceptanceEvidence({ ...input, verifiedReplyEvidenceHash });
      expect(result.technicalPassed).toBe(true);
      expect(result.finalPassed).toBe(false);
    }
  });

  it("requires every scope on a compound condition without splitting or rewriting its original hash", () => {
    const input = aggregationFixture();
    const secondScope = { allowedPaths: ["src/*.ts"], deniedPaths: [] };
    const secondProof = readGitScopeEvidence({ ...input, ...secondScope });
    if (!secondProof) throw new Error("valid second scope fixture");
    input.policy.conditions[2].requirements.push({ type: "git_scope", ...secondScope });
    expect(aggregateAcceptanceEvidence({ ...input, verifiedReplyEvidenceHash: "e".repeat(64) }).finalPassed).toBe(false);
    const result = aggregateAcceptanceEvidence({ ...input, gitScopeEvidence: [...input.gitScopeEvidence, secondProof], verifiedReplyEvidenceHash: "e".repeat(64) });
    expect(result.finalPassed).toBe(true);
    expect(result.coverage[2].conditionHash).toBe(acceptanceConditionHash(conditions[2]));
    expect(result.coverage[2].requirements.map(requirement => requirement.type)).toEqual(["regression", "reply", "git_scope"]);
  });
});
