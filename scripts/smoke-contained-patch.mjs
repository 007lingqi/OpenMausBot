import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

const context = process.env.OMB_CONTAINED_SMOKE_CONTEXT, base = process.env.OMB_CONTAINED_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(base ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context }), name = 'omb-contained-' + randomUUID(), temp = mkdtempSync(join(tmpdir(), name));
let volumeCreated = false, id, image;
try {
  const found = await docker.run(['image', 'inspect', '--format', '{{.Id}}', base]); assert.equal(found.exitCode, 0); assert.equal(found.stdout.toString().trim(), base);
  for (const [source, target] of [['contained-patch.smoke-worker.ts', 'worker.cjs'], ['contained-patch.smoke-probe.ts', 'probe.cjs']]) {
    await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/' + source, import.meta.url))], outfile: join(temp, target),
      bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
  }
  writeFileSync(join(temp, 'Dockerfile'), `FROM ${base}\nCOPY worker.cjs /opt/openmausbot/contained-patch-worker.js\n`);
  const archive = execFileSync('tar', ['--no-xattrs', '-C', temp, '-cf', '-', 'Dockerfile', 'worker.cjs'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 32 * 1024 * 1024 });
  const built = await docker.run(['build', '--network', 'none', '--pull=false', '-t', name, '-'], { input: archive, timeoutMs: 60000, maxOutputBytes: 8000 });
  assert.equal(built.exitCode, 0, built.stderr.toString());
  image = (await docker.run(['image', 'inspect', '--format', '{{.Id}}', name])).stdout.toString().trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const createdVolume = await docker.run(['volume', 'create', '--label', `com.openmausbot.contained-probe=${name}`, name]); assert.equal(createdVolume.exitCode, 0); volumeCreated = true;
  const volume = JSON.parse((await docker.run(['volume', 'inspect', name])).stdout.toString())[0];
  assert.equal(volume.Labels['com.openmausbot.contained-probe'], name); assert.equal(volume.Mountpoint, `/var/lib/docker/volumes/${name}/_data`);
  const root = volume.Mountpoint;
  // Only the trusted synthetic controller sees Docker. Task containers get
  // paths inside this disposable volume, never this socket or business data.
  const created = await docker.run(['create', '--name', name, '--label', `com.openmausbot.contained-probe=${name}`, '-i',
    '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '64', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
    '--mount', `type=volume,src=${name},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
    '--env', `OMB_CONTAINED_SMOKE_ROOT=${root}`, '--env', `OMB_CONTAINED_SMOKE_IMAGE=${image}`, '--env', 'DOCKER_API_VERSION=1.44',
    '--entrypoint', 'node', image, '--input-type=commonjs']);
  assert.equal(created.exitCode, 0); id = created.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/);
  const result = await docker.run(['start', '--attach', '--interactive', id], { input: readFileSync(join(temp, 'probe.cjs')), timeoutMs: 90000, maxOutputBytes: 12000 });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const evidence = JSON.parse(result.stdout.toString()); assert.equal(evidence.cases.length, 5); assert.equal(evidence.failureWrites, 0);
  console.log(JSON.stringify({ ...evidence, base, testedImage: image, syntheticProvider: true, disposableVolume: true }));
} finally {
  const found = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`]); assert.equal(found.exitCode, 0);
  if (found.stdout.toString().trim()) {
    const owned = JSON.parse((await docker.run(['inspect', id ?? name])).stdout.toString())[0];
    assert.equal(owned.Name, '/' + name); assert.equal(owned.Image, image); assert.equal(owned.Config.Labels['com.openmausbot.contained-probe'], name);
    assert.equal((await docker.run(['rm', '--force', owned.Id])).exitCode, 0);
  }
  if (volumeCreated) {
    const owned = JSON.parse((await docker.run(['volume', 'inspect', name])).stdout.toString())[0];
    assert.equal(owned.Name, name); assert.equal(owned.Labels['com.openmausbot.contained-probe'], name);
    const children = await docker.run(['ps', '-aq', '--filter', 'label=com.openmausbot.collaboration.managed=1']); assert.equal(children.exitCode, 0);
    for (const child of children.stdout.toString().trim().split(/\s+/).filter(Boolean)) {
      const inspected = JSON.parse((await docker.run(['inspect', child])).stdout.toString())[0];
      assert.ok(!inspected.Mounts.some(mount => mount.Source?.startsWith(`/var/lib/docker/volumes/${name}/_data/`)), 'unconfirmed_child_retains_volume');
    }
    assert.equal((await docker.run(['volume', 'rm', name])).exitCode, 0);
  }
  if (image) {
    assert.equal((await docker.run(['image', 'inspect', '--format', '{{.Id}}', name])).stdout.toString().trim(), image);
    assert.equal((await docker.run(['image', 'rm', name])).exitCode, 0);
  }
  rmSync(temp, { recursive: true, force: true });
}
