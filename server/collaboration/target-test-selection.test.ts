import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { TargetCommandSpec } from "./quality-gate.ts";
import { resolveTargetCommandsForCandidate, type CandidateTargetSelectionInput } from "./target-test-selection.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function write(root: string, file: string, source = "import { test } from 'node:test'; test('passes', () => {});\n"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), source);
}
function commit(root: string): string {
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "candidate"]);
  return git(root, ["rev-parse", "HEAD"]);
}
function fixture(): CandidateTargetSelectionInput {
  const worktree = mkdtempSync(join(tmpdir(), "omb-target-selection-")); roots.push(worktree);
  git(worktree, ["init", "-b", "main"]);
  write(worktree, "tests/base.test.mjs");
  write(worktree, "tests/z.test.cjs");
  write(worktree, "tests/nested/a.test.js");
  write(worktree, "tests/rendered-html.test.mjs");
  write(worktree, "tests/helper.mjs", "throw new Error('must never execute during discovery');\n");
  const command: TargetCommandSpec = { argv: ["node", "--test", "tests/base.test.mjs"],
    timeoutMs: 1000, maxOutputBytes: 32000, assertionReporter: "node-test-v1",
    nodeTestDiscovery: { directories: ["tests"], excludeFiles: ["tests/rendered-html.test.mjs"] } };
  return { worktree, candidateSha: commit(worktree), commandIds: ["cases"], commands: { cases: command },
    readScope: ["tests/**"], denyScope: [".git/**", ".env*"] };
}
it("appends only named test blobs from the fixed candidate, preserves base argv and binds the complete command", () => {
  const input = fixture();
  write(input.worktree, "tests/uncommitted.test.ts");
  write(input.worktree, "tests/z.test.cjs", "mutable contents must not affect the selection\n");
  const selected = resolveTargetCommandsForCandidate(input);
  expect(selected.commands.cases.argv).toEqual(["node", "--test", "tests/base.test.mjs", "tests/nested/a.test.js", "tests/z.test.cjs"]);
  expect(input.commands.cases.argv).toEqual(["node", "--test", "tests/base.test.mjs"]);
  expect(selected.selections.cases.candidateSha).toBe(input.candidateSha);
  expect(selected.selections.cases.files).toEqual(["tests/base.test.mjs", "tests/nested/a.test.js", "tests/z.test.cjs"].map(path => ({ path,
    blobSha: git(input.worktree, ["rev-parse", `${input.candidateSha}:${path}`]) })));
  expect(selected.selections.cases.definitionHash).toMatch(/^[a-f0-9]{64}$/u);
  const changed = resolveTargetCommandsForCandidate({ ...input, commands: { cases: { ...input.commands.cases, timeoutMs: 2000 } } });
  expect(changed.selections.cases.definitionHash).not.toBe(selected.selections.cases.definitionHash);
});
it("binds implementation source blobs without interpreting imports", () => {
  const input = fixture();
  write(input.worktree, "src/value.ts", "export const value = 1;\n");
  input.candidateSha = commit(input.worktree);
  input.readScope = ["tests/**", "src/**"];
  input.commands = { cases: { ...input.commands.cases, acceptanceSourceFiles: ["src/value.ts"] } };
  const first = resolveTargetCommandsForCandidate(input);
  expect(first.selections.cases.files.map(file => file.path)).toContain("src/value.ts");
  write(input.worktree, "src/value.ts", "export const value = 2;\n");
  input.candidateSha = commit(input.worktree);
  expect(resolveTargetCommandsForCandidate(input).selections.cases.definitionHash).not.toBe(first.selections.cases.definitionHash);
});
it("keeps commands without discovery unchanged and does not introduce a new selection identity", () => {
  const input = fixture();
  const command: TargetCommandSpec = { argv: ["node", "-e", "process.exit(0)"], timeoutMs: 1000, maxOutputBytes: 32000 };
  const result = resolveTargetCommandsForCandidate({ ...input, commands: { cases: command } });
  expect(result.commands.cases).toBe(command);
  expect(result.selections).toEqual({});
});
it("preserves explicit non-discovery test names and is stable when resolving the selected command again", () => {
  const input = fixture();
  write(input.worktree, "tests/contract.mjs"); input.candidateSha = commit(input.worktree);
  input.commands = { cases: { ...input.commands.cases, argv: ["node", "--test", "tests/contract.mjs"] } };
  const first = resolveTargetCommandsForCandidate(input);
  expect(first.commands.cases.argv).toEqual(["node", "--test", "tests/contract.mjs", "tests/base.test.mjs", "tests/nested/a.test.js", "tests/z.test.cjs"]);
  expect(resolveTargetCommandsForCandidate({ ...input, commands: first.commands })).toEqual(first);
});
it.each([
  { readScope: ["tests/base.test.mjs"], denyScope: [] },
  { readScope: ["tests/**"], denyScope: ["tests/nested"] },
  { readScope: ["tests/**"], denyScope: ["tests"] },
])("rejects discovery outside validate scopes before returning any command: %j", scopes => {
  expect(() => resolveTargetCommandsForCandidate({ ...fixture(), ...scopes })).toThrow("target_test_selection_scope_denied");
});
it.each(["HEAD", "main", "a".repeat(40)])("rejects unfixed or missing commit %s", candidateSha => {
  expect(() => resolveTargetCommandsForCandidate({ ...fixture(), candidateSha })).toThrow();
});
it("rejects blob object identities, symbolic links and submodules", () => {
  const input = fixture();
  const blob = git(input.worktree, ["rev-parse", `${input.candidateSha}:tests/base.test.mjs`]);
  expect(() => resolveTargetCommandsForCandidate({ ...input, candidateSha: blob })).toThrow("target_test_selection_not_commit");
  symlinkSync("base.test.mjs", join(input.worktree, "tests/link.test.mjs"));
  input.candidateSha = commit(input.worktree);
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_not_regular_file");
  rmSync(join(input.worktree, "tests/link.test.mjs"));
  git(input.worktree, ["add", "."]);
  git(input.worktree, ["update-index", "--add", "--cacheinfo", `160000,${input.candidateSha},tests/submodule`]);
  git(input.worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "submodule"]);
  input.candidateSha = git(input.worktree, ["rev-parse", "HEAD"]);
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_not_regular_file");
});
it.each(["tests/.env-secret.test.mjs", "tests/.ssh/private.test.mjs", "tests/node_modules/pkg/index.test.mjs", "tests/weird?.test.mjs"]) (
  "rejects unsafe discovered paths: %s", file => {
    const input = fixture(); write(input.worktree, file); input.candidateSha = commit(input.worktree);
    expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_path_invalid");
  });
