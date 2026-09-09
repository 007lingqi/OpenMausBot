import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeDockerCommandPort } from '../../server/collaboration/operations/docker-containment.ts';
import { recheckConfiguration, assertRecheckEvidence, assertOwnedController, assertOwnedChild, assertOwnedVolume,
  PROBE_LABEL, CHILD_LABEL } from './recheck-preflight-contract.mjs';

/** No business configuration, credentials, original Ledger, model socket or group transport is loaded. */
export async function runRecheckPreflight(env = process.env) {
  const config = recheckConfiguration(env), docker = new NodeDockerCommandPort({ context: config.context });
  const run = `omb-recheck-${randomUUID()}`, root = `/var/lib/docker/volumes/${run}/_data`, name = run + '-controller';
  const temp = mkdtempSync(join(tmpdir(), run + '-'));
  const command = async (args, options) => {
    const value = await docker.run(args, options);
    assert.equal(value.exitCode, 0, `preflight_docker_${args[0]}_failed: ${value.stderr.toString().slice(-3000)}`);
    return value.stdout.toString();
  };
  const inspect = async id => JSON.parse(await command(['inspect', id]))[0];
  const controllerCheck = actual => assertOwnedController(actual, { id: controller, name, run, root, image: config.image });
  const childCheck = actual => assertOwnedChild(actual, { run, root, image: config.image });
  let controller, volumeCreated = false, result, primaryError;
  const cleanupErrors = [], stoppedIds = [], children = [];
  try {
    assert.equal((await command(['image', 'inspect', '--format', '{{.Id}}', config.image])).trim(), config.image);
    const bundle = join(temp, 'recheck-probe.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./recheck-preflight-probe.mjs', import.meta.url))], outfile: bundle,
      bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'error' });
    const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    await command(['volume', 'create', '--label', `${PROBE_LABEL}=${run}`, run]); volumeCreated = true;
    assertOwnedVolume(JSON.parse(await command(['volume', 'inspect', run]))[0], run);
    controller = (await command(['create', '--name', name, '--label', `${PROBE_LABEL}=${run}`,
      '--network', 'none', '--read-only', '--restart', 'no', '--user', '0:0', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--mount', `type=volume,src=${run},dst=${root}`, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--env', 'DOCKER_API_VERSION=1.44', '--env', `OMB_RECHECK_PREFLIGHT_RUN=${run}`,
      '--env', `OMB_RECHECK_PREFLIGHT_ROOT=${root}`, '--env', `OMB_RECHECK_PREFLIGHT_IMAGE=${config.image}`,
      '--entrypoint', 'node', config.image, `${root}/recheck-probe.cjs`])).trim();
    assert.match(controller, /^[a-f0-9]{64}$/u);
    controllerCheck(await inspect(controller));
    await command(['cp', bundle, `${controller}:${root}/recheck-probe.cjs`]);
    const stdout = await command(['start', '--attach', controller], { timeoutMs: 120000, maxOutputBytes: 128000 });
    const observed = await inspect(controller); controllerCheck(observed);
    assert.equal(observed.State.Status, 'exited'); assert.equal(observed.State.ExitCode, 0); assert.equal(observed.State.Pid, 0);
    const lines = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    assert.equal(lines.length, 1, 'one_bounded_probe_result_required');
    assertRecheckEvidence(lines[0]);
    result = { run, image: config.image, context: config.context, bundleSha256, controllerId: controller,
      controllerExitCode: observed.State.ExitCode, evidence: lines[0] };
  } catch (error) { primaryError = error; }
  finally {
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    const stop = async (id, validate) => {
      const actual = await inspect(id); validate(actual);
      if (actual.State.Running) { await command(['kill', id]); await command(['wait', id]); }
      const stopped = await inspect(id); validate(stopped);
      assert.equal(stopped.State.Running, false); assert.equal(stopped.State.Pid, 0); stoppedIds.push(id);
    };
    // Stop the exact controller before listing its uniquely labelled descendants.
    if (controller) await attempt(() => stop(controller, controllerCheck));
    await attempt(async () => {
      children.push(...(await command(['ps', '-aq', '--no-trunc', '--filter', `label=${CHILD_LABEL}=${run}`])).trim().split(/\s+/u).filter(Boolean));
    });
    for (const id of children) await attempt(() => stop(id, childCheck));
    if (result) await attempt(async () => {
      assert.equal(children.length, 2, 'two_owned_task_containers_required');
      assert.deepEqual([...children].sort(), result.evidence.stages.map(stage => stage.id).sort());
    });
    if (!primaryError && result && cleanupErrors.length === 0) {
      for (const id of stoppedIds) await attempt(() => command(['rm', id]));
    }
    if (volumeCreated) await attempt(async () => {
      assertOwnedVolume(JSON.parse(await command(['volume', 'inspect', run]))[0], run);
      if (!primaryError && result && cleanupErrors.length === 0) {
        assert.equal((await command(['ps', '-aq', '--filter', `label=${CHILD_LABEL}=${run}`])).trim(), '');
        await command(['volume', 'rm', run]);
      } else console.error(JSON.stringify({ retainedSyntheticVolume: run, ownedController: controller, ownedChildren: children }));
    });
    rmSync(temp, { recursive: true, force: true });
  }
  if (primaryError || cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], 'recheck_preflight_failed_or_cleanup_unconfirmed');
  return { ...result, ownedContainersStopped: stoppedIds.length, cleanupConfirmed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRecheckPreflight().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
