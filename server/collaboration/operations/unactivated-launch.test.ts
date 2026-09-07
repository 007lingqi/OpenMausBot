import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerCliContainmentSupervisor, type DockerCommandPort } from "./docker-containment.ts";
import { writeDockerLaunch } from "./docker-launch.ts";
import { DockerUnactivatedLaunchRecovery } from "./unactivated-launch.ts";
import { createHash } from "node:crypto";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unactivated-launch-"))); roots.push(root);
  const binding = { runId: "run", instanceOwner: "old", instanceFence: 1, nonce: "a".repeat(32), canonicalWorktreePath: "/candidate" };
  const name = "omb-task-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 48), directory = join(root, name);
  mkdirSync(directory, { mode: 0o711 }); chmodSync(directory, 0o711);
  const image = "sha256:" + "b".repeat(64), id = "c".repeat(64);
  const docker = { run: vi.fn<DockerCommandPort["run"]>() };
  const supervisor = new DockerCliContainmentSupervisor({ docker, hostGeneration: "boot", verifierKey: Buffer.alloc(32, 1) });
  const launch = supervisor.prepareLaunch({ name, image, binding }); writeDockerLaunch(directory, launch);
  const value = { Id: id, Name: "/" + name, Image: image, Config: { Image: image, User: "0:0", Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], Entrypoint: ["node"], Cmd: ["/opt/openmausbot/contained-patch-worker.js"], Labels: Object.fromEntries(supervisor.launchLabels(launch).map(label => label.split("="))) },
    HostConfig: { RestartPolicy: { Name: "no" }, NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, PidMode: "", CapDrop: ["ALL"], CapAdd: ["CHOWN", "SETUID", "SETGID"], SecurityOpt: ["no-new-privileges:true"] },
    Mounts: [{ Source: directory, Destination: "/run/omb-control", RW: true }, { Source: directory, Destination: "/workspace", RW: false }, { Source: "/candidate", Destination: "/run/omb-private/candidate", RW: true }],
    State: { Running: false, Status: "created", Pid: 0, Paused: false, Restarting: false } };
  docker.run.mockImplementation(async args => {
    if (args[0] === "kill") { Object.assign(value.State, { Running: false, Status: "exited", Pid: 0 }); }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(args[0] === "ps" ? id : args[0] === "inspect" ? JSON.stringify([value]) : id) };
  });
  const context = { coordinatorFingerprint: "d".repeat(64), assertCurrent: vi.fn(), signal: new AbortController().signal };
  const recovery = new DockerUnactivatedLaunchRecovery({ exchangeRoot: root, image, containment: supervisor });
  return { root, binding, directory, launch, image, docker, supervisor, value, context, recovery };
}
describe("irreversible denial of a never-activated contained launch", () => {
  it("accepts the same narrow capabilities normalized by Compose to CAP_ names", async () => {
    const f = fixture(); f.value.HostConfig.CapAdd = ["CAP_CHOWN", "CAP_SETUID", "CAP_SETGID"];
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "aborted_before_activation" });
  });
  it("still rejects privileged capabilities with Compose CAP_ spelling", async () => {
    const f = fixture(); f.value.HostConfig.CapAdd = ["CAP_CHOWN", "CAP_SYS_ADMIN"];
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
  });
  it("seals the model gate, preserves the journal and returns a distinct non-execution receipt", async () => {
    const f = fixture(), original = readFileSync(join(f.directory, "launch.json"), "utf8");
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "aborted_before_activation", containerId: "c".repeat(64) });
    expect(JSON.parse(readFileSync(join(f.directory, "proposal.start"), "utf8"))).toMatchObject({ start: false });
    expect(() => writeFileSync(join(f.directory, "proposal.start"), '{"start":true}', { flag: "wx" })).toThrow();
    expect(readFileSync(join(f.directory, "launch.json"), "utf8")).toBe(original);
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "aborted_before_activation" });
    expect(f.docker.run.mock.calls.every(([args]) => ["ps", "inspect"].includes(args[0]))).toBe(true);
  });
  it.each(["proposal.start", "request.json", "proposal.json", "apply.start", "view"])("refuses a launch with activation evidence (%s)", async name => {
    const f = fixture(); if (name === "view") mkdirSync(join(f.directory, name)); else writeFileSync(join(f.directory, name), '{"start":true}', { mode: 0o600 });
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(f.docker.run.mock.calls.some(([args]) => args[0] === "kill")).toBe(false);
  });
  it.each(["wrong-mount", "wrong-command", "missing", "stale-coordinator", "cancelled", "wrong-image", "bad-journal"])("keeps %s blocked without a new start or removal", async mode => {
    const f = fixture();
    if (mode === "wrong-mount") f.value.Mounts[0].Source = "/other";
    if (mode === "wrong-command") f.value.Config.Cmd = ["/untrusted.js"];
    if (mode === "missing") f.docker.run.mockResolvedValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    if (mode === "stale-coordinator") f.context.coordinatorFingerprint = "invalid";
    if (mode === "cancelled") f.context.signal = AbortSignal.abort();
    if (mode === "wrong-image") f.value.Image = "sha256:" + "a".repeat(64);
    if (mode === "bad-journal") chmodSync(join(f.directory, "launch.json"), 0o644);
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(f.docker.run.mock.calls.every(([args]) => ["ps", "inspect"].includes(args[0]))).toBe(true);
    expect(existsSync(f.directory)).toBe(true);
  });
  it("seals before stopping a waiting container and spends at most three persistent kill attempts", async () => {
    const f = fixture(); Object.assign(f.value.State, { Running: true, Status: "running", Pid: 42 });
    const original = f.docker.run.getMockImplementation()!;
    f.docker.run.mockImplementation(async (args, options) => { if (args[0] === "kill") {
      expect(JSON.parse(readFileSync(join(f.directory, "proposal.start"), "utf8"))).toMatchObject({ start: false });
      throw Error("unknown kill receipt");
    } return original(args, options); });
    for (let n = 0; n < 4; n++) {
      const recovered = new DockerUnactivatedLaunchRecovery({ exchangeRoot: f.root, image: f.image, containment: f.supervisor });
      expect(await recovered.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    }
    expect(f.docker.run.mock.calls.filter(([args]) => args[0] === "kill")).toHaveLength(3);
    expect(readdirSync(f.directory).filter(name => name.startsWith("abort-kill-"))).toHaveLength(3);
  });
  it("cannot return success after the new owner lease is lost during observation", async () => {
    const f = fixture(); let count = 0; f.context.assertCurrent = vi.fn(() => { if (++count >= 3) throw Error("stale"); });
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
  });
  it.each(["/", "/run", "/run/omb-control/proposal.start", "/workspace/view", "/run/omb-private/candidate/secret", "/opt", "/usr/local/bin/node"])("refuses an overlapping extra mount at %s", async destination => {
    const f = fixture(); f.value.Mounts.push({ Source: "/other", Destination: destination, RW: true });
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(existsSync(join(f.directory, "proposal.start"))).toBe(false);
  });
  it.each(["extra-cap", "no-drop", "no-nnp", "unconfined"])("refuses weakened isolation: %s", async mode => {
    const f = fixture();
    if (mode === "extra-cap") f.value.HostConfig.CapAdd.push("SYS_ADMIN");
    if (mode === "no-drop") f.value.HostConfig.CapDrop = [];
    if (mode === "no-nnp") f.value.HostConfig.SecurityOpt = [];
    if (mode === "unconfined") f.value.HostConfig.SecurityOpt.push("seccomp=unconfined");
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(existsSync(join(f.directory, "proposal.start"))).toBe(false);
  });
  it.each(["NODE_OPTIONS=--require=/workspace/evil.js", "PATH=/workspace", "LD_PRELOAD=/workspace/evil.so"])("rejects executable environment overrides: %s", async override => {
    const f = fixture(); f.value.Config.Env.push(override);
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(existsSync(join(f.directory, "proposal.start"))).toBe(false);
  });
  it("rechecks authority after the last asynchronous inspect, immediately before kill", async () => {
    const f = fixture(); Object.assign(f.value.State, { Running: true, Status: "running", Pid: 42 });
    const original = f.docker.run.getMockImplementation()!; let inspects = 0, stale = false;
    f.context.assertCurrent = vi.fn(() => { if (stale) throw Error("lease_lost"); });
    f.docker.run.mockImplementation(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === "inspect" && ++inspects === 4) stale = true;
      return result;
    });
    expect(await f.recovery.recover(f.binding, f.context)).toMatchObject({ state: "blocked" });
    expect(f.docker.run.mock.calls.some(([args]) => args[0] === "kill")).toBe(false);
  });
});
