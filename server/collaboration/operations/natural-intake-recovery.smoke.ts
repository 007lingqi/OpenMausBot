/** Explicit cached-image Linux probe. Does not connect to DingTalk, models, repositories or user data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { NodeDockerCommandPort } from "./docker-containment.ts";
import { assertDocumentContainerIsolation } from "./document-extractor.smoke.ts";

const context = process.env.OMB_INTAKE_SMOKE_CONTEXT;
const image = process.env.OMB_INTAKE_SMOKE_IMAGE;
if (!context || !image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("explicit_context_and_fixed_cached_image_required");
const docker = new NodeDockerCommandPort({ context });
const root = mkdtempSync(join(tmpdir(), "omb-intake-bundle-"));
const name = `omb-intake-smoke-${randomUUID()}`;
let created = false;
try {
  const inspected = await docker.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 5000 });
  assert.equal(inspected.exitCode, 0); assert.equal(inspected.stdout.toString().trim(), image);
  const bundle = join(root, "probe.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./natural-intake-recovery.smoke-probe.ts", import.meta.url))], outfile: bundle,
    bundle: true, platform: "node", target: "node24", format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  // Record the owned name before create to cover lost create acknowledgements.
  created = true;
  const bootstrap = "import {writeFileSync} from 'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);writeFileSync('/tmp/probe.mjs',Buffer.concat(chunks),{mode:0o400});await import('file:///tmp/probe.mjs');";
  const result = await docker.run(["create", "--name", name, "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--log-driver", "none", "--user", "65534:65534", "--memory", "384m",
    "--memory-swap", "384m", "--cpus", "1", "--pids-limit", "32", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
    "--entrypoint", "node", image, "--input-type=module", "--eval", bootstrap], { timeoutMs: 15000 });
  assert.equal(result.exitCode, 0);
  const id = result.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/u);
  const isolation = await docker.run(["inspect", id], { timeoutMs: 5000 });
  assert.equal(isolation.exitCode, 0);
  assertDocumentContainerIsolation(JSON.parse(isolation.stdout.toString())[0], { id, image });
  const run = await docker.run(["start", "--attach", "--interactive", id], { input: readFileSync(bundle), timeoutMs: 40000, maxOutputBytes: 8000 });
  assert.equal(run.exitCode, 0, `natural_intake_probe_failed:${run.stderr.toString()}`);
  const state = await docker.run(["inspect", "--format", "{{json .State}}", id], { timeoutMs: 5000 });
  assert.equal(state.exitCode, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(state.stdout.toString())).filter(([key]) => ["Running", "ExitCode", "OOMKilled", "Error"].includes(key))),
    { Running: false, OOMKilled: false, ExitCode: 0, Error: "" });
  const evidence = JSON.parse(run.stdout.toString());
  assert.deepEqual(evidence, { evidenceSource: "linux_process_sqlite", interpretation: "controlled", messages: 15,
    killedAfterDurableWrite: true, allRecovered: true, replayDeduplicated: true, authorityUnchanged: true });
  console.log(JSON.stringify({ ...evidence, image, isolationInspected: true }));
} finally {
  if (created) {
    const listed = await docker.run(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { timeoutMs: 5000 });
    assert.equal(listed.exitCode, 0);
    if (listed.stdout.toString().trim()) assert.equal((await docker.run(["rm", "--force", name], { timeoutMs: 10000 })).exitCode, 0);
    const after = await docker.run(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { timeoutMs: 5000 });
    assert.equal(after.exitCode, 0); assert.equal(after.stdout.toString().trim(), "");
  }
  rmSync(root, { recursive: true, force: true });
}
