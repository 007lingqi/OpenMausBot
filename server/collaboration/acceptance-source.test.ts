import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
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
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/save.mjs"), 'export const save = () => "after";\n');
  writeFileSync(join(root, "src/.env.mjs"), 'const password = "fixture-private";');
  writeFileSync(join(root, "long.test.mjs"), "x".repeat(33000));
  symlinkSync("/private/secret", join(root, "link.test.mjs"));
  git("add", "."); git("commit", "-m", "fixture");
  const candidateSha = git("rev-parse", "HEAD");
  const command: TargetCommandSpec = { argv: ["node", "--test", "case.test.mjs"], assertionReporter: "node-test-v1", timeoutMs: 1000, maxOutputBytes: 32000 };
  return { root, input: { worktree: root, candidateSha, specHash: "a".repeat(64), conditions: [{ description: "保存成功", observation: "显示 after" }], commandIds: ["cases"], commands: { cases: command }, readScope: ["**/*"], denyScope: ["private/**"] } };
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
it("collects explicitly allowed implementation context from the same fixed candidate without executing it", () => {
  const { root, input } = fixture('import {save} from "./src/save.mjs";\ntest("保存",()=>assert.equal(save(),"after"));');
  input.commands.cases.acceptanceSourceFiles = ["src/save.mjs"];
  writeFileSync(join(root, "src/save.mjs"), 'throw new Error("mutable source must not be read or executed");');
  const request = collectAcceptanceMappingRequest(input);
  expect(request.sources).toHaveLength(2);
  expect(request.sources[1]).toMatchObject({ commandId: "cases", file: "src/save.mjs", role: "implementation", text: 'export const save = () => "after";\n' });
  expect(request.sources[1].blobSha).toMatch(/^[a-f0-9]{40}$/);
});
it.each(["src/save.mjs", "case.test.mjs"])("enforces plan read and deny scopes for every selected source: %s", file => {
  const { input } = fixture();
  input.commands.cases.acceptanceSourceFiles = ["src/save.mjs"];
  expect(() => collectAcceptanceMappingRequest({ ...input, denyScope: [file] })).toThrow("acceptance_source_scope_denied");
  expect(() => collectAcceptanceMappingRequest({ ...input, readScope: file === "src/save.mjs" ? ["case.test.mjs"] : ["src/**"] }))
    .toThrow("acceptance_source_scope_denied");
});
it.each(["../outside.mjs", "/outside.mjs", "src/../case.test.mjs", "src/*.mjs", "src/.env.mjs", "link.test.mjs", "missing.mjs"])("rejects unsafe or unavailable implementation selection: %s", file => {
  const { input } = fixture(); input.commands.cases.acceptanceSourceFiles = [file];
  expect(() => collectAcceptanceMappingRequest(input)).toThrow();
});
it("does not treat imported but unlisted files as authorized source context", () => {
  const { input } = fixture('import "./src/save.mjs"; test("保存",()=>{});');
  expect(collectAcceptanceMappingRequest(input).sources.map(s => s.file)).toEqual(["case.test.mjs"]);
});
it("keeps implementation paths repository-relative even when the test command has a cwd", () => {
  const { input } = fixture();
  input.commands.cases.cwd = "src";
  input.commands.cases.argv = ["node", "--test", "save.mjs"];
  input.commands.cases.acceptanceSourceFiles = ["case.test.mjs"];
  expect(collectAcceptanceMappingRequest(input).sources.map(s => s.file)).toEqual(["src/save.mjs", "case.test.mjs"]);
});
it("refuses duplicate roles, empty read scopes, denied ancestor directories and excessive context", () => {
  const { input } = fixture();
  expect(() => collectAcceptanceMappingRequest({ ...input, readScope: [] })).toThrow("acceptance_source_scope_denied");
  input.commands.cases.acceptanceSourceFiles = ["case.test.mjs"];
  expect(() => collectAcceptanceMappingRequest(input)).toThrow("acceptance_source_duplicate");
  input.commands.cases.acceptanceSourceFiles = ["src/save.mjs"];
  expect(() => collectAcceptanceMappingRequest({ ...input, denyScope: ["src"] })).toThrow("acceptance_source_scope_denied");
  input.commands.cases.acceptanceSourceFiles = Array.from({ length: 16 }, (_, i) => `src/file-${i}.mjs`);
  expect(() => collectAcceptanceMappingRequest(input)).toThrow("acceptance_source_limit");
});
