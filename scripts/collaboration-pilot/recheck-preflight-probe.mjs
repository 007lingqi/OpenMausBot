/** Disposable Linux probe; all model/mapping answers and old executor evidence are explicit synthetic fixtures. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CandidateVerificationCoordinator, candidateHasPassedTechnicalReview } from '../../server/collaboration/candidate-verification.ts';
import { acceptanceConditionHash } from '../../server/collaboration/acceptance-assertions.ts';
import { isolatedExecutionEnvironment } from '../../server/collaboration/execution-limits.ts';
import { InstanceLeaseCoordinator } from '../../server/collaboration/leases.ts';
import { nodeTestAssertionId } from '../../server/collaboration/node-test-reporter.ts';
import { policy, validProposal } from '../../server/collaboration/planner.test-fixtures.ts';
import { startCollaborationService } from '../../server/collaboration/service.ts';
import { publishVerificationRuntimePolicy } from '../../server/collaboration/verification-runtime-policy.ts';
import { DockerSandboxedCommandRunner, dockerCommandContainerName } from '../../server/collaboration/operations/docker-command-runner.ts';
import { DockerCliContainmentSupervisor, NodeDockerCommandPort } from '../../server/collaboration/operations/docker-containment.ts';
import { RecheckOwnedDocker, assertOwnedChild, assertRecheckEvidence } from './recheck-preflight-contract.mjs';

const commandId = 'pnpm test target';
const valueTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from './value.mjs';
test('candidate_value', () => assert.equal(value, 'after'));
`;
const isolationTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
test('fresh_stage_and_permissions', () => {
  accessSync('.', constants.R_OK | constants.W_OK | constants.X_OK);
  assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /^git version /);
  const metadata = readFileSync('.git', 'utf8').trim().replace(/^gitdir: /, '');
  assert.equal(existsSync(resolve(metadata)), false, 'repository metadata must not be mounted into command');
  assert.equal(existsSync('.self-cache'), false, 'each stage starts without ignored self output');
  if (process.env.OMB_ASSERTION_RUN_ID.endsWith(':self-recheck')) writeFileSync('.self-cache', 'self-stage-only\\n');
  else assert.match(process.env.OMB_ASSERTION_RUN_ID, /:verifier:1$/);
});
`;

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0, 'probe_matches_root_runtime_identity');
  const run = process.env.OMB_RECHECK_PREFLIGHT_RUN, image = process.env.OMB_RECHECK_PREFLIGHT_IMAGE;
  assert.match(run ?? '', /^omb-recheck-[a-f0-9-]{36}$/u);
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u);
  const volumeRoot = `/var/lib/docker/volumes/${run}/_data`;
  assert.equal(process.env.OMB_RECHECK_PREFLIGHT_ROOT, volumeRoot);
  assert.ok(lstatSync(volumeRoot).isDirectory());
  assert.equal(realpathSync(volumeRoot), resolve(volumeRoot));
  const root = mkdtempSync(join(volumeRoot, 'fixture-'));
  const docker = new RecheckOwnedDocker(new NodeDockerCommandPort(), { run, image, root });
  const hostGeneration = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const containment = new DockerCliContainmentSupervisor({ docker, hostGeneration, verifierKey: randomBytes(32) });
  const home = join(root, 'git-home'); mkdirSync(home, { mode: 0o700 });
  const gitEnv = isolatedExecutionEnvironment({ PATH: '/usr/local/bin:/usr/bin:/bin' }, home);
  const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: gitEnv, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let service, database, result, primaryError;
  const cleanupErrors = [], requests = [];
  const inspect = async id => {
    const observed = await docker.run(['inspect', id]); assert.equal(observed.exitCode, 0);
    const actual = JSON.parse(observed.stdout.toString())[0];
    assert.equal(actual.Id, id); assertOwnedChild(actual, { run, root, image }); return actual;
  };
  try {
    const repository = join(root, 'repository'), worktree = join(root, 'candidate'), dataDirectory = join(root, 'data');
    mkdirSync(join(repository, 'src'), { recursive: true });
    git(root, ['init', '-b', 'main', repository]);
    git(repository, ['config', 'user.name', 'Synthetic Recheck Fixture']);
    git(repository, ['config', 'user.email', 'recheck@example.invalid']);
    writeFileSync(join(repository, '.gitignore'), '.self-cache\n');
    writeFileSync(join(repository, 'src/value.mjs'), "export const value = 'before';\n");
    writeFileSync(join(repository, 'src/value.test.mjs'), valueTest);
    git(repository, ['add', '.']); git(repository, ['commit', '-m', 'synthetic base']);
    const baseSha = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['worktree', 'add', '-b', 'synthetic-candidate', worktree, baseSha]);
    writeFileSync(join(worktree, 'src/value.mjs'), "export const value = 'after';\n");
    writeFileSync(join(worktree, 'src/isolation.test.mjs'), isolationTest);
    git(worktree, ['add', '.']); git(worktree, ['commit', '-m', 'synthetic candidate with newly discovered test']);
    const candidateSha = git(worktree, ['rev-parse', 'HEAD']), runId = randomUUID(), ownerId = randomUUID();
    const condition = { description: '候选值已更新且阶段输出隔离', observation: '真实 Node 测试读取候选值并验证阶段目录隔离' };
    service = startCollaborationService({ dataDirectory, planning: { planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [repository] } } });
    const now = Date.now();
    const accepted = service.ingestDingTalkMessage({ sourceEventId: `synthetic-${run}`, transportMessageId: `synthetic-transport-${run}`,
      conversationId: 'synthetic-local-only', addressedToBot: true, text: '更新隔离夹具的候选值',
      sender: { senderCorpId: 'synthetic-corp', senderStaffId: 'synthetic-staff', senderId: 'synthetic-sender', displayName: 'Synthetic Fixture' }, receivedAt: now });
    assert.ok(accepted.workItemId);
    service.reviseWorkItemDefinition(accepted.workItemId, { goal: condition.description, goalConfirmed: true, repository,
      acceptanceConditions: [condition], blockingAmbiguities: [] }, now + 1);
    database = new DatabaseSync(join(dataDirectory, 'collaboration/collaboration.sqlite'));
    database.exec('PRAGMA foreign_keys=ON');
    const lease = new InstanceLeaseCoordinator(database, ownerId).acquire(Date.now(), 300000); assert.ok(lease);
    const modify = database.prepare("SELECT node_id,assigned_agent_id FROM collaboration_work_nodes WHERE work_item_id=? AND plan_revision=1 AND node_type='modify'").get(accepted.workItemId);
    assert.ok(modify);
    database.prepare('INSERT INTO collaboration_runs(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path,worktree_path,branch,base_sha,result_sha,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(runId, accepted.workItemId, 1, modify.node_id, 1, modify.assigned_agent_id, 'synthetic-thread', 'synthetic-turn', 'succeeded', repository, worktree,
        'synthetic-candidate', baseSha, candidateSha, now + 2, now + 3);
    database.prepare('INSERT INTO collaboration_candidates(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), runId, 'target_tests_passed', baseSha, candidateSha, JSON.stringify(['src/value.mjs', 'src/isolation.test.mjs']), '[]', JSON.stringify({ state: 'target_tests_passed' }), now + 3);
    // Explicitly synthetic historical evidence: this preflight exercises the new real recheck stages, not the original model/executor.
    const nonce = 'synthetic-historical-self-evidence', originalReport = JSON.stringify({ version: 1, runId, nonce,
      assertions: [{ id: nodeTestAssertionId('src/value.test.mjs', 'candidate_value'), state: 'passed' }] });
    database.prepare('INSERT INTO collaboration_test_evidence(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at,containment_binding_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), runId, commandId, JSON.stringify(['node', '--test', 'src/value.test.mjs']), worktree, 0, 1, originalReport, '', 'target_passed', now + 3,
        JSON.stringify({ runId, commandId, nonce }));
    const originalEvidence = database.prepare('SELECT * FROM collaboration_test_evidence WHERE run_id=?').all(runId);
    const commands = { [commandId]: { argv: ['node', '--test', 'src/value.test.mjs'], timeoutMs: 15000, maxOutputBytes: 64000,
      assertionReporter: 'node-test-v1', nodeTestDiscovery: { directories: ['src'] } } };
    let mappingCalls = 0;
    const acceptanceMapping = { policyId: 'trusted-synthetic-recheck-preflight-v1', proposer: { async complete(input) {
      mappingCalls++;
      const value = JSON.parse(input.user); assert.equal(value.candidateSha, candidateSha);
      return { version: 2, requestHash: value.requestHash, bindings: [
        ['src/value.test.mjs', 'candidate_value'], ['src/isolation.test.mjs', 'fresh_stage_and_permissions'],
      ].map(([file, testName]) => {
        const source = value.sources.find(entry => entry.file === file); assert.ok(source);
        return { conditionHash: acceptanceConditionHash(value.conditions[0]), commandId, file, testName, startLine: 1,
          endLine: source.numberedLines.length, rationale: '可信合成夹具精确绑定已提供测试' };
      }) };
    } }, verifier: { async complete(input) {
      mappingCalls++;
      const value = JSON.parse(input.user);
      return { version: 1, requestHash: value.requestHash, proposalHash: value.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(value.request.conditions[0]), state: 'covered', reason: '可信合成夹具已知对应关系，非真实模型评审' }] };
    } } };
    publishVerificationRuntimePolicy(database, { instance: { ownerId, fence: lease.fence }, now: Date.now(),
      repositories: { [repository]: { targetCommands: commands } }, mappingPolicy: acceptanceMapping.policyId });
    const actualRunner = new DockerSandboxedCommandRunner({ docker, containment, image, exchangeRoot: join(root, 'exchange'), user: '0:0', memory: '256m', cpus: '1', pidsLimit: 64 });
    const commandRunner = { async run(request) { requests.push(request); return actualRunner.run(request); } };
    const coordinator = new CandidateVerificationCoordinator(database, { commandRunner, containment, commands, dataDirectory, acceptanceMapping });
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 90000);
    let outcome;
    try { outcome = await coordinator.verify({ candidateRunId: runId, worktreePath: worktree, instance: { ownerId, fence: lease.fence }, now: Date.now(), signal: abort.signal }); }
    finally { clearTimeout(timer); }
    assert.deepEqual(outcome.reasons, [], JSON.stringify(outcome)); assert.equal(outcome.passed, true);
    assert.equal(candidateHasPassedTechnicalReview(database, runId, candidateSha), true);
    assert.equal(requests.length, 2); assert.equal(docker.ids.size, 2);
    const [self, verifier] = requests.map(request => request.sandbox.writableRoot);
    assert.notEqual(self, verifier); assert.notEqual(self, worktree); assert.notEqual(verifier, worktree);
    assert.equal(requests[0].containmentBinding.runId, `${runId}:verifier:1:self-recheck`);
    assert.equal(requests[1].containmentBinding.runId, `${runId}:verifier:1`);
    assert.equal(readFileSync(join(self, '.self-cache'), 'utf8'), 'self-stage-only\n');
    assert.equal(existsSync(join(verifier, '.self-cache')), false);
    for (const tree of [self, verifier, worktree]) { assert.equal(git(tree, ['rev-parse', 'HEAD']), candidateSha); assert.equal(git(tree, ['status', '--porcelain=v1', '--untracked-files=all']), ''); }
    assert.equal(git(repository, ['rev-parse', 'HEAD']), baseSha); assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    assert.deepEqual(database.prepare('SELECT * FROM collaboration_test_evidence WHERE run_id=?').all(runId), originalEvidence);
    const count = table => database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    assert.equal(count('collaboration_verification_commands'), 2); assert.equal(count('collaboration_verification_proofs'), 2);
    const settlements = database.prepare('SELECT evidence_json FROM collaboration_verification_settlements').all(); assert.equal(settlements.length, 1);
    const settlement = JSON.parse(settlements[0].evidence_json); assert.deepEqual(settlement.map(entry => entry.state), ['empty', 'empty']);
    const stages = [];
    for (const [index, id] of [...docker.ids].entries()) {
      const actual = await inspect(id); assert.equal(actual.Name, '/' + dockerCommandContainerName(requests[index].containmentBinding, commandId));
      assert.equal(actual.State.Running, false); assert.equal(actual.State.Pid, 0); assert.equal(actual.State.ExitCode, 0);
      stages.push({ phase: index === 0 ? 'self' : 'verifier', id, name: actual.Name.slice(1), exitCode: actual.State.ExitCode,
        worktree: requests[index].sandbox.writableRoot, mode: (statSync(requests[index].sandbox.writableRoot).mode & 0o777).toString(8), user: actual.Config.User });
    }
    result = { status: 'passed', probe: 'candidate-recheck', syntheticFixture: true, syntheticHistoricalExecutorEvidence: true,
      realModel: false, modelCalls: 0, realGroupMessages: 0, businessAcceptance: false, mapping: 'trusted_synthetic_fixture', mappingCalls,
      technicalGatePassed: true, originalEvidenceUnchanged: true, originalRepositoryUnchanged: true, candidateUnchanged: true,
      ignoredOutputIsolated: true, distinctWorktrees: true, gitAndDirectoryPermissionsChecked: true,
      verificationCommands: 2, verificationProofs: 2, settlementEmptyEntries: settlement.length, stages, candidateRunId: runId, candidateSha, image,
      controllerUid: process.getuid(), controllerFixtureMode: (statSync(root).mode & 0o777).toString(8) };
  } catch (error) { primaryError = error; }
  finally {
    let stopped = 0;
    for (const id of docker.ids) {
      try {
        const actual = await inspect(id);
        if (actual.State.Running) { assert.equal((await docker.run(['kill', id])).exitCode, 0); await docker.run(['wait', id]); }
        const final = await inspect(id); assert.equal(final.State.Running, false); assert.equal(final.State.Pid, 0); stopped++;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (result) result.ownedContainersStopped = stopped;
    database?.close(); service?.close();
  }
  if (primaryError || cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], 'recheck_preflight_failed_or_cleanup_unconfirmed');
  assertRecheckEvidence(result);
  console.log(JSON.stringify(result));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
