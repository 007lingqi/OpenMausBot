import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerCliContainmentSupervisor, NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';
import { readDockerLaunch, writeDockerLaunch } from '../server/collaboration/operations/docker-launch.ts';

// Synthetic, no business mounts, models or group messages. The only killed
// process/container belongs to this probe. Never select the default context.
const context = process.env.OMB_CONTAINMENT_SMOKE_CONTEXT, image = process.env.OMB_CONTAINMENT_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context });
if (process.argv.includes('--create-child')) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input), supervisor = new DockerCliContainmentSupervisor({ docker, hostGeneration: config.generation, verifierKey: Buffer.from(config.key, 'hex') });
  const launch = supervisor.prepareLaunch({ name: config.name, image, binding: config.binding });
  writeDockerLaunch(config.directory, launch);
  const made = await docker.run(['create', '--name', config.name, '--label', `com.openmausbot.launch-probe=${config.name}`,
    ...supervisor.launchLabels(launch).flatMap(label => ['--label', label]), '--network', 'none', '--read-only', '--restart', 'no',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '10001:10001', '--pids-limit', '32', '--memory', '128m', '--cpus', '1',
    '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(made.exitCode, 0);
  // Deliberately discard the create ID. Parent kills us before any receipt or start.
  process.stdout.write('create-reply-discarded\n'); setInterval(() => {}, 1000);
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omb-launch-recovery-'))), generation = randomUUID(), key = randomBytes(32);
  const binding = { runId: generation, canonicalWorktreePath: '/tmp/synthetic-candidate', instanceOwner: 'old-' + generation, instanceFence: 1, nonce: randomBytes(32).toString('hex') };
  const name = 'omb-task-' + createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 48), directory = join(root, name);
  mkdirSync(directory, { mode: 0o711 }); chmodSync(directory, 0o711);
  const options = { docker, hostGeneration: generation, verifierKey: key };
  let child, containerId;
  try {
    const cached = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]); assert.equal(cached.exitCode, 0); assert.equal(cached.stdout.toString().trim(), image);
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--create-child'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const ready = new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(Error('child_creation_timeout')), 35000);
      const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      child.once('error', finish); child.once('close', () => finish(Error('child_exited_before_fault_injection')));
      child.stdout.on('data', bytes => { output += bytes; if (output === 'create-reply-discarded\n') finish(); });
      child.stderr.resume();
    });
    child.stdin.end(JSON.stringify({ name, binding, generation, key: key.toString('hex'), directory }));
    await ready;
    const exited = once(child, 'close'); child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL');
    const journalBefore = readFileSync(join(directory, 'launch.json'));
    const persisted = readDockerLaunch(directory); assert.equal(persisted.containerId, undefined);
    const recoveredAuthority = new DockerCliContainmentSupervisor(options);
    const created = await recoveredAuthority.reconcileLaunch(persisted.launch, binding);
    assert.equal(created.state, 'observed'); assert.equal(created.status, 'created'); containerId = created.containerId;
    await assert.rejects(recoveredAuthority.issueProof(containerId, binding));
    const actual = JSON.parse((await docker.run(['inspect', containerId])).stdout.toString())[0];
    assert.equal(actual.Mounts.length, 0); assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.equal(actual.State.Pid, 0);
    assert.equal((await docker.run(['start', containerId])).exitCode, 0);
    assert.equal((await recoveredAuthority.reconcileLaunch(persisted.launch, binding)).status, 'active');
    assert.equal((await docker.run(['kill', containerId])).exitCode, 0);
    assert.equal((await docker.run(['wait', containerId])).exitCode, 0);
    assert.equal((await recoveredAuthority.reconcileLaunch(persisted.launch, binding)).status, 'exited');
    assert.equal((await new DockerCliContainmentSupervisor({ ...options, hostGeneration: 'different-boot' }).reconcileLaunch(persisted.launch, binding)).state, 'unknown');
    assert.deepEqual(readFileSync(join(directory, 'launch.json')), journalBefore);
    assert.equal((await docker.run(['rm', containerId])).exitCode, 0);
    assert.equal((await recoveredAuthority.reconcileLaunch(persisted.launch, binding)).state, 'unknown');
    console.log(JSON.stringify({ controllerKilledBeforeReceipt: true, durableIdentityRecovered: true, createdNotExecutionProof: true,
      activeAndExitedObserved: true, missingAndOldBootRemainUnknown: true, journalUnchanged: true, lifecycleSettled: false, modelCalls: 0, realGroupMessages: 0, image }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGKILL'); await exited; }
    const found = await docker.run(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`]); assert.equal(found.exitCode, 0);
    if (found.stdout.toString().trim()) {
      const actual = JSON.parse((await docker.run(['inspect', name])).stdout.toString())[0];
      assert.equal(actual.Name, '/' + name); assert.equal(actual.Image, image); assert.equal(actual.Config.Labels['com.openmausbot.launch-probe'], name);
      assert.equal((await docker.run(['rm', '--force', actual.Id])).exitCode, 0);
    }
    rmSync(root, { recursive: true, force: true });
  }
}
