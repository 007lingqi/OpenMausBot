import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assertionContractSchema, readAssertionReport, type AssertionContract, type AssertionResult } from "./acceptance-assertions.ts";
import { nodeTestAssertionId, validateNodeTestArgv } from "./node-test-reporter.ts";
import type { CandidateTargetSelection } from "./target-test-selection.ts";

import {
  type ContainmentPort,
  type ContainmentBinding,
  type ContainmentProof,
  verifyContainmentProof,
} from "./containment.ts";

const discoveryPath = z.string().min(1).max(2000).refine(path => path !== "." && path !== ".." &&
  !posix.isAbsolute(path) && posix.normalize(path) === path && !path.startsWith("../") &&
  ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || "\\*?[]{}".includes(character)) &&
  !path.split("/").some(segment => /^(?:\.git|\.ssh|node_modules|\.env.*)$/iu.test(segment)));
const discoveryPaths = z.array(discoveryPath).max(16).refine(paths => new Set(paths).size === paths.length);
export const nodeTestDiscoverySchema = z.object({
  directories: discoveryPaths.refine(paths => paths.length > 0).readonly(),
  excludeFiles: discoveryPaths.readonly().optional(),
}).strict().refine(policy => (policy.excludeFiles ?? []).every(file =>
  policy.directories.some(directory => file.startsWith(`${directory}/`))));
export type NodeTestDiscovery = z.infer<typeof nodeTestDiscoverySchema>;

export interface TargetCommandSpec {
  argv: readonly [string, ...string[]];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  assertionContract?: AssertionContract;
  assertionReporter?: "node-test-v1";
  /** Trusted repository-relative source files; never supplied by chat or model output. */
  acceptanceSourceFiles?: readonly string[];
  /** Trusted fixed-commit node:test roots; no import traversal or arbitrary argv. */
  nodeTestDiscovery?: NodeTestDiscovery;
}

export interface SandboxCommandAttestation {
  sandboxEnforced: boolean;
  writableRoot: string;
  deniedPaths: string[];
  network: "deny" | "unknown";
  processIsolated: boolean;
  processTreeReaped: boolean;
  containmentProof?: ContainmentProof;
  assertionReporter?: "node-test-v1";
}

export interface SandboxedCommandRequest {
  signal?: AbortSignal;
  commandId: string;
  argv: readonly [string, ...string[]];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  sandbox: {
    writableRoot: string;
    deniedPaths: string[];
    network: "deny";
  };
  containmentBinding: ContainmentBinding;
  registerContainment(proof: ContainmentProof): Promise<void>;
  assertionReporter?: "node-test-v1";
}

export interface SandboxedCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  attestation: SandboxCommandAttestation;
}

export interface SandboxedCommandRunner {
  run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult>;
}

export interface TestEvidence {
  commandId: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  state: "target_passed" | "failed" | "timeout" | "output_limit";
  containmentFingerprint: string;
  containmentBinding: ContainmentBinding;
  assertions?: AssertionResult[];
}

export type CandidateQualityState =
  | "modified"
  | "target_tests_passed"
  | "test_failed"
  | "not_verified"
  | "invalid"
  | "needs_configuration";

export interface CandidateStatusReport {
  state: CandidateQualityState;
  modified: boolean;
  targetTestsPassed: boolean;
  fullGatePassed: false;
  label: string;
  reasons: string[];
  /** Trusted resolver identity recorded with the original execution receipt. */
  targetSelections?: Readonly<Record<string, CandidateTargetSelection>>;
}

