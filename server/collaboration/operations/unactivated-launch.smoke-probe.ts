// Synthetic Docker fault probe. Never loaded by the production entrypoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort } from "./docker-containment.ts";
import { DockerCoordinatorAuthority } from "./docker-coordinator.ts";
import { DockerUnactivatedLaunchRecovery } from "./unactivated-launch.ts";
import { readDockerLaunch, writeDockerLaunch } from "./docker-launch.ts";
import type { UnactivatedLaunchContext } from "../unactivated-launch-recovery.ts";

async function main() {
  const root = process.env.OMB_ABORT_ROOT!, image = process.env.OMB_ABORT_IMAGE!, name = process.env.OMB_ABORT_NAME!;
  const docker = new NodeDockerCommandPort(), hostGeneration = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const verifierKey = Buffer.from(process.env.OMB_ABORT_KEY!, "hex"), options = { docker, hostGeneration, verifierKey };
  const coordinator = new DockerCoordinatorAuthority({ ...options, image, container: name }), old = { ownerId: "synthetic-original", fence: 1 };
  const supervisor = new DockerCliContainmentSupervisor(options), exchangeRoot = join(root, "launches");
  if (process.env.OMB_ABORT_MODE === "create") {
    mkdirSync(exchangeRoot, { mode: 0o711 });
    writeFileSync(join(root, "coordinator.json"), JSON.stringify(await coordinator.capture(old)), { flag: "wx", mode: 0o600 });
    for (const mode of ["created", "waiting"]) {
      const candidate = join(root, mode); mkdirSync(candidate); writeFileSync(join(candidate, "unchanged.txt"), "unchanged");
      const binding = { runId: mode, instanceOwner: old.ownerId, instanceFence: old.fence, nonce: "a".repeat(32), canonicalWorktreePath: candidate };
      const taskName = "omb-task-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 48);
      const directory = join(exchangeRoot, taskName); mkdirSync(directory, { mode: 0o711 });
      const launch = supervisor.prepareLaunch({ name: taskName, image, binding }); writeDockerLaunch(directory, launch);
      writeFileSync(join(directory, "heartbeat.json"), "1", { mode: 0o600 });
      const made = await docker.run(["create", "--name", taskName, "--label", `com.openmausbot.abort-probe=${name}`,
        ...supervisor.launchLabels(launch).flatMap(label => ["--label", label]), "--network", "none", "--read-only", "--restart", "no",
        "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "64", "--memory", "256m", "--cpus", "1", "--user", "0:0",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--tmpfs", "/run/omb-private:rw,noexec,nosuid,nodev,mode=0700,size=1m",
        "--mount", `type=bind,src=${directory},dst=/run/omb-control`, "--mount", `type=bind,src=${directory},dst=/workspace,readonly`,
        "--mount", `type=bind,src=${candidate},dst=/run/omb-private/candidate`,
        "--entrypoint", "node", image, "/opt/openmausbot/contained-patch-worker.js"]);
      assert.equal(made.exitCode, 0, made.stderr.toString());
      // Discard the create receipt; no container.json or execution proof.
      if (mode === "waiting") assert.equal((await docker.run(["start", taskName])).exitCode, 0);
    }
    process.stdout.write("ready-for-interruption\n"); setInterval(() => {}, 1000); return;
  }
  const proof = JSON.parse(readFileSync(join(root, "coordinator.json"), "utf8"));
  const stopped = await coordinator.inspect(proof, old); assert.equal(stopped.state, "stopped");
  if (stopped.state !== "stopped") throw Error("old_coordinator_unconfirmed");
  const recovery = new DockerUnactivatedLaunchRecovery({ exchangeRoot, image, containment: supervisor });
  const cases = [];
  for (const mode of ["created", "waiting"]) {
    const binding = { runId: mode, instanceOwner: old.ownerId, instanceFence: old.fence, nonce: "a".repeat(32), canonicalWorktreePath: join(root, mode) };
    const taskName = "omb-task-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 48), directory = join(exchangeRoot, taskName);
    const before = readFileSync(join(directory, "launch.json")); assert.equal(readDockerLaunch(directory).containerId, undefined);
    const context: UnactivatedLaunchContext = { coordinatorFingerprint: stopped.fingerprint, assertCurrent() {} };
    const result = await recovery.recover(binding, context); assert.equal(result.state, "aborted_before_activation");
    if (result.state !== "aborted_before_activation") throw Error("abort_failed");
    if (mode === "created") {
      // Daemon receives a late start after recovery. Gate must still deny it.
      assert.equal((await docker.run(["start", result.containerId])).exitCode, 0);
      assert.equal((await docker.run(["wait", result.containerId], { timeoutMs: 15000 })).stdout.toString().trim(), "1");
      const log = await docker.run(["logs", result.containerId]); assert.equal(log.stderr.toString().trim(), "synthetic_worker_failed");
    }
    assert.equal((await recovery.recover(binding, context)).state, "aborted_before_activation");
    assert.deepEqual(readFileSync(join(directory, "launch.json")), before);
    assert.equal(readFileSync(join(root, mode, "unchanged.txt"), "utf8"), "unchanged");
    for (const file of ["request.json", "proposal.json", "applied.json", "provider-called"]) assert.equal(existsSync(join(directory, file)), false);
    assert.equal(JSON.parse(readFileSync(join(directory, "proposal.start"), "utf8")).start, false);
    cases.push({ mode, gatePreserved: true, candidateUnchanged: true, noExecutionProof: true });
  }
  process.stdout.write(JSON.stringify({ cases, oldCoordinatorStopped: true, lateStartDenied: true, modelCalls: 0, realGroupMessages: 0 }) + "\n");
}
void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exit(1); });
