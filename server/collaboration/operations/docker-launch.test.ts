import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
vi.mock("node:fs", async () => { const actual = await vi.importActual<typeof fs>("node:fs"); return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }; });
import { containmentBindingHash, type ContainmentBinding } from "../containment.ts";
import { DockerCliContainmentSupervisor, type DockerCommandPort } from "./docker-containment.ts";
import { readDockerLaunch, writeDockerLaunch } from "./docker-launch.ts";

const binding: ContainmentBinding = { runId: "launch-run", canonicalWorktreePath: "/worktrees/launch-run", instanceOwner: "old-owner", instanceFence: 1, nonce: "n".repeat(32) };
const name = "omb-task-" + "c".repeat(48), image = "sha256:" + "d".repeat(64), id = "a".repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const docker = { run: vi.fn<DockerCommandPort["run"]>() };
  const options = { docker, hostGeneration: "boot-1", verifierKey: Buffer.alloc(32, 7) };
  const supervisor = new DockerCliContainmentSupervisor(options);
  const launch = supervisor.prepareLaunch({ name, image, binding });
  const labels = Object.fromEntries(supervisor.launchLabels(launch).map(label => { const i = label.indexOf("="); return [label.slice(0, i), label.slice(i + 1)]; }));
  const inspection = { Id: id, Name: "/" + name, Image: image, Config: { Image: image, Labels: labels },
    HostConfig: { RestartPolicy: { Name: "no" } }, State: { Running: false, Status: "created", Pid: 0, Paused: false, Restarting: false } };
  let list = id, listCode = 0;
  const response = (stdout: string, exitCode = 0) => ({ stdout: Buffer.from(stdout), exitCode, stderr: Buffer.alloc(0) });
  docker.run.mockImplementation(async args => args[0] === "ps" ? response(list, listCode) : response(JSON.stringify([inspection])));
  return { docker, supervisor, launch, inspection, options, setList(value: string, code = 0) { list = value; listCode = code; } };
}

describe("durable Docker launch reconciliation (observation only)", () => {
  it.each(["created", "running", "exited"])("reconstructs authority after lost create receipt and observes %s without issuing an execution proof", async status => {
    const f = fixture();
    f.inspection.State = { Running: status === "running", Status: status, Pid: status === "running" ? 42 : 0, Paused: false, Restarting: false };
    const reconstructed = new DockerCliContainmentSupervisor(f.options);
    const result = await reconstructed.reconcileLaunch(f.launch, binding);
    expect(result).toEqual({ state: "observed", status: status === "running" ? "active" : status, containerId: id });
    expect(result).not.toHaveProperty("receipt"); expect(result).not.toHaveProperty("identity");
    expect(f.docker.run.mock.calls.every(([args]) => ["ps", "inspect"].includes(args[0]))).toBe(true);
  });
  it.each(["absent", "multiple", "short-id", "daemon-error", "wrong-name", "wrong-image", "mutable-config-image", "wrong-id", "wrong-binding", "wrong-generation", "missing-launch-label", "restart-policy", "missing-pid", "restarting", "dead"])("keeps %s unknown", async mode => {
    const f = fixture();
    if (mode === "absent") f.setList("");
    if (mode === "multiple") f.setList(id + "\n" + "b".repeat(64));
    if (mode === "short-id") f.setList(id.slice(0, 12));
    if (mode === "daemon-error") f.setList(id, 1);
    if (mode === "wrong-name") f.inspection.Name = "/other";
    if (mode === "wrong-image") f.inspection.Image = "sha256:" + "e".repeat(64);
    if (mode === "mutable-config-image") f.inspection.Config.Image = "latest";
    if (mode === "wrong-id") f.inspection.Id = "b".repeat(64);
    if (mode === "wrong-binding") f.inspection.Config.Labels["com.openmausbot.collaboration.binding"] = "b".repeat(64);
    if (mode === "wrong-generation") f.inspection.Config.Labels["com.openmausbot.collaboration.host-generation"] = "other-boot";
    if (mode === "missing-launch-label") delete f.inspection.Config.Labels["com.openmausbot.collaboration.launch"];
    if (mode === "restart-policy") f.inspection.HostConfig.RestartPolicy.Name = "always";
    if (mode === "missing-pid") delete (f.inspection.State as { Pid?: number }).Pid;
    if (mode === "restarting") f.inspection.State.Restarting = true;
    if (mode === "dead") f.inspection.State.Status = "dead";
    expect(await f.supervisor.reconcileLaunch(f.launch, binding)).toMatchObject({ state: "unknown" });
  });
  it("does not accept a later replacement when a create receipt was persisted", async () => {
    const f = fixture();
    expect(await f.supervisor.reconcileLaunch(f.launch, binding, "b".repeat(64))).toMatchObject({ state: "unknown" });
    expect(await f.supervisor.reconcileLaunch(f.launch, binding, id)).toMatchObject({ state: "observed" });
  });
  it.each(["tampered", "old-format", "new-boot", "new-key", "new-owner", "new-fence", "new-nonce", "malformed"])("rejects %s before querying Docker", async mode => {
    const f = fixture(); let record: unknown = f.launch, expected = binding;
    if (mode === "tampered") record = { ...f.launch, name: "omb-task-" + "e".repeat(48) };
    if (mode === "old-format") record = { version: 1, name, image, binding };
    if (mode === "malformed") record = { ...f.launch, binding: null };
    if (mode === "new-owner") expected = { ...binding, instanceOwner: "new" };
    if (mode === "new-fence") expected = { ...binding, instanceFence: 2 };
    if (mode === "new-nonce") expected = { ...binding, nonce: "x".repeat(32) };
    const authority = new DockerCliContainmentSupervisor({ ...f.options, ...(mode === "new-boot" ? { hostGeneration: "boot-2" } : {}), ...(mode === "new-key" ? { verifierKey: Buffer.alloc(32, 9) } : {}) });
    expect(await authority.reconcileLaunch(record, expected)).toMatchObject({ state: "unknown" });
    expect(f.docker.run).not.toHaveBeenCalled();
  });
  it("binds canonical fields independent of object key order", async () => {
    const f = fixture(), reordered = { nonce: binding.nonce, instanceFence: 1, instanceOwner: binding.instanceOwner, canonicalWorktreePath: binding.canonicalWorktreePath, runId: binding.runId };
    expect(containmentBindingHash(reordered)).toBe(containmentBindingHash(binding));
    expect(await f.supervisor.reconcileLaunch(JSON.parse(JSON.stringify(f.launch)), reordered)).toMatchObject({ state: "observed" });
  });
  it("keeps a query exception unknown and never invokes mutation commands", async () => {
    const f = fixture(); f.docker.run.mockRejectedValue(Error("private daemon details"));
    expect(await f.supervisor.reconcileLaunch(f.launch, binding)).toEqual({ state: "unknown", reason: "launch_daemon_unavailable" });
  });
});

