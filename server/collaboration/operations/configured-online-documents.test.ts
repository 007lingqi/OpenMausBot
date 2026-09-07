import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configuredOnlineDocuments } from "./configured-online-documents.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "configured-doc-")); roots.push(root);
  const file = join(root, "online.json");
  const config = { version: 1, grants: [{ id: "fixture", profile: "corp:user", conversationId: "group", node: "fixture-node", product: "doc" }],
    transport: { kind: "private_socket", socketPath: "/not-mounted/document.sock" } };
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); write(config);
  return { root, file, config, write, environment: { OMB_DINGTALK_ENABLED: "1", OMB_ONLINE_DOCUMENTS_CONFIG_FILE: file } };
}
it("is opt-in and validates a fixed private configuration without contacting the host", () => {
  expect(configuredOnlineDocuments({}, new Set())).toBeUndefined();
  const h = fixture(), reader = configuredOnlineDocuments(h.environment, new Set(["group"]))!;
  expect(reader.authorizationFingerprint({ conversationId: "group", node: "fixture-node", sourceEventId: "event", normalizedHash: "a".repeat(64) })).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["unlisted-group", "disabled", "bad-permissions", "symlink", "unknown-key", "empty-grants", "duplicate", "relative", "tcp"])("fails closed for %s", mode => {
  const h = fixture(); let allowed = new Set(["group"]);
  if (mode === "unlisted-group") allowed = new Set();
  if (mode === "disabled") h.environment.OMB_DINGTALK_ENABLED = "0";
  if (mode === "bad-permissions") chmodSync(h.file, 0o644);
  if (mode === "symlink") { const link = join(h.root, "alias"); symlinkSync(h.file, link); h.environment.OMB_ONLINE_DOCUMENTS_CONFIG_FILE = link; }
  if (mode === "unknown-key") h.write({ ...h.config, clientSecret: "must-not-print" });
  if (mode === "empty-grants") h.write({ ...h.config, grants: [] });
  if (mode === "duplicate") h.write({ ...h.config, grants: [h.config.grants[0], h.config.grants[0]] });
  if (mode === "relative") h.write({ ...h.config, transport: { kind: "private_socket", socketPath: "relative" } });
  if (mode === "tcp") h.write({ ...h.config, transport: { kind: "http", endpoint: "https://arbitrary.invalid" } });
  expect(() => configuredOnlineDocuments(h.environment, allowed)).toThrow("online_document_configuration_invalid");
});
it("runs only the explicitly configured host CLI and fixed profile, with no project environment", async () => {
  const h = fixture(), executable = join(h.root, "dws.mjs");
  writeFileSync(executable, '#!/usr/bin/env node\nif(process.env.UNTRUSTED_ENV || process.argv.includes("--yes")) process.exit(1); console.log(JSON.stringify({contractVersion:"doc.content.v1",status:"success",complete:true,target:{product:"doc",canonicalId:"fixture-node"},content:"保留用户名"}));', { mode: 0o700 });
  h.write({ ...h.config, transport: { kind: "host_dws", executable, configDirectory: h.root, home: h.root, cwd: h.root, path: `${dirname(process.execPath)}:/usr/bin:/bin` } });
  const reader = configuredOnlineDocuments({ ...h.environment, UNTRUSTED_ENV: "must-not-inherit" }, new Set(["group"]))!;
  expect((await reader.read({ conversationId: "group", node: "fixture-node", sourceEventId: "event", normalizedHash: "a".repeat(64) }, new AbortController().signal)).records[0].text).toBe("保留用户名");
});