const PACKAGE_MANAGERS = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun"]);
const NETWORK_TOOLS = new Set(["curl", "wget", "ssh", "scp", "rsync"]);

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function validateTargetCommandSpec(commandId: string, spec: TargetCommandSpec): void {
  if (spec.assertionReporter !== undefined && spec.assertionReporter !== "node-test-v1")
    throw new Error("Target command assertion reporter is invalid");
  if (spec.nodeTestDiscovery !== undefined) {
    const policy = nodeTestDiscoverySchema.safeParse(spec.nodeTestDiscovery);
    if (spec.assertionReporter !== "node-test-v1" || !policy.success ||
      spec.argv.slice(2).some(file => policy.data.excludeFiles?.includes(posix.join(spec.cwd ?? ".", file))))
      throw new Error("node_test_discovery_invalid");
  }
  if (spec.acceptanceSourceFiles !== undefined) {
    const files = spec.acceptanceSourceFiles;
    if (spec.assertionReporter !== "node-test-v1" || !Array.isArray(files) || files.length > 16 ||
      new Set(files).size !== files.length) throw new Error("acceptance_source_files_invalid");
    for (const file of files) {
      if (typeof file !== "string" || /[\x00-\x1f\x7f*?\[\]{}]/u.test(file) || !/\.(?:[cm]?js|ts|[jt]sx)$/u.test(file))
        throw new Error("acceptance_source_files_invalid");
      nodeTestAssertionId(file, "validation");
    }
  }
  if (spec.assertionReporter !== undefined) {
    validateNodeTestArgv(spec.argv);
  }
  if (spec.assertionContract !== undefined && !assertionContractSchema.safeParse(spec.assertionContract).success) throw new Error("Target command assertion contract is invalid");
  if (!commandId.trim()) throw new Error("Target command ID is required");
  const executable = spec.argv[0].split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const args = spec.argv.slice(1).map((value) => value.toLowerCase());
  if (NETWORK_TOOLS.has(executable)) throw new Error(`Target command ${commandId} enables network access`);
  if (PACKAGE_MANAGERS.has(executable) && args.some((arg) => ["install", "add", "update", "upgrade", "dlx"].includes(arg))) {
    throw new Error(`Target command ${commandId} installs dependencies`);
  }
  if (spec.cwd && isAbsolute(spec.cwd)) throw new Error(`Target command ${commandId} cwd must be relative`);
  if (spec.timeoutMs <= 0 || spec.maxOutputBytes <= 0) throw new Error(`Target command ${commandId} limits are invalid`);
}

function evidence(
  commandId: string,
  cwd: string,
  spec: TargetCommandSpec,
  result: SandboxedCommandResult,
  containmentFingerprint: string,
  containmentBinding: ContainmentBinding,
): TestEvidence {
  const assertions = spec.assertionContract || spec.assertionReporter ? readAssertionReport(result.stdout.toString("utf8"), containmentBinding) : undefined;
  return {
    commandId,
    argv: [...spec.argv],
    cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    state: result.timedOut
      ? "timeout"
      : result.outputLimitExceeded
        ? "output_limit"
        : result.exitCode === 0
          ? "target_passed"
          : "failed",
    containmentFingerprint,
    containmentBinding,
    ...(assertions ? { assertions } : {}),
  };
}

