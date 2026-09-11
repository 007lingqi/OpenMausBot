import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../provider-runner.ts";
import { containedProviderRequest, validateContainedProposal } from "./contained-patch-protocol.ts";
import { gitBlobSha } from "../worktree-manager.ts";

const request = {
  runId: "run-1", threadId: "thread-1", turnId: "turn-1", workItemId: "WI-1", nodeId: "modify", planRevision: 1,
  cwd: "/real/candidate", objective: "fix default priority", instructions: "update src/main.ts", inputEvidence: ["user request"],
  readScope: ["src/**"], writeScope: ["src/**"], denyScope: ["src/private/**"], expectedArtifacts: ["src/main.ts"], completionDefinition: "default P2",
  environment: { SECRET: "not part of provider request" },
  capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
  sandbox: { filesystemRoot: "/real/candidate", readOnlyPaths: [], denyGitMetadata: true, network: "deny" },
  containmentBinding: { runId: "run-1", canonicalWorktreePath: "/real/candidate", instanceOwner: "owner", instanceFence: 1, nonce: "a".repeat(32) },
} as unknown as AgentRunRequest;
const files = [{ path: "src/main.ts", automaticReplacementAllowed: true }, { path: "src/config.ts", automaticReplacementAllowed: false }];
const proposal = { status: "completed", summary: "default updated", changes: [{ path: "src/main.ts", contents: "P2\n" }] };

describe("contained patch protocol", () => {
  it("preserves the exact current Spec across the contained request boundary and rejects foreign or privileged variants", () => {
    const requirementSpec = { version: 1 as const, workItemId: request.workItemId, snapshotRevision: 7, sourceWorkItemVersion: 3,
      goal: "订单导出为Excel", acceptanceConditions: [{ description: "导出Excel", observation: "文件为Excel" }] };
    expect(containedProviderRequest({ ...request, requirementSpec }).requirementSpec).toEqual(requirementSpec);
    expect(() => containedProviderRequest({ ...request, requirementSpec: { ...requirementSpec, workItemId: "WI-OTHER" } })).toThrow();
    expect(() => containedProviderRequest({ ...request, requirementSpec: { ...requirementSpec, snapshotRevision: 0 } })).toThrow();
    expect(() => containedProviderRequest({ ...request, requirementSpec: { ...requirementSpec, acceptanceConditions: [] } })).toThrow();
    const forged = { ...requirementSpec, permissions: { network: true } };
    expect(() => containedProviderRequest({ ...request, requirementSpec: forged })).toThrow();
  });

  it("retains host-pinned source and enforces the exact revision operations before accepting model content", () => {
    const sourceSha = "a".repeat(40), parentBlobSha = gitBlobSha("P1\n", sourceSha), resultBlobSha = gitBlobSha("P2\n", sourceSha);
    const revision = { ...request, sourceSha, allowedChanges: [
      { path: "src/main.ts", operation: "modify" as const, parentBlobSha, resultBlobSha },
      { path: "src/added.ts", operation: "add" as const, parentBlobSha: null },
    ] };
    const view = [{ ...files[0], blobSha: parentBlobSha }];
    const proposed = { ...proposal, changes: [...proposal.changes, { path: "src/added.ts", contents: "new" }] };
    expect(validateContainedProposal(revision, proposed, view)).toEqual(proposed);
    expect(containedProviderRequest(revision)).toMatchObject({ sourceSha, allowedChanges: revision.allowedChanges });
    for (const changed of [proposal, { ...proposed, changes: [{ ...proposed.changes[0], contents: "wrong" }, proposed.changes[1]] },
      { ...proposed, changes: [...proposed.changes, { path: "src/other.ts", contents: "extra" }] }]) {
      expect(() => validateContainedProposal(revision, changed, view)).toThrow();
    }
    expect(() => validateContainedProposal(revision, proposed, [{ ...view[0], blobSha: "0".repeat(40) }])).toThrow();
    expect(() => validateContainedProposal(revision, proposed, [...view, { path: "src/added.ts", blobSha: "b".repeat(40), automaticReplacementAllowed: true }])).toThrow();
  });
  it("passes only bounded task data and fixed capabilities to the isolated view", () => {
    const safe = containedProviderRequest({ ...request, assertAuthorityCurrent: () => { throw Error("host-only-authority"); } });
    expect(Object.hasOwn(safe, "assertAuthorityCurrent")).toBe(false);
    expect(safe.cwd).toBe("/workspace/view");
    expect(safe.environment).toEqual({});
    expect(JSON.stringify(safe)).not.toContain("/real/candidate");
    expect(JSON.stringify(safe)).not.toContain("not part of provider request");
    expect(safe.capabilities).toEqual(request.capabilities);
  });
  it("permits a valid scoped proposal", () => {
    expect(validateContainedProposal(request, proposal, files)).toEqual(proposal);
  });
  it.each(["src/private/secret.ts", ".env", "../escape", "src/./main.ts", "README.md", "src/config.ts"])("blocks unsafe or redacted target %s", path => {
    expect(() => validateContainedProposal(request, { ...proposal, changes: [{ path, contents: "new" }] }, files)).toThrow();
  });
  it("blocks duplicate targets and status/summary shape confusion", () => {
    for (const value of [null, { ...proposal, status: "accepted" }, { ...proposal, summary: 1 }, { ...proposal, changes: [...proposal.changes, ...proposal.changes] }])
      expect(() => validateContainedProposal(request, value, files)).toThrow();
  });
  it("does not apply a failed or configuration proposal even if it contains changes", () => {
    expect(() => validateContainedProposal(request, { ...proposal, status: "failed" }, files)).toThrow();
    expect(validateContainedProposal(request, { status: "needs_configuration", summary: "unclear", changes: [] }, files).changes).toEqual([]);
  });
  it("checks denied ancestors and sensitive directory segments even under a broad write scope", () => {
    for (const path of ["src/private/nested/file.ts", "src/.git/config", "src/.envprod", "src/.ssh/key", "src//main.ts", "src/main.ts/"])
      expect(() => validateContainedProposal({ writeScope: ["**"], denyScope: ["src/private"] }, { ...proposal, changes: [{ path, contents: "x" }] }, files)).toThrow();
  });
  it("rejects oversized proposals and does not pass provider-supplied fields on", () => {
    expect(() => validateContainedProposal(request, { ...proposal, changes: [{ path: "src/main.ts", contents: "x".repeat(1024 * 1024 + 1) }] }, files)).toThrow();
    expect(validateContainedProposal(request, { ...proposal, root: "/attack", changes: [{ ...proposal.changes[0], mode: 0o777 }] }, files)).toEqual(proposal);
  });
});
