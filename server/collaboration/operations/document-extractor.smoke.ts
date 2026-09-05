import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DockerDocumentExtractor } from "./document-extractor.ts";
import { NodeDockerCommandPort, type DockerCommandPort, type DockerCommandResult } from "./docker-containment.ts";

const fixedImage = /^sha256:[a-f0-9]{64}$/u;
const inspectionSchema = z.object({ Id: z.string(), Image: z.string(), Config: z.object({ User: z.string() }),
  Mounts: z.array(z.object({ Type: z.string() })), HostConfig: z.object({
    NetworkMode: z.literal("none"), ReadonlyRootfs: z.literal(true), Privileged: z.literal(false),
    CapDrop: z.array(z.string()), SecurityOpt: z.array(z.string()), PidMode: z.literal(""), IpcMode: z.literal("private"),
    Binds: z.array(z.unknown()).nullable(), Mounts: z.array(z.unknown()).optional(), Devices: z.array(z.unknown()).nullable(),
    Memory: z.literal(384 * 1024 * 1024), MemorySwap: z.literal(384 * 1024 * 1024), NanoCpus: z.literal(1e9), PidsLimit: z.literal(32),
    LogConfig: z.object({ Type: z.literal("none") }), Tmpfs: z.record(z.string(), z.string()),
  }),
});

