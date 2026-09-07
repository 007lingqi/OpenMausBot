import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseOnlineDocumentChannelArgs, startOnlineDocumentBridge } from "./online-document-bridge.ts";
import type { PrivateSshOperations } from "./opencodex-ssh-channel.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const reader = { authorizationFingerprint() { throw new Error("fixture_no_authorized_source"); }, async read(): Promise<never> { throw new Error("must_not_read"); } };
async function setup() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "document-bridge-")); chmodSync(root, 0o700);
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => server.close(() => resolve()));
  const ops: PrivateSshOperations = { master: vi.fn(async () => "master-1"), prepare: vi.fn(async () => {}), connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}), inspect: vi.fn(async () => true), cleanup: vi.fn(async () => {}) };
  return { reader, port: address.port, sshConfig: "/fixture/colima-openmausbot-pilot/ssh.config", stateFile: join(root, "state.json"), operations: ops, intervalMs: 60000 };
}
it("forwards on a separate document socket and closes its channel without issuing reads", async () => {
  const options = await setup(), bridge = await startOnlineDocumentBridge(options); cleanup.push(bridge.close);
  await vi.waitFor(() => expect(bridge.snapshot().status).toBe("connected"));
  expect(bridge.socketPath).toBe(`/tmp/omb-documents-channel-${options.port}/documents.sock`);
  const response = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(400); await bridge.close(); expect(bridge.snapshot().status).toBe("stopped");
});
it("reserves persistent attempts before each forward and stops at three across host restarts", async () => {
  const options = await setup(); vi.mocked(options.operations.connect).mockRejectedValue(new Error("fixture"));
  for (let i = 1; i <= 4; i++) {
    const bridge = await startOnlineDocumentBridge(options);
    await vi.waitFor(() => expect(["failed", "retrying"]).toContain(bridge.snapshot().status)); await bridge.close();
    expect(JSON.parse(readFileSync(options.stateFile, "utf8")).attempts).toBe(Math.min(i, 3));
  }
  expect(options.operations.connect).toHaveBeenCalledTimes(3);
});
it("refuses a busy listener before touching SSH", async () => {
  const options = await setup(), server = createServer(); server.listen(options.port, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise(resolve => server.close(() => resolve())));
  await expect(startOnlineDocumentBridge(options)).rejects.toThrow(); expect(options.operations.master).not.toHaveBeenCalled();
});
it("requires a journal, named pilot and canonical paths for bridge mode", () => {
  expect(parseOnlineDocumentChannelArgs(["--mode", "host", "--config", "/fixture/config", "--port", "0"]).mode).toBe("host");
  for (const args of [[], ["--mode", "host", "--config", "relative", "--port", "0"],
    ["--mode", "bridge", "--config", "/fixture/config", "--port", "12345"],
    ["--mode", "bridge", "--config", "/fixture/config", "--port", "12345", "--ssh-config", "/default/ssh.config", "--state-file", "/fixture/state"]]) {
    expect(() => parseOnlineDocumentChannelArgs(args)).toThrow("online_document_bridge_configuration_invalid");
  }
});
