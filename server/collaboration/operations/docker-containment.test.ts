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
      return result(0, JSON.stringify([{ Id: this.id, Config: { Labels: this.labels }, State: { Running: this.running } }]));
    }
    return result(1, "", "not found");
  }
}

function result(exitCode: number, stdout = "", stderr = ""): DockerCommandResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

describe("Docker CLI containment supervisor", () => {
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
