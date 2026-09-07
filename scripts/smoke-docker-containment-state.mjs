import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DockerCliContainmentSupervisor, NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

// Explicit, cached-only Docker target. No model, credentials, business volume,
// network, production container or mutable image tag is used by this probe.
const context = process.env.OMB_CONTAINMENT_SMOKE_CONTEXT;
const image = process.env.OMB_CONTAINMENT_SMOKE_IMAGE;
if (!context || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('explicit_context_and_fixed_cached_image_required');
const docker = new NodeDockerCommandPort({ context });
const name = 'omb-containment-state-' + randomUUID();
const binding = { runId: name, canonicalWorktreePath: '/tmp/probe', instanceOwner: name, instanceFence: 1, nonce: randomBytes(32).toString('hex') };
const configuration = { docker, hostGeneration: name, verifierKey: randomBytes(32) };
const supervisor = new DockerCliContainmentSupervisor(configuration);
let id;
try {
  const found = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]);
  assert.equal(found.exitCode, 0); assert.equal(found.stdout.toString().trim(), image);
  const created = await docker.run(['create', '--name', name, '--label', `com.openmausbot.state-probe=${name}`,
    ...supervisor.labels(binding).flatMap(label => ['--label', label]),
    '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--restart', 'no', '--pids-limit', '32', '--memory', '128m', '--cpus', '1',
    '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(created.exitCode, 0); id = created.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/);
  const inspected = await docker.run(['inspect', id]); assert.equal(inspected.exitCode, 0);
  const initial = JSON.parse(inspected.stdout.toString())[0];
  assert.equal(initial.State.Status, 'created'); assert.equal(initial.HostConfig.NetworkMode, 'none');
  assert.equal(initial.HostConfig.Privileged, false); assert.equal(initial.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(initial.HostConfig.CapDrop, ['ALL']); assert.equal(initial.Config.User, '10001:10001');
  assert.equal(initial.Mounts.length, 0);
  await assert.rejects(supervisor.issueProof(id, binding));
  assert.equal((await supervisor.terminateBoundContainer(id, binding)).state, 'empty');
  const started = await docker.run(['start', id]); assert.equal(started.exitCode, 0);
  const proof = await supervisor.issueProof(id, binding);
  assert.equal((await supervisor.verifyProof(proof, binding)).verified, true);
  assert.equal((await supervisor.inspect(proof.identity)).state, 'active');
  assert.equal((await supervisor.terminateAndWaitEmpty(proof.identity)).state, 'empty');
  const recreated = new DockerCliContainmentSupervisor(configuration);
  assert.equal((await recreated.verifyProof(proof, binding)).verified, true);
  assert.equal((await recreated.inspect(proof.identity)).state, 'empty');
  const final = JSON.parse((await docker.run(['inspect', id])).stdout.toString())[0];
  assert.equal(final.State.Pid, 0); assert.equal(final.State.Status, 'exited');
  console.log(JSON.stringify({ image, createdIsNotAProof: true, runningProofVerified: true, stoppedConfirmed: true,
    reconstructedAuthorityVerified: true, network: 'none', businessMounts: 0, modelCalls: 0 }));
} finally {
  const listed = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`]); assert.equal(listed.exitCode, 0);
  if (listed.stdout.toString().trim()) {
    const inspected = await docker.run(['inspect', id ?? name]); assert.equal(inspected.exitCode, 0);
    const owned = JSON.parse(inspected.stdout.toString())[0];
    assert.equal(owned.Name, '/' + name); assert.equal(owned.Image, image);
    assert.equal(owned.Config.Labels['com.openmausbot.state-probe'], name);
    assert.equal((await docker.run(['rm', '--force', owned.Id])).exitCode, 0);
  }
}
