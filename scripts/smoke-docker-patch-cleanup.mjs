import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

const context = process.env.OMB_PATCH_SMOKE_CONTEXT, image = process.env.OMB_PATCH_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context }), name = 'omb-patch-cleanup-' + randomUUID();
const temp = mkdtempSync(join(tmpdir(), 'omb-patch-smoke-')); let volumeCreated = false, id;
try {
  const found = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]); assert.equal(found.exitCode, 0); assert.equal(found.stdout.toString().trim(), image);
  const createdVolume = await docker.run(['volume', 'create', '--label', `com.openmausbot.patch-probe=${name}`, name]); assert.equal(createdVolume.exitCode, 0); volumeCreated = true;
  const volumeResult = await docker.run(['volume', 'inspect', name]); assert.equal(volumeResult.exitCode, 0);
  const volume = JSON.parse(volumeResult.stdout.toString())[0];
  assert.equal(volume.Name, name); assert.equal(volume.Labels['com.openmausbot.patch-probe'], name);
  const root = volume.Mountpoint; assert.equal(root, `/var/lib/docker/volumes/${name}/_data`);
  const bundle = join(temp, 'probe.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/patch-cleanup.smoke-probe.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm' });
  // Only this trusted, fixed smoke controller gets daemon access. Patch children
  // get two paths inside this disposable volume, no socket and no business data.
  const created = await docker.run(['create', '--name', name, '--label', `com.openmausbot.patch-probe=${name}`,
    '-i', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
    '--mount', `type=volume,src=${name},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
    '--env', `OMB_PATCH_SMOKE_ROOT=${root}`, '--env', `OMB_PATCH_SMOKE_IMAGE=${image}`, '--env', 'DOCKER_API_VERSION=1.44',
    '--entrypoint', 'node', image, '--input-type=module']);
  assert.equal(created.exitCode, 0); id = created.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/);
  const result = await docker.run(['start', '--attach', '--interactive', id], { input: readFileSync(bundle), timeoutMs: 60000, maxOutputBytes: 16000 });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const evidence = JSON.parse(result.stdout.toString()); assert.equal(evidence.cases.length, 4); assert.equal(evidence.failureWrites, 0);
  console.log(JSON.stringify({ ...evidence, image, disposableVolume: true }));
} finally {
  const found = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`]); assert.equal(found.exitCode, 0);
  if (found.stdout.toString().trim()) {
    const inspect = await docker.run(['inspect', id ?? name]); assert.equal(inspect.exitCode, 0);
    const owned = JSON.parse(inspect.stdout.toString())[0]; assert.equal(owned.Name, '/' + name); assert.equal(owned.Image, image);
    assert.equal(owned.Config.Labels['com.openmausbot.patch-probe'], name);
    assert.equal((await docker.run(['rm', '--force', owned.Id])).exitCode, 0);
  }
  if (volumeCreated) {
    const inspect = await docker.run(['volume', 'inspect', name]); assert.equal(inspect.exitCode, 0);
    const owned = JSON.parse(inspect.stdout.toString())[0]; assert.equal(owned.Name, name); assert.equal(owned.Labels['com.openmausbot.patch-probe'], name);
    // Refuses removal if an unconfirmed child still owns the volume path; no pruning.
    const containers = await docker.run(['ps', '-aq', '--filter', 'label=com.openmausbot.collaboration.managed=1']); assert.equal(containers.exitCode, 0);
    for (const child of containers.stdout.toString().trim().split(/\s+/).filter(Boolean)) {
      const result = await docker.run(['inspect', child]); assert.equal(result.exitCode, 0);
      assert.ok(!JSON.parse(result.stdout.toString())[0].Mounts.some(mount => mount.Source.startsWith(`/var/lib/docker/volumes/${name}/_data/`)), 'unconfirmed_child_retains_probe_volume');
    }
    assert.equal((await docker.run(['volume', 'rm', name])).exitCode, 0);
  }
  rmSync(temp, { recursive: true, force: true });
}
