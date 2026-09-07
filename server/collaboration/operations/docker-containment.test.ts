import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import type { ContainmentBinding } from "../containment.ts";
import {
  DockerCliContainmentSupervisor,
  NodeDockerCommandPort,
  type DockerCommandPort,
  type DockerCommandResult,
} from "./docker-containment.ts";

const binding: ContainmentBinding = {
  runId: "run-1",
  canonicalWorktreePath: "/worktrees/run-1",
  instanceOwner: "owner-1",
  instanceFence: 1,
  nonce: "n".repeat(32),
};

class FakeDocker implements DockerCommandPort {
  running = true;
  labels: Record<string, string> = {};
  readonly id = "a".repeat(64);

  async run(args: readonly string[]): Promise<DockerCommandResult> {
    if (args[0] === "kill") {
      this.running = false;
      return result(0, this.id);
    }
    if (args[0] === "inspect" && args[1] === this.id) {
      return result(0, JSON.stringify([{ Id: this.id, Config: { Labels: this.labels },
        HostConfig: { RestartPolicy: { Name: "no" } },
        State: { Running: this.running, Status: this.running ? "running" : "exited", Pid: this.running ? 42 : 0, Paused: false, Restarting: false } }]));
    }
    return result(1, "", "not found");
  }
}

function result(exitCode: number, stdout = "", stderr = ""): DockerCommandResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

