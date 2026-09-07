import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommandCleanupError, isolatedExecutionEnvironment } from "../execution-limits.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "../provider-runner.ts";
import type { ContainmentBinding } from "../containment.ts";
import { CONTAINED_CANDIDATE_ROOT, containedProviderRequest, validateContainedProposal } from "./contained-patch-protocol.ts";
import { DockerCliContainmentSupervisor, type DockerCommandPort } from "./docker-containment.ts";
import { readDockerLaunch, writeDockerContainerReceipt, writeDockerLaunch, type DockerLaunchObservation } from "./docker-launch.ts";
import { assertProviderReadViewCurrent, createProviderReadView, disposeProviderReadView, type ProviderReadView } from "./provider-read-view.ts";

interface Options {
  docker: DockerCommandPort;
  containment: DockerCliContainmentSupervisor;
  image: string;
  exchangeRoot: string;
  modelSocketDirectory: string;
  relayUid: number;
  relayGid: number;
  timeoutMs?: number;
  pollMs?: number;
}
interface ActiveRun {
  controller: AbortController;
  finished: Promise<void>;
  cleanupError?: CommandCleanupError;
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw Error("contained_task_cancelled_or_timed_out");
}
function mountPath(path: string): string {
  if (!isAbsolute(path) || /[,\x00-\x1f\x7f]/u.test(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory())
    throw Error("contained_mount_path_invalid");
  return path;
}
function overlaps(left: string, right: string): boolean {
  const path = relative(left, right);
  return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function writeControl(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
}
function readReceipt(directory: string, name: string): unknown | undefined {
  const path = join(directory, name);
  let info;
  try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
    (process.getuid && info.uid !== process.getuid()) || info.size < 2 || info.size > 8 * 1024 * 1024)
    throw Error("contained_receipt_invalid");
  return JSON.parse(readFileSync(path, "utf8"));
}
async function unlessCancelled<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  assertActive(signal);
  let abort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(Error("contained_task_cancelled_or_timed_out"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => { assertActive(signal); return operation(); }).then(resolve, reject);
    });
  } finally { signal.removeEventListener("abort", abort); }
}

/** Explicit headless opt-in, not deployed until independent crash/recovery
 * checks pass. One real container covers BOTH
 * the provider and trusted applier, including detached provider descendants. */
export class DockerContainedPatchAgent implements AgentRunPort {
  private readonly active = new Map<string, ActiveRun>();
  private readonly options: Options & { timeoutMs: number; pollMs: number };

