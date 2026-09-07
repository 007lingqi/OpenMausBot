import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunRequest } from "../provider-runner.ts";
import { DockerContainedPatchAgent } from "./contained-patch-agent.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";

async function main(): Promise<void> {
const root = process.env.OMB_CONTAINED_SMOKE_ROOT!, image = process.env.OMB_CONTAINED_SMOKE_IMAGE!;
assert.match(root, /^\/var\/lib\/docker\/volumes\/omb-contained-[a-f0-9-]+\/_data$/u);
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const raw = new NodeDockerCommandPort(), cases: string[] = [];
for (const mode of ["success", "provider-failure", "register-failure", "cancel-registration", "cancel-provider"] as const) {
  const directory = join(root, mode), cwd = join(directory, "candidate"), channel = join(directory, "channel"), exchange = join(directory, "exchange");
  mkdirSync(join(cwd, "src"), { recursive: true }); mkdirSync(channel, { mode: 0o700 });
  writeFileSync(join(channel, "private-marker"), "synthetic private data", { mode: 0o600 });
  writeFileSync(join(cwd, "src/main.ts"), "export const priority = 'P1';\n");
  writeFileSync(join(cwd, ".env"), "SYNTHETIC_FIXTURE_ONLY=not-a-real-secret\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", ...args], { stdio: "ignore" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "synthetic fixture");
  let id: string | undefined, control = "", observation: { uid?: number; readOnly?: boolean; privateDenied?: boolean; detachedPid?: number } | undefined;
  const controller = new AbortController();
  const docker: DockerCommandPort = { async run(args, options) {
    if (args[0] === "create") control = args[args.indexOf("--mount") + 1].split(",")[1].slice(4);
    const result = await raw.run(args, options);
    if (args[0] === "create" && result.exitCode === 0) id = result.stdout.toString().trim();
    return result;
  } };
  const runId = randomUUID(), containment = new DockerCliContainmentSupervisor({ docker, hostGeneration: runId, verifierKey: randomBytes(32) });
  const originalStop = containment.terminateBoundContainer.bind(containment);
  containment.terminateBoundContainer = async (...args) => {
    if (existsSync(join(control, "observation.json"))) observation = JSON.parse(readFileSync(join(control, "observation.json"), "utf8"));
    return originalStop(...args);
  };
  const agent = new DockerContainedPatchAgent({ docker, containment, image, exchangeRoot: exchange, modelSocketDirectory: channel, relayUid: 501, relayGid: 1000, timeoutMs: 20000 });
  const binding = { runId, canonicalWorktreePath: cwd, instanceOwner: "synthetic-controller", instanceFence: 1, nonce: randomBytes(32).toString("hex") };
  let registered = false;
  const request = { runId, cwd, threadId: runId, turnId: runId, nodeId: "modify", workItemId: "WI-SYNTHETIC", planRevision: 1,
    objective: mode, instructions: "Synthetic fixture only", inputEvidence: [], readScope: ["src/**"], writeScope: ["src/**"], denyScope: [".env*"],
    completionDefinition: "P2", expectedArtifacts: ["src/main.ts"], environment: {},
    capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: cwd, readOnlyPaths: [], denyGitMetadata: true, network: "deny" }, containmentBinding: binding,
    signal: controller.signal, emit: () => {}, registerContainment: async proof => {
      assert.equal((await containment.verifyProof(proof, binding)).verified, true);
      assert.equal(existsSync(join(control, "proposal.start")), false);
      assert.equal(existsSync(join(control, "observation.json")), false);
      if (mode === "register-failure") throw Error("synthetic_registration_failure");
      registered = true;
      if (mode === "cancel-registration") controller.abort();
    },
  } as AgentRunRequest;
  const timer = setInterval(() => {
    if (mode === "cancel-provider" && control && existsSync(join(control, "observation.json"))) controller.abort();
  }, 25);
  try {
    if (mode === "success" || mode === "provider-failure") {
      const result = await agent.run(request);
      assert.equal(result.status, mode === "success" ? "completed" : "failed");
      assert.ok(result.containmentProof); assert.equal(result.containmentProof.identity.opaqueId, id);
    } else await assert.rejects(agent.run(request));
    assert.equal(readFileSync(join(cwd, "src/main.ts"), "utf8"), `export const priority = '${mode === "success" ? "P2" : "P1"}';\n`);
    if (mode === "success" || mode === "provider-failure" || mode === "cancel-provider") {
      assert.equal(registered, true); assert.equal(observation?.uid, 10001); assert.equal(observation?.readOnly, true); assert.equal(observation?.privateDenied, true);
      assert.ok(observation?.detachedPid && observation.detachedPid > 1);
    } else assert.equal(observation, undefined);
    assert.ok(id);
    const inspection = JSON.parse((await raw.run(["inspect", id])).stdout.toString())[0];
    assert.equal(inspection.State.Status, "exited"); assert.equal(inspection.State.Pid, 0);
    assert.equal(inspection.HostConfig.NetworkMode, "none"); assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.HostConfig.Privileged, false); assert.equal(inspection.HostConfig.RestartPolicy.Name, "no");
    assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
    assert.ok(inspection.Mounts.every((mount: { Source: string; Type: string }) => mount.Type === "tmpfs" || mount.Source.startsWith(root + "/")));
    assert.equal(inspection.Mounts.find((mount: { Destination: string }) => mount.Destination === "/workspace").RW, false);
    assert.deepEqual(readdirSync(exchange), []); await agent.interrupt(runId);
    cases.push(mode);
  } finally {
    clearInterval(timer);
    if (id) {
      const owned = JSON.parse((await raw.run(["inspect", id])).stdout.toString())[0]; assert.equal(owned.Image, image);
      for (const label of containment.labels(binding)) { const n = label.indexOf("="); assert.equal(owned.Config.Labels[label.slice(0, n)], label.slice(n + 1)); }
      assert.equal((await raw.run(["rm", "--force", id])).exitCode, 0);
    }
  }
}
console.log(JSON.stringify({ cases, registeredBeforeProvider: true, detachedDescendantsStopped: true, privateCandidateDenied: true,
  failureWrites: 0, modelCalls: 0, realGroupMessages: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
