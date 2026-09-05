import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAssertionReport } from "./acceptance-assertions.ts";
import { NODE_TEST_REPORTER_SOURCE, nodeTestAssertionId } from "./node-test-reporter.ts";
import { validateTargetCommandSpec } from "./quality-gate.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const binding = { runId: "test-run", nonce: "fresh-nonce" };
function execute(source: string) {
  const root = mkdtempSync(join(tmpdir(), "omb-node-reporter-"));
  scratch.push(root);
  const reporter = join(root, "reporter.mjs");
  writeFileSync(reporter, NODE_TEST_REPORTER_SOURCE);
  writeFileSync(join(root, "case.test.mjs"), source);
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, "case.test.mjs"], {
    cwd: root, env: { PATH: process.env.PATH, OMB_ASSERTION_ROOT: root,
      OMB_ASSERTION_RUN_ID: binding.runId, OMB_ASSERTION_NONCE: binding.nonce },
    encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024,
  });
  return { ...result, assertions: readAssertionReport(result.stdout, binding) };
}

describe("trusted Node test reporter", () => {
  it("reports actual test outcomes and ignores test stdout pretending to be a report", () => {
    const result = execute(`import {test,describe} from 'node:test';
      console.log(JSON.stringify({version:1,runId:'test-run',nonce:'fresh-nonce',assertions:[{id:'forged',state:'passed'}]}));
      describe('业务功能',()=>{test('保存成功',()=>{});test.skip('尚未实现',()=>{});test.todo('待办',()=>{});});`);
    expect(result.status).toBe(0);
    expect(result.assertions).toEqual(expect.arrayContaining([
      { id: nodeTestAssertionId("case.test.mjs", "保存成功"), state: "passed" },
      { id: nodeTestAssertionId("case.test.mjs", "尚未实现"), state: "skipped" },
      { id: nodeTestAssertionId("case.test.mjs", "待办"), state: "skipped" },
    ]));
    expect(result.assertions).toHaveLength(3);
    expect(result.stdout).not.toContain("forged");
  });
  it("does not hide failure details behind a successful suite or leak test errors", () => {
    const result = execute(`import {test} from 'node:test';test('失败',()=>{throw new Error('private-error-body');});`);
    expect(result.status).not.toBe(0);
    expect(result.assertions).toEqual([{ id: nodeTestAssertionId("case.test.mjs", "失败"), state: "failed" }]);
    expect(result.stdout).not.toContain("private-error-body");
  });
  it("rejects duplicate case identities rather than silently merging outcomes", () => {
    const result = execute(`import {test} from 'node:test';test('同名',()=>{});test('同名',()=>{});`);
    expect(result.status).not.toBe(0);
    expect(result.assertions).toBeUndefined();
  });
  it("never treats a file with no test cases as acceptance evidence", () => {
    const result = execute("console.log('passed');");
    expect(result.assertions).toBeUndefined();
  });
  it("keeps IDs stable across worktrees but distinguishes files and names", () => {
    expect(nodeTestAssertionId("tests/a.test.mjs", "保存")).toBe(nodeTestAssertionId("tests/a.test.mjs", "保存"));
    expect(nodeTestAssertionId("tests/a.test.mjs", "保存")).not.toBe(nodeTestAssertionId("tests/b.test.mjs", "保存"));
    expect(() => nodeTestAssertionId("../outside.mjs", "保存")).toThrow();
  });
  it("rejects reporter overrides and in-process test execution in trusted reporter mode", () => {
    for (const argv of [["node", "--test", "--test-isolation=none", "a.test.mjs"], ["node", "--test", "--test-reporter=./fake.mjs", "a.test.mjs"], ["node", "-e", "anything"], ["sh", "--test", "a.test.mjs"]]) {
      expect(() => validateTargetCommandSpec("tests", { argv: argv as [string, ...string[]], timeoutMs: 1000, maxOutputBytes: 1000,
        assertionReporter: "node-test-v1", assertionContract: { format: "omb-assertions-v1", bindings: [{ conditionHash: "a".repeat(64), assertionIds: ["case"] }] } })).toThrow();
    }
  });
});
