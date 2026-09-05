import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { isolatedExecutionEnvironment } from "./execution-limits.ts";
import { mappingRequestHash, type MappingRequest } from "./acceptance-mapping.ts";
import { nodeTestAssertionId, validateNodeTestArgv } from "./node-test-reporter.ts";
import { redactSensitiveText } from "./sensitive-text.ts";
import type { TargetCommandSpec } from "./quality-gate.ts";

/** Read-only Git objects: never execute candidate tests, traverse symlinks, or use mutable worktree contents. */
export function collectAcceptanceMappingRequest(input: {
  worktree: string; candidateSha: string; specHash: string; conditions: MappingRequest["conditions"];
  commandIds: readonly string[]; commands: Readonly<Record<string, TargetCommandSpec>>;
}): MappingRequest {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.candidateSha) || !input.commandIds.length ||
    new Set(input.commandIds).size !== input.commandIds.length) throw new Error("acceptance_source_invalid");
  const worktree = realpathSync(input.worktree);
  const env = { ...isolatedExecutionEnvironment(process.env, worktree), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (args: string[], maxBuffer = 64000) => execFileSync("git", ["--literal-pathspecs", "-C", worktree, ...args],
    { env, timeout: 5000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  if (git(["cat-file", "-t", input.candidateSha]).toString("utf8").trim() !== "commit") throw new Error("acceptance_source_not_commit");
  const sources: MappingRequest["sources"] = [];
  for (const commandId of input.commandIds) {
    const command = input.commands[commandId];
    if (!command || command.assertionReporter !== "node-test-v1") throw new Error("acceptance_source_reporter_required");
    validateNodeTestArgv(command.argv);
    const cwd = command.cwd ?? ".";
    if (cwd !== ".") nodeTestAssertionId(`${cwd}/guard`, "validation");
    for (const selectedFile of command.argv.slice(2)) {
      if (sources.length >= 16) throw new Error("acceptance_source_limit");
      const file = posix.join(cwd, selectedFile);
      nodeTestAssertionId(file, "validation");
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
      sources.push({ commandId, file, blobSha, text: redactSensitiveText(source) });
    }
  }
  const request = { candidateSha: input.candidateSha, specHash: input.specHash, conditions: input.conditions, sources };
  mappingRequestHash(request); // Validate total bounds and identity uniqueness before returning any model input.
  return request;
}
