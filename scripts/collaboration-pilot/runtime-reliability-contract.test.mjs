import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { smokeConfiguration, assertOwnedContainer, assertOwnedVolume, assertRecoveryChild, assertOwnedChild, assertPhaseEvidence, evidenceLines } from '../smoke-docker-runtime-reliability.mjs';

const image = 'sha256:' + 'a'.repeat(64), run = 'omb-runtime-test', root = `/var/lib/docker/volumes/${run}/_data`;
const expected = { id: 'b'.repeat(64), name: run + '-run', image, run, root };
function fixture() { return { Id: expected.id, Name: '/' + expected.name, Image: image, Config: { User: '0:0', Labels: { 'com.openmausbot.runtime-probe': run } },
  HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, RestartPolicy: { Name: 'no' }, CapDrop: ['ALL'], CapAdd: null, PidMode: '', SecurityOpt: ['no-new-privileges:true'] },
  Mounts: [{ Type: 'volume', Name: run, Source: root, Destination: root }, { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] }; }
describe('disposable Linux runtime smoke ownership contract', () => {
  it('requires an explicit context, immutable image and probe mode', () => {
    assert.throws(() => smokeConfiguration({}, 'concurrency'));
    assert.throws(() => smokeConfiguration({ OMB_CONTAINMENT_SMOKE_CONTEXT: ' ' }, 'concurrency'));
    assert.throws(() => smokeConfiguration({ OMB_CONTAINMENT_SMOKE_CONTEXT: 'pilot', OMB_CONTAINMENT_SMOKE_IMAGE: 'latest' }, 'recovery'));
    assert.throws(() => smokeConfiguration({ OMB_CONTAINMENT_SMOKE_CONTEXT: 'pilot', OMB_CONTAINMENT_SMOKE_IMAGE: image }, 'business'));
    assert.equal(smokeConfiguration({ OMB_CONTAINMENT_SMOKE_CONTEXT: 'pilot', OMB_CONTAINMENT_SMOKE_IMAGE: image }, 'recovery').image, image);
  });
  it('accepts only the exact owned container with the minimal controller mounts', () => assert.doesNotThrow(() => assertOwnedContainer(fixture(), expected)));
  for (const field of ['Id', 'Name', 'Image']) it(`rejects different ${field}`, () => { const f = fixture(); f[field] += 'x'; assert.throws(() => assertOwnedContainer(f, expected)); });
  it('rejects missing ownership label', () => { const f = fixture(); f.Config.Labels = {}; assert.throws(() => assertOwnedContainer(f, expected)); });
  for (const [key, value] of [['NetworkMode', 'host'], ['ReadonlyRootfs', false], ['Privileged', true], ['CapAdd', ['SYS_ADMIN']]]) {
    it(`rejects expanded ${key}`, () => { const f = fixture(); f.HostConfig[key] = value; assert.throws(() => assertOwnedContainer(f, expected)); });
  }
  it('rejects business data mounts', () => { const f = fixture(); f.Mounts.push({ Type: 'bind', Source: '/var/lib/openmausbot-collaboration-pilot/data', Destination: '/data' }); assert.throws(() => assertOwnedContainer(f, expected)); });
  it('rejects a substituted volume or destination', () => { const f = fixture(); f.Mounts[0].Name = 'other'; assert.throws(() => assertOwnedContainer(f, expected)); });
  it('rejects a volume source substitution', () => { const f = fixture(); f.Mounts[0].Source = '/unrelated'; assert.throws(() => assertOwnedContainer(f, expected)); });
  it('rejects missing namespace and privilege isolation', () => {
    const f = fixture(); f.HostConfig.PidMode = 'host'; assert.throws(() => assertOwnedContainer(f, expected));
    f.HostConfig.PidMode = ''; f.HostConfig.SecurityOpt = []; assert.throws(() => assertOwnedContainer(f, expected));
  });
  it('never accepts an unrelated volume', () => {
    const f = { Name: run, Labels: { 'com.openmausbot.runtime-probe': run }, Mountpoint: root };
    assert.doesNotThrow(() => assertOwnedVolume(f, run));
    assert.throws(() => assertOwnedVolume({ ...f, Mountpoint: root + '-other' }, run));
    assert.throws(() => assertOwnedVolume({ ...f, Labels: {} }, run));
  });
  it('parses durable checkpoints without tolerating non-evidence output', () => {
    assert.deepEqual(evidenceLines('\n{"event":"crash_ready"}\n'), [{ event: 'crash_ready' }]);
    assert.throws(() => evidenceLines('not ready'));
  });
  it('requires explicit semantic success, phase and no external effects', () => {
    const good = { status: 'passed', phase: 'recover', modelCalls: 0, realGroupMessages: 0,
      realRuntimeRecovery: true, realTaskExitProof: true, oldCoordinatorStopped: true, oldWriterStopped: true,
      recoveredSettlements: 1, recoveryNotices: 1, originalAttempts: 1, repositoryReleased: true,
      continuationDispatch: 'direct_probe_lifecycle', businessAcceptance: false };
    assert.doesNotThrow(() => assertPhaseEvidence([good], 'recover'));
    for (const bad of [[], [{}], [{ ...good, phase: 'replay' }], [{ ...good, status: 'failed' }], [{ ...good, modelCalls: 1 }], [{ ...good, originalAttempts: 2 }], [{ ...good, realTaskExitProof: false }]]) assert.throws(() => assertPhaseEvidence(bad, 'recover'));
  });
  it('requires the crash task exact ID, name, image, own label and signed-binding identity before killing it', () => {
    const ready = { taskContainerId: expected.id, taskName: expected.name, taskBindingHash: 'c'.repeat(64),
      probeLabelKey: 'com.openmausbot.runtime-crash-probe', probeLabelValue: run };
    const f = fixture(); f.Mounts = []; f.Config.Labels = { [ready.probeLabelKey]: run, 'com.openmausbot.runtime-probe-child': run,
      'com.openmausbot.collaboration.managed': '1', 'com.openmausbot.collaboration.binding': ready.taskBindingHash };
    assert.doesNotThrow(() => assertRecoveryChild(f, ready, { run, root, image }));
    assert.throws(() => assertRecoveryChild(f, { ...ready, probeLabelValue: 'live-service' }, { run, root, image }));
    assert.throws(() => assertRecoveryChild(f, { ...ready, taskBindingHash: 'd'.repeat(64) }, { run, root, image }));
    f.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' });
    assert.throws(() => assertRecoveryChild(f, ready, { run, root, image }));
    f.Mounts = [{ Type: 'bind', Source: root + '/../../../../real-data', Destination: '/workspace' }];
    assert.throws(() => assertOwnedChild(f, { run, root, image }));
  });
  it('recognizes actual barrier and product command containers without accepting foreign or writable control mounts', () => {
    const f = fixture(); f.Name = '/omb-rc-11111111-1111-1111-1111-111111111111'; f.Mounts = [];
    f.Config.User = '10001:10001';
    f.Config.Labels = { 'com.openmausbot.runtime-probe-child': run, 'com.openmausbot.collaboration.managed': '1', 'com.openmausbot.collaboration.binding': 'c'.repeat(64) };
    assert.doesNotThrow(() => assertOwnedChild(f, { run, root, image }));
    f.Name = '/omb-11111111-1111-1111-1111-111111111111-check'; f.Config.User = '0:0';
    f.Mounts = [{ Type: 'bind', Source: root + '/fixture/worktrees/test', Destination: root + '/fixture/worktrees/test', RW: true },
      { Type: 'bind', Source: root + '/fixture/exchange/test', Destination: '/run/openmausbot', RW: false }, { Type: 'tmpfs', Destination: '/tmp' }];
    assert.doesNotThrow(() => assertOwnedChild(f, { run, root, image }));
    f.Mounts[1].RW = true; assert.throws(() => assertOwnedChild(f, { run, root, image }));
    f.Mounts[1].RW = false; f.Mounts[0].Destination = '/data'; assert.throws(() => assertOwnedChild(f, { run, root, image }));
  });
});