  constructor(input: Options) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.image) ||
      ![input.relayUid, input.relayGid].every(id => Number.isSafeInteger(id) && id > 0 && id !== 10001 && id <= 2147483647))
      throw Error("contained_configuration_invalid");
    const timeoutMs = input.timeoutMs ?? 15 * 60_000, pollMs = input.pollMs ?? 50;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw Error("contained_timeout_invalid");
    mkdirSync(input.exchangeRoot, { recursive: true, mode: 0o700 });
    const exchangeRoot = mountPath(realpathSync(input.exchangeRoot)), modelSocketDirectory = mountPath(input.modelSocketDirectory);
    if (overlaps(exchangeRoot, modelSocketDirectory) || overlaps(modelSocketDirectory, exchangeRoot)) throw Error("contained_mount_overlap");
    this.options = { ...input, exchangeRoot, modelSocketDirectory, timeoutMs, pollMs };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    assertActive(request.signal);
    if (this.active.has(request.runId)) throw Error("contained_task_already_active_or_unsettled");
    let finish!: () => void;
    const active: ActiveRun = { controller: new AbortController(), finished: new Promise(resolve => { finish = resolve; }) };
    this.active.set(request.runId, active);
    const abort = () => active.controller.abort(), timer = setTimeout(abort, this.options.timeoutMs);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    try { return await this.runContained({ ...request, signal: active.controller.signal }); }
    catch (error) { if (error instanceof CommandCleanupError) active.cleanupError = error; throw error; }
    finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      if (!active.cleanupError) this.active.delete(request.runId);
      finish();
    }
  }

  private async runContained(request: AgentRunRequest): Promise<AgentRunResult> {
    assertActive(request.signal);
    if (request.sandbox.network !== "deny" || request.sandbox.denyGitMetadata !== true ||
      Object.values(request.capabilities).some(value => value !== false)) throw Error("contained_contract_invalid");
    const { docker, containment, image, exchangeRoot, modelSocketDirectory } = this.options;
    const source = mountPath(request.cwd);
    if (request.containmentBinding.runId !== request.runId || request.containmentBinding.canonicalWorktreePath !== source ||
      request.sandbox.filesystemRoot !== source || [exchangeRoot, modelSocketDirectory].some(path => overlaps(source, path) || overlaps(path, source)))
      throw Error("contained_candidate_binding_invalid");
    const safeRequest = containedProviderRequest(request);
    const key = createHash("sha256").update(JSON.stringify(request.containmentBinding)).digest("hex"), name = `omb-task-${key.slice(0, 48)}`;
    const directory = join(exchangeRoot, name);
    mkdirSync(directory, { mode: 0o711 }); chmodSync(directory, 0o711);
    const launch = containment.prepareLaunch({ name, image, binding: request.containmentBinding });
    writeDockerLaunch(directory, launch);
    let sequence = 0, heartbeatError = false;
    const pulse = () => {
      try {
        writeFileSync(join(directory, "heartbeat.next"), JSON.stringify(++sequence), { mode: 0o600 });
        renameSync(join(directory, "heartbeat.next"), join(directory, "heartbeat.json"));
      } catch { heartbeatError = true; }
    };
    pulse();
    const heartbeat = setInterval(pulse, 1000), waitController = new AbortController();
    let containerId: string | undefined, view: ProviderReadView | undefined, createAttempted = false;
    let waiting: Promise<{ exit: string; code: number } | { error: true }> | undefined;
    try {
      createAttempted = true;
      const created = await docker.run([
        "create", "--name", name, "--network", "none", "--read-only", "--restart", "no", "--cap-drop", "ALL",
        "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128", "--memory", "768m", "--cpus", "1", "--user", "0:0",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m", "--tmpfs", "/run/omb-private:rw,noexec,nosuid,nodev,mode=0700,size=1m",
        "--mount", `type=bind,src=${directory},dst=/run/omb-control`,
        "--mount", `type=bind,src=${directory},dst=/workspace,readonly`,
        "--mount", `type=bind,src=${source},dst=${CONTAINED_CANDIDATE_ROOT}`,
        "--mount", `type=bind,src=${modelSocketDirectory},dst=/run/omb-channel,readonly`,
        "--env", `OMB_OPENCODEX_RELAY_UID=${this.options.relayUid}`, "--env", `OMB_OPENCODEX_RELAY_GID=${this.options.relayGid}`,
        ...containment.launchLabels(launch).flatMap(label => ["--label", label]),
        "--workdir", "/", "--entrypoint", "node", image, "/opt/openmausbot/contained-patch-worker.js",
      ], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
      const id = created.stdout.toString("utf8").trim();
      if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(id)) throw Error("contained_create_unconfirmed");
      containerId = id;
      writeDockerContainerReceipt(directory, containerId);
      assertActive(request.signal);
      const started = await docker.run(["start", id], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (started.exitCode !== 0) throw Error("contained_start_failed");
      assertActive(request.signal);
      const proof = await containment.issueProof(id, request.containmentBinding);
      await unlessCancelled(request.signal, () => request.registerContainment(proof));
      assertActive(request.signal);
      const baseSha = execFileSync("git", ["--no-optional-locks", "-C", source, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
        { env: { ...isolatedExecutionEnvironment(process.env, source), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
      view = createProviderReadView({ source, destination: join(directory, "view"), baseSha, readScope: request.readScope, denyScope: request.denyScope });
      writeControl(directory, "request.json", { request: safeRequest, files: view.files });
      assertActive(request.signal);
      if (heartbeatError) throw Error("contained_heartbeat_failed");
      waiting = docker.run(["wait", id], { timeoutMs: this.options.timeoutMs, maxOutputBytes: 4096, signal: waitController.signal })
        .then(value => ({ code: value.exitCode, exit: value.stdout.toString("utf8").trim() }), () => ({ error: true as const }));
      let waitEnded = false;
      void waiting.then(() => { waitEnded = true; });
      const receipt = async (filename: string): Promise<unknown> => {
        for (;;) {
          assertActive(request.signal);
          if (heartbeatError) throw Error("contained_heartbeat_failed");
          const value = readReceipt(directory, filename);
          if (value !== undefined) return value;
          if (waitEnded) throw Error("contained_worker_exited_without_receipt");
          await delay(this.options.pollMs, undefined, { signal: request.signal });
        }
      };
      writeControl(directory, "proposal.start", { start: true });
      const proposal = validateContainedProposal(request, await receipt("proposal.json"), view.files);
      if (proposal.status === "completed") {
        assertProviderReadViewCurrent(view);
        // New files are allowed; an existing file absent from the read view is not.
        // Preflight every ancestor/target before any fixed applier writes occur.
        const known = new Set(view.files.map(file => file.path));
        for (const change of proposal.changes) {
          const parts = change.path.split("/");
          for (let index = 1; index <= parts.length; index++) {
            try {
              const stat = lstatSync(join(source, ...parts.slice(0, index)));
              if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || !known.has(change.path)))
                throw Error("contained_existing_target_not_readable");
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        }
        assertActive(request.signal);
        writeControl(directory, "apply.json", { root: CONTAINED_CANDIDATE_ROOT, writeScopes: request.writeScope, changes: proposal.changes });
        writeControl(directory, "apply.start", { start: true });
        const applied = await receipt("applied.json") as { status?: unknown; paths?: unknown };
        if (applied?.status !== "applied" || JSON.stringify(applied.paths) !== JSON.stringify(proposal.changes.map(change => change.path)))
          throw Error("contained_apply_receipt_invalid");
        const waited = await unlessCancelled(request.signal, () => waiting!);
        assertActive(request.signal);
        if ("error" in waited || waited.code !== 0 || waited.exit !== "0" || (await containment.inspect(proof.identity)).state !== "empty")
          throw Error("contained_exit_unconfirmed");
      }
      return { threadId: request.threadId, turnId: request.turnId, status: proposal.status, message: proposal.summary,
        sandboxEnforced: true, containmentProof: proof };
    } finally {
      clearInterval(heartbeat);
      try {
        if (containerId) {
          const stopped = await containment.terminateBoundContainer(containerId, request.containmentBinding);
          if (stopped.state !== "empty") throw Error("contained_cleanup_unconfirmed");
        } else if (createAttempted) throw Error("contained_create_unconfirmed");
        if (view) disposeProviderReadView(view);
        rmSync(directory, { recursive: true });
      } catch { throw new CommandCleanupError(Error("contained_cleanup_unconfirmed")); }
      finally { waitController.abort(); if (waiting) await waiting; }
      assertActive(request.signal);
    }
  }

  /** Diagnosis only. Never releases the run, cleans files, backfills proof or starts work. */
  async inspectPendingLaunch(name: string, binding: ContainmentBinding): Promise<DockerLaunchObservation> {
    if (!/^omb-task-[a-f0-9]{48}$/u.test(name)) return { state: "unknown", reason: "launch_name_invalid" };
    let record: ReturnType<typeof readDockerLaunch>;
    try { record = readDockerLaunch(join(this.options.exchangeRoot, name)); }
    catch { return { state: "unknown", reason: "launch_record_unavailable" }; }
    return await this.options.containment.reconcileLaunch(record.launch, binding, record.containerId);
  }

  async interrupt(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    active.controller.abort();
    await active.finished;
    if (active.cleanupError) throw active.cleanupError;
  }
}