export async function runTargetTests(input: {
  worktree: string;
  environment: NodeJS.ProcessEnv;
  commandIds: readonly string[];
  commands: Readonly<Record<string, TargetCommandSpec>>;
  runner: SandboxedCommandRunner | undefined;
  deniedPaths: readonly string[];
  containment: ContainmentPort;
  containmentContext: Omit<ContainmentBinding, "commandId" | "nonce">;
  signal?: AbortSignal;
}): Promise<{ evidence: TestEvidence[]; configurationProblems: string[] }> {
  input.signal?.throwIfAborted();
  const root = realpathSync(input.worktree);
  const results: TestEvidence[] = [];
  const configurationProblems: string[] = [];
  if (!input.runner) return { evidence: [], configurationProblems: ["sandboxed command runner unavailable"] };
  const deniedPaths = [...new Set(input.deniedPaths.map((path) => realpathSync(path)))].sort();
  for (const commandId of input.commandIds) {
    input.signal?.throwIfAborted();
    const spec = input.commands[commandId];
    if (!spec) {
      configurationProblems.push(`missing command: ${commandId}`);
      continue;
    }
    validateTargetCommandSpec(commandId, spec);
    const cwd = realpathSync(resolve(root, spec.cwd ?? "."));
    if (!contained(root, cwd)) throw new Error(`Target command ${commandId} cwd escaped the worktree`);
    const containmentBinding: ContainmentBinding = {
      ...input.containmentContext,
      commandId,
      canonicalWorktreePath: root,
      nonce: randomBytes(32).toString("base64url"),
    };
    let registeredFingerprint: string | null = null;
    const result = await input.runner.run({
      signal: input.signal,
      commandId,
      argv: spec.argv,
      assertionReporter: spec.assertionReporter,
      cwd,
      environment: spec.assertionContract || spec.assertionReporter ? { ...input.environment,
        OMB_ASSERTION_RUN_ID: containmentBinding.runId, OMB_ASSERTION_NONCE: containmentBinding.nonce,
        ...(spec.assertionReporter ? { OMB_ASSERTION_ROOT: root } : {}) } : input.environment,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      sandbox: { writableRoot: root, deniedPaths, network: "deny" },
      containmentBinding,
      registerContainment: async (proof) => {
        // An entered runner still owns process cleanup. Do not abandon its containment handshake.
        const verified = await verifyContainmentProof(input.containment, proof, containmentBinding);
        if (!verified.verified) throw new Error(`containment registration rejected for command: ${commandId}`);
        if (registeredFingerprint !== null && registeredFingerprint !== verified.fingerprint) {
          throw new Error(`containment registration changed for command: ${commandId}`);
        }
        registeredFingerprint = verified.fingerprint;
      },
    });
    input.signal?.throwIfAborted();
    const attestedDenied = [...new Set(result.attestation.deniedPaths.map((path) => realpathSync(path)))].sort();
    if (
      (spec.assertionReporter !== undefined && result.attestation.assertionReporter !== spec.assertionReporter) ||
      !result.attestation.sandboxEnforced ||
      realpathSync(result.attestation.writableRoot) !== root ||
      result.attestation.network !== "deny" ||
      !result.attestation.processIsolated ||
      !result.attestation.processTreeReaped ||
      JSON.stringify(attestedDenied) !== JSON.stringify(deniedPaths)
    ) {
      configurationProblems.push(`sandbox attestation rejected for command: ${commandId}`);
      break;
    }
    const proof = result.attestation.containmentProof ?? null;
    const verified = await verifyContainmentProof(input.containment, proof, containmentBinding);
    if (!verified.verified || !proof) {
      configurationProblems.push(`containment proof rejected for command: ${commandId}`);
      break;
    }
    if (registeredFingerprint !== verified.fingerprint) {
      configurationProblems.push(`containment not registered for command: ${commandId}`);
      break;
    }
    const inspected = await input.containment.inspect(proof.identity);
    if (inspected.state !== "empty" || inspected.fingerprint !== verified.fingerprint) {
      configurationProblems.push(`containment not empty for command: ${commandId}`);
      break;
    }
    results.push(evidence(commandId, cwd, spec, result, verified.fingerprint, containmentBinding));
    if (results.at(-1)?.state !== "target_passed") break;
  }
  return { evidence: results, configurationProblems };
}

export function renderCandidateStatus(input: {
  modified: boolean;
  violations?: readonly string[];
  needsConfiguration?: readonly string[];
  evidence?: readonly TestEvidence[];
}): CandidateStatusReport {
  if (input.violations?.length) {
    return {
      state: "invalid",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: "候选无效",
      reasons: [...input.violations],
    };
  }
  if (input.needsConfiguration?.length) {
    return {
      state: "needs_configuration",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: "需要配置",
      reasons: [...input.needsConfiguration],
    };
  }
  if (!input.evidence?.length) {
    return {
      state: input.modified ? "not_verified" : "modified",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: input.modified ? "已修改，尚未验证" : "未生成修改",
      reasons: [],
    };
  }
  if (input.evidence.every((item) => item.state === "target_passed")) {
    return {
      state: "target_tests_passed",
      modified: input.modified,
      targetTestsPassed: true,
      fullGatePassed: false,
      label: "目标测试通过；完整门禁未执行",
      reasons: [],
    };
  }
  return {
    state: "test_failed",
    modified: input.modified,
    targetTestsPassed: false,
    fullGatePassed: false,
    label: "目标测试失败",
    reasons: input.evidence.filter((item) => item.state !== "target_passed").map((item) => `${item.commandId}: ${item.state}`),
  };
}