describe("Docker CLI containment supervisor", () => {
  function fixture() {
    const docker = new FakeDocker();
    const supervisor = new DockerCliContainmentSupervisor({ docker, hostGeneration: "boot-1", verifierKey: Buffer.alloc(32, 7) });
    for (const label of supervisor.labels(binding)) {
      const offset = label.indexOf("=");
      docker.labels[label.slice(0, offset)] = label.slice(offset + 1);
    }
    return { docker, supervisor };
  }

  it.each(["wrong-id", "multiple", "no-state", "no-running", "string-running", "pid-alive", "restarting", "created", "dead", "restart-policy", "foreign-generation"])(
    "never reports ambiguous Docker state as empty (%s)", async mode => {
      const { docker, supervisor } = fixture();
      const proof = await supervisor.issueProof(docker.id, binding);
      docker.running = false;
      const valid = JSON.parse((await docker.run(["inspect", docker.id])).stdout.toString());
      if (mode === "wrong-id") valid[0].Id = "b".repeat(64);
      if (mode === "multiple") valid.push(valid[0]);
      if (mode === "no-state") delete valid[0].State;
      if (mode === "no-running") delete valid[0].State.Running;
      if (mode === "string-running") valid[0].State.Running = "false";
      if (mode === "pid-alive") valid[0].State.Pid = 42;
      if (mode === "restarting") valid[0].State.Restarting = true;
      if (mode === "created") valid[0].State.Status = "created";
      if (mode === "dead") valid[0].State.Status = "dead";
      if (mode === "restart-policy") valid[0].HostConfig.RestartPolicy.Name = "always";
      if (mode === "foreign-generation") valid[0].Config.Labels["com.openmausbot.collaboration.host-generation"] = "other";
      const run = vi.spyOn(docker, "run").mockImplementation(async () => result(0, JSON.stringify(valid)));
      await expect(supervisor.inspect(proof.identity)).resolves.toMatchObject({ state: "unknown" });
      await expect(supervisor.terminateAndWaitEmpty(proof.identity)).resolves.toMatchObject({ state: "unknown" });
      expect(run.mock.calls.every(([args]) => args[0] === "inspect")).toBe(true);
    },
  );

  it("rejects proof issue and verification when Docker returns a different full identity", async () => {
    const { docker, supervisor } = fixture();
    const proof = await supervisor.issueProof(docker.id, binding);
    const wrong = JSON.parse((await docker.run(["inspect", docker.id])).stdout.toString());
    wrong[0].Id = "b".repeat(64);
    vi.spyOn(docker, "run").mockResolvedValue(result(0, JSON.stringify(wrong)));
    await expect(supervisor.issueProof(docker.id, binding)).rejects.toThrow();
    await expect(supervisor.verifyProof(proof, binding)).resolves.toMatchObject({ verified: false });
  });

  it("permits cleanup of a bound never-started container but not a malformed stopped state", async () => {
    const { docker, supervisor } = fixture();
    docker.running = false;
    const state = JSON.parse((await docker.run(["inspect", docker.id])).stdout.toString());
    state[0].State.Status = "created";
    vi.spyOn(docker, "run").mockImplementation(async () => result(0, JSON.stringify(state)));
    await expect(supervisor.terminateBoundContainer(docker.id, binding)).resolves.toMatchObject({ state: "empty" });
    delete state[0].State.Pid;
    await expect(supervisor.terminateBoundContainer(docker.id, binding)).resolves.toMatchObject({ state: "unknown" });
  });

  it("does not spawn an already cancelled command", async () => {
    const controller = new AbortController();
    controller.abort("private reason");
    const spawn = vi.spyOn(childProcess, "spawn");
    try {
      await expect(new NodeDockerCommandPort({ executable: process.execPath }).run(["-e", "process.exit(0)"], { signal: controller.signal }))
        .rejects.toThrow("docker_command_aborted");
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
  it("reaps a running CLI before rejecting cancellation and removes its abort listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const spawn = vi.spyOn(childProcess, "spawn");
    const pending = new NodeDockerCommandPort({ executable: process.execPath }).run(["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, timeoutMs: 2000 });
    const assertion = expect(pending).rejects.toThrow("docker_command_aborted");
    const child = spawn.mock.results[0].value as childProcess.ChildProcess;
    try {
      await once(child, "spawn");
      controller.abort("private reason");
      await assertion;
      expect(child.signalCode).toBe("SIGKILL");
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally { child.kill("SIGKILL"); spawn.mockRestore(); remove.mockRestore(); }
  });
  it("binds a proof to Docker labels, host generation, and the scheduler fence", async () => {
    const docker = new FakeDocker();
    const supervisor = new DockerCliContainmentSupervisor({
      docker,
      hostGeneration: "boot-1",
      verifierKey: Buffer.alloc(32, 7),
    });
    for (const label of supervisor.labels(binding)) {
      const offset = label.indexOf("=");
      docker.labels[label.slice(0, offset)] = label.slice(offset + 1);
    }
    const proof = await supervisor.issueProof(docker.id, binding);
    await expect(supervisor.verifyProof(proof, binding)).resolves.toMatchObject({ verified: true });
    await expect(supervisor.inspect(proof.identity)).resolves.toMatchObject({ state: "active" });
    await expect(supervisor.terminateAndWaitEmpty(proof.identity)).resolves.toMatchObject({ state: "empty" });
  });

  it("rejects relabeling, stale generations, and forged receipts", async () => {
    const docker = new FakeDocker();
    const supervisor = new DockerCliContainmentSupervisor({
      docker,
      hostGeneration: "boot-1",
      verifierKey: Buffer.alloc(32, 9),
    });
    for (const label of supervisor.labels(binding)) {
      const offset = label.indexOf("=");
      docker.labels[label.slice(0, offset)] = label.slice(offset + 1);
    }
    const proof = await supervisor.issueProof(docker.id, binding);
    docker.labels["com.openmausbot.collaboration.binding"] = createHash("sha256").update("other").digest("hex");
    await expect(supervisor.verifyProof(proof, binding)).resolves.toEqual({
      verified: false,
      reason: "containment_container_unavailable",
    });
    docker.labels["com.openmausbot.collaboration.binding"] = supervisor.labels(binding)[1].split("=")[1];
    await expect(supervisor.verifyProof({ ...proof, receipt: "forged" }, binding)).resolves.toEqual({
      verified: false,
      reason: "containment_receipt_invalid",
    });
    await expect(supervisor.inspect({ ...proof.identity, hostGeneration: "old-boot" })).resolves.toEqual({
      state: "unknown",
      reason: "containment_identity_invalid",
    });
  });
});