it("rejects missing or non-directory discovery roots and missing explicit tests", () => {
  const input = fixture();
  for (const directory of ["missing", "tests/base.test.mjs"]) {
    expect(() => resolveTargetCommandsForCandidate({ ...input, commands: { cases: { ...input.commands.cases,
      nodeTestDiscovery: { directories: [directory] } } } })).toThrow("target_test_selection_directory_invalid");
  }
  expect(() => resolveTargetCommandsForCandidate({ ...input, commands: { cases: { ...input.commands.cases,
    argv: ["node", "--test", "tests/missing.test.mjs"] } } })).toThrow("target_test_selection_not_regular_file");
});
it("uses repository-relative discovery roots with cwd-relative final argv, without permitting parent traversal", () => {
  const input = fixture();
  input.commands = { cases: { ...input.commands.cases, cwd: "tests", argv: ["node", "--test", "base.test.mjs"] } };
  expect(resolveTargetCommandsForCandidate(input).commands.cases.argv).toEqual(["node", "--test", "base.test.mjs", "nested/a.test.js", "z.test.cjs"]);
  write(input.worktree, "outside/a.test.mjs"); input.candidateSha = commit(input.worktree);
  input.commands = { cases: { ...input.commands.cases, nodeTestDiscovery: { directories: ["tests", "outside"] } } };
  input.readScope = ["**/*"];
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_cwd_escape");
});
it("rejects count and byte limits without silently truncating discovered tests", () => {
  const input = fixture();
  for (let index = 0; index < 14; index++) write(input.worktree, `tests/extra-${index}.test.mjs`);
  input.candidateSha = commit(input.worktree);
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_limit");
});
it("accepts exactly sixteen files and rejects combined source bytes above eighty thousand", () => {
  const input = fixture();
  for (let index = 0; index < 13; index++) write(input.worktree, `tests/extra-${index}.test.mjs`);
  input.candidateSha = commit(input.worktree);
  expect(resolveTargetCommandsForCandidate(input).selections.cases.files).toHaveLength(16);
  for (const file of ["tests/base.test.mjs", "tests/z.test.cjs", "tests/nested/a.test.js"]) write(input.worktree, file, "x".repeat(28000));
  input.candidateSha = commit(input.worktree);
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow("target_test_selection_limit");
});
it("ignores Git replace refs when resolving the fixed original commit", () => {
  const input = fixture();
  write(input.worktree, "tests/replacement.test.mjs");
  const replacement = commit(input.worktree);
  git(input.worktree, ["replace", input.candidateSha, replacement]);
  expect(resolveTargetCommandsForCandidate(input).commands.cases.argv).not.toContain("tests/replacement.test.mjs");
});
it.each([Buffer.alloc(32001, 65), Buffer.from([255]), Buffer.from("a\0b")])("rejects oversized, invalid UTF-8 or binary test blobs", source => {
  const input = fixture(); writeFileSync(join(input.worktree, "tests/z.test.cjs"), source); input.candidateSha = commit(input.worktree);
  expect(() => resolveTargetCommandsForCandidate(input)).toThrow();
});
