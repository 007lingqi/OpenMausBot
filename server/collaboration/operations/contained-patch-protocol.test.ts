import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../provider-runner.ts";
import { containedProviderRequest, validateContainedProposal } from "./contained-patch-protocol.ts";

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
  it("passes only bounded task data and fixed capabilities to the isolated view", () => {
    const safe = containedProviderRequest(request);
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
