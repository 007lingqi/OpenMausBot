import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

const context = process.env.OMB_READ_VIEW_SMOKE_CONTEXT, image = process.env.OMB_READ_VIEW_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context }), name = 'omb-provider-view-' + randomUUID(), root = mkdtempSync(join(tmpdir(), 'omb-view-probe-'));
let id;
try {
  const found = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]); assert.equal(found.exitCode, 0); assert.equal(found.stdout.toString().trim(), image);
  const bundle = join(root, 'probe.cjs'); await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/provider-read-view.smoke-probe.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs' });
  const created = await docker.run(['create', '--name', name, '--label', `com.openmausbot.read-view-probe=${name}`,
    '-i', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--entrypoint', 'node', image, '--input-type=commonjs']);
  assert.equal(created.exitCode, 0); id = created.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/);
  const before = JSON.parse((await docker.run(['inspect', id])).stdout.toString())[0];
  assert.equal(before.Image, image); assert.equal(before.Mounts.length, 0); assert.equal(before.HostConfig.NetworkMode, 'none');
  assert.equal(before.HostConfig.Privileged, false); assert.equal(before.HostConfig.ReadonlyRootfs, true);
  const result = await docker.run(['start', '--attach', '--interactive', id], { input: readFileSync(bundle), timeoutMs: 30000, maxOutputBytes: 12000 });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const evidence = JSON.parse(result.stdout.toString()); assert.equal(evidence.providerUid, 10001); assert.equal(evidence.provenanceStillCurrent, true);
  console.log(JSON.stringify({ ...evidence, image, isolatedLinuxProbe: true }));
} finally {
  const found = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`]); assert.equal(found.exitCode, 0);
  if (found.stdout.toString().trim()) {
    const inspect = await docker.run(['inspect', id ?? name]); assert.equal(inspect.exitCode, 0); const owned = JSON.parse(inspect.stdout.toString())[0];
    assert.equal(owned.Name, '/' + name); assert.equal(owned.Image, image); assert.equal(owned.Config.Labels['com.openmausbot.read-view-probe'], name);
    assert.equal((await docker.run(['rm', '--force', owned.Id])).exitCode, 0);
  }
  rmSync(root, { recursive: true, force: true });
}
