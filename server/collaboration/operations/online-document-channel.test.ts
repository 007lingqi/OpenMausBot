import { once } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CommandCleanupError } from "../execution-limits.ts";
import { DwsOnlineDocumentReader, type OnlineReadGrant, type OnlineDocumentReader } from "./dws-online-reader.ts";
import { DockerRelayOnlineDocumentReader, PrivateSocketOnlineDocumentReader, startOnlineDocumentGateway } from "./online-document-channel.ts";
import { startOnlineDocumentRelay } from "./online-document-relay.ts";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const grant: OnlineReadGrant = { id: "fixture", profile: "fixture:reader", conversationId: "group", node: "fixture-node", product: "doc" };
const source = { conversationId: "group", node: "fixture-node", sourceEventId: "event", normalizedHash: "a".repeat(64) };
function fixtureReader() {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify({ contractVersion: "doc.content.v1", status: "success",
    complete: true, target: { product: "doc", canonicalId: "fixture-node" }, content: "保留用户名；api_key=sk-fixture-secret-123456789012345" })),
    stderr: Buffer.alloc(0), timedOut: false, outputLimitExceeded: false }));
  return { reader: new DwsOnlineDocumentReader([grant], { run }), run };
}
async function fixture(reader: OnlineDocumentReader = fixtureReader().reader) {
  const root = mkdtempSync(join(realpathSync("/tmp"), "omb-doc-")); chmodSync(root, 0o700);
  closes.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const gateway = await startOnlineDocumentGateway({ reader }); closes.push(gateway.close);
  const socketPath = join(root, "document.sock"), received: Buffer[] = [];
  // A real local Unix-to-loopback forward substitutes only SSH/VM transport; the protocol and reader execute unchanged.
  const forward = createServer(socket => {
    const upstream = connect(Number(new URL(gateway.url).port), "127.0.0.1");
    socket.on("data", chunk => received.push(Buffer.from(chunk)));
    socket.pipe(upstream).pipe(socket); socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
  });
  forward.listen(socketPath); await once(forward, "listening"); chmodSync(socketPath, 0o600);
  closes.push(() => new Promise(resolve => forward.close(() => resolve())));
  return { gateway, root, socketPath, client: new PrivateSocketOnlineDocumentReader([grant], socketPath), received };
}
async function throughRelay(h: Awaited<ReturnType<typeof fixture>>) {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const relay = await startOnlineDocumentRelay({ socketPath: h.socketPath, port: address.port }); closes.push(relay.close);
  return new DockerRelayOnlineDocumentReader([grant], address.port);
}
it("carries a source-bound sanitized receipt through a private socket without sending a profile or command", async () => {
  const { reader, run } = fixtureReader(), h = await fixture(reader);
  const result = await h.client.read(source, new AbortController().signal);
  expect(result.records[0].text).toContain("保留用户名");
  expect(JSON.stringify(result)).not.toContain("sk-fixture-secret");
  expect(result.grantFingerprint).toBe(reader.authorizationFingerprint(source)); expect(run).toHaveBeenCalledOnce();
  const wire = Buffer.concat(h.received).toString();
  expect(wire).toContain(source.normalizedHash); expect(wire).not.toContain(grant.profile); expect(wire).not.toContain("--profile");
});
it("connects controller, unprivileged relay, private socket and host reader while the startup probe reads nothing", async () => {
  const { reader, run } = fixtureReader(), h = await fixture(reader), listener = createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening"); const address = listener.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const relay = await startOnlineDocumentRelay({ socketPath: h.socketPath, port: address.port }); closes.push(relay.close);
  expect(run).not.toHaveBeenCalled();
  const controller = new DockerRelayOnlineDocumentReader([grant], address.port);
  expect((await controller.read(source, new AbortController().signal)).records[0].text).toContain("保留用户名");
  expect(run).toHaveBeenCalledOnce();
  await expect(controller.read({ ...source, conversationId: "outside" }, new AbortController().signal)).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
});
it.each(["group", "node", "profile", "argv"])("rejects caller-controlled %s before a host CLI call", async mode => {
  const { reader, run } = fixtureReader(), h = await fixture(reader);
  const changed = { ...source, ...(mode === "group" ? { conversationId: "foreign" } : mode === "node" ? { node: "foreign" } : { [mode]: "untrusted" }) };
  const response = await fetch(h.gateway.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, source: changed }) });
  expect(response.status).toBe(400); expect(run).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("untrusted");
});
it.each(["origin", "authorization", "cookie", "sec-fetch-site"])("rejects browser/credential header %s", async header => {
  const { reader, run } = fixtureReader(), h = await fixture(reader);
  const response = await fetch(h.gateway.url, { method: "POST", headers: { "Content-Type": "application/json", [header]: "private" }, body: JSON.stringify({ version: 1, source }) });
  expect(response.status).toBe(400); expect(run).not.toHaveBeenCalled();
});
it("rejects wrong routes, oversized bodies and invalid requests without reading", async () => {
  const { reader, run } = fixtureReader(), h = await fixture(reader);
  for (const [url, body] of [[h.gateway.url + "/extra", "{}"], [h.gateway.url, "x".repeat(9000)], [h.gateway.url, "not-json"]]) {
    expect((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(400);
  }
  expect(run).not.toHaveBeenCalled();
});
it.each(["regular-file", "parent-mode", "socket-mode", "symlink"])("does not connect through an unsafe %s", async mode => {
  const { reader, run } = fixtureReader(), h = await fixture(reader);
  let path = h.socketPath;
  if (mode === "parent-mode") chmodSync(h.root, 0o755);
  if (mode === "socket-mode") chmodSync(h.socketPath, 0o666);
  if (mode === "regular-file") { path = join(h.root, "file"); writeFileSync(path, "private", { mode: 0o600 }); }
  if (mode === "symlink") { path = join(h.root, "link"); symlinkSync(h.socketPath, path); }
  await expect(new PrivateSocketOnlineDocumentReader([grant], path).read(source, new AbortController().signal)).rejects.toThrow("online_document_socket_unavailable");
  expect(run).not.toHaveBeenCalled();
});
it.each(['private_socket', 'docker_relay'])("%s distinguishes settled failure from unconfirmed cleanup without private errors", async transport => {
  const { reader } = fixtureReader();
  for (const unknown of [false, true]) {
    const h = await fixture({ authorizationFingerprint: input => reader.authorizationFingerprint(input), async read() {
      if (unknown) throw new CommandCleanupError(new Error("private-error")); throw new Error("private-error");
    } });
    const client = transport === 'docker_relay' ? await throughRelay(h) : h.client;
    const error = await client.read(source, new AbortController().signal).catch(value => value);
    expect(error).toBeInstanceOf(unknown ? CommandCleanupError : Error);
    if (!unknown) expect(error).not.toBeInstanceOf(CommandCleanupError);
    expect(error.message).not.toContain("private-error");
  }
});
it.each(['private_socket', 'docker_relay'])("%s rejects a receipt for another source even if the server claims success", async transport => {
  const { reader } = fixtureReader();
  const h = await fixture({ authorizationFingerprint: input => reader.authorizationFingerprint(input), async read(input, signal) {
    return { ...await reader.read(input, signal), sourceEventId: "other-event" };
  } });
  const client = transport === 'docker_relay' ? await throughRelay(h) : h.client;
  await expect(client.read(source, new AbortController().signal)).rejects.toBeInstanceOf(CommandCleanupError);
});
it.each(['private_socket', 'docker_relay'])("%s waits for host settlement during shutdown and treats lost response as unknown", async transport => {
  const { reader } = fixtureReader(); let finish!: () => void, started = false;
  const h = await fixture({ authorizationFingerprint: input => reader.authorizationFingerprint(input), async read(input, signal) {
    started = true; await new Promise<void>(resolve => { finish = resolve; }); return reader.read(input, signal);
  } });
  const client = transport === 'docker_relay' ? await throughRelay(h) : h.client;
  const pending = client.read(source, new AbortController().signal).catch(error => error);
  await vi.waitFor(() => expect(started).toBe(true));
  let stopped = false; const stop = h.gateway.close().then(() => { stopped = true; });
  expect(await pending).toBeInstanceOf(CommandCleanupError); expect(stopped).toBe(false);
  finish(); await stop; expect(stopped).toBe(true);
});
it('rejects changed host authorization through the relay even for the same source and body', async () => {
  const { reader } = fixtureReader();
  const h = await fixture({ authorizationFingerprint: input => reader.authorizationFingerprint(input), async read(input, signal) {
    return { ...await reader.read(input, signal), grantFingerprint: 'b'.repeat(64) };
  } });
  const client = await throughRelay(h);
  await expect(client.read(source, new AbortController().signal)).rejects.toBeInstanceOf(CommandCleanupError);
});
it('does not send an already aborted read, and never retries a cancelled in-flight relay read', async () => {
  const { reader } = fixtureReader(); let calls = 0, upstreamSignal: AbortSignal | undefined, finish!: () => void;
  const h = await fixture({ authorizationFingerprint: input => reader.authorizationFingerprint(input), async read(input, signal) {
    calls++; upstreamSignal = signal; await new Promise<void>(resolve => { finish = resolve; }); return reader.read(input, signal);
  } });
  const client = await throughRelay(h), aborted = new AbortController(); aborted.abort();
  await expect(client.read(source, aborted.signal)).rejects.toThrow(); expect(calls).toBe(0);
  const stop = new AbortController(), pending = client.read(source, stop.signal).catch(error => error);
  try {
    await vi.waitFor(() => expect(calls).toBe(1)); stop.abort();
    expect(await pending).toBeInstanceOf(CommandCleanupError);
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true)); expect(calls).toBe(1);
  } finally { stop.abort(); finish?.(); await pending; }
});
