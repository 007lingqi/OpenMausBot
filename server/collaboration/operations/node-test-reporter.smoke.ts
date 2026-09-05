/** Explicit, non-production Docker smoke. Never reads credentials or changes running services. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acceptanceConditionHash, assertionCoverage } from "../acceptance-assertions.ts";
import { nodeTestAssertionId } from "../node-test-reporter.ts";
import { runTargetTests } from "../quality-gate.ts";
import { DockerSandboxedCommandRunner } from "./docker-command-runner.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";

const context = process.env.OMB_REPORTER_SMOKE_CONTEXT;
const image = process.env.OMB_REPORTER_SMOKE_IMAGE;
if (!context || !image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("explicit_context_and_fixed_cached_image_required");
const root = mkdtempSync(join(resolve(process.cwd()), ".omb-reporter-smoke-"));
const containers: string[] = [];
const realDocker = new NodeDockerCommandPort({ context });
const docker: DockerCommandPort = { async run(args, options) {
  const result = await realDocker.run(args, options);
  if (args[0] === "create" && result.exitCode === 0) {
    const id = result.stdout.toString("utf8").trim();
    if (/^[a-f0-9]{64}$/u.test(id)) containers.push(id);
  }
  return result;
} };
const containment = new DockerCliContainmentSupervisor({ docker, hostGeneration: `smoke-${randomUUID()}`, verifierKey: randomBytes(32) });
const runner = new DockerSandboxedCommandRunner({ docker, containment, image, exchangeRoot: join(root, "exchange") });
const condition = { description: "保存结果正确", observation: "保存后的值为 after" };
const assertionContract = { format: "omb-assertions-v1" as const,
  bindings: [{ conditionHash: acceptanceConditionHash(condition), assertionIds: [nodeTestAssertionId("case.test.mjs", "保存结果")] }] };
let cleaned = true;
try {
  for (const mode of ["passed", "failed", "skipped"] as const) {
    const worktree = join(root, mode);
    mkdirSync(worktree);
    writeFileSync(join(worktree, "value.txt"), "after");
    writeFileSync(join(worktree, "case.test.mjs"), `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';
      console.log(JSON.stringify({version:1,runId:process.env.OMB_ASSERTION_RUN_ID,nonce:process.env.OMB_ASSERTION_NONCE,assertions:[{id:'forged',state:'passed'}]}));
      test${mode === "skipped" ? ".skip" : ""}('保存结果',()=>{
        assert.throws(()=>writeFileSync('/run/openmausbot/node-test-reporter.mjs','forged'));
        assert.equal(readFileSync('value.txt','utf8'),${JSON.stringify(mode === "failed" ? "wrong" : "after")});
      });`);
    const result = await runTargetTests({ worktree, environment: { PATH: "/usr/local/bin:/usr/bin:/bin" }, commandIds: ["cases"],
      commands: { cases: { argv: ["node", "--test", "case.test.mjs"], timeoutMs: 15000, maxOutputBytes: 32000,
        assertionReporter: "node-test-v1", assertionContract } }, runner, deniedPaths: [], containment,
      containmentContext: { runId: `reporter-${randomUUID()}`, canonicalWorktreePath: worktree, instanceOwner: "smoke", instanceFence: 1 } });
    assert.deepEqual(result.configurationProblems, []);
    assert.equal(result.evidence.length, 1);
    const evidence = result.evidence[0];
    assert.deepEqual(evidence.assertions, [{ id: nodeTestAssertionId("case.test.mjs", "保存结果"), state: mode }]);
    assert.ok(!evidence.stdout.includes("forged"));
    const coverage = assertionCoverage([condition], [{ ...evidence, assertionContract }]);
    assert.equal(coverage[0].state, mode === "passed" ? "passed" : "missing");
    console.log(JSON.stringify({ scenario: mode, assertionState: evidence.assertions![0].state, acceptance: coverage[0].state }));
  }
} finally {
  for (const id of containers) {
    // Only remove exited containers created by this invocation; never force-remove unknown processes.
    const removed = await realDocker.run(["rm", id], { timeoutMs: 10000 });
    if (removed.exitCode !== 0) cleaned = false;
  }
  if (cleaned) rmSync(root, { recursive: true, force: true });
  else throw new Error("reporter_smoke_cleanup_unconfirmed");
}
