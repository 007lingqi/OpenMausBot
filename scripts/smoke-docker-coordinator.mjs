import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';
const context = process.env.OMB_CONTAINMENT_SMOKE_CONTEXT, image = process.env.OMB_CONTAINMENT_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context }), name = 'omb-coordinator-' + randomUUID(), volume = name, temp = mkdtempSync(join(tmpdir(), name));
const owned = [], key = randomBytes(32).toString('hex'); let hasVolume = false;
try {
  const cached = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]); assert.equal(cached.exitCode, 0); assert.equal(cached.stdout.toString().trim(), image);
  await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/docker-coordinator.smoke-worker.ts', import.meta.url))], outfile: join(temp, 'worker.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
  assert.equal((await docker.run(['volume', 'create', '--label', `com.openmausbot.coordinator-probe=${name}`, volume])).exitCode, 0); hasVolume = true;
  async function create(suffix, mode) {
    const made = await docker.run(['create', '--name', name + suffix, '--label', `com.openmausbot.coordinator-probe=${name}`, '--network', 'none', '--read-only', '--restart', 'no',
      '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CAP_CHOWN', '--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_SETGID', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
      '--mount', `type=volume,src=${volume},dst=/probe`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--env', 'DOCKER_API_VERSION=1.44', '--env', `OMB_COORDINATOR_SMOKE_NAME=${name}`, '--env', `OMB_COORDINATOR_SMOKE_IMAGE=${image}`,
      '--env', `OMB_COORDINATOR_SMOKE_KEY=${key}`, '--env', `OMB_COORDINATOR_SMOKE_MODE=${mode}`, '--entrypoint', 'node', image, '/probe/worker.cjs']);
    assert.equal(made.exitCode, 0); const id = made.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/); owned.push(id); return id;
  }
  const original = await create('', 'write'); assert.equal((await docker.run(['cp', join(temp, 'worker.cjs'), original + ':/probe/worker.cjs'])).exitCode, 0);
  assert.equal((await docker.run(['start', original])).exitCode, 0);
  let ready = false;
  for (let n = 0; n < 60; n++) { const log = await docker.run(['logs', original]); if (log.stdout.toString().includes('native-git-running')) { ready = true; break; } await delay(100); }
  if (!ready) { const logs = await docker.run(['logs', original]); throw Error('synthetic_worker_failed: ' + logs.stderr.toString().slice(-1000)); }
  await delay(1100); // Also let the synthetic original lease expire, not the process.
  assert.equal((await docker.run(['kill', original])).exitCode, 0); assert.equal((await docker.run(['wait', original])).exitCode, 0);
  const observer = await create('-observer', 'observe');
  const observed = await docker.run(['start', '--attach', observer], { timeoutMs: 30000, maxOutputBytes: 4000 });
  assert.equal(observed.exitCode, 0, observed.stderr.toString()); const evidence = JSON.parse(observed.stdout.toString());
  assert.equal(evidence.nativeGitStable, true); assert.equal(evidence.recoveredWithoutInventedFinalization, true);
  assert.equal((await docker.run(['start', original])).exitCode, 0);
  let restart;
  for (let n = 0; n < 50; n++) { const read = await docker.run(['exec', original, '/bin/cat', '/probe/restart.json']); if (read.exitCode === 0) { restart = JSON.parse(read.stdout.toString()); break; } await delay(100); }
  assert.equal(restart?.oldStoppedWhileNewActive, true);
  console.log(JSON.stringify({ ...evidence, ...restart, detachedNativeWriter: true, syntheticLedger: true, image }));
} finally {
  for (const id of owned.reverse()) {
    const result = await docker.run(['inspect', id]); assert.equal(result.exitCode, 0); const actual = JSON.parse(result.stdout.toString())[0];
    assert.equal(actual.Id, id); assert.equal(actual.Image, image); assert.equal(actual.Config.Labels['com.openmausbot.coordinator-probe'], name);
    assert.equal((await docker.run(['rm', '--force', id])).exitCode, 0);
  }
  if (hasVolume) { const actual = JSON.parse((await docker.run(['volume', 'inspect', volume])).stdout.toString())[0]; assert.equal(actual.Labels['com.openmausbot.coordinator-probe'], name); assert.equal((await docker.run(['volume', 'rm', volume])).exitCode, 0); }
  rmSync(temp, { recursive: true, force: true });
}
