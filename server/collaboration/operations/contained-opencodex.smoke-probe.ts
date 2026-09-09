// One-shot real-model component check on a NEW, synthetic, non-production
// repository. Never replay the historical failed engine work item here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunRequest } from "../provider-runner.ts";
import { DockerContainedPatchAgent } from "./contained-patch-agent.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";

async function main(): Promise<void> {
  const root = process.env.OMB_CONTAINED_REAL_ROOT!, image = process.env.OMB_CONTAINED_REAL_IMAGE!;
  assert.equal(root, "/var/lib/docker/volumes/omb-contained-real-worker-v1/_data");
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  const attempt = join(root, "attempt-1"); mkdirSync(attempt, { mode: 0o700 }); // Exclusive; no retry/reset.
  const save = (file: string, value: unknown) => writeFileSync(join(attempt, file), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  const cwd = join(root, "candidate"); mkdirSync(join(cwd, "src"), { recursive: true, mode: 0o755 });
  writeFileSync(join(cwd, "src/greeting.js"), 'export function greeting() { return "helo"; }\n', { mode: 0o644 });
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Contained Smoke", "-c", "user.email=smoke@example.invalid", ...args], { stdio: "ignore" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "synthetic greeting fixture");
  const sourceSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runId = randomUUID(), raw = new NodeDockerCommandPort();
  let id: string | undefined, control = "", registered = false;
  const docker: DockerCommandPort = { async run(args, options) {
    if (args[0] === "create") control = args[args.indexOf("--mount") + 1].split(",")[1].slice(4);
    const result = await raw.run(args, options);
    if (args[0] === "create" && result.exitCode === 0) {
      id = result.stdout.toString().trim(); save("container.json", { id, image });
    }
    return result;
  } };
  const containment = new DockerCliContainmentSupervisor({ docker, hostGeneration: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), verifierKey: randomBytes(32) });
  const binding = { runId, canonicalWorktreePath: cwd, instanceOwner: "one-shot-contained-model-probe", instanceFence: 1, nonce: randomBytes(32).toString("hex") };
  // SAFETY: every AgentRunRequest field is locally constructed for this synthetic repo, whose committed sourceSha was fixed above.
  const request = { runId, cwd, sourceSha, workItemId: "WI-SYNTHETIC-GREETING", threadId: runId, turnId: runId, nodeId: "modify", planRevision: 1,
    objective: '修复问候文本的拼写：src/greeting.js 的 greeting() 当前返回 "helo"，应返回 "hello"。',
    instructions: "只修复这一个返回文本，不新增文件、不改接口。之后由可信执行器与独立检查分别验证；本阶段只提交修改建议。",
    inputEvidence: ["受信任测试夹具，不是真实群任务。"], readScope: ["src/greeting.js"], writeScope: ["src/greeting.js"], denyScope: [".git", ".env*"],
    expectedArtifacts: ["src/greeting.js"], completionDefinition: 'greeting() 返回严格相等的字符串 "hello"。', environment: {},
    capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: cwd, readOnlyPaths: [], denyGitMetadata: true, network: "deny" }, containmentBinding: binding,
    signal: new AbortController().signal, emit: () => {}, registerContainment: async proof => {
      assert.equal((await containment.verifyProof(proof, binding)).verified, true);
      assert.equal(existsSync(join(control, "proposal.start")), false);
      save("registration.json", { identity: proof.identity, modelGateWasClosed: true }); registered = true;
    },
  } as AgentRunRequest;
  save("attempt.json", { attempt: 1, image, model: "gpt-6-astra", reasoningEffort: "medium", source: "new synthetic greeting fixture",
    requestHash: createHash("sha256").update(JSON.stringify({ objective: request.objective, instructions: request.instructions, source: readFileSync(join(cwd, "src/greeting.js"), "utf8") })).digest("hex") });
  const agent = new DockerContainedPatchAgent({ docker, containment, image, exchangeRoot: join(root, "exchange"),
    modelSocketDirectory: "/tmp/omb-model-channel-18101", relayUid: Number(process.env.OMB_CONTAINED_REAL_RELAY_UID), relayGid: Number(process.env.OMB_CONTAINED_REAL_RELAY_GID), timeoutMs: 180_000 });
  try {
    const result = await agent.run(request);
    save("provider-result.json", { status: result.status, registered, containerId: result.containmentProof?.identity.opaqueId,
      candidateHash: createHash("sha256").update(readFileSync(join(cwd, "src/greeting.js"))).digest("hex") });
    assert.equal(registered, true); assert.equal(result.status, "completed"); assert.equal(result.containmentProof?.identity.opaqueId, id);
    const checks: string[] = [];
    // Separate read-only containers; these are component assertions, not a
    // forged engine Spec/Meta acceptance receipt or a real group delivery.
    for (const role of ["developer", "independent-verifier"]) {
      const name = `omb-contained-real-${role}-${runId}`;
      const created = await raw.run(["create", "--name", name, "--label", `com.openmausbot.contained-real-probe=${runId}`,
        "--network", "none", "--read-only", "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "32", "--memory", "128m", "--cpus", "1", "--mount", `type=bind,src=${cwd},dst=/workspace,readonly`,
        "--entrypoint", "node", image, "--input-type=module", "-e", 'import assert from "node:assert/strict"; import {greeting} from "/workspace/src/greeting.js"; assert.equal(greeting(), "hello"); console.log("greeting assertion passed");']);
      assert.equal(created.exitCode, 0); const checkId = created.stdout.toString().trim();
      const executed = await raw.run(["start", "--attach", checkId], { timeoutMs: 20000 });
      const state = JSON.parse((await raw.run(["inspect", checkId])).stdout.toString())[0];
      save(`${role}.json`, { id: checkId, exit: executed.exitCode, state: state.State.Status, pid: state.State.Pid, candidateHash: createHash("sha256").update(readFileSync(join(cwd, "src/greeting.js"))).digest("hex") });
      assert.equal(executed.exitCode, 0); assert.equal(state.State.Status, "exited"); assert.equal(state.State.Pid, 0); checks.push(role);
    }
    save("result.json", { status: "passed", model: "gpt-6-astra", reasoningEffort: "medium", registeredBeforeModel: true, checks, engineMetaAcceptance: false, realGroupMessages: 0 });
    console.log(JSON.stringify({ status: "passed", registeredBeforeModel: true, checks, evidenceRoot: attempt, engineMetaAcceptance: false, realGroupMessages: 0 }));
  } catch (error) {
    save("failure.json", { status: "failed", registered, containerId: id, errorClass: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}
void main().catch(() => { process.stderr.write("contained_real_probe_failed_evidence_retained\n"); process.exitCode = 1; });