export function assertDocumentContainerIsolation(value: unknown, expected: { id: string; image: string }): void {
  const state = inspectionSchema.parse(value);
  assert.equal(state.Id, expected.id); assert.equal(state.Image, expected.image);
  assert.equal(state.Config.User, "65534:65534");
  assert.deepEqual(state.HostConfig.CapDrop, ["ALL"]);
  assert.ok(state.HostConfig.SecurityOpt.includes("no-new-privileges:true") || state.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal(state.HostConfig.Binds?.length ?? 0, 0);
  assert.equal(state.HostConfig.Mounts?.length ?? 0, 0);
  assert.equal(state.HostConfig.Devices?.length ?? 0, 0);
  assert.ok(state.Mounts.every(mount => mount.Type === "tmpfs"));
  assert.deepEqual(Object.keys(state.HostConfig.Tmpfs), ["/tmp"]);
  assert.deepEqual(new Set(state.HostConfig.Tmpfs["/tmp"].split(",")), new Set(["rw", "noexec", "nosuid", "nodev", "size=32m"]));
}

const fixtureSchema = z.array(z.object({ name: z.string().regex(/^[a-z-]+$/u), format: z.enum(["docx", "xlsx", "pdf"]),
  base64: z.string().max(1024 * 1024), reject: z.boolean().optional(), truncated: z.boolean().optional(),
  location: z.string().optional(), contains: z.string().optional(), warnings: z.array(z.string()).optional(),
}).strict()).length(7);
const mediaTypes = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

export async function runDocumentExtractorSmoke(config: { context: string; image: string; testImage: string }, suppliedDocker?: DockerCommandPort) {
  if (!config.context.trim() || !fixedImage.test(config.image) || !fixedImage.test(config.testImage)) throw new Error("explicit_context_and_fixed_images_required");
  const real = suppliedDocker ?? new NodeDockerCommandPort({ context: config.context });
  for (const image of [config.image, config.testImage]) {
    const found = await real.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 5000, maxOutputBytes: 1000 });
    assert.equal(found.exitCode, 0); assert.equal(found.stdout.toString("utf8").trim(), image);
  }
  type Evidence = { name: string; id?: string; isolated: boolean; processVerified: boolean; result?: DockerCommandResult; timedOut: boolean };
  const owned: Evidence[] = [];
  const current = () => { const record = owned.at(-1); assert.ok(record); return record; };
  const inspectProcess = async (record: Evidence, running: boolean, exitCode?: number) => {
    const inspected = await real.run(["inspect", record.id!], { timeoutMs: 5000, maxOutputBytes: 64000 });
    assert.equal(inspected.exitCode, 0);
    const value = z.array(z.object({ Id: z.literal(record.id!), State: z.object({
      Running: z.boolean(), ExitCode: z.number().int(), Error: z.literal(""), OOMKilled: z.literal(false),
    }) })).length(1).parse(JSON.parse(inspected.stdout.toString("utf8")))[0];
    assert.equal(value.State.Running, running);
    if (exitCode !== undefined) assert.equal(value.State.ExitCode, exitCode);
    record.processVerified = true;
  };
  const docker: DockerCommandPort = { async run(args, options) {
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      assert.match(name, /^omb-(?:document|parser-smoke)-[a-f0-9-]{36}$/u);
      assert.ok(!owned.some(record => record.name === name));
      // Save the generated name before create, including a lost acknowledgement.
      owned.push({ name, isolated: false, processVerified: false, timedOut: false });
      const result = await real.run(args, options);
      assert.equal(result.exitCode, 0);
      const id = result.stdout.toString("utf8").trim(); assert.match(id, /^[a-f0-9]{64}$/u); current().id = id;
      const inspected = await real.run(["inspect", id], { timeoutMs: 5000, maxOutputBytes: 64000 });
      assert.equal(inspected.exitCode, 0);
      const values = z.array(z.unknown()).length(1).parse(JSON.parse(inspected.stdout.toString("utf8")));
      assertDocumentContainerIsolation(values[0], { id, image: args.includes(config.testImage) ? config.testImage : config.image });
      current().isolated = true;
      return result;
    }
    if (args[0] === "start") {
      const record = current(); assert.ok(record.isolated); assert.equal(args.at(-1), record.id);
      let result: DockerCommandResult;
      try { result = await real.run(args, options); }
      catch (error) {
        if (error instanceof Error && error.message === "docker_command_timed_out") {
          record.timedOut = true;
          // A CLI timeout alone does not prove the process actually started.
          await inspectProcess(record, true);
        }
        throw error;
      }
      record.result = result;
      await inspectProcess(record, false, result.exitCode);
      return result;
    }
    return real.run(args, options);
  } };
  const listed = async (record: Evidence) => {
    const filter = record.id ? `id=${record.id}` : `name=^/${record.name}$`;
    const list = await real.run(["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"], { timeoutMs: 5000, maxOutputBytes: 1000 });
    assert.equal(list.exitCode, 0);
    const id = list.stdout.toString("utf8").trim();
    if (id) { assert.match(id, /^[a-f0-9]{64}$/u); if (record.id) assert.equal(id, record.id); }
    return id;
  };
  const removed = async (record: Evidence) => { assert.equal(await listed(record), ""); };
  const requireProcess = () => {
    const record = current(); assert.ok(record.id && record.isolated && record.processVerified, "parser_process_evidence_missing");
    return record;
  };
  const testProcess = async (script: string) => {
    const created = await docker.run(["create", "--name", `omb-parser-smoke-${randomUUID()}`, "--interactive", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--log-driver", "none", "--user", "65534:65534", "--memory", "384m",
      "--memory-swap", "384m", "--cpus", "1", "--pids-limit", "32", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--entrypoint", "python", config.testImage, script],
    { timeoutMs: 30000, maxOutputBytes: 4096 });
    assert.equal(created.exitCode, 0); const id = created.stdout.toString("utf8").trim();
    const result = await docker.run(["start", "--attach", "--interactive", id], { timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 });
    assert.equal(result.exitCode, 0); return result.stdout;
  };
  const results: Array<{ scenario: string; passed: true }> = [];
  try {
    await testProcess("/app/test_extractor.py");
    await testProcess("/app/test_smoke_fixtures.py");
    const fixtures = fixtureSchema.parse(JSON.parse((await testProcess("/app/smoke_fixtures.py")).toString("utf8")));
    assert.deepEqual(fixtures.map(fixture => [fixture.name, fixture.format, fixture.reject === true]), [
      ["word-table", "docx", false], ["excel-hidden-sheet", "xlsx", false], ["excel-formula", "xlsx", false],
      ["pdf-text", "pdf", false], ["pdf-partial", "pdf", false], ["word-active-content", "docx", true], ["pdf-encrypted", "pdf", true],
    ]);
    const extractor = new DockerDocumentExtractor({ docker, image: config.image });
    for (const fixture of fixtures) {
      const input = { bytes: Buffer.from(fixture.base64, "base64"), displayName: `${fixture.name}.${fixture.format}`, mediaType: mediaTypes[fixture.format] };
      if (fixture.reject) {
        await assert.rejects(extractor.extract(input), /^Error: attachment_document_extraction_failed$/u);
        const record = requireProcess();
        assert.equal(record.result?.exitCode, 2);
        assert.deepEqual(JSON.parse(record.result.stdout.toString("utf8")), { error: "attachment_document_invalid" });
      }
      else {
        const result = await extractor.extract(input);
        assert.equal(result.format, fixture.format); assert.equal(result.truncated, fixture.truncated);
        assert.equal(result.extractor?.version, `1:${config.image}`);
        const content = result.chunks.map(chunk => chunk.text).join("\n");
        assert.ok(content.includes(fixture.location!)); assert.ok(content.includes(fixture.contains!));
        assert.ok(!content.includes("fixture-only-never-publish"));
        assert.ok(result.chunks.every(chunk => chunk.untrusted && /^[a-f0-9]{64}$/u.test(chunk.textHash)));
        for (const warning of fixture.warnings ?? []) assert.ok(result.warnings.includes(warning));
      }
      requireProcess();
      await removed(current());
      results.push({ scenario: fixture.name, passed: true });
    }
    const timeoutDocker: DockerCommandPort = { async run(args, options) {
      if (args[0] === "create") return docker.run([...args.slice(0, args.indexOf(config.image) + 1), "-I", "-c", "import time; time.sleep(30)"], options);
      return docker.run(args, args[0] === "start" ? { ...options, timeoutMs: 500 } : options);
    } };
    await assert.rejects(new DockerDocumentExtractor({ docker: timeoutDocker, image: config.image }).extract({
      bytes: Buffer.from("trusted timeout fixture"), displayName: "timeout.pdf", mediaType: mediaTypes.pdf,
    }), /^Error: attachment_document_extraction_failed$/u);
    assert.equal(requireProcess().timedOut, true);
    await removed(current());
    results.push({ scenario: "timeout-cleanup", passed: true });
    return { version: 1, evidenceSource: suppliedDocker ? "controlled_docker_port" : "docker",
      runtimeImage: config.image, testImage: config.testImage, scenarios: results, isolationInspected: true };
  } finally {
    const failures: unknown[] = [];
    for (const record of owned) {
      try {
        const id = await listed(record);
        if (id) assert.equal((await real.run(["rm", "--force", id], { timeoutMs: 10000, maxOutputBytes: 1000 })).exitCode, 0);
        await removed(record);
      } catch (error) {
        // Try the other owned containers even when one cleanup is unavailable.
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "document_smoke_cleanup_unconfirmed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runDocumentExtractorSmoke({ context: process.env.OMB_DOCUMENT_SMOKE_CONTEXT ?? "",
    image: process.env.OMB_DOCUMENT_SMOKE_IMAGE ?? "", testImage: process.env.OMB_DOCUMENT_SMOKE_TEST_IMAGE ?? "" })));
}
