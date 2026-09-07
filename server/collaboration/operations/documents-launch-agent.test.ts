import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function launch(source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'omb-doc-launch-')); roots.push(root);
  cpSync(new URL('../../../packaging/collaboration/documents-launch-agent.mjs', import.meta.url), join(root, 'launcher.mjs'));
  if (source !== undefined) writeFileSync(join(root, 'online-document-bridge.mjs'), source);
  const child = spawn(process.execPath, [join(root, 'launcher.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}
it.each([
  undefined,
  "export function parseOnlineDocumentChannelArgs(){return {mode:'host'};} export async function runOnlineDocumentChannel(){console.log('must not run');}",
  "export function parseOnlineDocumentChannelArgs(){return {mode:'bridge'};} export async function runOnlineDocumentChannel(){console.log('must not run');}",
  "export function parseOnlineDocumentChannelArgs(){return {mode:'bridge',stateFile:'/private/state'};} export async function runOnlineDocumentChannel(){throw Error('private diagnostic');}",
])('parks a missing/invalid/failed document service without retry or private diagnostics (%#)', async source => {
  const p = launch(source);
  try {
    const deadline = Date.now() + 3000;
    while (!p.stderr() && p.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(p.stderr()).toBe('document_channel_service_failed\n'); expect(p.stdout()).toBe(''); expect(p.child.exitCode).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(p.stderr()).toBe('document_channel_service_failed\n'); expect(p.child.exitCode).toBeNull();
    p.child.kill('SIGTERM'); expect(await p.exited).toEqual([0, null]);
  } finally { if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL'); await p.exited; }
});
it('runs a valid document service once and exits normally after its lifecycle settles', async () => {
  const p = launch("export function parseOnlineDocumentChannelArgs(){return {mode:'bridge',stateFile:'/private/state'};} export async function runOnlineDocumentChannel(){console.log('called once');}");
  expect(await p.exited).toEqual([0, null]); expect(p.stdout()).toBe('called once\n'); expect(p.stderr()).toBe('');
});
it('pins an independent document bridge, private state and a bounded clean shutdown', () => {
  const source = readFileSync(new URL('../../../packaging/collaboration/com.openmausbot.documents-pilot-channel.plist', import.meta.url), 'utf8');
  for (const required of ['<string>/usr/bin/env</string>', '<string>-i</string>', '__NODE__', '__RELEASE__/documents-launch-agent.mjs',
    '__ROOT__/state/documents.json', '__ROOT__/config/online.json', '<string>18103</string>', '<string>bridge</string>', 'colima-openmausbot-pilot/ssh.config']) expect(source).toContain(required);
  expect(source).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  expect(source).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>180<\/integer>/);
  expect(source).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
  expect(source).not.toMatch(/NODE_OPTIONS|API_KEY|CLIENT_SECRET|dist-server|StartInterval|WatchPaths/);
});
it('only adds the fixed relay and two existing readonly paths to Docker', () => {
  const source = readFileSync(new URL('../../../packaging/collaboration/docker/compose.documents.yaml', import.meta.url), 'utf8');
  const config = parse(source);
  expect(Object.keys(config)).toEqual(['services']); expect(Object.keys(config.services)).toEqual(['collaboration']);
  const service = config.services.collaboration;
  expect(Object.keys(service).sort()).toEqual(['environment', 'volumes']);
  expect(service.environment).toEqual({ OMB_ONLINE_DOCUMENTS_CONFIG_FILE: '/run/omb-documents-config/online.json',
    OMB_DOCUMENT_RELAY_ENABLED: '1', OMB_DOCUMENT_RELAY_UID: '${OMB_DOCUMENT_RELAY_UID:?required}',
    OMB_DOCUMENT_RELAY_GID: '${OMB_DOCUMENT_RELAY_GID:?required}', OMB_DOCUMENT_RELAY_PORT: '18102',
    OMB_DOCUMENT_RELAY_SOCKET: '/run/omb-document-channel/documents.sock' });
  expect(service.volumes).toHaveLength(2);
  expect(service.volumes.map((v: { target: string }) => v.target)).toEqual(['/run/omb-documents-config/online.json', '/run/omb-document-channel']);
  for (const volume of service.volumes) expect(volume).toMatchObject({ type: 'bind', read_only: true, bind: { create_host_path: false } });
  expect(source).not.toMatch(/privileged:|cap_add:|ports:|network_mode:|\.dws|\.env/);
});
