import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Explicit dedicated context and already present image only. No live service/config/credential mounts.
const [context, image, mode, ...extra] = process.argv.slice(2);
assert.equal(context, 'colima-openmausbot-pilot'); assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
assert.ok(mode === undefined || mode === '--packaged'); assert.equal(extra.length, 0);
const packaged = mode === '--packaged';
const root = dirname(dirname(fileURLToPath(import.meta.url))), staging = mkdtempSync(join(root, '.document-docker-smoke-'));
const name = `omb-document-relay-fixture-${randomUUID()}`;
const docker = args => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 45000, maxBuffer: 65536 });
let id;
try {
  // Packaged mode intentionally does not mount a replacement relay. The file
  // must exist and work at the actual Docker entrypoint's path inside the image.
  await build({ entryPoints: { probe: join(root, 'server/collaboration/operations/online-document-docker.smoke-probe.ts'),
    ...(!packaged ? { 'online-document-relay': join(root, 'server/collaboration/operations/online-document-relay.ts') } : {}) }, outdir: staging,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', outExtension: { '.js': '.mjs' } });
  chmodSync(staging, 0o755); // Only public synthetic fixture code is staged here.
  id = docker(['create', '--pull', 'never', '--name', name, '--label', 'omb.fixture=document-relay', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777',
    '--mount', `type=bind,source=${staging},target=/fixture,readonly`, '--user', '0:0', '--entrypoint', '/usr/local/bin/node', image, '/fixture/probe.mjs',
    ...(packaged ? ['packaged'] : [])]).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  const output = docker(['start', '-a', id]);
  const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
  assert.equal(state.Running, false); assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
  assert.ok(output.includes('docker_document_relay_fixture_passed'));
  console.log(JSON.stringify({ result: 'passed', context, container: name, id, fixtureOnly: true,
    relayArtifact: packaged ? 'image' : 'fixture', rootDirectSocket: 'EACCES', relayUid: 501, relayGid: 1000, realDwsReads: 0 }));
} finally {
  // Retain this newly created stopped container for evidence. Never remove historical containers.
  if (id && /^[a-f0-9]{64}$/.test(id)) {
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
    if (state.Running) docker(['stop', '--time', '5', id]);
  }
  rmSync(staging, { recursive: true, force: true });
}
