import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRunRequest } from "../provider-runner.ts";
import { CONTAINED_VIEW_ROOT, type ContainedProviderRequest, validateContainedProposal } from "./contained-patch-protocol.ts";
import type { ProviderReadViewFile } from "./provider-read-view.ts";

/** No executable entrypoint in this module: importing/bundling it cannot start
 * a relay, provider or writer. The trusted container main supplies those. */
export async function runContainedPatchWorker(options: {
  controlDirectory: string;
  candidateRoot: string;
  propose(request: AgentRunRequest): Promise<unknown>;
  signal: AbortSignal;
  pollMs?: number;
  heartbeatTimeoutMs?: number;
}): Promise<void> {
  const pollMs = options.pollMs ?? 100, heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
  if (![pollMs, heartbeatTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 30_000))
    throw Error("contained_worker_timeout_invalid");
  const stop = new AbortController(), signal = AbortSignal.any([options.signal, stop.signal]);
  const directory = options.controlDirectory;
  let failure: Error | undefined;
  const active = () => { if (signal.aborted) throw failure ?? Error("contained_worker_cancelled"); };
  const read = (name: string, optional = false): unknown => {
    let fd: number;
    try { fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 8 * 1024 * 1024)
        throw Error("contained_control_file_invalid");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
  };
  const write = (name: string, value: unknown) => {
    active();
    writeFileSync(join(directory, `${name}.next`), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(join(directory, `${name}.next`), join(directory, name));
  };
  let sequence = 0, changedAt = performance.now();
  const checkHeartbeat = () => {
    try {
      const value = read("heartbeat.json");
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value < sequence)
        throw Error("contained_heartbeat_invalid");
      if (value > sequence) { sequence = value; changedAt = performance.now(); }
      if (performance.now() - changedAt >= heartbeatTimeoutMs) throw Error("contained_heartbeat_expired");
    } catch { failure = Error("contained_heartbeat_lost"); stop.abort(); }
  };
  checkHeartbeat();
  const timer = setInterval(checkHeartbeat, pollMs);
  const gate = async (name: string) => {
    for (;;) {
      active();
      const value = read(name, true);
      if (value !== undefined) {
        if (!value || typeof value !== "object" || (value as { start?: unknown }).start !== true) throw Error("contained_gate_invalid");
        return;
      }
      try { await delay(pollMs, undefined, { signal }); } catch { active(); throw Error("contained_wait_failed"); }
    }
  };
  try {
    await gate("proposal.start");
    const envelope = read("request.json") as { request: ContainedProviderRequest; files: ProviderReadViewFile[] };
    const request = envelope?.request, files = envelope?.files;
    if (!request || request.cwd !== CONTAINED_VIEW_ROOT || request.sandbox?.filesystemRoot !== CONTAINED_VIEW_ROOT ||
      request.sandbox.denyGitMetadata !== true || request.sandbox.network !== "deny" ||
      !request.environment || Object.keys(request.environment).length || !request.capabilities ||
      Object.values(request.capabilities).some(value => value !== false) || !Array.isArray(files))
      throw Error("contained_worker_request_invalid");
    let abort!: () => void;
    let proposal;
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(failure ?? Error("contained_worker_cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          active();
          return options.propose({ ...request, signal, emit: () => {},
            registerContainment: async () => { throw Error("contained_nested_registration_denied"); } });
        }).then(resolve, reject);
      });
      proposal = validateContainedProposal(request, raw, files);
    } catch {
      active();
      // Neither private upstream diagnostics nor malformed model output crosses
      // into the controller's business reply. Never retry the model here.
      proposal = { status: "failed" as const, summary: "模型未能完成本次修改建议。", changes: [] };
    } finally { signal.removeEventListener("abort", abort); }
    write("proposal.json", proposal);
    if (proposal.status !== "completed") return;
    await gate("apply.start");
    const application = read("apply.json") as { changes?: unknown };
    if (JSON.stringify(application?.changes) !== JSON.stringify(proposal.changes)) throw Error("contained_apply_proposal_mismatch");
    // Root/path/scopes supplied in the payload are never authority. Only the
    // fixed candidate mount and the independently validated proposal are used.
    validateContainedProposal(request, proposal, files);
    const known = new Map(files.map(file => [file.path, file]));
    const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
    for (const change of proposal.changes) {
      const parts = change.path.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const target = join(options.candidateRoot, ...parts.slice(0, index));
        try {
          const stat = lstatSync(target), original = known.get(change.path);
          if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() :
            !stat.isFile() || stat.nlink !== 1 || !original || !original.automaticReplacementAllowed ||
            hash(readFileSync(target)) !== original.contentHash)) throw Error("contained_apply_target_changed_or_denied");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (known.has(change.path)) throw Error("contained_apply_source_missing");
        }
      }
    }
    active();
    for (const change of proposal.changes) {
      const target = join(options.candidateRoot, change.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // All targets are preflighted before any mutation; provider cannot access
      // this private mount. Crash-partial writes still require ledger recovery.
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, change.contents); } finally { closeSync(fd); }
    }
    write("applied.json", { status: "applied", paths: proposal.changes.map(change => change.path) });
  } finally { clearInterval(timer); stop.abort(); }
}
