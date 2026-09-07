import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

import {
  containmentBindingHash,
  type ContainmentBinding,
  type ContainmentInspection,
  type ContainmentPort,
  type ContainmentProof,
  runtimeIdentityFingerprint,
  type RuntimeIdentity,
} from "../containment.ts";
import { dockerLaunchPayload, dockerLaunchSchema, sealUnactivatedLaunch, type DockerLaunchObservation, type DockerLaunchRecord } from "./docker-launch.ts";

const BACKEND = "docker_cgroup_v2";
const MANAGED_LABEL = "com.openmausbot.collaboration.managed";
const BINDING_LABEL = "com.openmausbot.collaboration.binding";
const GENERATION_LABEL = "com.openmausbot.collaboration.host-generation";
const LAUNCH_LABEL = "com.openmausbot.collaboration.launch";

export interface DockerCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DockerCommandPort {
  run(args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<DockerCommandResult>;
}

export class NodeDockerCommandPort implements DockerCommandPort {
  private readonly executable: string;
  private readonly prefix: readonly string[];

  constructor(input: { executable?: string; context?: string } = {}) {
    this.executable = input.executable?.trim() || "docker";
    const context = input.context?.trim();
    this.prefix = context ? ["--context", context] : [];
  }

  async run(
    args: readonly string[],
    options: { input?: Buffer; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
  ): Promise<DockerCommandResult> {
    if (options.signal?.aborted) throw new Error("docker_command_aborted");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("docker_timeout_invalid");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("docker_output_limit_invalid");
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.prefix, ...args], {
        shell: false,
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        reject(new Error("docker_stdio_unavailable"));
        return;
      }
      let bytes = 0;
      let settled = false;
      let limited = false;
      let timedOut = false;
      let inputFailed = false;
      let aborted = false;
      const abort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          limited = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (aborted) {
          reject(new Error("docker_command_aborted"));
          return;
        }
        if (limited) {
          reject(new Error("docker_output_limit_exceeded"));
          return;
        }
        if (timedOut) {
          reject(new Error("docker_command_timed_out"));
          return;
        }
        if (inputFailed) {
          reject(new Error("docker_stdin_write_failed"));
          return;
        }
        resolve({ exitCode: code ?? 127, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      if (options.input) {
        if (!child.stdin) {
          child.kill("SIGKILL");
          reject(new Error("docker_stdin_unavailable"));
          return;
        }
        child.stdin.once("error", () => {
          inputFailed = true;
          child.kill("SIGKILL");
        });
        child.stdin.end(options.input);
      }
    });
  }
}

interface DockerInspection {
  Id?: unknown;
  Name?: unknown;
  Image?: unknown;
  Config?: { Image?: unknown; Labels?: Record<string, string> | null; User?: unknown; Env?: unknown; Entrypoint?: unknown; Cmd?: unknown };
  HostConfig?: { RestartPolicy?: { Name?: unknown }; NetworkMode?: unknown; ReadonlyRootfs?: unknown; Privileged?: unknown; PidMode?: unknown; CapDrop?: unknown; CapAdd?: unknown; SecurityOpt?: unknown };
  Mounts?: Array<{ Type?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }>;
  State?: { Running?: unknown; Status?: unknown; Pid?: unknown; Paused?: unknown; Restarting?: unknown };
}

/** Unknown, restarting or incomplete daemon state is never evidence of emptiness. */
function observedState(inspection: DockerInspection, allowCreated = false): "active" | "empty" | "unknown" {
  const state = inspection.State;
  if (!state || inspection.HostConfig?.RestartPolicy?.Name !== "no" || state.Restarting !== false) return "unknown";
  if (state.Running === true && Number.isSafeInteger(state.Pid) && Number(state.Pid) > 0 &&
    ((state.Status === "running" && state.Paused === false) || (state.Status === "paused" && state.Paused === true))) return "active";
  if (state.Running === false && state.Pid === 0 && state.Paused === false &&
    (state.Status === "exited" || (allowCreated && state.Status === "created"))) return "empty";
  return "unknown";
}

function receipt(key: Buffer, identity: RuntimeIdentity, binding: ContainmentBinding): string {
  return createHmac("sha256", key)
    .update(runtimeIdentityFingerprint(identity))
    .update("\0")
    .update(containmentBindingHash(binding))
    .digest("base64url");
}

function parseInspection(result: DockerCommandResult): DockerInspection | null {
  if (result.exitCode !== 0 || result.stdout.length > 128 * 1024) return null;
  try {
    const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    const value = parsed[0];
    return value && typeof value === "object" && !Array.isArray(value) ? (value as DockerInspection) : null;
  } catch {
    return null;
  }
}

export class DockerCliContainmentSupervisor implements ContainmentPort {
  private readonly docker: DockerCommandPort;
  private readonly hostGeneration: string;
  private readonly verifierKey: Buffer;
  private readonly verifierVersion: string;
  private readonly emptyTimeoutMs: number;

