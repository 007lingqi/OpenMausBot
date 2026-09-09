import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeCandidateRevisionLocally, readCandidateRevisionForAttempt } from "../candidate-revision.ts";
import { createCandidateRevisionFixture } from "../candidate-revision.test-fixtures.ts";
import { containmentBindingHash, runtimeIdentityFingerprint, type ContainmentBinding, type ContainmentPort, type ContainmentProof } from "../containment.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";
import type { AgentRunPort, AgentRunRequest } from "../provider-runner.ts";
import type { SandboxedCommandRunner } from "../quality-gate.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";

afterEach(() => vi.restoreAllMocks());
function proof(binding: ContainmentBinding): ContainmentProof {
  return { identity: { backend: "test_verified_runtime", opaqueId: "revision-runtime-test",
    hostGeneration: "revision-host", verifierVersion: "revision-v1" }, receipt: containmentBindingHash(binding) };
}
const containment: ContainmentPort = {
  async verifyProof(candidate, binding) {
    return candidate.receipt === containmentBindingHash(binding)
      ? { verified: true, fingerprint: runtimeIdentityFingerprint(candidate.identity), bindingHash: containmentBindingHash(binding) }
      : { verified: false, reason: "unverified" };
  },
  async inspect(identity) { return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) }; },
  async terminateAndWaitEmpty(identity) { return { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) }; },
};

type Fixture = ReturnType<typeof createCandidateRevisionFixture>;
function setupRuntime(f: Fixture, calls: AgentRunRequest[], ownerId: string) {
  const agent: AgentRunPort = {
    async run(request) {
      calls.push(request);
      await request.registerContainment(proof(request.containmentBinding));
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: request.cwd, encoding: "utf8" }).trim()).toBe(f.parentSha);
      expect(request.instructions).toContain(f.input.instructions);
      writeFileSync(join(request.cwd, "app/release-board.tsx"), 'export default "verified functionality with optional initial state";\n');
      writeFileSync(join(request.cwd, "tests/empty-state-render.test.mjs"),
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";\n' +
        'test("preserves existing behavior and adds initial state", () => assert.match(readFileSync("app/release-board.tsx", "utf8"), /verified functionality with optional initial state/));\n');
      return { threadId: request.threadId, turnId: request.turnId, status: "completed",
        message: "Added test", sandboxEnforced: true, containmentProof: proof(request.containmentBinding) };
    },
    async interrupt() {},
  };
  const runner: SandboxedCommandRunner = {
    async run(request) {
      const containmentProof = proof(request.containmentBinding);
      await request.registerContainment(containmentProof);
      // Process containment is simulated, but this command really runs against the new Git worktree.
      const stdout = execFileSync(request.argv[0], request.argv.slice(1), { cwd: request.cwd, encoding: "buffer" });
      return { exitCode: 0, stdout, stderr: Buffer.alloc(0), durationMs: 1, timedOut: false, outputLimitExceeded: false,
        attestation: { sandboxEnforced: true, writableRoot: request.sandbox.writableRoot, deniedPaths: [...request.sandbox.deniedPaths],
          network: "deny", processIsolated: true, processTreeReaped: true, containmentProof } };
    },
  };
  return new CollaborationHeadlessRuntime({ dataDirectory: f.root, ownerId, platform: "linux", autoExecuteReady: true,
    agent, commandRunner: runner, containment, execution: { managedWorktreeRoot: join(f.root, "worktrees"),
      repositories: { [f.repository]: { baseSha: f.baseSha, targetCommands: {
        "test-target": { argv: [process.execPath, "--test", "tests/empty-state-render.test.mjs"], timeoutMs: 5_000, maxOutputBytes: 32_000 },
      } } }, limits: { maxAttempts: 3, agentTimeoutMs: 5_000, maxAgentEventBytes: 16_000, interruptGraceMs: 500 } },
  });
}
function issue(f: Fixture) {
  authorizeCandidateRevisionLocally(f.db, f.input);
  new InstanceLeaseCoordinator(f.db, f.lease.ownerId).release(f.lease, Date.now());
}

describe("normal runtime candidate revision dispatch", () => {
  it("builds once from the fixed parent while retaining original Spec, run and full diff base", async () => {
    const f = createCandidateRevisionFixture(), calls: AgentRunRequest[] = [];
    const snapshots = f.db.prepare("SELECT * FROM collaboration_work_item_snapshots").all();
    const parent = f.db.prepare("SELECT * FROM collaboration_runs WHERE id='parent-run'").get();
    issue(f);
    const runtime = setupRuntime(f, calls, "revision-runtime");
    try {
      expect((await runtime.start()).ready).toBe(true);
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
        expect(runtime["scheduledWorkItems"].size).toBe(0);
      }, { timeout: 10_000 });
      expect(f.db.prepare("SELECT * FROM collaboration_work_item_snapshots").all()).toEqual(snapshots);
      expect(f.db.prepare("SELECT * FROM collaboration_runs WHERE id='parent-run'").get()).toEqual(parent);
      const result = f.db.prepare("SELECT id,status,base_sha,result_sha FROM collaboration_runs WHERE attempt=2").get();
      expect(result).toMatchObject({ status: "succeeded", base_sha: f.baseSha });
      expect(result?.result_sha).toMatch(/^[a-f0-9]{40}$/u);
      expect(f.git("rev-parse", `${result!.result_sha}^`)).toBe(f.parentSha);
      expect(readCandidateRevisionForAttempt(f.db, "WI-revision", 2)).toMatchObject({ stage: "started", sessionId: result!.id });
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_reviews WHERE candidate_run_id='parent-run'").get()).toMatchObject({ n: 0 });
      for (let count = 0; count < 2; count++) await runtime.drainOnce();
      expect(calls).toHaveLength(1);
      // No fixture mapping/Meta/delivery proof: successful execution alone must never mean delivery complete.
      expect(f.db.prepare("SELECT status FROM collaboration_work_items WHERE id='WI-revision'").get()?.status).not.toBe("accepted");
    } finally { await runtime.stop(); f.close(); }
  });

  it("consumes a failed preparation once and does not re-dispatch or revive the parent after restart", async () => {
    const f = createCandidateRevisionFixture(), calls: AgentRunRequest[] = [];
    issue(f);
    const prepare = vi.spyOn(WorktreeManager.prototype, "prepare").mockRejectedValue(new Error("controlled_preparation_failure"));
    let runtime = setupRuntime(f, calls, "revision-prepare-first");
    try {
      await runtime.start();
      await vi.waitFor(() => {
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(runtime["scheduledWorkItems"].size).toBe(0);
      });
      expect(readCandidateRevisionForAttempt(f.db, "WI-revision", 2)?.stage).toBe("started");
      await runtime.stop();
      prepare.mockRestore();
      runtime = setupRuntime(f, calls, "revision-prepare-restarted");
      await runtime.start();
      await runtime.drainOnce();
      expect(calls).toHaveLength(0);
      expect(f.db.prepare("SELECT attempt FROM collaboration_execution_dispatches ORDER BY attempt").all()).toEqual([{ attempt: 1 }, { attempt: 2 }]);
      expect(f.db.prepare("SELECT count(*) AS n FROM collaboration_candidate_reviews WHERE candidate_run_id='parent-run'").get()).toMatchObject({ n: 0 });
    } finally { await runtime.stop(); f.close(); }
  });
});
