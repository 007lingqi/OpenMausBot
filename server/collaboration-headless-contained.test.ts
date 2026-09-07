import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCollaborationHeadless } from "./collaboration-headless.ts";
import { DockerContainedPatchAgent } from "./collaboration/operations/contained-patch-agent.ts";
import { DockerPatchAgent } from "./collaboration/operations/docker-patch-agent.ts";
import { DockerCoordinatorAuthority } from "./collaboration/operations/docker-coordinator.ts";
import { DockerUnactivatedLaunchRecovery } from "./collaboration/operations/unactivated-launch.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./collaboration/operations/runtime.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "contained-headless-"))); scratch.push(root);
  const key = join(root, "key"), generation = join(root, "generation"), channel = join(root, "channel");
  writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 }); writeFileSync(generation, "synthetic-boot-generation"); mkdirSync(channel);
  const environment: NodeJS.ProcessEnv = {
    OMB_DINGTALK_ENABLED: "0", OMB_EXECUTION_ENABLED: "1", OMB_EXECUTION_BACKEND: "docker",
    OMB_EXECUTION_REPOSITORY: root, OMB_EXECUTION_WORKTREE_ROOT: join(root, "worktrees"), OMB_EXECUTION_EXCHANGE_ROOT: join(root, "exchange"),
    OMB_EXECUTION_BASE_SHA: "b".repeat(40), OMB_DOCKER_COMMAND_IMAGE: "old-command-image:unchanged", OMB_CONTAINMENT_VERIFIER_KEY_FILE: key,
    OMB_HOST_GENERATION_FILE: generation, OMB_EXECUTION_TARGET_COMMANDS_JSON: JSON.stringify({ cases: { argv: ["node", "--version"], timeoutMs: 1000, maxOutputBytes: 32000 } }),
    OMB_EXECUTION_WRITE_SCOPES_JSON: '["src/**"]', OMB_EXECUTION_ACCEPTANCE_JSON: '[{"description":"拼写正确","observation":"显示hello"}]',
    OMB_DOCKER_PROVIDER_ISOLATION: "task_container", OMB_DOCKER_PROVIDER_IMAGE: "sha256:" + "c".repeat(64),
    OMB_DOCKER_COORDINATOR_CONTAINER: "pilot", OMB_DOCKER_COORDINATOR_IMAGE: "sha256:" + "d".repeat(64),
    OMB_PROVIDER_MODEL_SOCKET_DIRECTORY: channel, OMB_OPENCODEX_RELAY_UID: "501", OMB_OPENCODEX_RELAY_GID: "1000",
    OMB_CODEX_MODEL: "gpt-6-astra", OMB_CODEX_REASONING_EFFORT: "medium", OMB_CODEX_OPENCODEX_ENDPOINT: "http://127.0.0.1:18100/v1/responses",
    OMB_PROVIDER_UID: "10001", OMB_PROVIDER_GID: "10001",
  };
  const seen: CollaborationHeadlessRuntimeOptions[] = [];
  const run = (overrides: NodeJS.ProcessEnv = {}) => runCollaborationHeadless(["--health", "--data-dir", root], { ...environment, ...overrides }, {
    io: { stdin: Readable.from([]), stdout: { write() {} }, stderr: { write() {} }, once() {}, off() {} },
    createRuntime(options) { seen.push(options); return new CollaborationHeadlessRuntime({ dataDirectory: root, probeOnly: true }); },
  });
  return { root, environment, seen, run };
}

describe("headless contained provider assembly", () => {
  it("selects the contained agent with a separately pinned task image without executing a task during health checks", async () => {
    const f = fixture(); await f.run();
    expect(f.seen).toHaveLength(1); expect(f.seen[0].agent).toBeInstanceOf(DockerContainedPatchAgent);
    expect(f.seen[0].commandRunner).toBeDefined(); expect(f.seen[0].executionIsolation).toBe("docker_linux");
    expect(f.seen[0].coordinator).toBeInstanceOf(DockerCoordinatorAuthority);
    expect(f.seen[0].unactivatedLaunchRecovery).toBeInstanceOf(DockerUnactivatedLaunchRecovery);
    expect(f.seen[0].execution?.repositories[f.root].targetCommands.cases.argv).toEqual(["node", "--version"]);
  });
  it.each([
    { OMB_DOCKER_COORDINATOR_CONTAINER: undefined },
    { OMB_DOCKER_COORDINATOR_IMAGE: undefined },
    { OMB_DOCKER_COORDINATOR_IMAGE: "latest" },
    { OMB_DOCKER_PROVIDER_ISOLATION: "typo" },
    { OMB_DOCKER_PROVIDER_IMAGE: undefined },
    { OMB_DOCKER_PROVIDER_IMAGE: "mutable:latest" },
    { OMB_CODEX_MODEL: "other-model" },
    { OMB_CODEX_REASONING_EFFORT: "high" },
    { OMB_CODEX_OPENCODEX_ENDPOINT: "https://remote.invalid/responses" },
    { OMB_CODEX_EXECUTABLE: "/untrusted/cli" },
    { OMB_PROVIDER_SET_PRIV_EXECUTABLE: "/untrusted/launcher" },
    { OMB_PROVIDER_UID: "10002", OMB_PROVIDER_GID: "10002" },
    { OMB_OPENCODEX_RELAY_UID: undefined },
    { OMB_OPENCODEX_RELAY_UID: "10001" },
    { OMB_PROVIDER_MODEL_SOCKET_DIRECTORY: "/nonexistent-contained-channel" },
  ])("fails before runtime creation on an inconsistent contained contract: %j", async override => {
    const f = fixture(); await expect(f.run(override)).rejects.toThrow(); expect(f.seen).toEqual([]);
  });
  it("keeps the explicitly selected legacy mode separate, with no silent fallback from contained failures", async () => {
    const f = fixture(); await f.run({ OMB_DOCKER_PROVIDER_ISOLATION: "shared_process" });
    expect(f.seen[0].agent).toBeInstanceOf(DockerPatchAgent);
  });
});