  constructor(input: {
    docker: DockerCommandPort;
    hostGeneration: string;
    verifierKey: Buffer;
    verifierVersion?: string;
    emptyTimeoutMs?: number;
  }) {
    if (!input.hostGeneration.trim()) throw new Error("host_generation_required");
    if (input.verifierKey.length < 32) throw new Error("containment_verifier_key_too_short");
    this.docker = input.docker;
    this.hostGeneration = input.hostGeneration.trim();
    this.verifierKey = Buffer.from(input.verifierKey);
    this.verifierVersion = input.verifierVersion ?? "docker-cgroup-v2-hmac-v1";
    this.emptyTimeoutMs = input.emptyTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.emptyTimeoutMs) || this.emptyTimeoutMs < 1) throw new Error("containment_timeout_invalid");
  }

  labels(binding: ContainmentBinding): string[] {
    return [
      `${MANAGED_LABEL}=1`,
      `${BINDING_LABEL}=${containmentBindingHash(binding)}`,
      `${GENERATION_LABEL}=${this.hostGeneration}`,
    ];
  }

  prepareLaunch(input: Pick<DockerLaunchRecord, "name" | "image" | "binding">): DockerLaunchRecord {
    const checked = dockerLaunchSchema.parse({ ...input, version: 2, hostGeneration: this.hostGeneration,
      verifierVersion: this.verifierVersion, receipt: "x".repeat(43) });
    return { ...checked, receipt: this.launchReceipt(checked) };
  }

  launchLabels(launch: DockerLaunchRecord): string[] {
    if (!this.validLaunch(launch)) throw Error("launch_record_untrusted");
    return [...this.labels(launch.binding), `${LAUNCH_LABEL}=${createHash("sha256").update(dockerLaunchPayload(launch)).digest("hex")}`];
  }

  /** Read-only identity reconciliation, NOT an execution proof or release authorization.
   * Absence is unknown: a previously submitted create may still complete later. */
  async reconcileLaunch(record: unknown, expectedBinding: ContainmentBinding, expectedId?: string): Promise<DockerLaunchObservation> {
    const parsed = dockerLaunchSchema.safeParse(record);
    if (!parsed.success || !this.validLaunch(parsed.data)) return { state: "unknown", reason: "launch_record_untrusted" };
    const launch = parsed.data;
    if (containmentBindingHash(launch.binding) !== containmentBindingHash(expectedBinding) ||
      (expectedId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedId))) return { state: "unknown", reason: "launch_binding_mismatch" };
    try {
      // List by binding, not just name: conflicting duplicates must remain ambiguous.
      const listed = await this.docker.run(["ps", "-aq", "--no-trunc", ...this.labels(launch.binding).flatMap(label => ["--filter", `label=${label}`])],
        { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 });
      if (listed.exitCode !== 0 || listed.stdout.length > 16 * 1024) return { state: "unknown", reason: "launch_daemon_unavailable" };
      const ids = listed.stdout.toString("utf8").trim().split(/\r?\n/u);
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0])) return { state: "unknown", reason: "launch_identity_unconfirmed" };
      const id = ids[0];
      if (expectedId !== undefined && id !== expectedId) return { state: "unknown", reason: "launch_identity_mismatch" };
      const inspected = await this.inspection(id);
      const labels = inspected?.Config?.Labels ?? {};
      if (!inspected || inspected.Name !== `/${launch.name}` || inspected.Image !== launch.image || inspected.Config?.Image !== launch.image ||
        !this.launchLabels(launch).every(label => { const i = label.indexOf("="); return labels[label.slice(0, i)] === label.slice(i + 1); }))
        return { state: "unknown", reason: "launch_identity_mismatch" };
      const state = observedState(inspected, true);
      if (state === "unknown") return { state, reason: "launch_state_unconfirmed" };
      return { state: "observed", status: state === "active" ? "active" : inspected.State?.Status === "created" ? "created" : "exited", containerId: id };
    } catch { return { state: "unknown", reason: "launch_daemon_unavailable" }; }
  }

  private launchReceipt(launch: DockerLaunchRecord): string {
    return createHmac("sha256", this.verifierKey).update(dockerLaunchPayload(launch)).digest("base64url");
  }

  async inspectUnactivatedLaunch(launch: DockerLaunchRecord, binding: ContainmentBinding, directory: string, id?: string): Promise<DockerLaunchObservation> {
    const found = await this.reconcileLaunch(launch, binding, id);
    if (found.state !== "observed") return found;
    const actual = await this.inspection(found.containerId);
    const mounts = actual?.Mounts;
    const mount = (destination: string, source: string, writable: boolean) => {
      const matches = mounts?.filter(value => value.Destination === destination);
      return matches?.length === 1 && matches[0].Source === source && matches[0].RW === writable;
    };
    const allowedMounts = new Set(["/run/omb-control", "/workspace", "/run/omb-private/candidate", "/run/omb-channel", "/tmp", "/run/omb-private"]);
    const capabilities = actual?.HostConfig?.CapAdd;
    const drop = actual?.HostConfig?.CapDrop;
    const security = actual?.HostConfig?.SecurityOpt;
    const environment = actual?.Config?.Env;
    const workerPath = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    if (!actual || !this.labelsMatch(actual, binding) || actual.Image !== launch.image || actual.Config?.User !== "0:0" ||
      JSON.stringify(actual.Config?.Entrypoint) !== '["node"]' || JSON.stringify(actual.Config?.Cmd) !== '["/opt/openmausbot/contained-patch-worker.js"]' ||
      actual.HostConfig?.NetworkMode !== "none" || actual.HostConfig.ReadonlyRootfs !== true || actual.HostConfig.Privileged !== false || actual.HostConfig.PidMode !== "" ||
      !Array.isArray(drop) || drop.length !== 1 || drop[0] !== "ALL" ||
      !Array.isArray(capabilities) || capabilities.some(cap => !["CHOWN", "SETUID", "SETGID"].includes(cap)) ||
      !Array.isArray(security) || security.length !== 1 || !["no-new-privileges", "no-new-privileges:true"].includes(security[0]) ||
      !Array.isArray(environment) || environment.filter(value => value === workerPath).length !== 1 ||
      environment.some(value => typeof value !== "string" || !/^(?:PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|OMB_OPENCODEX_RELAY_UID|OMB_OPENCODEX_RELAY_GID)=/u.test(value) ||
        (value.startsWith("PATH=") && value !== workerPath)) ||
      !mounts || mounts.some(value => typeof value.Destination !== "string" || !allowedMounts.has(value.Destination) ||
        ((value.Destination === "/tmp" || value.Destination === "/run/omb-private") && value.Type !== "tmpfs") ||
        (value.Destination === "/run/omb-channel" && value.RW !== false)) ||
      new Set(mounts.map(value => value.Destination)).size !== mounts.length ||
      !mount("/run/omb-control", directory, true) || !mount("/workspace", directory, false) || !mount("/run/omb-private/candidate", binding.canonicalWorktreePath, true))
      return { state: "unknown", reason: "abort_worker_contract_mismatch" };
    const state = observedState(actual, true);
    return state === "unknown" ? { state, reason: "abort_state_unconfirmed" } : { state: "observed", containerId: found.containerId,
      status: state === "active" ? "active" : actual.State?.Status === "created" ? "created" : "exited" };
  }

  /** Only after old coordinator stop + absent task proof + durable denied gate;
   * the caller reserves the persistent kill budget and awaits this operation. */
  async stopUnactivatedLaunch(launch: DockerLaunchRecord, binding: ContainmentBinding, directory: string, id: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    sealUnactivatedLaunch(directory, launch);
    const actual = await this.inspectUnactivatedLaunch(launch, binding, directory, id);
    if (actual.state !== "observed") throw Error("abort_identity_unconfirmed");
    assertCurrent();
    if (actual.status === "active") await this.docker.run(["kill", id], { timeoutMs: this.emptyTimeoutMs, maxOutputBytes: 4096 });
  }

  private validLaunch(launch: DockerLaunchRecord): boolean {
    if (launch.hostGeneration !== this.hostGeneration || launch.verifierVersion !== this.verifierVersion) return false;
    const expected = Buffer.from(this.launchReceipt(launch)), actual = Buffer.from(launch.receipt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async issueProof(containerId: string, binding: ContainmentBinding): Promise<ContainmentProof> {
    const identity = this.identity(containerId);
    const inspection = await this.inspection(containerId);
    if (!inspection || observedState(inspection) !== "active" || inspection.State?.Paused !== false) throw new Error("containment_container_not_running");
    if (!this.labelsMatch(inspection, binding)) throw new Error("containment_container_labels_invalid");
    return { identity, receipt: receipt(this.verifierKey, identity, binding) };
  }

  async verifyProof(proof: ContainmentProof, expectedBinding: ContainmentBinding) {
    if (!this.validIdentity(proof.identity)) {
      return { verified: false as const, reason: "containment_supervisor_identity_mismatch" };
    }
    const inspection = await this.inspection(proof.identity.opaqueId);
    if (!inspection || !this.labelsMatch(inspection, expectedBinding)) {
      return { verified: false as const, reason: "containment_container_unavailable" };
    }
    const expected = Buffer.from(receipt(this.verifierKey, proof.identity, expectedBinding));
    const actual = Buffer.from(proof.receipt);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { verified: false as const, reason: "containment_receipt_invalid" };
    }
    return {
      verified: true as const,
      fingerprint: runtimeIdentityFingerprint(proof.identity),
      bindingHash: containmentBindingHash(expectedBinding),
    };
  }

  async inspect(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    if (!this.validIdentity(identity)) return { state: "unknown", reason: "containment_identity_invalid" };
    const inspection = await this.inspection(identity.opaqueId);
    if (!inspection) return { state: "unknown", reason: "containment_container_unavailable" };
    if (!this.managedIdentityMatches(inspection)) return { state: "unknown", reason: "containment_container_labels_invalid" };
    const state = observedState(inspection);
    return state === "unknown" ? { state, reason: "containment_state_unconfirmed" } : { state, fingerprint: runtimeIdentityFingerprint(identity) };
  }

  async terminateAndWaitEmpty(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    if (!this.validIdentity(identity)) return { state: "unknown", reason: "containment_identity_invalid" };
    const before = await this.inspect(identity);
    if (before.state !== "active") return before;
    await this.docker.run(["kill", identity.opaqueId], { timeoutMs: this.emptyTimeoutMs, maxOutputBytes: 16 * 1024 });
    const deadline = Date.now() + this.emptyTimeoutMs;
    while (Date.now() <= deadline) {
      const state = await this.inspect(identity);
      if (state.state === "empty" || state.state === "unknown") return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { state: "unknown", reason: "containment_container_did_not_stop" };
  }

  /** Cleanup for this invocation's full create receipt, including failures before proof registration. */
  async terminateBoundContainer(containerId: string, binding: ContainmentBinding): Promise<ContainmentInspection> {
    const identity = this.identity(containerId);
    const fingerprint = runtimeIdentityFingerprint(identity);
    const deadline = Date.now() + this.emptyTimeoutMs;
    let killRequested = false;
    do {
      const inspection = await this.inspection(identity.opaqueId);
      if (!inspection || inspection.Id !== identity.opaqueId || !this.labelsMatch(inspection, binding)) {
        return { state: "unknown", reason: "containment_binding_unconfirmed" };
      }
      // This path is only for the owning invocation after all create/start calls
      // have returned. A never-started container cannot be a lifecycle proof.
      const state = observedState(inspection, true);
      if (state === "empty") return { state: "empty", fingerprint };
      if (state !== "active") return { state: "unknown", reason: "containment_state_unconfirmed" };
      if (!killRequested) {
        // Even a nonzero kill response can race a normal exit; only the next inspect proves emptiness.
        await this.docker.run(["kill", identity.opaqueId], { timeoutMs: this.emptyTimeoutMs, maxOutputBytes: 16 * 1024 });
        killRequested = true;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() <= deadline);
    return { state: "unknown", reason: "containment_container_did_not_stop" };
  }

  private identity(containerId: string): RuntimeIdentity {
    const normalized = containerId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error("containment_container_id_invalid");
    return {
      backend: BACKEND,
      opaqueId: normalized,
      hostGeneration: this.hostGeneration,
      verifierVersion: this.verifierVersion,
    };
  }

  private validIdentity(identity: RuntimeIdentity): boolean {
    return (
      identity.backend === BACKEND &&
      identity.hostGeneration === this.hostGeneration &&
      identity.verifierVersion === this.verifierVersion &&
      /^[0-9a-f]{64}$/u.test(identity.opaqueId)
    );
  }

  private labelsMatch(inspection: DockerInspection, binding: ContainmentBinding): boolean {
    const labels = inspection.Config?.Labels ?? {};
    return (
      this.managedIdentityMatches(inspection) && labels[BINDING_LABEL] === containmentBindingHash(binding)
    );
  }

  private managedIdentityMatches(inspection: DockerInspection): boolean {
    const labels = inspection.Config?.Labels ?? {};
    return labels[MANAGED_LABEL] === "1" && labels[GENERATION_LABEL] === this.hostGeneration &&
      typeof labels[BINDING_LABEL] === "string" && /^[a-f0-9]{64}$/u.test(labels[BINDING_LABEL]);
  }

  private async inspection(containerId: string): Promise<DockerInspection | null> {
    const normalized = containerId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) return null;
    const inspected = parseInspection(await this.docker.run(["inspect", normalized], { timeoutMs: 5_000, maxOutputBytes: 128 * 1024 }));
    return inspected?.Id === normalized ? inspected : null;
  }
}
