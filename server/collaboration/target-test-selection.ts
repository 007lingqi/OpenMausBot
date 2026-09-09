import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { isolatedExecutionEnvironment } from "./execution-limits.ts";
import { nodeTestAssertionId } from "./node-test-reporter.ts";
import { validateTargetCommandSpec, type TargetCommandSpec } from "./quality-gate.ts";
import { matchesPathScope } from "./worktree-manager.ts";

export interface CandidateTargetSelectionInput {
  worktree: string;
  candidateSha: string;
  commandIds: readonly string[];
  commands: Readonly<Record<string, TargetCommandSpec>>;
  readScope: readonly string[];
  denyScope: readonly string[];
}
export interface CandidateTargetFile { path: string; blobSha: string }
export interface CandidateTargetSelection {
  candidateSha: string;
  definitionHash: string;
  files: readonly CandidateTargetFile[];
}
export interface CandidateTargetSelectionResult {
  commands: Readonly<Record<string, TargetCommandSpec>>;
  selections: Readonly<Record<string, CandidateTargetSelection>>;
}

interface TreeEntry { mode: string; kind: string; blobSha: string; path: string }
interface SelectionBudget { count: number; bytes: number }
type GitReader = (args: readonly string[], maxBuffer?: number) => Buffer;
const scopesSchema = z.array(z.string().min(1).max(2000).refine(scope => !scope.includes("\0"))).max(64);
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const testNamePattern = /\.test\.(?:[cm]?js|ts)$/u;

function validatePath(path: string): void {
  try { nodeTestAssertionId(path, "validation"); } catch { throw new Error("target_test_selection_path_invalid"); }
  if (path === "." || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || "*?[]{}".includes(character)) ||
    path.split("/").some(segment => /^(?:\.git|\.ssh|node_modules|\.env.*)$/iu.test(segment)))
    throw new Error("target_test_selection_path_invalid");
}
function assertScope(path: string, input: CandidateTargetSelectionInput): void {
  validatePath(path);
  const segments = path.split("/");
  if (!matchesPathScope(path, input.readScope) || segments.some((_, index) =>
    matchesPathScope(segments.slice(0, index + 1).join("/"), input.denyScope)))
    throw new Error("target_test_selection_scope_denied");
}
function treeEntries(bytes: Buffer): TreeEntry[] {
  const records = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
  if (records.pop() !== "") throw new Error("target_test_selection_tree_invalid");
  return records.map(record => {
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("target_test_selection_tree_invalid");
    return { mode: match[1], kind: match[2], blobSha: match[3], path: match[4] };
  });
}
function regularFile(entry: TreeEntry | undefined, path: string): CandidateTargetFile {
  if (!entry || entry.path !== path || entry.kind !== "blob" || !["100644", "100755"].includes(entry.mode))
    throw new Error("target_test_selection_not_regular_file");
  return { path: entry.path, blobSha: entry.blobSha };
}
function readFile(git: GitReader, input: CandidateTargetSelectionInput, path: string, budget: SelectionBudget): CandidateTargetFile {
  assertScope(path, input);
  const entries = treeEntries(git(["ls-tree", "-z", input.candidateSha, "--", path]));
  if (entries.length !== 1) throw new Error("target_test_selection_not_regular_file");
  const file = regularFile(entries[0], path);
  const size = Number(git(["cat-file", "-s", file.blobSha]).toString("utf8").trim());
  budget.count++; budget.bytes += size;
  if (!Number.isSafeInteger(size) || size < 1 || size > 32000 || budget.count > 16 || budget.bytes > 80000)
    throw new Error("target_test_selection_limit");
  const bytes = git(["cat-file", "blob", file.blobSha], 32000);
  if (bytes.length !== size) throw new Error("target_test_selection_size_mismatch");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\0")) throw new Error("target_test_selection_binary");
  return file;
}

