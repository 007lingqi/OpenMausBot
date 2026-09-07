import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readlinkSync } from "node:fs";
import { z } from "zod";
import type { CoordinatorAuthority, CoordinatorInstance, CoordinatorObservation } from "../coordinator-lifecycle.ts";
import type { DockerCommandPort } from "./docker-containment.ts";

const timestamp = (value: unknown): bigint | null => {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return null;
  const millis = Date.parse(match[1] + "Z");
  if (!Number.isFinite(millis) || millis <= 0 || new Date(millis).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(millis) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
};
const schema = z.object({
  version: z.literal(1), backend: z.literal("docker_coordinator_epoch_v1"), containerId: z.string().regex(/^[a-f0-9]{64}$/u),
  containerName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u), image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  hostGeneration: z.string().min(1).max(200), startedAt: z.string().refine(value => timestamp(value) !== null), pidNamespace: z.string().regex(/^pid:\[[1-9]\d{0,19}\]$/u),
  instance: z.object({ ownerId: z.string().min(1).max(4096), fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();
export type DockerCoordinatorProof = z.infer<typeof schema>;
interface Snapshot {
  Id?: unknown; Name?: unknown; Image?: unknown; Mounts?: Array<{ Destination?: unknown }>;
  State?: { Running?: unknown; Status?: unknown; Pid?: unknown; Paused?: unknown; Restarting?: unknown; Dead?: unknown; StartedAt?: unknown; FinishedAt?: unknown };
  HostConfig?: { PidMode?: unknown; Privileged?: unknown; ReadonlyRootfs?: unknown; CapDrop?: unknown; CapAdd?: unknown; SecurityOpt?: unknown };
}
function isolated(value: Snapshot): boolean {
  const config = value.HostConfig;
  return !!config && config.PidMode === "" && config.Privileged === false && config.ReadonlyRootfs === true &&
    Array.isArray(config.CapDrop) && config.CapDrop.includes("ALL") &&
    (config.CapAdd === null || (Array.isArray(config.CapAdd) && config.CapAdd.every(cap => ["CHOWN", "SETUID", "SETGID", "CAP_CHOWN", "CAP_SETUID", "CAP_SETGID"].includes(cap)))) &&
    Array.isArray(config.SecurityOpt) && config.SecurityOpt.some(opt => opt === "no-new-privileges" || opt === "no-new-privileges:true") &&
    Array.isArray(value.Mounts) && value.Mounts.every(mount => typeof mount.Destination === "string" && !["/usr/bin/readlink", "/proc/self/ns/pid"].some(target =>
      mount.Destination === "/" || target === mount.Destination || target.startsWith(`${mount.Destination}/`)));
}
function state(value: Snapshot): "active" | "exited" | "unknown" {
  const s = value.State;
  if (!isolated(value) || !s || s.Dead !== false || s.Restarting !== false || s.Paused !== false || timestamp(s.StartedAt) === null) return "unknown";
  if (s.Running === true && s.Status === "running" && Number.isSafeInteger(s.Pid) && Number(s.Pid) > 0) return "active";
  if (s.Running === false && s.Status === "exited" && s.Pid === 0 && timestamp(s.FinishedAt) !== null && timestamp(s.FinishedAt)! > timestamp(s.StartedAt)!) return "exited";
  return "unknown";
}
function payload(proof: DockerCoordinatorProof): string {
  return JSON.stringify({ purpose: "coordinator-startup-epoch-v1", version: proof.version, backend: proof.backend, containerId: proof.containerId,
    containerName: proof.containerName, image: proof.image, hostGeneration: proof.hostGeneration, startedAt: proof.startedAt,
    pidNamespace: proof.pidNamespace, instance: { ownerId: proof.instance.ownerId, fence: proof.instance.fence } });
}

/** Docker's immutable container ID plus a signed startup epoch covers native
 * headless/Git descendants. A later start cannot resurrect an older PID namespace.
 * Cross-VM-boot evidence remains unsupported rather than silently relaxed. */
export class DockerCoordinatorAuthority implements CoordinatorAuthority {
  private readonly key: Buffer;
  private readonly options: { docker: DockerCommandPort; container: string; image: string; hostGeneration: string; verifierKey: Buffer; localPidNamespace?: () => string };
  constructor(options: DockerCoordinatorAuthority["options"]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(options.container) || !/^sha256:[a-f0-9]{64}$/u.test(options.image) ||
      !options.hostGeneration.trim() || options.hostGeneration.length > 200 || options.verifierKey.length < 32) throw Error("coordinator_configuration_invalid");
    this.key = Buffer.from(options.verifierKey);
    this.options = options;
  }
  private signature(proof: DockerCoordinatorProof): string { return createHmac("sha256", this.key).update(payload(proof)).digest("base64url"); }
  private async snapshot(reference: string): Promise<Snapshot> {
    const result = await this.options.docker.run(["inspect", "--type", "container", reference], { timeoutMs: 5000, maxOutputBytes: 128 * 1024 });
    if (result.exitCode !== 0 || result.stdout.length > 128 * 1024) throw Error("coordinator_unavailable");
    const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") throw Error("coordinator_unavailable");
    return parsed[0] as Snapshot;
  }
  async capture(instance: CoordinatorInstance): Promise<DockerCoordinatorProof> {
    const local = this.options.localPidNamespace ?? (() => readlinkSync("/proc/self/ns/pid"));
    const pidNamespace = local(), before = await this.snapshot(this.options.container);
    if (state(before) !== "active" || before.Name !== `/${this.options.container}` || before.Image !== this.options.image ||
      typeof before.Id !== "string" || !/^[a-f0-9]{64}$/u.test(before.Id) || !/^pid:\[[1-9]\d{0,19}\]$/u.test(pidNamespace)) throw Error("coordinator_self_unconfirmed");
    // Fixed read-only diagnostic inside the configured, pinned controller image.
    const probe = await this.options.docker.run(["exec", "--user", "0:0", "--env", "LD_PRELOAD=", "--env", "LD_LIBRARY_PATH=", before.Id, "/usr/bin/readlink", "/proc/self/ns/pid"],
      { timeoutMs: 5000, maxOutputBytes: 128 });
    if (probe.exitCode !== 0 || probe.stdout.toString("utf8").trim() !== pidNamespace || local() !== pidNamespace) throw Error("coordinator_namespace_mismatch");
    const after = await this.snapshot(before.Id);
    if (state(after) !== "active" || after.Id !== before.Id || after.Name !== before.Name || after.Image !== before.Image || after.State?.StartedAt !== before.State?.StartedAt)
      throw Error("coordinator_epoch_changed");
    const proof = schema.parse({ version: 1, backend: "docker_coordinator_epoch_v1", containerId: before.Id, containerName: this.options.container,
      image: this.options.image, hostGeneration: this.options.hostGeneration, startedAt: before.State?.StartedAt, pidNamespace,
      instance: { ownerId: instance.ownerId, fence: instance.fence }, receipt: "x".repeat(43) });
    return { ...proof, receipt: this.signature(proof) };
  }
  async inspect(record: unknown, expected: CoordinatorInstance): Promise<CoordinatorObservation> {
    const parsed = schema.safeParse(record);
    if (!parsed.success) return { state: "unknown", reason: "coordinator_proof_invalid" };
    const proof = parsed.data, signature = Buffer.from(this.signature(proof)), actual = Buffer.from(proof.receipt);
    if (proof.hostGeneration !== this.options.hostGeneration || proof.instance.ownerId !== expected.ownerId || proof.instance.fence !== expected.fence ||
      signature.length !== actual.length || !timingSafeEqual(signature, actual)) return { state: "unknown", reason: "coordinator_proof_rejected" };
    try {
      const observed = await this.snapshot(proof.containerId), status = state(observed);
      if (observed.Id !== proof.containerId || observed.Name !== `/${proof.containerName}` || observed.Image !== proof.image || status === "unknown" ||
        timestamp(observed.State?.StartedAt)! < timestamp(proof.startedAt)!) return { state: "unknown", reason: "coordinator_epoch_unconfirmed" };
      const fingerprint = createHash("sha256").update(payload(proof)).digest("hex");
      return { state: status === "exited" || timestamp(observed.State?.StartedAt)! > timestamp(proof.startedAt)! ? "stopped" : "active", fingerprint };
    } catch { return { state: "unknown", reason: "coordinator_unavailable" }; }
  }
}
