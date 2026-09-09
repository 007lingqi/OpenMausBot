import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { recheckConfiguration, assertRecheckEvidence, assertOwnedController, assertOwnedChild, assertOwnedVolume, RecheckOwnedDocker, PROBE_LABEL, CHILD_LABEL } from './recheck-preflight-contract.mjs';

const image = 'sha256:' + 'a'.repeat(64);
const run = 'omb-recheck-11111111-1111-1111-1111-111111111111', root = `/var/lib/docker/volumes/${run}/_data`;
const expected = { id: 'b'.repeat(64), name: run + '-controller', image, run, root };
function controller() { return { Id: expected.id, Name: '/' + expected.name, Image: image,
  Config: { User: '0:0', Labels: { [PROBE_LABEL]: run } },
  HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, RestartPolicy: { Name: 'no' },
    CapDrop: ['ALL'], CapAdd: null, PidMode: '', SecurityOpt: ['no-new-privileges:true'] },
  Mounts: [{ Type: 'volume', Name: run, Source: root, Destination: root, RW: true },
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }, { Type: 'tmpfs', Destination: '/tmp' }] }; }
function child() { const value = controller(); value.Name = '/omb-11111111-111111-abcDEF_0123456789';
  value.Config.Labels = { [CHILD_LABEL]: run, 'com.openmausbot.collaboration.managed': '1', 'com.openmausbot.collaboration.binding': 'c'.repeat(64) };
  value.Mounts = [{ Type: 'bind', Source: root + '/fixture/self', Destination: root + '/fixture/self', RW: true },
    { Type: 'bind', Source: root + '/fixture/exchange/test', Destination: '/run/openmausbot', RW: false }, { Type: 'tmpfs', Destination: '/tmp' }];
  return value; }
describe('bounded real Docker recheck preflight', () => {
  it('requires an explicit context and complete immutable image identity', () => {
    assert.throws(() => recheckConfiguration({}), /explicit_context_required/u);
    for (const value of ['latest', 'c783903244ab', 'sha256:short']) {
      assert.throws(() => recheckConfiguration({ OMB_RECHECK_PREFLIGHT_CONTEXT: 'pilot', OMB_RECHECK_PREFLIGHT_IMAGE: value }), /fixed_cached_image_required/u);
    }
    assert.deepEqual(recheckConfiguration({ OMB_RECHECK_PREFLIGHT_CONTEXT: 'pilot', OMB_RECHECK_PREFLIGHT_IMAGE: image }), { context: 'pilot', image });
  });
  it('requires actual two-stage success and explicitly synthetic boundaries', () => {
    const valid = { status: 'passed', probe: 'candidate-recheck', syntheticFixture: true, realModel: false, modelCalls: 0,
      realGroupMessages: 0, businessAcceptance: false, mapping: 'trusted_synthetic_fixture',
      technicalGatePassed: true, originalEvidenceUnchanged: true, originalRepositoryUnchanged: true,
      candidateUnchanged: true, ignoredOutputIsolated: true, distinctWorktrees: true,
      gitAndDirectoryPermissionsChecked: true, verificationCommands: 2, verificationProofs: 2,
      settlementEmptyEntries: 2, mappingCalls: 2, ownedContainersStopped: 2,
      stages: [{ phase: 'self', id: 'b'.repeat(64), name: 'omb-self', exitCode: 0 },
        { phase: 'verifier', id: 'c'.repeat(64), name: 'omb-verifier', exitCode: 0 }] };
    assert.doesNotThrow(() => assertRecheckEvidence(valid));
    for (const [key, value] of [['status', 'failed'], ['realModel', true], ['modelCalls', 1], ['realGroupMessages', 1],
      ['businessAcceptance', true], ['technicalGatePassed', false], ['ignoredOutputIsolated', false], ['verificationProofs', 1],
      ['settlementEmptyEntries', 1], ['gitAndDirectoryPermissionsChecked', false], ['mappingCalls', 0]]) {
      assert.throws(() => assertRecheckEvidence({ ...valid, [key]: value }), key);
    }
    assert.throws(() => assertRecheckEvidence({ ...valid, stages: [valid.stages[0], valid.stages[0]] }));
  });
  it('only accepts its exact labelled controller, image and synthetic volume/socket mounts', () => {
    assert.doesNotThrow(() => assertOwnedController(controller(), expected));
    for (const field of ['Id', 'Name', 'Image']) {
      const value = controller(); value[field] += 'other'; assert.throws(() => assertOwnedController(value, expected));
    }
    for (const mutate of [value => { value.Config.Labels = {}; }, value => { value.HostConfig.NetworkMode = 'host'; },
      value => { value.HostConfig.CapAdd = ['SYS_ADMIN']; }, value => { value.HostConfig.PidMode = 'host'; },
      value => { value.HostConfig.SecurityOpt = []; }, value => { value.Mounts[0].Name = 'business'; },
      value => { value.Mounts.push({ Type: 'bind', Source: '/real-data', Destination: '/data' }); }]) {
      const value = controller(); mutate(value); assert.throws(() => assertOwnedController(value, expected));
    }
  });
  it('only accepts labelled child containers with writable own tree and readonly own control mount', () => {
    assert.doesNotThrow(() => assertOwnedChild(child(), { run, root, image }));
    for (const mutate of [value => { value.Config.Labels[CHILD_LABEL] = 'business'; },
      value => { value.Config.Labels['com.openmausbot.collaboration.binding'] = ''; },
      value => { value.Mounts[0].Source = root + '/../../business'; }, value => { value.Mounts[0].Destination = '/data'; },
      value => { value.Mounts[1].RW = true; }, value => { value.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }); }]) {
      const value = child(); mutate(value); assert.throws(() => assertOwnedChild(value, { run, root, image }));
    }
  });
  it('requires exact labelled volume ownership before removal', () => {
    const volume = { Name: run, Labels: { [PROBE_LABEL]: run }, Mountpoint: root };
    assert.doesNotThrow(() => assertOwnedVolume(volume, run));
    assert.throws(() => assertOwnedVolume({ ...volume, Labels: {} }, run));
    assert.throws(() => assertOwnedVolume({ ...volume, Mountpoint: root + '-other' }, run));
  });
  it('denies unrelated Docker operations before invoking the daemon and labels bounded child creation', async () => {
    const calls = [], port = new RecheckOwnedDocker({ async run(args) { calls.push(args); return { exitCode: 0, stdout: Buffer.from(expected.id), stderr: Buffer.alloc(0) }; } }, { run, root, image });
    for (const args of [['kill', 'unrelated'], ['inspect', 'unrelated'], ['rm', 'unrelated'], ['ps', '-aq'], ['system', 'prune']]) {
      await assert.rejects(port.run(args));
    }
    assert.equal(calls.length, 0);
    const create = ['create', '--name', 'omb-owned', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '0:0',
      '--mount', `type=bind,src=${root}/fixture/self,dst=${root}/fixture/self`,
      '--mount', `type=bind,src=${root}/fixture/exchange/one,dst=/run/openmausbot,readonly`, '--entrypoint', 'node', image, '-e', ''];
    await port.run(create);
    assert.ok(calls[0].includes(`${CHILD_LABEL}=${run}`));
    assert.ok(port.ids.has(expected.id));
    await port.run(['inspect', expected.id]);
    await assert.rejects(port.run(['kill', expected.id, '--signal', 'TERM']));
    const foreign = [...create]; foreign[foreign.indexOf('--mount') + 1] = 'type=bind,src=/real-data,dst=/real-data';
    await assert.rejects(port.run(foreign));
    assert.equal(calls.length, 2);
  });
});
