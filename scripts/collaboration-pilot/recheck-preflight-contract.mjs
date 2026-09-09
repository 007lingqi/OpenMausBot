export const PROBE_LABEL = 'com.openmausbot.recheck-preflight';
export const CHILD_LABEL = 'com.openmausbot.recheck-preflight-child';

export function recheckConfiguration(env) {
  assert.match(env.OMB_RECHECK_PREFLIGHT_CONTEXT ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u, 'explicit_context_required');
  assert.match(env.OMB_RECHECK_PREFLIGHT_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/u, 'fixed_cached_image_required');
  return { context: env.OMB_RECHECK_PREFLIGHT_CONTEXT, image: env.OMB_RECHECK_PREFLIGHT_IMAGE };
}

export function assertRecheckEvidence(value) {
  assert.equal(value.status, 'passed');
  assert.equal(value.probe, 'candidate-recheck');
  assert.equal(value.mapping, 'trusted_synthetic_fixture');
  for (const key of ['syntheticFixture', 'technicalGatePassed', 'originalEvidenceUnchanged', 'originalRepositoryUnchanged',
    'candidateUnchanged', 'ignoredOutputIsolated', 'distinctWorktrees', 'gitAndDirectoryPermissionsChecked']) assert.equal(value[key], true, key);
  for (const key of ['realModel', 'businessAcceptance']) assert.equal(value[key], false, key);
  for (const key of ['modelCalls', 'realGroupMessages']) assert.equal(value[key], 0, key);
  for (const key of ['verificationCommands', 'verificationProofs', 'settlementEmptyEntries', 'mappingCalls', 'ownedContainersStopped']) assert.equal(value[key], 2, key);
  assert.equal(value.stages.length, 2);
  assert.deepEqual(value.stages.map(stage => stage.phase), ['self', 'verifier']);
  assert.equal(new Set(value.stages.map(stage => stage.id)).size, 2);
  assert.equal(new Set(value.stages.map(stage => stage.name)).size, 2);
  for (const stage of value.stages) { assert.match(stage.id, /^[a-f0-9]{64}$/u); assert.equal(stage.exitCode, 0); }
}

export function isInside(root, path) {
  return path !== undefined && posix.normalize(path) === path && path.startsWith(root + '/');
}

function assertIsolation(actual, image) {
  assert.match(actual.Id, /^[a-f0-9]{64}$/u);
  assert.equal(actual.Image, image);
  assert.equal(actual.Config.User, '0:0');
  assert.equal(actual.HostConfig.NetworkMode, 'none');
  assert.equal(actual.HostConfig.ReadonlyRootfs, true);
  assert.equal(actual.HostConfig.Privileged, false);
  assert.equal(actual.HostConfig.RestartPolicy.Name, 'no');
  assert.equal(actual.HostConfig.PidMode, '');
  assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']);
  assert.ok(actual.HostConfig.CapAdd === null || actual.HostConfig.CapAdd.length === 0);
  assert.ok(actual.HostConfig.SecurityOpt?.some(value => ['no-new-privileges:true', 'no-new-privileges'].includes(value)));
}

export function assertOwnedController(actual, expected) {
  assertIsolation(actual, expected.image);
  assert.equal(actual.Id, expected.id);
  assert.equal(actual.Name, '/' + expected.name);
  assert.equal(actual.Config.Labels[PROBE_LABEL], expected.run);
  assert.equal(actual.Mounts.filter(mount => mount.Type === 'volume').length, 1);
  assert.equal(actual.Mounts.filter(mount => mount.Type === 'bind').length, 1);
  assert.ok(actual.Mounts.every(mount => (mount.Type === 'tmpfs' && mount.Destination === '/tmp') ||
    (mount.Type === 'volume' && mount.Name === expected.run && mount.Source === expected.root && mount.Destination === expected.root) ||
    (mount.Type === 'bind' && mount.Source === '/var/run/docker.sock' && mount.Destination === '/var/run/docker.sock')));
}

export function assertOwnedChild(actual, expected) {
  assertIsolation(actual, expected.image);
  assert.match(actual.Name, /^\/omb-[a-zA-Z0-9_.-]{1,59}$/u);
  assert.equal(actual.Config.Labels[CHILD_LABEL], expected.run);
  assert.equal(actual.Config.Labels['com.openmausbot.collaboration.managed'], '1');
  assert.match(actual.Config.Labels['com.openmausbot.collaboration.binding'], /^[a-f0-9]{64}$/u);
  assert.equal(actual.Mounts.filter(mount => mount.Type === 'bind').length, 2);
  assert.equal(actual.Mounts.filter(mount => mount.Destination === '/run/openmausbot').length, 1);
  assert.ok(actual.Mounts.every(mount => (mount.Type === 'tmpfs' && mount.Destination === '/tmp') ||
    (mount.Type === 'bind' && isInside(expected.root, mount.Source) &&
      ((mount.Destination === mount.Source && mount.RW === true) || (mount.Destination === '/run/openmausbot' && mount.RW === false)))));
}

export function assertOwnedVolume(actual, run) {
  assert.equal(actual.Name, run);
  assert.equal(actual.Labels[PROBE_LABEL], run);
  assert.equal(actual.Mountpoint, `/var/lib/docker/volumes/${run}/_data`);
}

/** Only this invocation's exact returned IDs may receive later Docker operations. */
export class RecheckOwnedDocker {
  constructor(actual, config) { this.actual = actual; this.config = config; this.ids = new Set(); }
  async run(args, options) {
    if (args[0] === 'create') {
      assert.ok(args.includes(this.config.image), 'fixed_image_required');
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
      assert.equal(args[args.indexOf('--user') + 1], '0:0');
      assert.ok(args.includes('--read-only'));
      assert.match(args[args.indexOf('--name') + 1], /^omb-[a-zA-Z0-9_.-]{1,59}$/u);
      let mounts = 0;
      for (let index = 0; index < args.length; index++) if (args[index] === '--mount') {
        mounts++;
        const parts = args[++index].split(','), source = parts.find(part => part.startsWith('src='))?.slice(4),
          destination = parts.find(part => part.startsWith('dst='))?.slice(4);
        assert.ok(parts.includes('type=bind') && isInside(this.config.root, source), 'foreign_mount_denied');
        assert.ok(destination === source || (destination === '/run/openmausbot' && parts.includes('readonly')), 'foreign_destination_denied');
      }
      assert.equal(mounts, 2);
      const result = await this.actual.run(['create', '--label', `${CHILD_LABEL}=${this.config.run}`, ...args.slice(1)], options);
      if (result.exitCode === 0) { const id = result.stdout.toString().trim(); assert.match(id, /^[a-f0-9]{64}$/u); this.ids.add(id); }
      return result;
    }
    assert.ok(['start', 'inspect', 'wait', 'logs', 'kill', 'rm'].includes(args[0]), 'docker_operation_denied');
    assert.equal(args.length, 2, 'docker_arguments_denied');
    assert.ok(this.ids.has(args[1]), 'foreign_container_denied');
    return this.actual.run(args, options);
  }
}
import assert from 'node:assert/strict';
import { posix } from 'node:path';
