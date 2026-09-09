import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { NODE_TEST_REPORTER_SOURCE, validateNodeTestArgv } from "../node-test-reporter.ts";
import { CommandCleanupError } from "../execution-limits.ts";
import { containmentBindingHash, type ContainmentBinding } from "../containment.ts";

import type {
  SandboxedCommandRequest,
  SandboxedCommandResult,
  SandboxedCommandRunner,
} from "../quality-gate.ts";
import {
  DockerCliContainmentSupervisor,
  type DockerCommandPort,
} from "./docker-containment.ts";

const SAFE_ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;

export function dockerCommandContainerName(binding: ContainmentBinding, commandId: string): string {
  const normalized = `${binding.runId}-${commandId}`.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("docker_container_name_invalid");
  // A full SHA-256 digest fits in 43 base64url characters, leaving 15 for a readable prefix.
  // Hash every binding field: truncating the run id previously discarded both role and nonce.
  const digest = createHash("sha256").update(JSON.stringify({ bindingHash: containmentBindingHash(binding), commandId })).digest("base64url");
  return `omb-${normalized.slice(0, 15)}-${digest}`;
}

function environmentArgs(environment: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!SAFE_ENVIRONMENT_KEY.test(key) || value === undefined || value.includes("\0")) continue;
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

function containerId(stdout: Buffer): string {
  const value = stdout.toString("utf8").trim().toLowerCase();
  if (!CONTAINER_ID.test(value)) throw new Error("docker_create_did_not_return_container_id");
  return value;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("docker_command_cancelled");
}

async function cancellable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotCancelled(signal);
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("docker_command_cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([operation(), cancelled]); }
  finally { if (cancel) signal?.removeEventListener("abort", cancel); }
}

export class DockerSandboxedCommandRunner implements SandboxedCommandRunner {
  private readonly docker: DockerCommandPort;
  private readonly containment: DockerCliContainmentSupervisor;
  private readonly image: string;
  private readonly exchangeRoot: string;
  private readonly user: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;

  constructor(input: {
    docker: DockerCommandPort;
    containment: DockerCliContainmentSupervisor;
    image: string;
    exchangeRoot: string;
    user?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
  }) {
    if (!input.image.trim()) throw new Error("docker_command_image_required");
    this.docker = input.docker;
    this.containment = input.containment;
    this.image = input.image.trim();
    this.exchangeRoot = resolve(input.exchangeRoot);
    this.user = input.user?.trim() || `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;
    this.memory = input.memory?.trim() || "1g";
    this.cpus = input.cpus?.trim() || "1";
    this.pidsLimit = input.pidsLimit ?? 256;
    if (!Number.isSafeInteger(this.pidsLimit) || this.pidsLimit < 16) throw new Error("docker_pids_limit_invalid");
    mkdirSync(this.exchangeRoot, { recursive: true, mode: 0o700 });
  }

  async run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    assertNotCancelled(request.signal);
    if (request.assertionReporter !== undefined) {
      if (request.assertionReporter !== "node-test-v1") throw new Error("docker_assertion_reporter_invalid");
      validateNodeTestArgv(request.argv);
      if (["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].some(key => request.environment[key] !== undefined)) throw new Error("docker_assertion_reporter_environment_invalid");
    }
    const startedAt = Date.now();
    const name = dockerCommandContainerName(request.containmentBinding, request.commandId);
    const runDirectory = join(this.exchangeRoot, name);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const gate = join(runDirectory, "start");
    if (request.assertionReporter) writeFileSync(join(runDirectory, "node-test-reporter.mjs"), NODE_TEST_REPORTER_SOURCE, { mode: 0o444, flag: "wx" });
    const argv = request.assertionReporter
      ? [request.argv[0], "--test-reporter=/run/openmausbot/node-test-reporter.mjs", ...request.argv.slice(1)] : request.argv;
    const labels = this.containment.labels(request.containmentBinding).flatMap((label) => ["--label", label]);
    let id: string;
    try {
      const create = await this.docker.run([
      "create",
      "--name", name,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", String(this.pidsLimit),
      "--memory", this.memory,
      "--cpus", this.cpus,
      "--user", this.user,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--mount", `type=bind,src=${request.sandbox.writableRoot},dst=${request.sandbox.writableRoot}`,
      "--mount", `type=bind,src=${runDirectory},dst=/run/openmausbot,readonly`,
      "--workdir", request.cwd,
      ...environmentArgs(request.environment),
      ...labels,
      "--entrypoint", "/bin/sh",
      this.image,
      "-c", "while [ ! -f /run/openmausbot/start ]; do sleep 0.02; done; exec \"$@\"", "openmausbot-command",
      ...argv,
      ], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
      if (create.exitCode !== 0) throw new Error("docker_command_create_failed");
      id = containerId(create.stdout);
    } catch {
      // No authoritative container id: do not guess a target or discard recovery material.
      throw new CommandCleanupError(new Error("docker_command_create_unconfirmed"));
    }
    let proof;
    let timedOut = false;
    let outputLimitExceeded = false;
    try {
      assertNotCancelled(request.signal);
      const start = await this.docker.run(["start", id], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (start.exitCode !== 0) throw new Error("docker_command_start_failed");
      assertNotCancelled(request.signal);
      proof = await this.containment.issueProof(id, request.containmentBinding);
      await cancellable(() => request.registerContainment(proof!), request.signal);
      assertNotCancelled(request.signal);
      writeFileSync(gate, "start\n", { mode: 0o600 });
      let exitCode: number | null = null;
      try {
        const waited = await cancellable(() => this.docker.run(["wait", id], {
          timeoutMs: request.timeoutMs,
          maxOutputBytes: 16 * 1024,
        }), request.signal);
        const parsed = Number(waited.stdout.toString("utf8").trim());
        exitCode = Number.isSafeInteger(parsed) ? parsed : waited.exitCode === 0 ? 127 : waited.exitCode;
      } catch (error) {
        assertNotCancelled(request.signal);
        timedOut = error instanceof Error && /timeout|timed out/iu.test(error.message);
        const stopped = await this.containment.terminateBoundContainer(id, request.containmentBinding);
        if (stopped.state !== "empty") throw new CommandCleanupError(new Error("docker_command_cleanup_unconfirmed"));
      }
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      try {
        const logs = await this.docker.run(["logs", id], {
          timeoutMs: 10_000,
          maxOutputBytes: request.maxOutputBytes,
        });
        stdout = logs.stdout;
        stderr = logs.stderr;
      } catch (error) {
        outputLimitExceeded = error instanceof Error && error.message === "docker_output_limit_exceeded";
      }
      const inspected = await this.containment.inspect(proof.identity);
      assertNotCancelled(request.signal);
      const processTreeReaped = inspected.state === "empty";
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        outputLimitExceeded,
        attestation: {
          sandboxEnforced: true,
          writableRoot: request.sandbox.writableRoot,
          deniedPaths: [...request.sandbox.deniedPaths],
          network: "deny",
          processIsolated: true,
          processTreeReaped,
          containmentProof: proof,
          ...(request.assertionReporter ? { assertionReporter: request.assertionReporter } : {}),
        },
      };
    } finally {
      try {
        const stopped = await this.containment.terminateBoundContainer(id, request.containmentBinding);
        if (stopped.state !== "empty") throw new Error("docker_command_cleanup_unconfirmed");
      } catch {
        throw new CommandCleanupError(new Error("docker_command_cleanup_unconfirmed"));
      }
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}

export const dockerCommandGateName = (path: string): string => basename(path);
