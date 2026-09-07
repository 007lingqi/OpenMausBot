import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

if (process.env.OMB_CONTAINED_REAL_OPT_IN !== '1') throw Error('real_model_probe_opt_in_required');
const base = process.env.OMB_CONTAINED_REAL_IMAGE;
assert.match(base ?? '', /^sha256:[a-f0-9]{64}$/);
const docker = new NodeDockerCommandPort({ context: 'colima-openmausbot-pilot' }), name = 'omb-contained-real-worker-v1';
// Fixed one-shot identity, no fresh ledger/root on repeat invocation. Retain all
// evidence and containers (stopped) for recovery; never touch old engine tasks.
const existing = await docker.run(['volume', 'ls', '--format', '{{.Name}}']); assert.equal(existing.exitCode, 0);
if (existing.stdout.toString().split('\n').includes(name)) throw Error('existing_probe_requires_evidence_review_not_retry');
const pilotResult = await docker.run(['inspect', 'openmausbot-collaboration-pilot']); assert.equal(pilotResult.exitCode, 0);
const pilot = JSON.parse(pilotResult.stdout.toString())[0];
const config = Object.fromEntries(pilot.Config.Env.filter(v => /^OMB_OPENCODEX_RELAY_(UID|GID)=/.test(v)).map(v => v.split('=')));
const channel = pilot.Mounts.find(m => m.Destination === '/run/omb-channel'); assert.equal(channel.Source, '/tmp/omb-model-channel-18101');
const uid = config.OMB_OPENCODEX_RELAY_UID, gid = config.OMB_OPENCODEX_RELAY_GID;
for (const value of [uid, gid]) assert.match(value ?? '', /^[1-9][0-9]*$/);
const project = fileURLToPath(new URL('../', import.meta.url)), temp = mkdtempSync(join(tmpdir(), 'omb-contained-real-build-'));
copyFileSync(join(project, 'dist-server/collaboration/operations/contained-patch-worker.js'), join(temp, 'worker.js'));
copyFileSync(join(project, 'dist-server/collaboration/operations/opencodex-model-channel.js'), join(temp, 'channel.js'));
await build({ entryPoints: [join(project, 'server/collaboration/operations/contained-opencodex.smoke-probe.ts')], outfile: join(temp, 'probe.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
writeFileSync(join(temp, 'Dockerfile'), `FROM ${base}\nCOPY worker.js /opt/openmausbot/contained-patch-worker.js\nCOPY channel.js /opt/openmausbot/collaboration/operations/opencodex-model-channel.js\n`);
const archive = execFileSync('tar', ['--no-xattrs', '-C', temp, '-cf', '-', 'Dockerfile', 'worker.js', 'channel.js'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 32 * 1024 * 1024 });
const built = await docker.run(['build', '--network', 'none', '--pull=false', '-t', name, '-'], { input: archive, timeoutMs: 60000, maxOutputBytes: 8000 });
assert.equal(built.exitCode, 0, built.stderr.toString());
const image = (await docker.run(['image', 'inspect', '--format', '{{.Id}}', name])).stdout.toString().trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.equal((await docker.run(['volume', 'create', '--label', `com.openmausbot.contained-real-probe=${name}`, name])).exitCode, 0);
const volume = JSON.parse((await docker.run(['volume', 'inspect', name])).stdout.toString())[0];
assert.equal(volume.Labels['com.openmausbot.contained-real-probe'], name); assert.equal(volume.Mountpoint, `/var/lib/docker/volumes/${name}/_data`);
const root = volume.Mountpoint;
writeFileSync(join(temp, 'build-evidence.json'), JSON.stringify({ image, base, workerHash: createHash('sha256').update(readFileSync(join(temp, 'worker.js'))).digest('hex'), root }), { flag: 'wx', mode: 0o600 });
const created = await docker.run(['create', '--name', name, '--label', `com.openmausbot.contained-real-probe=${name}`, '-i',
  '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--pids-limit', '64', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
  '--mount', `type=volume,src=${name},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
  '--mount', `type=bind,src=${channel.Source},dst=${channel.Source},readonly`,
  '--env', `OMB_CONTAINED_REAL_ROOT=${root}`, '--env', `OMB_CONTAINED_REAL_IMAGE=${image}`,
  '--env', `OMB_CONTAINED_REAL_RELAY_UID=${uid}`, '--env', `OMB_CONTAINED_REAL_RELAY_GID=${gid}`, '--env', 'DOCKER_API_VERSION=1.44',
  '--entrypoint', 'node', image, '--input-type=commonjs']);
assert.equal(created.exitCode, 0); const id = created.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/);
console.log(JSON.stringify({ started: true, id, image, evidenceRoot: root, hostBuildEvidence: temp, model: 'gpt-6-astra', reasoningEffort: 'medium' }));
const executed = await docker.run(['start', '--attach', '--interactive', id], { input: readFileSync(join(temp, 'probe.cjs')), timeoutMs: 240000, maxOutputBytes: 16000 });
const state = JSON.parse((await docker.run(['inspect', id])).stdout.toString())[0];
assert.equal(state.State.Status, 'exited'); assert.equal(state.State.Pid, 0);
assert.equal(executed.exitCode, 0, executed.stderr.toString());
console.log(executed.stdout.toString().trim());
