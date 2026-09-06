import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { isolatedExecutionEnvironment } from "./execution-limits.ts";
import { mappingRequestHash, type MappingRequest } from "./acceptance-mapping.ts";
import { nodeTestAssertionId, validateNodeTestArgv } from "./node-test-reporter.ts";
import { redactSensitiveSource } from "./sensitive-source.ts";
import { validateTargetCommandSpec, type TargetCommandSpec } from "./quality-gate.ts";
import { matchesPathScope } from "./worktree-manager.ts";

/** Read-only Git objects: never execute candidate tests, traverse symlinks, or use mutable worktree contents. */
export function collectAcceptanceMappingRequest(input: {
  worktree: string; candidateSha: string; specHash: string; conditions: MappingRequest["conditions"];
  commandIds: readonly string[]; commands: Readonly<Record<string, TargetCommandSpec>>;
  readScope: readonly string[]; denyScope: readonly string[];
}): MappingRequest {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.candidateSha) || !input.commandIds.length ||
    new Set(input.commandIds).size !== input.commandIds.length) throw new Error("acceptance_source_invalid");
  const scopesValid = (scopes: readonly string[]) => Array.isArray(scopes) && scopes.length <= 64 &&
    scopes.every(scope => typeof scope === "string" && scope.length > 0 && scope.length <= 2000 && !scope.includes("\0"));
  if (!scopesValid(input.readScope) || !scopesValid(input.denyScope)) throw new Error("acceptance_source_scope_invalid");
  const selections: Array<{ commandId: string; file: string; role?: "implementation" }> = [];
  for (const commandId of input.commandIds) {
    const command = input.commands[commandId];
    if (!command || command.assertionReporter !== "node-test-v1") throw new Error("acceptance_source_reporter_required");
    validateTargetCommandSpec(commandId, command);
    validateNodeTestArgv(command.argv);
    const cwd = command.cwd ?? ".";
    if (cwd !== ".") nodeTestAssertionId(`${cwd}/guard`, "validation");
    const files = [
      ...command.argv.slice(2).map(file => ({ commandId, file: posix.join(cwd, file) })),
      ...(command.acceptanceSourceFiles ?? []).map(file => ({ commandId, file, role: "implementation" as const })),
    ];
    if (new Set(files.map(item => item.file)).size !== files.length) throw new Error("acceptance_source_duplicate");
    for (const item of files) {
      nodeTestAssertionId(item.file, "validation");
      const segments = item.file.split("/");
      if (/[\x00-\x1f\x7f*?\[\]{}]/u.test(item.file) || segments.some(segment => /^(?:\.git|\.ssh|node_modules|\.env.*)$/iu.test(segment)) ||
        !matchesPathScope(item.file, input.readScope) ||
        segments.some((_, index) => matchesPathScope(segments.slice(0, index + 1).join("/"), input.denyScope)))
        throw new Error("acceptance_source_scope_denied");
      selections.push(item);
      if (selections.length > 16) throw new Error("acceptance_source_limit");
    }
  }
  // Validate every selection before reading any object. Imports are not authorization.
  const worktree = realpathSync(input.worktree);
  const env = { ...isolatedExecutionEnvironment(process.env, worktree), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (args: string[], maxBuffer = 64000) => execFileSync("git", ["--literal-pathspecs", "-C", worktree, ...args],
    { env, timeout: 5000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  if (git(["cat-file", "-t", input.candidateSha]).toString("utf8").trim() !== "commit") throw new Error("acceptance_source_not_commit");
  const sources: MappingRequest["sources"] = [];
  for (const { commandId, file, role } of selections) {
    const tree = git(["ls-tree", "-z", input.candidateSha, "--", file]).toString("utf8");
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(tree);
    if (!match || match[3] !== file) throw new Error("acceptance_source_not_regular_file");
    const blobSha = match[2];
    const size = Number(git(["cat-file", "-s", blobSha]).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 1 || size > 32000) throw new Error("acceptance_source_limit");
    const bytes = git(["cat-file", "blob", blobSha], 32000);
    if (bytes.length !== size) throw new Error("acceptance_source_size_mismatch");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) throw new Error("acceptance_source_binary");
    sources.push({ commandId, file, blobSha, text: redactSensitiveSource(source, file), ...(role ? { role } : {}) });
  }
  const request = { candidateSha: input.candidateSha, specHash: input.specHash, conditions: input.conditions, sources };
  mappingRequestHash(request); // Validate total bounds and identity uniqueness before returning any model input.
  return request;
}
