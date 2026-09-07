import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "../provider-runner.ts";
import { DockerPatchApplier } from "./docker-patch-agent.ts";

const id = "a".repeat(64);
const proof = { identity: { backend: "docker_cgroup_v2", opaqueId: id, hostGeneration: "boot", verifierVersion: "v1" }, receipt: "test" };
const changes = [{ path: "src/output.txt", contents: "hello" }];
const result = (stdout = "", exitCode = 0) => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "patch-cleanup-"));
  const controller = new AbortController();
  const input = {
    runId: "run-1", cwd: root, writeScope: ["src/**"], signal: controller.signal,
    containmentBinding: { runId: "run-1", canonicalWorktreePath: root, instanceOwner: "owner", instanceFence: 1, nonce: "n".repeat(32) },
    registerContainment: vi.fn(async () => {}),
  } as unknown as AgentRunRequest;
  const docker = { run: vi.fn(async (args: readonly string[], _options?: unknown) => result(args[0] === "create" ? id : args[0] === "wait" ? "0\n" : "")) };
  const containment = {
    labels: vi.fn(() => []), issueProof: vi.fn(async () => proof), inspect: vi.fn(async () => ({ state: "empty" })),
    terminateBoundContainer: vi.fn(async () => ({ state: "empty" })),
  };
  const exchange = join(root, "exchange");
  const applier = new DockerPatchApplier({ docker, containment: containment as never, image: "fixed:test", exchangeRoot: exchange });
  const directories = () => readdirSync(exchange);
  const hasGate = () => directories().some(directory => existsSync(join(exchange, directory, "start")));
  return { input, docker, containment, applier, controller, directories, hasGate };
}