/** Resolve once from immutable Git objects; never execute, import or read mutable candidate sources. */
export function resolveTargetCommandsForCandidate(input: CandidateTargetSelectionInput): CandidateTargetSelectionResult {
  if (!shaPattern.test(input.candidateSha) || !input.commandIds.length || input.commandIds.length > 16 ||
    new Set(input.commandIds).size !== input.commandIds.length) throw new Error("target_test_selection_invalid");
  if (!scopesSchema.safeParse(input.readScope).success || !scopesSchema.safeParse(input.denyScope).success)
    throw new Error("target_test_selection_scope_invalid");
  const commands: Record<string, TargetCommandSpec> = {};
  const selections: Record<string, CandidateTargetSelection> = {};
  for (const commandId of input.commandIds) {
    const spec = Object.hasOwn(input.commands, commandId) ? input.commands[commandId] : undefined;
    if (!spec) throw new Error(`missing command: ${commandId}`);
    validateTargetCommandSpec(commandId, spec);
    Object.defineProperty(commands, commandId, { value: spec, enumerable: true, configurable: true });
  }
  if (!input.commandIds.some(commandId => commands[commandId].nodeTestDiscovery)) return { commands, selections };
  const worktree = realpathSync(input.worktree);
  const env = { ...isolatedExecutionEnvironment(process.env, worktree), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  const deadline = Date.now() + 10000;
  const git: GitReader = (args, maxBuffer = 256000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("target_test_selection_timeout");
    try { return execFileSync("git", ["--literal-pathspecs", "-C", worktree, ...args],
      { env, timeout: Math.min(5000, remaining), maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
    } catch { throw new Error("target_test_selection_git_failed"); }
  };
  if (git(["cat-file", "-t", input.candidateSha]).toString("utf8").trim() !== "commit")
    throw new Error("target_test_selection_not_commit");
  const budget: SelectionBudget = { count: 0, bytes: 0 };
  for (const commandId of input.commandIds) {
    const spec = commands[commandId], policy = spec.nodeTestDiscovery;
    if (!policy) continue;
    const cwd = spec.cwd ?? ".";
    if (cwd !== ".") validatePath(cwd);
    const explicit = spec.argv.slice(2).map(file => posix.join(cwd, file));
    if (new Set(explicit).size !== explicit.length) throw new Error("target_test_selection_duplicate");
    const discovered = new Set<string>();
    for (const directory of [...policy.directories].sort()) {
      const roots = treeEntries(git(["ls-tree", "-z", input.candidateSha, "--", directory]));
      if (roots.length !== 1 || roots[0].path !== directory || roots[0].kind !== "tree" || roots[0].mode !== "040000")
        throw new Error("target_test_selection_directory_invalid");
      for (const entry of treeEntries(git(["ls-tree", "-r", "-z", input.candidateSha, "--", directory]))) {
        regularFile(entry, entry.path);
        if (!testNamePattern.test(entry.path) || policy.excludeFiles?.includes(entry.path)) continue;
        assertScope(entry.path, input);
        discovered.add(entry.path);
        if (discovered.size > 16) throw new Error("target_test_selection_limit");
      }
    }
    const paths = [...explicit, ...[...discovered].filter(path => !explicit.includes(path)).sort()];
    const sources = [...paths, ...(spec.acceptanceSourceFiles ?? [])];
    if (new Set(sources).size !== sources.length) throw new Error("target_test_selection_duplicate");
    if (sources.length > 16) throw new Error("target_test_selection_limit");
    const args = paths.map(path => {
      const relative = posix.relative(cwd, path);
      if (relative === ".." || relative.startsWith("../")) throw new Error("target_test_selection_cwd_escape");
      return relative;
    });
    const resolved: TargetCommandSpec = { ...spec, argv: [spec.argv[0], "--test", ...args] };
    validateTargetCommandSpec(commandId, resolved);
    const files = sources.map(path => readFile(git, input, path, budget));
    const definitionHash = createHash("sha256").update(JSON.stringify({ version: 1, candidateSha: input.candidateSha,
      commandId, argv: resolved.argv, cwd: resolved.cwd ?? null, timeoutMs: resolved.timeoutMs,
      maxOutputBytes: resolved.maxOutputBytes, assertionContract: resolved.assertionContract ?? null,
      assertionReporter: resolved.assertionReporter ?? null, acceptanceSourceFiles: resolved.acceptanceSourceFiles ?? null,
      nodeTestDiscovery: { directories: [...policy.directories].sort(), excludeFiles: [...(policy.excludeFiles ?? [])].sort() },
      readScope: [...input.readScope].sort(), denyScope: [...input.denyScope].sort(), files })).digest("hex");
    Object.defineProperty(commands, commandId, { value: resolved, enumerable: true, configurable: true });
    Object.defineProperty(selections, commandId, { value: { candidateSha: input.candidateSha, definitionHash, files }, enumerable: true });
  }
  return { commands, selections };
}
