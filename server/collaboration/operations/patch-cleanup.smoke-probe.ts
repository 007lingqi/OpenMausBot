import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentRunRequest } from "../provider-runner.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";
import { DockerPatchApplier } from "./docker-patch-agent.ts";

const root = process.env.OMB_PATCH_SMOKE_ROOT!;
const image = process.env.OMB_PATCH_SMOKE_IMAGE!;
assert.match(root, /^\/var\/lib\/docker\/volumes\/omb-patch-cleanup-[a-f0-9-]+\/_data$/u);
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const raw = new NodeDockerCommandPort(); // Inside this disposable Linux controller, explicit mounted daemon only.
const cases: string[] = [];
for (const mode of ["success", "registration-failure", "cancel-during-registration", "start-receipt-failure"] as const) {
  const directory = join(root, mode), worktree = join(directory, "worktree"), exchange = join(directory, "exchange");
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  let id: string | undefined;
  const docker: DockerCommandPort = { async run(args, options) {
    const result = await raw.run(args, options);
    if (args[0] === "create" && result.exitCode === 0) id = result.stdout.toString().trim();
    // Fault happens only AFTER a real daemon start; cleanup must inspect and stop it.
    if (args[0] === "start" && mode === "start-receipt-failure") throw Error("synthetic_lost_start_receipt");
    return result;
  } };
  const runId = randomUUID();
  const containment = new DockerCliContainmentSupervisor({ docker, hostGeneration: runId, verifierKey: randomBytes(32) });
  const binding = { runId, canonicalWorktreePath: worktree, instanceOwner: "patch-smoke", instanceFence: 1, nonce: randomBytes(32).toString("hex") };
  const applier = new DockerPatchApplier({ docker, containment, image, exchangeRoot: exchange, user: "0:0" });
  const request = {
    runId, cwd: worktree, writeScope: ["hello.txt"], containmentBinding: binding, signal: controller.signal,
    async registerContainment(proof) {
      assert.equal((await containment.verifyProof(proof, binding)).verified, true);
      if (mode === "registration-failure") throw Error("synthetic_registration_failure");
      if (mode === "cancel-during-registration") controller.abort();
    },
  } as AgentRunRequest;
  try {
    if (mode === "success") {
      const proof = await applier.apply(request, [{ path: "hello.txt", contents: "hello\n" }]);
      assert.equal((await containment.inspect(proof.identity)).state, "empty");
      assert.equal(readFileSync(join(worktree, "hello.txt"), "utf8"), "hello\n");
    } else {
      await assert.rejects(applier.apply(request, [{ path: "hello.txt", contents: "must not write\n" }]),
        mode === "registration-failure" ? /synthetic_registration_failure/u : mode === "cancel-during-registration" ? /docker_patch_cancelled/u : /synthetic_lost_start_receipt/u);
      assert.equal(existsSync(join(worktree, "hello.txt")), false);
    }
    assert.ok(id);
    const result = await raw.run(["inspect", id]); assert.equal(result.exitCode, 0);
    const value = JSON.parse(result.stdout.toString())[0];
    assert.equal(value.State.Status, "exited"); assert.equal(value.State.Pid, 0);
    assert.equal(value.State.Running, false); assert.equal(value.HostConfig.NetworkMode, "none");
    assert.equal(value.HostConfig.Privileged, false); assert.equal(value.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(value.HostConfig.CapDrop, ["ALL"]);
    assert.ok(value.Mounts.every((mount: { Source: string }) => mount.Source.startsWith(root + "/")));
    assert.deepEqual(readdirSync(exchange), []);
    await applier.interrupt(runId);
    cases.push(mode);
  } finally {
    if (id) {
      const result = await raw.run(["inspect", id]); assert.equal(result.exitCode, 0);
      const value = JSON.parse(result.stdout.toString())[0];
      assert.equal(value.Image, image);
      for (const label of containment.labels(binding)) { const n = label.indexOf("="); assert.equal(value.Config.Labels[label.slice(0, n)], label.slice(n + 1)); }
      assert.equal((await raw.run(["rm", "--force", id])).exitCode, 0);
    }
  }
}
console.log(JSON.stringify({ cases, stoppedPidZero: true, failureWrites: 0, cleanedAfterConfirmedExit: true, modelCalls: 0, realGroupMessages: 0 }));