describe("patch container cancellation and cleanup", () => {
  it.each(["", "0\n0", "NaN", "00"])("does not mistake a malformed wait receipt for success (%s)", async output => {
    const f = fixture();
    f.docker.run.mockImplementation(async args => result(args[0] === "create" ? id : args[0] === "wait" ? output : ""));
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow("docker_patch_apply_failed");
    expect(f.containment.terminateBoundContainer).toHaveBeenCalledTimes(1);
  });

  it("rejects cancellation during final cleanup even after a zero exit", async () => {
    const f = fixture();
    f.containment.terminateBoundContainer.mockImplementation(async () => { f.controller.abort(); return { state: "empty" }; });
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow("docker_patch_cancelled");
    expect(f.directories()).toEqual([]);
  });

  it("cancels the wait CLI and awaits actual container cleanup", async () => {
    const f = fixture(); let waiting = false; let finishCleanup!: () => void;
    f.docker.run.mockImplementation(async (args, options) => {
      if (args[0] !== "wait") return result(args[0] === "create" ? id : "");
      const signal = (options as { signal: AbortSignal }).signal;
      waiting = true;
      return await new Promise((_, reject) => { signal.addEventListener("abort", () => reject(Error("docker_command_aborted")), { once: true }); });
    });
    f.containment.terminateBoundContainer.mockImplementation(async () => { await new Promise<void>(resolve => { finishCleanup = resolve; }); return { state: "empty" }; });
    const pending = f.applier.apply(f.input, changes); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(waiting).toBe(true));
    let finished = false; const stopped = f.applier.interrupt(f.input.runId).then(() => { finished = true; });
    await vi.waitFor(() => expect(finishCleanup).toBeDefined());
    expect(finished).toBe(false); expect(f.directories()).toHaveLength(1);
    finishCleanup(); await stopped; await rejected;
    expect(f.directories()).toEqual([]);
  });

  it("interrupts hung proof registration without opening a late gate", async () => {
    const f = fixture(); let finishRegistration!: () => void;
    f.input.registerContainment = vi.fn(async () => { await new Promise<void>(resolve => { finishRegistration = resolve; }); });
    const pending = f.applier.apply(f.input, changes); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finishRegistration).toBeDefined());
    await f.applier.interrupt(f.input.runId); await rejected;
    finishRegistration(); await Promise.resolve();
    expect(f.hasGate()).toBe(false); expect(f.directories()).toEqual([]);
    expect(f.docker.run.mock.calls.some(([args]) => args[0] === "wait")).toBe(false);
  });

  it("does not create containers or state for an already cancelled request", async () => {
    const f = fixture(); f.controller.abort();
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow();
    expect(f.docker.run).not.toHaveBeenCalled(); expect(f.directories()).toEqual([]);
  });

  it.each(["create-throw", "create-unknown", "create-nonzero"])("retains material when the create receipt is uncertain (%s)", async mode => {
    const f = fixture();
    f.docker.run.mockImplementation(async () => { if (mode === "create-throw") throw Error("private daemon details"); return result("", mode === "create-nonzero" ? 1 : 0); });
    await expect(f.applier.apply(f.input, changes)).rejects.toHaveProperty("name", "CommandCleanupError");
    expect(f.directories()).toHaveLength(1); expect(f.hasGate()).toBe(false);
    expect(f.containment.terminateBoundContainer).not.toHaveBeenCalled();
    await expect(f.applier.interrupt(f.input.runId)).rejects.toHaveProperty("name", "CommandCleanupError");
  });

  it.each(["start", "proof", "register", "wait"])("confirms emptiness before discarding material after %s fails", async stage => {
    const f = fixture();
    if (stage === "proof") f.containment.issueProof.mockRejectedValue(Error("proof failed"));
    if (stage === "register") f.input.registerContainment = vi.fn(async () => { throw Error("registration failed"); });
    f.docker.run.mockImplementation(async args => {
      if (args[0] === stage) throw Error("operation failed");
      return result(args[0] === "create" ? id : args[0] === "wait" ? "0" : "");
    });
    f.containment.terminateBoundContainer.mockImplementation(async () => { expect(f.directories()).toHaveLength(1); return { state: "empty" }; });
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow();
    expect(f.containment.terminateBoundContainer).toHaveBeenCalledWith(id, f.input.containmentBinding);
    expect(f.directories()).toEqual([]);
  });

  it("retains material and stop failure until independently confirmed empty", async () => {
    const f = fixture(); f.containment.terminateBoundContainer.mockResolvedValue({ state: "unknown" });
    await expect(f.applier.apply(f.input, changes)).rejects.toHaveProperty("name", "CommandCleanupError");
    expect(f.directories()).toHaveLength(1);
    await expect(f.applier.interrupt(f.input.runId)).rejects.toHaveProperty("name", "CommandCleanupError");
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow();
    expect(f.docker.run.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
  });

  it("does not open the gate when cancellation arrives during proof registration", async () => {
    const f = fixture(); f.input.registerContainment = vi.fn(async () => { f.controller.abort(); });
    f.containment.terminateBoundContainer.mockImplementation(async () => { expect(f.hasGate()).toBe(false); return { state: "empty" }; });
    await expect(f.applier.apply(f.input, changes)).rejects.toThrow();
    expect(f.docker.run.mock.calls.some(([args]) => args[0] === "wait")).toBe(false);
    expect(f.containment.terminateBoundContainer).toHaveBeenCalledTimes(1);
  });

  it("shares interruption, waits for a pending create and stops before start", async () => {
    const f = fixture(); let finishCreate!: (value: ReturnType<typeof result>) => void;
    f.docker.run.mockImplementation(async args => args[0] === "create" ? await new Promise(resolve => { finishCreate = resolve; }) : result("0"));
    const pending = f.applier.apply(f.input, changes); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finishCreate).toBeDefined());
    let stopped = false;
    const stops = Promise.all([f.applier.interrupt(f.input.runId), f.applier.interrupt(f.input.runId)]).then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    finishCreate(result(id)); await rejected; await stops;
    expect(f.docker.run.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
    expect(f.containment.terminateBoundContainer).toHaveBeenCalledTimes(1);
    expect(f.directories()).toEqual([]);
  });
});
