import { describe, expect, it } from "vitest";
import { assertDocumentContainerIsolation, runDocumentExtractorSmoke } from "./document-extractor.smoke.ts";
import type { DockerCommandPort } from "./docker-containment.ts";

const image = `sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
function inspection() {
  return { Id: id, Image: image, Config: { User: "65534:65534" }, Mounts: [], HostConfig: {
    NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
    Privileged: false, PidMode: "", IpcMode: "private", Binds: null, Mounts: [], Devices: [],
    Memory: 384 * 1024 * 1024, MemorySwap: 384 * 1024 * 1024, NanoCpus: 1e9, PidsLimit: 32,
    LogConfig: { Type: "none" }, Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=32m" },
  } };
}
describe("document parser Docker smoke evidence", () => {
  it("accepts only the inspected immutable image and restricted runtime", () => {
    expect(() => assertDocumentContainerIsolation(inspection(), { id, image })).not.toThrow();
    for (const field of ["NetworkMode", "ReadonlyRootfs", "Privileged", "CapDrop", "SecurityOpt", "Memory", "MemorySwap", "NanoCpus", "PidsLimit", "LogConfig", "Tmpfs"] as const) {
      const value = inspection();
      Object.assign(value.HostConfig, { [field]: null });
      expect(() => assertDocumentContainerIsolation(value, { id, image })).toThrow();
    }
    for (const field of ["Binds", "Devices"] as const) {
      const value = inspection(); Object.assign(value.HostConfig, { [field]: ["host-resource"] });
      expect(() => assertDocumentContainerIsolation(value, { id, image })).toThrow();
    }
    expect(() => assertDocumentContainerIsolation({ ...inspection(), Config: { User: "0:0" } }, { id, image })).toThrow();
    expect(() => assertDocumentContainerIsolation({ ...inspection(), Mounts: [{ Type: "bind" }] }, { id, image })).toThrow();
    expect(() => assertDocumentContainerIsolation(inspection(), { id: "c".repeat(64), image })).toThrow();
    expect(() => assertDocumentContainerIsolation(inspection(), { id, image: `sha256:${"c".repeat(64)}` })).toThrow();
  });
  it("fails before Docker without fixed images and a selected context", async () => {
    let calls = 0;
    const docker: DockerCommandPort = { async run() { calls++; throw new Error("must_not_run"); } };
    for (const config of [{ context: "", image, testImage: image }, { context: "test", image: "parser:latest", testImage: image }, { context: "test", image, testImage: "tests:latest" }]) {
      await expect(runDocumentExtractorSmoke(config, docker)).rejects.toThrow("explicit_context_and_fixed_images_required");
    }
    expect(calls).toBe(0);
  });
});

const fixtures = [
  { name: "word-table", format: "docx", truncated: false, location: "table:1:row:1:cell:1", contains: "无法保存" },
  { name: "excel-hidden-sheet", format: "xlsx", truncated: false, location: "隐藏补充!B2", contains: "列表也需要刷新", warnings: [] },
  { name: "excel-formula", format: "xlsx", truncated: true, location: "隐藏补充!B2", contains: "=1+1", warnings: ["formulas_not_evaluated"] },
  { name: "pdf-text", format: "pdf", truncated: false, location: "page:1", contains: "Save result stale", warnings: [] },
  { name: "pdf-partial", format: "pdf", truncated: true, location: "page:1", contains: "Save result stale", warnings: ["unread_empty_or_scanned_page"] },
  { name: "word-active-content", format: "docx", reject: true },
  { name: "pdf-encrypted", format: "pdf", reject: true },
].map(fixture => ({ ...fixture, base64: Buffer.from(fixture.name).toString("base64") }));

function fakeDocker(fault = "") {
  const containers = new Map<string, { name: string; script: string; inspected: boolean; running: boolean; exitCode: number }>();
  const unrelatedId = "f".repeat(64);
  containers.set(unrelatedId, { name: "existing-user-container", script: "", inspected: false, running: true, exitCode: 0 });
  const removed: string[] = [];
  let count = 0;
  let runtimeCount = 0;
  const result = (stdout = "", exitCode = 0) => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode });
  const docker: DockerCommandPort = { async run(args) {
    if (args[0] === "image") return result(image);
    if (args[0] === "create") {
      const containerId = (++count).toString(16).padStart(64, "0");
      const script = args.at(-1)!;
      if (script === "docx" || script === "pdf" || script === "xlsx" || script.includes("time.sleep")) runtimeCount++;
      if (runtimeCount === 6 && fault === "create-failed") return result("", 125);
      containers.set(containerId, { name: args[args.indexOf("--name") + 1], script, inspected: false, running: false, exitCode: 0 });
      if ((runtimeCount === 6 && fault === "create-lost") || (count === 1 && fault === "test-create-lost")) throw new Error("docker_command_timed_out");
      return result(containerId);
    }
    if (args[0] === "inspect") {
      const containerId = args.at(-1)!;
      const container = containers.get(containerId)!;
      if (runtimeCount === 6 && !container.inspected && fault === "inspect-failed") return result("", 1);
      if (runtimeCount === 6 && container.inspected && fault === "process-inspect-failed") return result("", 1);
      container.inspected = true;
      return result(JSON.stringify([{ ...inspection(), Id: containerId,
        State: { Running: container.running, ExitCode: fault === "wrong-process-exit" && runtimeCount === 6 ? 125 : container.exitCode, Error: "", OOMKilled: false } }]));
    }
    if (args[0] === "start") {
      const container = containers.get(args.at(-1)!)!;
      if (container.script === "/app/smoke_fixtures.py") return result(JSON.stringify(fault === "duplicate-fixtures" ? fixtures.map(() => fixtures[0]) : fixtures));
      if (container.script.startsWith("/app/test_")) return result();
      if (container.script.includes("time.sleep")) {
        container.running = fault !== "timeout-before-start";
        throw new Error(fault === "timeout-other-error" ? "docker_stdio_unavailable" : "docker_command_timed_out");
      }
      const fixture = fixtures[runtimeCount - 1];
      if (fixture.reject) {
        if (fault === "start-failed") throw new Error("docker_unavailable");
        container.exitCode = 2;
        return result(fault === "wrong-rejection-body" ? "" : '{"error":"attachment_document_invalid"}', 2);
      }
      return result(JSON.stringify({ version: 1, format: fixture.format, truncated: fixture.truncated, warnings: fixture.warnings ?? [],
        records: [{ location: fixture.location, text: fixture.contains }] }));
    }
    if (args[0] === "rm") {
      const ref = args.at(-1)!;
      removed.push(ref);
      const found = [...containers].find(([key, value]) => key === ref || value.name === ref);
      if (fault === "cleanup-failed") return result("", 1);
      if (found && fault !== "cleanup-lies") containers.delete(found[0]);
      return result();
    }
    if (args[0] === "ps") {
      if (fault === "cleanup-list-failed") return result("", 1);
      const filter = args[args.indexOf("--filter") + 1];
      return result([...containers].filter(([key, value]) => filter === `id=${key}` || filter === `name=^/${value.name}$`).map(([key]) => key).join("\n"));
    }
    throw new Error(`unexpected_command:${args[0]}`);
  } };
  return { docker, containers, removed };
}

describe("document smoke orchestration (controlled Docker port, not Linux evidence)", () => {
  it("validates seven documents and an actual timeout and removes only its own containers", async () => {
    const fake = fakeDocker();
    const report = await runDocumentExtractorSmoke({ context: "test", image, testImage: image }, fake.docker);
    expect(report.scenarios).toHaveLength(8);
    expect(report.evidenceSource).toBe("controlled_docker_port");
    expect([...fake.containers.keys()]).toEqual(["f".repeat(64)]);
    expect(fake.removed.every(ref => /^[a-f0-9]{64}$/.test(ref) || /^omb-(document|parser-smoke)-[a-f0-9-]+$/.test(ref))).toBe(true);
  });
  it.each(["create-failed", "create-lost", "test-create-lost", "inspect-failed", "process-inspect-failed", "start-failed", "wrong-process-exit", "wrong-rejection-body",
    "timeout-before-start", "timeout-other-error", "duplicate-fixtures", "cleanup-failed", "cleanup-lies", "cleanup-list-failed"])("cannot report success after %s", async fault => {
    const fake = fakeDocker(fault);
    await expect(runDocumentExtractorSmoke({ context: "test", image, testImage: image }, fake.docker)).rejects.toThrow();
    expect(fake.removed).not.toContain("f".repeat(64));
    if (!["cleanup-failed", "cleanup-lies", "cleanup-list-failed"].includes(fault)) expect([...fake.containers.keys()]).toEqual(["f".repeat(64)]);
    else expect(fake.removed.length || fault === "cleanup-list-failed").toBeTruthy();
    if (fault === "cleanup-failed" || fault === "cleanup-lies") expect(new Set(fake.removed).size).toBe(4);
  });
});
