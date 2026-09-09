import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../server/collaboration/operations/docker-containment.ts';

// Fault injection is restricted to fresh, labelled, disposable fixtures. Never
// load the business configuration, model socket, Ledger, or a default context.
export function smokeConfiguration(env, mode) {
  assert.match(env.OMB_CONTAINMENT_SMOKE_CONTEXT ?? '', /\S/, 'explicit_context_required');
  assert.match(env.OMB_CONTAINMENT_SMOKE_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/, 'fixed_cached_image_required');
  assert.ok(['concurrency', 'recovery'].includes(mode), 'explicit_probe_mode_required');
  return { context: env.OMB_CONTAINMENT_SMOKE_CONTEXT, image: env.OMB_CONTAINMENT_SMOKE_IMAGE, mode };
}

export function assertOwnedContainer(actual, expected) {
  assert.equal(actual.Id, expected.id);
  assert.equal(actual.Name, '/' + expected.name);
  assert.equal(actual.Image, expected.image);
  assert.equal(actual.Config.Labels['com.openmausbot.runtime-probe'], expected.run);
  assert.equal(actual.Config.User, '0:0');
  assert.equal(actual.HostConfig.PidMode, '');
  assert.ok(actual.HostConfig.SecurityOpt?.some(s => ['no-new-privileges:true', 'no-new-privileges'].includes(s)));
  assert.equal(actual.HostConfig.NetworkMode, 'none');
  assert.equal(actual.HostConfig.ReadonlyRootfs, true);
  assert.equal(actual.HostConfig.Privileged, false);
  assert.equal(actual.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']);
  assert.ok(actual.HostConfig.CapAdd === null || actual.HostConfig.CapAdd.length === 0);
  assert.ok(actual.Mounts.every(m => (m.Type === 'tmpfs' && m.Destination === '/tmp') ||
    (m.Type === 'volume' && m.Name === expected.run && m.Source === expected.root && m.Destination === expected.root) ||
    (m.Type === 'bind' && m.Source === '/var/run/docker.sock' && m.Destination === '/var/run/docker.sock')));
  assert.equal(actual.Mounts.filter(m => m.Type === 'volume').length, 1);
}

export function assertOwnedVolume(actual, run) {
  assert.equal(actual.Name, run);
  assert.equal(actual.Labels['com.openmausbot.runtime-probe'], run);
  assert.equal(actual.Mountpoint, `/var/lib/docker/volumes/${run}/_data`);
}

export function assertRecoveryChild(actual, ready, config) {
  assert.match(ready.taskContainerId ?? '', /^[a-f0-9]{64}$/);
  assert.match(ready.taskBindingHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(ready.probeLabelKey, 'com.openmausbot.runtime-crash-probe');
  assert.equal(ready.probeLabelValue, config.run);
  assert.match(ready.taskName ?? '', /^[a-zA-Z0-9_.-]+$/);
  assert.ok(ready.taskName.startsWith(config.run + '-'));
  assert.equal(actual.Id, ready.taskContainerId);
  assert.equal(actual.Name, '/' + ready.taskName);
  assert.equal(actual.Image, config.image);
  assert.equal(actual.Config.Labels[ready.probeLabelKey], config.run);
  assert.equal(actual.Config.Labels['com.openmausbot.collaboration.managed'], '1');
  assert.equal(actual.Config.Labels['com.openmausbot.collaboration.binding'], ready.taskBindingHash);
  assertOwnedChild(actual, config);
}

export function assertOwnedChild(actual, config) {
  assert.match(actual.Id, /^[a-f0-9]{64}$/);
  assert.equal(actual.Image, config.image);
  assert.equal(actual.Config.Labels['com.openmausbot.runtime-probe-child'], config.run);
  assert.equal(actual.Config.Labels['com.openmausbot.collaboration.managed'], '1');
  assert.match(actual.Config.Labels['com.openmausbot.collaboration.binding'], /^[a-f0-9]{64}$/);
  assert.ok(actual.Name.startsWith('/' + config.run + '-') || /^\/omb-[a-z0-9_.-]{1,80}$/.test(actual.Name));
  assert.ok(['0:0', '10001:10001'].includes(actual.Config.User));
  assert.equal(actual.HostConfig.PidMode, '');
  assert.ok(actual.HostConfig.SecurityOpt?.some(s => ['no-new-privileges:true', 'no-new-privileges'].includes(s)));
  assert.equal(actual.HostConfig.NetworkMode, 'none');
  assert.equal(actual.HostConfig.ReadonlyRootfs, true);
  assert.equal(actual.HostConfig.Privileged, false);
  assert.equal(actual.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']);
  assert.ok(actual.HostConfig.CapAdd === null || actual.HostConfig.CapAdd.length === 0);
  assert.ok(actual.Mounts.every(m => (m.Type === 'tmpfs' && m.Destination === '/tmp') ||
    (m.Type === 'bind' && posix.normalize(m.Source) === m.Source &&
      m.Source.startsWith(config.root + '/') && (['/workspace', '/control', '/run/openmausbot'].includes(m.Destination) || m.Source === m.Destination))));
  assert.ok(actual.Mounts.filter(m => ['/control', '/run/openmausbot'].includes(m.Destination)).every(m => m.RW === false));
}

export function evidenceLines(stdout) {
  return stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

export function assertPhaseEvidence(lines, phase) {
  assert.ok(lines.length > 0, 'probe_result_missing');
  const result = lines.at(-1);
  assert.equal(result.status, 'passed'); assert.equal(result.phase, phase);
  assert.equal(result.modelCalls, 0); assert.equal(result.realGroupMessages, 0);
  if (phase === 'run') {
    assert.equal(result.result, 'VERIFIED'); assert.equal(result.executionSessionsSettled, 4);
    assert.equal(result.originalRepositoriesUnchanged, true);
    assert.deepEqual(result.cases, ['same_repository_serialized', 'different_repositories_concurrent',
      'durable_repository_reservation_rejects_contender', 'real_git_index_writers_overlap', 'original_repositories_unchanged']);
    assert.equal(result.runs.length, 4);
  } else if (phase === 'recover') {
    assert.equal(result.realRuntimeRecovery, true); assert.equal(result.realTaskExitProof, true);
    assert.equal(result.oldCoordinatorStopped, true); assert.equal(result.oldWriterStopped, true);
    assert.equal(result.recoveredSettlements, 1); assert.equal(result.recoveryNotices, 1);
    assert.equal(result.originalAttempts, 1); assert.equal(result.repositoryReleased, true);
    assert.equal(result.continuationDispatch, 'direct_probe_lifecycle'); assert.equal(result.businessAcceptance, false);
  } else if (phase === 'replay') {
    assert.equal(result.restartedRuntime, true); assert.equal(result.recoveryReplayDeduplicated, true);
    assert.equal(result.continuationNotReexecuted, true); assert.equal(result.deliveryFilesUnchanged, true);
    assert.equal(result.originalAttempts, 1); assert.equal(result.repositoryReleased, true); assert.equal(result.businessAcceptance, false);
  } else assert.fail('unknown_probe_phase');
}

async function main() {
  const config = smokeConfiguration(process.env, process.argv[2]);
  const { image, mode } = config, docker = new NodeDockerCommandPort({ context: config.context });
  const run = `omb-runtime-${mode}-${randomUUID()}`, root = `/var/lib/docker/volumes/${run}/_data`;
  const temp = mkdtempSync(join(tmpdir(), run)), owned = [], phases = [];
  let volumeCreated = false, success = false, recoveryChild, primaryError, result;
  const cleanupErrors = [];
  const command = async (args, options) => {
    const result = await docker.run(args, options);
    assert.equal(result.exitCode, 0, `probe_docker_${args[0]}_failed: ${result.stderr.toString().slice(-3000)}`);
    return result.stdout.toString();
  };
  const inspect = async id => JSON.parse(await command(['inspect', id]))[0];
  const validate = actual => assertOwnedContainer(actual, { id: actual.Id, name: owned.find(c => c.id === actual.Id)?.name, image, run, root });
  try {
    assert.equal((await command(['image', 'inspect', '--format', '{{.Id}}', image])).trim(), image);
    const source = mode === 'concurrency' ? 'repository-concurrency.smoke-probe.ts' : 'runtime-crash-recovery.smoke-probe.ts';
    const bundle = join(temp, 'probe.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('../server/collaboration/operations/' + source, import.meta.url))], outfile: bundle,
      bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
    const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    await command(['volume', 'create', '--label', `com.openmausbot.runtime-probe=${run}`, run]); volumeCreated = true;
    assertOwnedVolume(JSON.parse(await command(['volume', 'inspect', run]))[0], run);
    const key = randomBytes(32).toString('hex');
    async function create(phase) {
      const name = `${run}-${phase}`;
      const prefix = mode === 'concurrency' ? 'OMB_REPOSITORY_CONCURRENCY_' : 'OMB_RUNTIME_SMOKE_';
      const id = (await command(['create', '--name', name, '--label', `com.openmausbot.runtime-probe=${run}`,
        '--network', 'none', '--read-only', '--restart', 'no', '--user', '0:0', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
        '--mount', `type=volume,src=${run},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
        '--env', 'DOCKER_API_VERSION=1.44', '--env', `${prefix}ROOT=${root}`, '--env', `${prefix}IMAGE=${image}`,
        '--env', `${prefix}CONTAINER=${name}`, '--env', `${prefix}KEY=${key}`, '--env', `${prefix}MODE=${phase}`,
        '--entrypoint', 'node', image, `${root}/probe.cjs`])).trim();
      assert.match(id, /^[a-f0-9]{64}$/); owned.push({ id, name });
      await command(['cp', bundle, `${id}:${root}/probe.cjs`]);
      validate(await inspect(id)); return id;
    }
    async function finish(id, phase) {
      const stdout = await command(['start', '--attach', id], { timeoutMs: 120000, maxOutputBytes: 32000 });
      const state = await inspect(id); validate(state);
      assert.equal(state.State.Status, 'exited'); assert.equal(state.State.ExitCode, 0); assert.equal(state.State.Pid, 0);
      const evidence = evidenceLines(stdout); assertPhaseEvidence(evidence, phase);
      phases.push({ phase, id, exitCode: state.State.ExitCode, evidence });
    }
    if (mode === 'concurrency') await finish(await create('run'), 'run');
    else {
      const original = await create('produce'); await command(['start', original]);
      let ready;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const state = await inspect(original); validate(state);
        const logs = await command(['logs', original]);
        ready = evidenceLines(logs).find(row => row.event === 'crash_ready');
        if (ready) break;
        assert.equal(state.State.Running, true, 'producer_exited_before_injection');
        await delay(250);
      }
      assert.ok(ready, 'durable_inflight_checkpoint_not_observed');
      assertRecoveryChild(await inspect(ready.taskContainerId), ready, { run, root, image });
      recoveryChild = ready;
      // The controller has durably recorded the exact crash boundary. Only its
      // owned container is killed; recovery itself determines task completion.
      validate(await inspect(original)); await command(['kill', original]); await command(['wait', original]);
      const stopped = await inspect(original); validate(stopped);
      assert.equal(stopped.State.Pid, 0); assert.equal(stopped.State.Status, 'exited'); assert.equal(stopped.State.ExitCode, 137);
      const child = await inspect(ready.taskContainerId);
      assertRecoveryChild(child, ready, { run, root, image });
      assert.equal(child.State.Running, true, 'task_expected_to_survive_controller_crash');
      await command(['kill', child.Id]); await command(['wait', child.Id]);
      const childStopped = await inspect(child.Id);
      assertRecoveryChild(childStopped, ready, { run, root, image });
      assert.equal(childStopped.State.Status, 'exited'); assert.equal(childStopped.State.Pid, 0);
      phases.push({ phase: 'produce', id: original, exitCode: 137, evidence: [ready] });
      await finish(await create('recover'), 'recover');
      await finish(await create('replay'), 'replay');
    }
    success = true;
    result = { run, image, bundleSha256, mode, phases, syntheticLedger: true, modelCalls: 0, realGroupMessages: 0 };
  } catch (error) { primaryError = error; }
  finally {
    const stoppedIds = [], childIds = new Set();
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    // Stop controllers first: their descendants cannot create more task
    // containers after this boundary. Continue cleanup if any one check fails.
    async function stopOwned(id, check) {
      const actual = await inspect(id); check(actual);
      if (actual.State.Running) { await command(['kill', id]); await command(['wait', id]); }
      const stopped = await inspect(id); check(stopped);
      assert.equal(stopped.State.Running, false); assert.equal(stopped.State.Pid, 0);
      stoppedIds.push(id);
    }
    for (const record of owned) await attempt(() => stopOwned(record.id, validate));
    if (recoveryChild) childIds.add(recoveryChild.taskContainerId);
    await attempt(async () => {
      for (const id of (await command(['ps', '-aq', '--no-trunc', '--filter', `label=com.openmausbot.runtime-probe-child=${run}`])).trim().split(/\s+/).filter(Boolean)) childIds.add(id);
    });
    for (const id of childIds) await attempt(() => stopOwned(id, actual => assertOwnedChild(actual, { run, root, image })));
    if (success && cleanupErrors.length === 0) {
      for (const id of stoppedIds) await attempt(() => command(['rm', id]));
    }
    if (volumeCreated) {
      await attempt(async () => {
        assertOwnedVolume(JSON.parse(await command(['volume', 'inspect', run]))[0], run);
        // Restrict unrelated-container reads to mounts only, never Config.Env.
        const all = (await command(['ps', '-aq', '--no-trunc'])).trim().split(/\s+/).filter(Boolean), retained = [];
        for (const id of all) {
          const mounts = JSON.parse(await command(['inspect', '--format', '{{json .Mounts}}', id]));
          if (mounts.some(m => m.Source === root || m.Source?.startsWith(root + '/'))) retained.push(id);
        }
        if (success && cleanupErrors.length === 0) { assert.deepEqual(retained, [], 'probe_children_retain_volume'); await command(['volume', 'rm', run]); }
        else console.error(JSON.stringify({ retainedSyntheticVolume: run, referencedContainers: retained }));
      });
    }
    rmSync(temp, { recursive: true, force: true });
  }
  if (primaryError || cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], 'runtime_smoke_failed_or_cleanup_unconfirmed');
  console.log(JSON.stringify({ ...result, cleanupConfirmed: true }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
