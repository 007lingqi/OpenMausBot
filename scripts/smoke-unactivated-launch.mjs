import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';
const context = process.env.OMB_CONTAINMENT_SMOKE_CONTEXT, base = process.env.OMB_CONTAINMENT_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(base ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context }), name = 'omb-abort-' + randomUUID(), temp = mkdtempSync(join(tmpdir(), name));
const key = randomBytes(32).toString('hex'); let image, hasVolume = false;
try {
  const cached = await docker.run(['image', 'inspect', '--format', '{{.Id}}', base]); assert.equal(cached.exitCode, 0); assert.equal(cached.stdout.toString().trim(), base);
  for (const [source, target] of [['contained-patch.smoke-worker.ts', 'worker.cjs'], ['unactivated-launch.smoke-probe.ts', 'probe.cjs']])
    await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/' + source, import.meta.url))], outfile: join(temp, target), bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
  writeFileSync(join(temp, 'Dockerfile'), `FROM ${base}\nCOPY worker.cjs /opt/openmausbot/contained-patch-worker.js\nCOPY probe.cjs /opt/openmausbot/abort-probe.cjs\n`);
  const archive = execFileSync('tar', ['--no-xattrs', '-C', temp, '-cf', '-', 'Dockerfile', 'worker.cjs', 'probe.cjs'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 32 * 1024 * 1024 });
  const built = await docker.run(['build', '--network', 'none', '--pull=false', '-t', name, '-'], { input: archive, timeoutMs: 60000 }); assert.equal(built.exitCode, 0, built.stderr.toString());
  image = (await docker.run(['image', 'inspect', '--format', '{{.Id}}', name])).stdout.toString().trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await docker.run(['volume', 'create', '--label', `com.openmausbot.abort-probe=${name}`, name])).exitCode, 0); hasVolume = true;
  const root = `/var/lib/docker/volumes/${name}/_data`;
  async function create(suffix, mode) {
    const made = await docker.run(['create', '--name', name + suffix, '--label', `com.openmausbot.abort-probe=${name}`,
      '--network', 'none', '--read-only', '--restart', 'no', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m',
      '--mount', `type=volume,src=${name},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--env', 'DOCKER_API_VERSION=1.44', '--env', `OMB_ABORT_ROOT=${root}`, '--env', `OMB_ABORT_IMAGE=${image}`, '--env', `OMB_ABORT_NAME=${name}`,
      '--env', `OMB_ABORT_KEY=${key}`, '--env', `OMB_ABORT_MODE=${mode}`, '--entrypoint', 'node', image, '/opt/openmausbot/abort-probe.cjs']);
    assert.equal(made.exitCode, 0, made.stderr.toString()); const id = made.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/); return id;
  }
  const original = await create('', 'create'); assert.equal((await docker.run(['start', original])).exitCode, 0);
  let ready = false;
  for (let i = 0; i < 70; i++) { const logs = await docker.run(['logs', original]); if (logs.stdout.toString().includes('ready-for-interruption')) { ready = true; break; } await delay(100); }
  assert.ok(ready, (await docker.run(['logs', original])).stderr.toString());
  assert.equal((await docker.run(['kill', original])).exitCode, 0); assert.equal((await docker.run(['wait', original])).exitCode, 0);
  const observer = await create('-observer', 'observe'); const result = await docker.run(['start', '--attach', observer], { timeoutMs: 50000, maxOutputBytes: 8000 });
  assert.equal(result.exitCode, 0, result.stderr.toString()); const evidence = JSON.parse(result.stdout.toString());
  assert.equal(evidence.cases.length, 2); assert.equal(evidence.lateStartDenied, true);
  console.log(JSON.stringify({ ...evidence, syntheticProvider: true, image, base }));
} finally {
  const found = await docker.run(['ps', '-aq', '--no-trunc', '--filter', `label=com.openmausbot.abort-probe=${name}`]); assert.equal(found.exitCode, 0);
  for (const id of found.stdout.toString().trim().split(/\s+/).filter(Boolean)) {
    const actual = JSON.parse((await docker.run(['inspect', id])).stdout.toString())[0]; assert.equal(actual.Id, id); assert.equal(actual.Image, image);
    assert.equal(actual.Config.Labels['com.openmausbot.abort-probe'], name); assert.equal((await docker.run(['rm', '--force', id])).exitCode, 0);
  }
  if (hasVolume) { const actual = JSON.parse((await docker.run(['volume', 'inspect', name])).stdout.toString())[0]; assert.equal(actual.Labels['com.openmausbot.abort-probe'], name); assert.equal((await docker.run(['volume', 'rm', name])).exitCode, 0); }
  if (image) { assert.equal((await docker.run(['image', 'inspect', '--format', '{{.Id}}', name])).stdout.toString().trim(), image); assert.equal((await docker.run(['image', 'rm', name])).exitCode, 0); }
  rmSync(temp, { recursive: true, force: true });
}