describe("launch journal", () => {
  function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), "docker-launch-"))); roots.push(root); const path = join(root, name); mkdirSync(path, { mode: 0o711 }); chmodSync(path, 0o711); return path; }
  it("persists an exclusive record for a new observer and never overwrites it", () => {
    const { launch } = fixture(), path = directory();
    writeDockerLaunch(path, launch);
    expect(readDockerLaunch(path)).toEqual({ launch });
    expect(() => writeDockerLaunch(path, { ...launch, name: "other" })).toThrow();
    expect(JSON.parse(readFileSync(join(path, "launch.json"), "utf8"))).toEqual(launch);
  });
  it.each(["symlink", "hardlink", "permissions", "oversize", "truncated", "directory-link", "writable-directory", "missing-launch", "invalid-container", "legacy-container"])("does not trust %s records", mode => {
    const { launch } = fixture(); let path = directory(); const file = join(path, "launch.json");
    if (mode !== "missing-launch") writeDockerLaunch(path, launch);
    if (mode === "symlink") { rmSync(file); writeFileSync(join(path, "other"), JSON.stringify(launch), { mode: 0o600 }); symlinkSync(join(path, "other"), file); }
    if (mode === "hardlink") linkSync(file, join(path, "other"));
    if (mode === "permissions") chmodSync(file, 0o644);
    if (mode === "oversize") writeFileSync(file, " ".repeat(64 * 1024));
    if (mode === "truncated") writeFileSync(file, "{");
    if (mode === "directory-link") { const alias = path + "-link"; symlinkSync(path, alias); path = alias; }
    if (mode === "writable-directory") chmodSync(path, 0o733);
    if (mode === "invalid-container") writeFileSync(join(path, "container.json"), JSON.stringify({ containerId: "bad" }), { mode: 0o600 });
    if (mode === "legacy-container") writeFileSync(join(path, "container.json"), JSON.stringify({ containerId: id }), { mode: 0o644 });
    expect(() => readDockerLaunch(path)).toThrow();
    expect(existsSync(path)).toBe(true);
  });
  it("reads a complete create receipt when one was persisted", () => {
    const { launch } = fixture(), path = directory(); writeDockerLaunch(path, launch);
    writeFileSync(join(path, "container.json"), JSON.stringify({ containerId: id }), { mode: 0o600 });
    expect(readDockerLaunch(path)).toEqual({ launch, containerId: id });
  });
  it("syncs the record, task directory and parent before returning", () => {
    const { launch } = fixture(), path = directory(), synced: string[] = [];
    const original = vi.mocked(fs.fsyncSync).getMockImplementation()!;
    vi.mocked(fs.fsyncSync).mockImplementation(fd => { synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); original(fd); });
    try { writeDockerLaunch(path, launch); expect(synced).toEqual(["file", "directory", "directory"]); }
    finally { vi.mocked(fs.fsyncSync).mockImplementation(original); }
  });
  it("does not silently replace a record after persistence failure", () => {
    const { launch } = fixture(), path = directory();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw Error("fsync_failed"); });
    expect(() => writeDockerLaunch(path, launch)).toThrow("fsync_failed");
    expect(() => writeDockerLaunch(path, launch)).toThrow();
    expect(existsSync(join(path, "launch.json"))).toBe(true);
  });
});
