import { describe, expect, it, vi } from "vitest";
import { DockerCoordinatorAuthority } from "./docker-coordinator.ts";
import type { DockerCommandPort } from "./docker-containment.ts";

const instance = { ownerId: "headless:original", fence: 1 }, image = "sha256:" + "a".repeat(64), id = "b".repeat(64);
const first = "2026-09-07T10:00:00.123456789Z", later = "2026-09-07T10:01:00.123456789Z";
function fixture() {
  const state = { Running: true, Status: "running", Pid: 42, Paused: false, Restarting: false, Dead: false, StartedAt: first, FinishedAt: "0001-01-01T00:00:00Z" };
  const value = { Id: id, Name: "/coordinator", Image: image, State: state, Mounts: [] as Array<{ Destination: string }>,
    HostConfig: { PidMode: "", Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: ["CHOWN", "SETUID", "SETGID"], SecurityOpt: ["no-new-privileges:true"] } };
  const docker = { run: vi.fn<DockerCommandPort["run"]>(async args => ({ exitCode: 0, stdout: Buffer.from(args[0] === "exec" ? "pid:[12345]\n" : JSON.stringify([value])), stderr: Buffer.alloc(0) })) };
  const options = { docker, container: "coordinator", image, hostGeneration: "boot-1", verifierKey: Buffer.alloc(32, 5), localPidNamespace: () => "pid:[12345]" };
  const authority = new DockerCoordinatorAuthority(options);
  return { state, value, docker, options, authority, exited() { Object.assign(state, { Running: false, Status: "exited", Pid: 0, FinishedAt: later }); } };
}
describe("Docker coordinator startup epoch authority", () => {
  it("captures current PID namespace and binds the real container epoch to owner and fence", async () => {
    const f = fixture(), lease = { ...instance, expiresAt: Date.now() + 60000, version: 1 }, proof = await f.authority.capture(lease);
    expect(proof).toMatchObject({ containerId: id, image, startedAt: first, pidNamespace: "pid:[12345]", instance });
    expect(await f.authority.inspect(proof, instance)).toMatchObject({ state: "active" });
    f.exited(); expect(await new DockerCoordinatorAuthority(f.options).inspect(JSON.parse(JSON.stringify(proof)), instance)).toMatchObject({ state: "stopped" });
  });
  it("does not confuse a restarted container with its old coordinator epoch", async () => {
    const f = fixture(), old = await f.authority.capture(instance);
    f.state.StartedAt = later;
    expect(await f.authority.inspect(old, instance)).toMatchObject({ state: "stopped" });
    const fresh = await f.authority.capture({ ownerId: "headless:new", fence: 2 });
    expect(await f.authority.inspect(fresh, fresh.instance)).toMatchObject({ state: "active" });
  });
  it.each(["pid-namespace", "wrong-container", "wrong-image", "host-pid", "privileged", "writable-root", "cap-add", "cap-drop", "no-nnp", "shadowed-readlink", "restarted-during-capture"])("refuses issuance for %s", async mode => {
    const f = fixture();
    if (mode === "pid-namespace") f.options.localPidNamespace = () => "pid:[99999]";
    if (mode === "wrong-container") f.value.Name = "/other";
    if (mode === "wrong-image") f.value.Image = "sha256:" + "c".repeat(64);
    if (mode === "host-pid") f.value.HostConfig.PidMode = "host";
    if (mode === "privileged") f.value.HostConfig.Privileged = true;
    if (mode === "writable-root") f.value.HostConfig.ReadonlyRootfs = false;
    if (mode === "cap-add") f.value.HostConfig.CapAdd.push("SYS_ADMIN");
    if (mode === "cap-drop") f.value.HostConfig.CapDrop = [];
    if (mode === "no-nnp") f.value.HostConfig.SecurityOpt = [];
    if (mode === "shadowed-readlink") f.value.Mounts.push({ Destination: "/usr/bin" });
    if (mode === "restarted-during-capture") { const run = f.docker.run.getMockImplementation()!; f.docker.run.mockImplementation(async (args, options) => { const result = await run(args, options); if (args[0] === "exec") f.state.StartedAt = later; return result; }); }
    await expect(new DockerCoordinatorAuthority(f.options).capture(instance)).rejects.toThrow();
  });
  it.each(["forged", "wrong-owner", "wrong-fence", "old-boot", "missing", "wrong-id", "wrong-image", "missing-pid", "paused", "restarting", "dead", "earlier-start", "malformed-start", "bad-finished", "missing-finished"])("keeps %s unknown, never kills or executes during inspection", async mode => {
    const f = fixture(), proof = await f.authority.capture(instance); f.exited(); f.docker.run.mockClear();
    let record: unknown = proof, expected = instance, authority = f.authority;
    if (mode === "forged") record = { ...proof, startedAt: later };
    if (mode === "wrong-owner") expected = { ...instance, ownerId: "other" };
    if (mode === "wrong-fence") expected = { ...instance, fence: 2 };
    if (mode === "old-boot") authority = new DockerCoordinatorAuthority({ ...f.options, hostGeneration: "boot-2" });
    if (mode === "missing") f.docker.run.mockRejectedValue(Error("private error"));
    if (mode === "wrong-id") f.value.Id = "c".repeat(64);
    if (mode === "wrong-image") f.value.Image = "sha256:" + "c".repeat(64);
    if (mode === "missing-pid") delete (f.state as { Pid?: number }).Pid;
    if (mode === "paused") f.state.Paused = true;
    if (mode === "restarting") f.state.Restarting = true;
    if (mode === "dead") f.state.Dead = true;
    if (mode === "earlier-start") f.state.StartedAt = "2026-09-06T10:00:00Z";
    if (mode === "malformed-start") f.state.StartedAt = "yesterday";
    if (mode === "bad-finished") f.state.FinishedAt = first;
    if (mode === "missing-finished") delete (f.state as { FinishedAt?: string }).FinishedAt;
    expect(await authority.inspect(record, expected)).toMatchObject({ state: "unknown" });
    expect(f.docker.run.mock.calls.every(([args]) => args[0] === "inspect")).toBe(true);
  });
});
