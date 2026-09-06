import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectAcceptanceMappingRequest } from "./acceptance-source.ts";
import { mappingRequestHash } from "./acceptance-mapping.ts";
import { redactSensitiveSource } from "./sensitive-source.ts";
import type { TargetCommandSpec } from "./quality-gate.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(source = "test('保存',()=>{assert.equal(save(),'after');});\n") {
  const root = mkdtempSync(join(tmpdir(), "omb-source-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "case.test.mjs"), source);
  writeFileSync(join(root, "long.test.mjs"), "x".repeat(33000));
  symlinkSync("/private/secret", join(root, "link.test.mjs"));
  git("add", "."); git("commit", "-m", "fixture");
  const candidateSha = git("rev-parse", "HEAD");
  const command: TargetCommandSpec = { argv: ["node", "--test", "case.test.mjs"], assertionReporter: "node-test-v1", timeoutMs: 1000, maxOutputBytes: 32000 };
  return { root, input: { worktree: root, candidateSha, specHash: "a".repeat(64), conditions: [{ description: "保存成功", observation: "显示 after" }], commandIds: ["cases"], commands: { cases: command } } };
}
it("reads the fixed Git blob rather than a mutable or injected worktree file", () => {
  const { root, input } = fixture();
  writeFileSync(join(root, "case.test.mjs"), "changed after candidate was fixed");
  const request = collectAcceptanceMappingRequest(input);
  expect(request.sources[0]).toMatchObject({ commandId: "cases", file: "case.test.mjs", text: "test('保存',()=>{assert.equal(save(),'after');});\n" });
  expect(request.sources[0].blobSha).toMatch(/^[a-f0-9]{40}$/);
});
it("refuses symlinks, missing paths, oversized files and nonliteral commands", () => {
  const { input } = fixture();
  for (const path of ["link.test.mjs", "missing.test.mjs", "long.test.mjs", "../outside.test.mjs", "--import=evil.mjs"]) {
    input.commands.cases.argv = ["node", "--test", path];
    expect(() => collectAcceptanceMappingRequest(input)).toThrow();
  }
});
it("redacts fixed source values without losing operators, evidence lines or canonical identity", () => {
  const source = 'function login(password) { return password === "fixture-value"; }\n' +
    'test("登录", () => { assert.equal(login(input), false); });\n';
  const { input } = fixture(source);
  const request = collectAcceptanceMappingRequest(input);
  expect(request.sources[0].text).toBe(redactSensitiveSource(source, "case.test.mjs"));
  expect(request.sources[0].text).not.toContain("fixture-value");
  expect(request.sources[0].text.split("\n")[1]).toBe(source.split("\n")[1]);
  expect(mappingRequestHash(request)).toBe(mappingRequestHash({ ...request,
    sources: request.sources.map(s => ({ ...s, text: redactSensitiveSource(s.text, s.file) })) }));
});
it("refuses malformed Git source without exposing parser diagnostics or source values", () => {
  const { input } = fixture('const password = "fixture-value');
  expect(() => collectAcceptanceMappingRequest(input)).toThrow("sensitive_source_unavailable");
});
