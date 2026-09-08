import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "../provider-runner.ts";
import { DockerContainedPatchAgent } from "./contained-patch-agent.ts";
import { DockerCliContainmentSupervisor, type DockerCommandPort } from "./docker-containment.ts";
import { readDockerLaunch } from "./docker-launch.ts";

function fixture(mode: "success" | "provider-failure" | "register-failure" | "source-drift" | "cleanup-unknown" | "hang-exit" = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "contained-agent-"))), cwd = join(root, "candidate"), exchange = join(root, "exchange"), channel = join(root, "channel");
  mkdirSync(cwd); mkdirSync(channel); mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src/main.ts"), "export const value = 'P1';\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { stdio: "ignore" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
  const id = "a".repeat(64), controller = new AbortController(); let control = "", running = false, registered = false, finishWait: ((value: ReturnType<typeof result>) => void) | undefined;
  const calls: readonly string[][] = [];
  function result(stdout = "", exitCode = 0) { return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode }; }
  const docker: DockerCommandPort = { run: vi.fn<DockerCommandPort["run"]>(async (args, options) => {
    (calls as string[][]).push([...args]);
    if (args[0] === "create") { control = args[args.indexOf("--mount") + 1].split(",")[1].slice(4);
      expect(readDockerLaunch(control).launch).toMatchObject({ version: 2, name: args[args.indexOf("--name") + 1] }); return result(id); }
    if (args[0] === "start") { running = true; return result(id); }
    if (args[0] === "wait") return await new Promise(resolve => { finishWait = resolve; options?.signal?.addEventListener("abort", () => resolve(result("137")), { once: true }); });
    return result();
  }) };
  const proof = { identity: { backend: "docker_cgroup_v2", opaqueId: id, hostGeneration: "boot", verifierVersion: "v1" }, receipt: "receipt" };
  const authority = new DockerCliContainmentSupervisor({ docker, hostGeneration: "boot", verifierKey: Buffer.alloc(32, 7) });
  const containment = {
    prepareLaunch: authority.prepareLaunch.bind(authority), launchLabels: authority.launchLabels.bind(authority), reconcileLaunch: authority.reconcileLaunch.bind(authority),
    labels: vi.fn(() => []), issueProof: vi.fn(async () => proof), inspect: vi.fn(async () => ({ state: running ? "active" : "empty" })),
    terminateBoundContainer: vi.fn(async () => { if (mode === "cleanup-unknown") return { state: "unknown" }; running = false; finishWait?.(result("137")); return { state: "empty" }; }),
  };
  const request = { runId: "run-1", threadId: "thread-1", turnId: "turn-1", workItemId: "WI-1", nodeId: "modify", planRevision: 1,
    cwd, objective: "change default", instructions: "update source", inputEvidence: [], readScope: ["src/**"], writeScope: ["src/**"], denyScope: [".git/**", ".env*"],
    expectedArtifacts: ["src/main.ts"], completionDefinition: "P2", environment: {}, capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: cwd, readOnlyPaths: [], denyGitMetadata: true, network: "deny" }, signal: controller.signal,
    containmentBinding: { runId: "run-1", canonicalWorktreePath: cwd, instanceOwner: "owner", instanceFence: 1, nonce: "x".repeat(32) },
    registerContainment: vi.fn(async () => { expect(existsSync(join(control, "proposal.start"))).toBe(false); if (mode === "register-failure") throw Error("register_failed"); registered = true; }), emit: vi.fn(),
  } as AgentRunRequest;
  const agent = new DockerContainedPatchAgent({ docker, containment: containment as never, image: "sha256:" + "b".repeat(64), exchangeRoot: exchange,
    modelSocketDirectory: channel, relayUid: 501, relayGid: 1000, timeoutMs: 2000, pollMs: 5 });
  let timer: ReturnType<typeof setInterval>;
  timer = setInterval(() => {
    if (!control || !running || !existsSync(join(control, "proposal.start"))) return;
    expect(registered).toBe(true);
    const path = join(control, "proposal.json");
    if (!existsSync(path)) {
      if (mode === "source-drift") writeFileSync(join(cwd, "src/main.ts"), "export const value = 'concurrent';\n");
      writeFileSync(path, JSON.stringify(mode === "provider-failure" ? { status: "needs_configuration", summary: "unclear", need: "provider_source_unavailable", changes: [] } : { status: "completed", summary: "updated", changes: [{ path: "src/main.ts", contents: "export const value = 'P2';\n" }] }), { mode: 0o600 });
    }
    if (existsSync(join(control, "apply.start"))) {
      const approved = JSON.parse(readFileSync(join(control, "apply.json"), "utf8"));
      writeFileSync(join(cwd, "src/main.ts"), approved.changes[0].contents);
      writeFileSync(join(control, "applied.json"), JSON.stringify({ status: "applied", paths: ["src/main.ts"] }), { mode: 0o600 });
      if (mode !== "hang-exit") { running = false; finishWait?.(result("0")); }
    }
  }, 5);
  return { root, cwd, exchange, agent, request, containment, docker, calls, controller, git, stop() { clearInterval(timer); }, control: () => control };
}

