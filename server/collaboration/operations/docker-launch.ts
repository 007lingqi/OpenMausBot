import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { containmentBindingHash } from "../containment.ts";

const boundedText = z.string().min(1).max(4096).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value));
const bindingSchema = z.object({
  runId: boundedText, commandId: boundedText.optional(), canonicalWorktreePath: boundedText.refine(isAbsolute),
  instanceOwner: boundedText, instanceFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), nonce: boundedText.min(32),
}).strict();
export const dockerLaunchSchema = z.object({
  version: z.literal(2), name: z.string().regex(/^omb-task-[a-f0-9]{48}$/u), image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  binding: bindingSchema, hostGeneration: boundedText, verifierVersion: boundedText, receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();
export type DockerLaunchRecord = z.infer<typeof dockerLaunchSchema>;
export type DockerLaunchObservation = { state: "observed"; status: "created" | "active" | "exited"; containerId: string } |
  { state: "unknown"; reason: string };

/** Domain-separated from execution proofs; canonical key order survives serialization. */
export function dockerLaunchPayload(launch: Omit<DockerLaunchRecord, "receipt">): string {
  return JSON.stringify({ purpose: "docker-launch-v2", version: launch.version, name: launch.name, image: launch.image,
    bindingHash: containmentBindingHash(launch.binding), hostGeneration: launch.hostGeneration, verifierVersion: launch.verifierVersion });
}

const LIMIT = 32 * 1024;
function directoryChecked(directory: string): void {
  const stat = lstatSync(directory);
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw Error("launch_directory_invalid");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Exclusive and durable BEFORE submitting create. An incomplete write remains a blocker. */
function writeRecord(directory: string, name: string, value: unknown): void {
  directoryChecked(directory); directoryChecked(dirname(directory));
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > LIMIT) throw Error("launch_record_too_large");
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory); syncDirectory(dirname(directory));
}
export function writeDockerLaunch(directory: string, launch: DockerLaunchRecord): void {
  const checked = dockerLaunchSchema.parse(launch);
  if (basename(directory) !== checked.name) throw Error("launch_directory_mismatch");
  writeRecord(directory, "launch.json", checked);
}
export function writeDockerContainerReceipt(directory: string, containerId: string): void {
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw Error("launch_container_id_invalid");
  writeRecord(directory, "container.json", { containerId });
}
function readRecord(directory: string, name: string): unknown {
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) ||
      stat.size < 2 || stat.size > LIMIT) throw Error("launch_record_invalid");
    // Bound the read itself, even if an old coordinator is still writing.
    const bytes = Buffer.alloc(LIMIT + 1); let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length !== stat.size || length > LIMIT) throw Error("launch_record_changed");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}
export function readDockerLaunch(directory: string): { launch: DockerLaunchRecord; containerId?: string } {
  directoryChecked(directory); directoryChecked(dirname(directory));
  const launch = dockerLaunchSchema.parse(readRecord(directory, "launch.json"));
  if (basename(directory) !== launch.name) throw Error("launch_directory_mismatch");
  let containerId: string | undefined;
  try { containerId = z.object({ containerId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(readRecord(directory, "container.json")).containerId; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return containerId ? { launch, containerId } : { launch };
}

function deniedGate(launch: DockerLaunchRecord) {
  return { start: false, reason: "aborted_before_activation", launchHash: createHash("sha256").update(dockerLaunchPayload(launch)).digest("hex") };
}
/** No execution material may ever have been published. Retain this directory:
 * a delayed Docker start will encounter the permanently denied model gate. */
export function sealUnactivatedLaunch(directory: string, launch: DockerLaunchRecord): string {
  if (JSON.stringify(readDockerLaunch(directory).launch) !== JSON.stringify(launch)) throw Error("abort_launch_changed");
  for (const name of readdirSync(directory)) {
    if (!["launch.json", "container.json", "heartbeat.json", "heartbeat.next", "proposal.start"].includes(name) && !/^abort-kill-[1-3]\.json$/u.test(name))
      throw Error("launch_may_have_been_activated");
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw Error("abort_record_invalid");
  }
  const gate = deniedGate(launch);
  try {
    if (JSON.stringify(readRecord(directory, "proposal.start")) !== JSON.stringify(gate)) throw Error("launch_may_have_been_activated");
    // A prior process may have died between creation and fsync. Re-sync, never replace.
    const fd = openSync(join(directory, "proposal.start"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(directory); syncDirectory(dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeRecord(directory, "proposal.start", gate);
  }
  return createHash("sha256").update(JSON.stringify(gate)).digest("hex");
}
export function reserveLaunchAbortKill(directory: string, launch: DockerLaunchRecord, containerId: string): void {
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw Error("abort_identity_invalid");
  const expected = { version: 1, launchHash: deniedGate(launch).launchHash, containerId };
  let count = 0;
  for (let i = 1; i <= 3; i++) {
    try {
      const existing = readRecord(directory, `abort-kill-${i}.json`);
      if (count !== i - 1 || JSON.stringify(existing) !== JSON.stringify(expected)) throw Error("abort_budget_invalid");
      count++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (count >= 3) throw Error("abort_budget_exhausted");
  writeRecord(directory, `abort-kill-${count + 1}.json`, expected);
}
