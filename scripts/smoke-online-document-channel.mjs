import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { dirname, join } from "node:path";

/** An isolated CLI fixture proves the packaged host entry, not real DWS authorization or document content. */
export async function smokeOnlineDocumentChannel(entry, environment, staging, relayEntry) {
  const executable = join(staging, "fixture-dws.mjs"), config = join(staging, "fixture-documents.json");
  writeFileSync(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({contractVersion:"doc.content.v1",status:"success",complete:true,target:{product:"doc",canonicalId:"fixture-node"},content:"登录失败后保留用户名"}));\n', { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ version: 1, grants: [{ id: "fixture", profile: "fixture:reader", conversationId: "fixture-group", node: "fixture-node", product: "doc" }],
    transport: { kind: "host_dws", executable, configDirectory: staging, home: staging, cwd: staging, path: `${dirname(process.execPath)}:/usr/bin:/bin` } }), { mode: 0o600 });
  const child = execFile(process.execPath, [entry, "--mode", "host", "--config", config, "--port", "0"], {
    cwd: staging, env: { ...environment, OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "fixture-group" }, timeout: 20000,
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk; });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes("\n") && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const ready = JSON.parse(output.trim().split(/\r?\n/).at(-1) || "null");
    if (ready?.event !== "online_document_channel_ready" || child.exitCode !== null) throw new Error("packaged document channel did not start");
    const invoke = source => fetch(ready.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, source }), signal: AbortSignal.timeout(5000) });
    const source = { conversationId: "fixture-group", node: "fixture-node", sourceEventId: "fixture-event", normalizedHash: "a".repeat(64) };
    if ((await invoke({ ...source, conversationId: "unapproved" })).status !== 400) throw new Error("packaged document channel accepted an unapproved group");
    const result = await (await invoke(source)).json();
    if (result.version !== 1 || result.status !== "success" || result.cleanupConfirmed !== true || result.receipt?.sourceEventId !== source.sourceEventId ||
      result.receipt?.records?.[0]?.text !== "登录失败后保留用户名") throw new Error("packaged document channel did not return bound fixture evidence");
    if (process.platform !== 'win32') await smokeRelay(ready.url, relayEntry, source, environment, staging);
    child.kill("SIGTERM"); const ended = await exit;
    if (ended.code !== 0) throw new Error("packaged document channel did not shut down cleanly");
    console.log("packaged document host channel validates grants, reads a synthetic CLI and exits cleanly ✓");
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exit; } }
}

async function smokeRelay(hostUrl, entry, source, environment, cwd) {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'omb-doc-relay-')); chmodSync(root, 0o700);
  const socket = join(root, 'documents.sock');
  const forward = createServer(peer => {
    const upstream = connect(Number(new URL(hostUrl).port), '127.0.0.1');
    peer.pipe(upstream).pipe(peer); peer.on('error', () => upstream.destroy()); upstream.on('error', () => peer.destroy());
    peer.on('close', () => upstream.destroy()); upstream.on('close', () => peer.destroy());
  });
  let relay, relayExit;
  try {
    forward.listen(socket); await once(forward, 'listening'); chmodSync(socket, 0o600);
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    relay = spawn(process.execPath, [entry, '--port', String(port), '--socket', socket, '--parent-stdin', '1'], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    relayExit = once(relay, 'exit'); let output = '', errors = '';
    relay.stdout.on('data', chunk => { output = (output + chunk).slice(0, 4096); }); relay.stderr.on('data', chunk => { errors = (errors + chunk).slice(0, 4096); });
    const deadline = Date.now() + 5000;
    while (!output.includes('\n') && relay.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const ready = JSON.parse(output.trim() || 'null');
    if (errors || ready?.event !== 'online_document_channel_ready' || ready.mode !== 'relay') throw new Error('packaged document relay did not start');
    const response = await fetch(ready.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, source }), signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (result.status !== 'success' || result.receipt?.sourceEventId !== source.sourceEventId) throw new Error('packaged document relay lost source binding');
    relay.stdin.end();
    const timer = setTimeout(() => relay.kill('SIGKILL'), 5000);
    try { const [code] = await relayExit; if (code !== 0) throw new Error('packaged document relay did not stop on parent-pipe closure'); }
    finally { clearTimeout(timer); }
    console.log('packaged document relay probes the host, forwards a fixture and stops with its parent ✓');
  } finally {
    if (relay?.exitCode === null && relay?.signalCode === null) relay.kill('SIGKILL');
    if (relayExit) await relayExit;
    await new Promise(resolve => forward.close(resolve)); rmSync(root, { recursive: true, force: true });
  }
}
