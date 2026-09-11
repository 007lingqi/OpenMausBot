import { posix } from "node:path";
import type { AgentRunRequest } from "../provider-runner.ts";
import { redactSensitiveText } from "../sensitive-text.ts";
import { assertRevisionChanges, gitBlobSha, matchesPathScope } from "../worktree-manager.ts";
import type { ProviderReadViewFile } from "./provider-read-view.ts";
import { parseExecutionSpec } from "../execution-spec.ts";

export const CONTAINED_VIEW_ROOT = "/workspace/view";
export const CONTAINED_CANDIDATE_ROOT = "/run/omb-private/candidate";
export type ContainedProviderRequest = Omit<AgentRunRequest, "signal" | "emit" | "registerContainment" | "assertAuthorityCurrent">;
export interface ContainedProposal {
  status: "completed" | "failed" | "needs_configuration";
  summary: string;
  changes: Array<{ path: string; contents: string }>;
}

function text(value: string, limit: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit || value.includes("\0"))
    throw Error("contained_request_text_invalid");
  return redactSensitiveText(value);
}
function list(values: string[], count: number, length: number): string[] {
  if (!Array.isArray(values) || values.length > count) throw Error("contained_request_list_invalid");
  return values.map(value => text(value, length));
}

/** Data only: never serialize the host environment, paths, callbacks or proof.
 * The worker gets an inert local binding; only the coordinator owns the real one. */
export function containedProviderRequest(request: AgentRunRequest): ContainedProviderRequest {
  if (request.sourceSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.sourceSha)) throw Error("contained_source_pin_invalid");
  if (request.allowedChanges !== undefined) assertRevisionChanges(request.allowedChanges, request.sourceSha ?? "");
  return {
    runId: text(request.runId, 200), threadId: text(request.threadId, 200), turnId: text(request.turnId, 200),
    workItemId: text(request.workItemId, 200), nodeId: text(request.nodeId, 200), planRevision: request.planRevision,
    cwd: CONTAINED_VIEW_ROOT, objective: text(request.objective, 32_000), instructions: text(request.instructions, 64_000),
    sourceSha: request.sourceSha,
    allowedChanges: request.allowedChanges?.map(change => ({ path: change.path, operation: change.operation,
      parentBlobSha: change.parentBlobSha, resultBlobSha: change.resultBlobSha })),
    inputEvidence: list(request.inputEvidence, 64, 32_000), readScope: list(request.readScope, 64, 2000),
    ...(request.requirementSpec !== undefined ? { requirementSpec: parseExecutionSpec(request.requirementSpec, request.workItemId) } : {}),
    writeScope: list(request.writeScope, 64, 2000), denyScope: list(request.denyScope, 64, 2000),
    expectedArtifacts: list(request.expectedArtifacts, 64, 2000), completionDefinition: text(request.completionDefinition, 32_000),
    environment: {}, capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: CONTAINED_VIEW_ROOT, readOnlyPaths: [], denyGitMetadata: true, network: "deny" },
    containmentBinding: { runId: request.runId, canonicalWorktreePath: CONTAINED_VIEW_ROOT,
      instanceOwner: "contained-worker", instanceFence: 1, nonce: "0".repeat(32) },
  };
}

/** Both the coordinator and trusted worker validate untrusted model JSON.
 * viewFiles is coordinator-owned metadata, never taken from model output. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function is the untrusted model JSON parser boundary; its body validates the contract before returning a named ContainedProposal.
export function validateContainedProposal(request: Pick<AgentRunRequest, "writeScope" | "denyScope" | "allowedChanges" | "sourceSha">, value: unknown,
  viewFiles: ReadonlyArray<Pick<ProviderReadViewFile, "path" | "automaticReplacementAllowed"> & Partial<Pick<ProviderReadViewFile, "blobSha">>>): ContainedProposal {
  const fail = (): never => { throw Error("contained_proposal_invalid_or_denied"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const proposal = value as Partial<ContainedProposal>;
  if (request.allowedChanges !== undefined) assertRevisionChanges(request.allowedChanges, request.sourceSha ?? "");
  if (!["completed", "failed", "needs_configuration"].includes(proposal.status ?? "") ||
    typeof proposal.summary !== "string" || Buffer.byteLength(proposal.summary) > 8000 || proposal.summary.length > 2000 ||
    !Array.isArray(proposal.changes) || proposal.changes.length > 64 ||
    (proposal.status !== "completed" && proposal.changes.length !== 0) ||
    (proposal.status === "completed" && !proposal.changes.length)) return fail();
  const view = new Map(viewFiles.map(file => [file.path, file])), seen = new Set<string>();
  let bytes = 0;
  const changes = proposal.changes.map(change => {
    if (!change || typeof change !== "object" || typeof change.path !== "string" || typeof change.contents !== "string") return fail();
    const path = change.path, parts = path.split("/");
    if (!path || path.length > 500 || posix.isAbsolute(path) || posix.normalize(path) !== path ||
      /[\x00-\x1f\x7f\\]/u.test(path) || parts.some(part => !part || part === "." || part === ".." || /^(?:\.git|\.ssh|\.env.*)$/iu.test(part)) ||
      seen.has(path) || !matchesPathScope(path, request.writeScope) ||
      parts.some((_, index) => matchesPathScope(parts.slice(0, index + 1).join("/"), request.denyScope)) ||
      view.get(path)?.automaticReplacementAllowed === false || change.contents.includes("\0")) return fail();
    bytes += Buffer.byteLength(change.contents);
    if (bytes > 1024 * 1024) return fail();
    seen.add(path);
    return { path, contents: change.contents };
  });
  if (request.allowedChanges !== undefined && proposal.status === "completed") {
    const allowed = new Map(request.allowedChanges.map(change => [change.path, change]));
    if (changes.length !== allowed.size) return fail();
    for (const change of changes) {
      const fixed = allowed.get(change.path), original = view.get(change.path);
      if (!fixed || (fixed.operation === "add" ? original !== undefined : original?.blobSha !== fixed.parentBlobSha) ||
        (fixed.resultBlobSha !== undefined && gitBlobSha(change.contents, request.sourceSha ?? "") !== fixed.resultBlobSha)) return fail();
    }
  }
  return { status: proposal.status!, summary: redactSensitiveText(proposal.summary), changes };
}