describe("independent contained patch Agent", () => {
  it.each(["json", "ts"])("reports a trusted %s read failure without losing registered containment or opening the model gate", async extension => {
    const f = fixture();
    const source = extension === "json" ? '{"password":"synthetic-private-value", invalid}' : 'const password = "synthetic-private-value"; const broken = ;';
    try {
      writeFileSync(join(f.cwd, `src/broken.${extension}`), source); f.git("add", "."); f.git("commit", "-qm", "unreadable fixture");
      const result = await f.agent.run(f.request);
      expect(result).toMatchObject({ status: "needs_configuration", need: "provider_source_unavailable", sandboxEnforced: true });
      expect(f.request.registerContainment).toHaveBeenCalledExactlyOnceWith(result.containmentProof);
      expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
      expect(f.calls.some(args => args[0] === "wait")).toBe(false);
      expect(f.containment.terminateBoundContainer).toHaveBeenCalledOnce();
      expect(readdirSync(f.exchange)).toEqual([]);
      expect(readFileSync(join(f.cwd, "src/main.ts"), "utf8")).toContain("P1");
      expect(readFileSync(join(f.cwd, `src/broken.${extension}`), "utf8")).toBe(source);
    } finally { f.stop(); }
  });

  it("does not hide uncertain cleanup behind a readable-source failure", async () => {
    const f = fixture("cleanup-unknown");
    try {
      writeFileSync(join(f.cwd, "src/broken.json"), "{invalid}"); f.git("add", "."); f.git("commit", "-qm", "unreadable fixture");
      await expect(f.agent.run(f.request)).rejects.toHaveProperty("name", "CommandCleanupError");
      expect(existsSync(f.control())).toBe(true);
      expect(existsSync(join(f.control(), "proposal.start"))).toBe(false);
      await expect(f.agent.interrupt(f.request.runId)).rejects.toHaveProperty("name", "CommandCleanupError");
    } finally { f.stop(); }
  });

  it("reconciles a lost create reply from a fresh agent without starting, releasing or backfilling proof", async () => {
    const f = fixture(), original = f.docker.run; let createdArgs: readonly string[] = [];
    f.docker.run = vi.fn(async args => {
      if (args[0] === "create") { createdArgs = args; await original(args); throw Error("lost reply"); }
      const stdout = args[0] === "ps" ? "a".repeat(64) : JSON.stringify([{ Id: "a".repeat(64),
        Name: "/" + createdArgs[createdArgs.indexOf("--name") + 1], Image: "sha256:" + "b".repeat(64),
        Config: { Image: "sha256:" + "b".repeat(64), Labels: Object.fromEntries(createdArgs.flatMap((value, i) => value === "--label" ? [createdArgs[i + 1].split("=")] : [])) },
        HostConfig: { RestartPolicy: { Name: "no" } }, State: { Running: false, Status: "created", Pid: 0, Paused: false, Restarting: false } }]);
      return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0 };
    });
    try {
      await expect(f.agent.run(f.request)).rejects.toHaveProperty("name", "CommandCleanupError");
      const pendingName = readdirSync(f.exchange)[0], before = readFileSync(join(f.control(), "launch.json"), "utf8");
      const authority = new DockerCliContainmentSupervisor({ docker: f.docker, hostGeneration: "boot", verifierKey: Buffer.alloc(32, 7) });
      const fresh = new DockerContainedPatchAgent({ docker: f.docker, containment: authority, image: "sha256:" + "b".repeat(64),
        exchangeRoot: f.exchange, modelSocketDirectory: join(f.root, "channel"), relayUid: 501, relayGid: 1000 });
      expect(await fresh.inspectPendingLaunch(pendingName, f.request.containmentBinding)).toEqual({ state: "observed", status: "created", containerId: "a".repeat(64) });
      expect(await fresh.inspectPendingLaunch("../escape", f.request.containmentBinding)).toMatchObject({ state: "unknown" });
      await expect(fresh.run(f.request)).rejects.toThrow();
      expect(readFileSync(join(f.control(), "launch.json"), "utf8")).toBe(before);
      expect(existsSync(join(f.control(), "proposal.start"))).toBe(false);
      expect(f.request.registerContainment).not.toHaveBeenCalled();
      expect(vi.mocked(f.docker.run).mock.calls.map(([args]) => args[0])).toEqual(["create", "ps", "inspect"]);
      expect(readFileSync(join(f.cwd, "src/main.ts"), "utf8")).toContain("P1");
    } finally { f.stop(); }
  });
  it("registers the real task containment before model gate and returns the same proof after writing", async () => {
    const f = fixture(); try {
      const result = await f.agent.run(f.request);
      expect(result).toMatchObject({ status: "completed", sandboxEnforced: true });
      expect(f.request.registerContainment).toHaveBeenCalledExactlyOnceWith(result.containmentProof);
      expect(readFileSync(join(f.cwd, "src/main.ts"), "utf8")).toContain("P2");
      const create = f.calls.find(args => args[0] === "create")!;
      expect(create).toContain("none"); expect(create).toContain("--read-only");
      expect(create.join(" ")).not.toContain("docker.sock");
      expect(readdirSync(f.exchange)).toEqual([]);
    } finally { f.stop(); }
  });
  it("keeps valid containment on a provider configuration failure without applying", async () => {
    const f = fixture("provider-failure"); try {
      const result = await f.agent.run(f.request);
      expect(result).toMatchObject({ status: "needs_configuration", sandboxEnforced: true, containmentProof: expect.any(Object) });
      expect(result).not.toHaveProperty("need"); // Model JSON cannot claim the coordinator's pre-model source-read cause.
      expect(readFileSync(join(f.cwd, "src/main.ts"), "utf8")).toContain("P1");
      expect(f.containment.terminateBoundContainer).toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it.each(["register-failure", "source-drift"] as const)("does not apply after %s", async mode => {
    const f = fixture(mode); try {
      await expect(f.agent.run(f.request)).rejects.toThrow();
      expect(readFileSync(join(f.cwd, "src/main.ts"), "utf8")).not.toContain("P2");
      expect(f.containment.terminateBoundContainer).toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it("retains files and stop failure when container cleanup is unknown", async () => {
    const f = fixture("cleanup-unknown"); try {
      await expect(f.agent.run(f.request)).rejects.toHaveProperty("name", "CommandCleanupError");
      expect(existsSync(f.control())).toBe(true);
      await expect(f.agent.interrupt(f.request.runId)).rejects.toHaveProperty("name", "CommandCleanupError");
    } finally { f.stop(); }
  });
  it("never creates a task for a request already cancelled", async () => {
    const f = fixture(); try { f.controller.abort(); await expect(f.agent.run(f.request)).rejects.toThrow(); expect(f.calls).toEqual([]); } finally { f.stop(); }
  });
  it("interrupts an outstanding Docker wait and does not return a late success", async () => {
    const f = fixture("hang-exit"); try {
      const pending = f.agent.run(f.request), rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(existsSync(join(f.control(), "applied.json"))).toBe(true));
      await f.agent.interrupt(f.request.runId); await rejected;
      expect(f.containment.terminateBoundContainer).toHaveBeenCalledOnce();
      expect(readdirSync(f.exchange)).toEqual([]);
    } finally { f.stop(); }
  });
  it("does not open a late model gate after hung registration is interrupted", async () => {
    const f = fixture(); let done!: () => void;
    f.request.registerContainment = vi.fn(async () => await new Promise<void>(resolve => { done = resolve; }));
    try {
      const pending = f.agent.run(f.request), rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(done).toBeDefined());
      await f.agent.interrupt(f.request.runId); done(); await rejected;
      expect(existsSync(join(f.control(), "proposal.start"))).toBe(false);
      expect(f.calls.some(args => args[0] === "wait")).toBe(false);
    } finally { f.stop(); }
  });
  it("retains an uncertain create without guessing identity or starting another container", async () => {
    const f = fixture(); f.docker.run = vi.fn(async () => { throw Error("unknown create receipt"); });
    try {
      await expect(f.agent.run(f.request)).rejects.toHaveProperty("name", "CommandCleanupError");
      expect(readdirSync(f.exchange)).toHaveLength(1);
      await expect(f.agent.interrupt(f.request.runId)).rejects.toHaveProperty("name", "CommandCleanupError");
      await expect(f.agent.run(f.request)).rejects.toThrow("already_active_or_unsettled");
      expect(f.docker.run).toHaveBeenCalledOnce();
      expect(f.containment.terminateBoundContainer).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
});
