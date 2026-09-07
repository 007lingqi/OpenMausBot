/** Synthetic cross-UID Docker check. Never accesses DWS, a model, or a live Ledger. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, chownSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { DockerRelayOnlineDocumentReader, startOnlineDocumentGateway } from './online-document-channel.ts';
import { documentRelayLaunchConfiguration } from './docker-service-supervisor.ts';
import { DwsOnlineDocumentReader, type OnlineReadGrant } from './dws-online-reader.ts';

const socketPath = '/tmp/document-channel/documents.sock', port = 18102;
const grant: OnlineReadGrant = { id: 'fixture', profile: 'fixture:reader', conversationId: 'fixture-group', node: 'fixture-node', product: 'doc' };
const source = { conversationId: grant.conversationId, node: grant.node, sourceEventId: 'fixture-event', normalizedHash: 'a'.repeat(64) };
const config = documentRelayLaunchConfiguration({ OMB_DOCUMENT_RELAY_ENABLED: '1', OMB_DOCUMENT_RELAY_UID: '501',
  OMB_DOCUMENT_RELAY_GID: '1000', OMB_DOCUMENT_RELAY_PORT: String(port), OMB_DOCUMENT_RELAY_SOCKET: socketPath })!;
const emit = (event: string) => process.stdout.write(JSON.stringify({ event }) + '\n');
let phase = 'identity';

async function host() {
  assert.equal(process.getuid?.(), 501); assert.equal(process.getgid?.(), 1000);
  const reader = new DwsOnlineDocumentReader([grant], { async run() {
    emit('fixture_read');
    return { exitCode: 0, timedOut: false, outputLimitExceeded: false, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({
      contractVersion: 'doc.content.v1', status: 'success', complete: true, target: { product: 'doc', canonicalId: grant.node }, content: '登录失败后保留用户名',
    })) };
  } });
  const gateway = await startOnlineDocumentGateway({ reader });
  const forward = createServer(peer => {
    const upstream = connect(Number(new URL(gateway.url).port), '127.0.0.1');
    peer.pipe(upstream).pipe(peer); peer.on('error', () => upstream.destroy()); upstream.on('error', () => peer.destroy());
    peer.on('close', () => upstream.destroy()); upstream.on('close', () => peer.destroy());
  });
  try {
    forward.listen(socketPath); await once(forward, 'listening'); chmodSync(socketPath, 0o600);
    const ended = once(process.stdin, 'end'); process.stdin.resume(); emit('fixture_ready'); await ended;
  } finally { await gateway.close(); await new Promise<void>(resolve => forward.close(() => resolve())); }
}

function start(entry: string, args: string[]) {
  const child = spawn('/usr/bin/setpriv', [...config.args, process.execPath, entry, ...args], { env: config.environment, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, exited, stdout: () => stdout, stderr: () => stderr, async ready(event: string) {
    const deadline = Date.now() + 5000;
    while (!stdout.includes(event) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(child.exitCode, null); assert.equal(stderr, ''); assert.ok(stdout.includes(event));
  }, async stop() { child.stdin.end(); assert.deepEqual(await exited, [0, null]); assert.equal(stderr, ''); } };
}

async function controller() {
  assert.equal(process.getuid?.(), 0);
  const status = readFileSync('/proc/self/status', 'utf8');
  assert.equal(BigInt('0x' + status.match(/^CapEff:\s*([a-f0-9]+)/mi)![1]), 0xc1n); // CHOWN, SETGID, SETUID only.
  assert.match(status, /^NoNewPrivs:\s*1$/m);
  phase = 'private_directory';
  mkdirSync('/tmp/document-channel', { mode: 0o700 }); chownSync('/tmp/document-channel', 501, 1000);
  phase = 'fixture_host';
  const upstream = start(fileURLToPath(import.meta.url), ['host']);
  let relay: ReturnType<typeof start> | undefined;
  try {
    await upstream.ready('fixture_ready');
    phase = 'root_denied';
    assert.throws(() => statSync(socketPath), { code: 'EACCES' });
    phase = 'relay_start';
    relay = start(fileURLToPath(new URL('./online-document-relay.mjs', import.meta.url)), config.channelArgs);
    await relay.ready('online_document_channel_ready');
    const reads = () => upstream.stdout().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value => value.event === 'fixture_read').length;
    assert.equal(reads(), 0);
    phase = 'source_read';
    const reader = new DockerRelayOnlineDocumentReader([grant], port);
    const result = await reader.read(source, AbortSignal.timeout(5000));
    assert.equal(result.sourceEventId, source.sourceEventId); assert.equal(result.records[0].text, '登录失败后保留用户名');
    phase = 'authorization';
    await assert.rejects(reader.read({ ...source, conversationId: 'unapproved' }, AbortSignal.timeout(5000)));
    const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, source: { ...source, node: 'unapproved' } }), signal: AbortSignal.timeout(5000) });
    assert.equal((await response.json() as { status: string }).status, 'failure');
    assert.equal(reads(), 1);
    await relay.stop(); relay = undefined;
    emit('docker_document_relay_fixture_passed');
  } finally { if (relay) await relay.stop(); await upstream.stop(); }
}
// In the isolated test container, PID 1 teardown is the final bound for an uncooperative child.
const timer = setTimeout(() => { process.stderr.write('document_fixture_timeout\n'); process.exit(1); }, 20000);
try { if (process.argv[2] === 'host') await host(); else await controller(); }
catch { process.stderr.write(`document_fixture_failed:${phase}\n`); process.exitCode = 1; }
finally { clearTimeout(timer); }
