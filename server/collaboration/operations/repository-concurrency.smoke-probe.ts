/** Isolated Linux/Docker probe. Bundled separately; never loaded by the service entrypoint. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ExecutionLifecycle } from "../execution-lifecycle.ts";
import { isolatedExecutionEnvironment } from "../execution-limits.ts";
import { currentInstanceLease } from "../leases.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "../provider-runner.ts";
import { startCollaborationService } from "../service.ts";
import { DockerSandboxedCommandRunner } from "./docker-command-runner.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";

const PROBE_LABEL = "com.openmausbot.repository-concurrency-probe";
const DEADLINE_MS = 90_000;
const countSchema = z.object({ n: z.number().int().nonnegative() });
const revisionSchema = z.object({ revision: z.number().int().positive() });
const serialBoundarySchema = z.object({ first_settled_at: z.number().int().nonnegative(), second_reserved_at: z.number().int().nonnegative() });
const runRowSchema = z.object({ id: z.string().min(1), work_item_id: z.string().min(1), repository_path: z.string().min(1), worktree_path: z.string().min(1),
  result_sha: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable(), status: z.string().min(1), finished_at: z.number().int().nonnegative().nullable() });
type Repository = { path: string; baseSha: string };
type RunRow = z.infer<typeof runRowSchema>;
type AgentObservation = { request: AgentRunRequest; containerId: string; startedAt: number; stoppedAt?: number; writtenAt?: number };
type LiveTask = { workItemId: string; containerId: string; pid: number; worktree: string };
interface ProbeEvidence {
  probe: "repository-concurrency";
  phase: "run";
  status: "failed" | "passed";
  root: string;
  image: string;
  result: "INCONCLUSIVE" | "NOT_VERIFIED" | "VERIFIED";
  modelCalls: 0;
  realGroupMessages: 0;
  boundaries: { scheduler: string; durableOccupancy: string; git: string; containment: string; candidateWriter: string; delivery: string };
  concurrent?: { liveTasks: LiveTask[]; gitIndexLocks: string[]; durableSessions: number; sameRepositoryContenderRejected: boolean };
  serial?: { first: string; second: string; firstWrittenAt: number; secondStartedAt: number; first_settled_at: number; second_reserved_at: number; releasedAfterSettlement: boolean };
  runs?: RunRow[];
  originalRepositoriesUnchanged?: boolean;
  executionSessionsSettled?: number;
  cases?: string[];
  error?: string;
  shutdownFailed?: boolean;
  cleanupFailed?: boolean;
  ownedContainersStopped?: number;
  ownedContainersRemoved?: number;
}
type Inspection = {
  Id: string; Image: string; Config: { User: string; Labels: Record<string, string> };
  State: { Running: boolean; Pid: number; Status: string };
  HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; RestartPolicy: { Name: string } };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
};

function inside(root: string, path: string): boolean {
  const part = relative(root, resolve(path));
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

/** Refuses even read-only Docker operations for any container not created by this invocation. */
class OwnedDocker implements DockerCommandPort {
  readonly ids = new Set<string>();
  readonly stopped = new Set<string>();
  readonly removed: string[] = [];
  private readonly actual = new NodeDockerCommandPort();
  constructor(readonly root: string, readonly image: string, readonly owner: string, readonly volumeName: string) {}

  async run(args: readonly string[], options?: Parameters<DockerCommandPort["run"]>[1]) {
    if (args[0] === "create") {
      assert.ok(args.includes(this.image), "fixed_image_required");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.ok(args.includes("--read-only"));
      assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
      for (let i = 0; i < args.length; i++) if (args[i] === "--mount") {
        const mount = args[++i];
        const source = mount.split(",").find(part => part.startsWith("src="))?.slice(4);
        assert.ok(source && inside(this.root, source), "foreign_mount_denied");
      }
      const result = await this.actual.run(["create", "--label", `${PROBE_LABEL}=${this.owner}`,
        "--label", `com.openmausbot.runtime-probe-child=${this.volumeName}`, ...args.slice(1)], options);
      if (result.exitCode === 0) {
        const id = result.stdout.toString("utf8").trim();
        assert.match(id, /^[a-f0-9]{64}$/u);
        this.ids.add(id);
      }
      return result;
    }
    assert.ok(["start", "inspect", "wait", "logs", "kill", "rm"].includes(args[0]), "docker_operation_denied");
    assert.equal(args.length, 2, "docker_arguments_denied");
    assert.ok(this.ids.has(args[1]), "foreign_container_denied");
    return this.actual.run(args, options);
  }

  async inspect(id: string): Promise<Inspection> {
    const result = await this.run(["inspect", id]);
    assert.equal(result.exitCode, 0, "owned_container_inspect_failed");
    const values: Inspection[] = JSON.parse(result.stdout.toString("utf8"));
    assert.equal(values.length, 1);
    const value = values[0];
    assert.equal(value.Id, id);
    assert.equal(value.Image, this.image);
    assert.equal(value.Config.Labels[PROBE_LABEL], this.owner);
    assert.equal(value.Config.Labels["com.openmausbot.runtime-probe-child"], this.volumeName);
    assert.equal(value.HostConfig.NetworkMode, "none");
    assert.equal(value.HostConfig.ReadonlyRootfs, true);
    assert.equal(value.HostConfig.Privileged, false);
    assert.deepEqual(value.HostConfig.CapDrop, ["ALL"]);
    assert.equal(value.HostConfig.RestartPolicy.Name, "no");
    for (const mount of value.Mounts) assert.ok(mount.Type === "tmpfs" || inside(this.root, mount.Source), "foreign_mount_observed");
    return value;
  }

  async cleanup(remove = false): Promise<void> {
    const failures: string[] = [];
    for (const id of this.ids) {
      if (this.removed.includes(id)) continue;
      try {
        const before = await this.inspect(id);
        if (before.State.Running) await this.run(["kill", id]);
        await waitFor(async () => {
          const value = await this.inspect(id);
          return !value.State.Running && value.State.Pid === 0;
        }, "owned_container_stop_unconfirmed", 10_000);
        this.stopped.add(id);
        // Keep logs/inspect evidence for the outer runner, especially on failed probes.
        if (remove) {
          assert.equal((await this.run(["rm", id])).exitCode, 0, "owned_container_remove_failed");
          this.removed.push(id);
        }
      } catch { failures.push(id); }
    }
    assert.equal(failures.length, 0, "owned_container_cleanup_unconfirmed");
  }
}

/** No model: the trusted fixture writes only src/value.txt after a real Docker lifetime settles. */
class BarrierAgent implements AgentRunPort {
  readonly runs = new Map<string, AgentObservation>();
  private readonly pending = new Map<string, (complete: boolean) => void>();
  private aborting = false;
  constructor(private readonly docker: OwnedDocker, private readonly containment: DockerCliContainmentSupervisor) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    assert.ok(inside(this.docker.root, realpathSync(request.cwd)), "foreign_candidate_denied");
    let id: string | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const created = await this.docker.run(["create", "--name", `omb-rc-${randomUUID()}`, "--network", "none", "--read-only", "--restart", "no",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "10001:10001", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5",
        ...this.containment.labels(request.containmentBinding).flatMap(label => ["--label", label]),
        "--entrypoint", "node", this.docker.image, "-e", "setInterval(()=>{},1000)"]);
      assert.equal(created.exitCode, 0, "barrier_create_failed");
      id = created.stdout.toString("utf8").trim();
      assert.equal((await this.docker.run(["start", id])).exitCode, 0, "barrier_start_failed");
      const proof = await this.containment.issueProof(id, request.containmentBinding);
      assert.equal((await this.containment.verifyProof(proof, request.containmentBinding)).verified, true);
      await request.registerContainment(proof);
      const row: AgentObservation = { request, containerId: id, startedAt: Date.now() };
      assert.equal(this.runs.has(request.workItemId), false, "duplicate_agent_start");
      const decision = new Promise<boolean>(resolveDecision => {
        this.pending.set(request.runId, resolveDecision);
        const abort = () => resolveDecision(false);
        request.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => request.signal.removeEventListener("abort", abort);
        if (this.aborting || request.signal.aborted) resolveDecision(false);
      });
      this.runs.set(request.workItemId, row);
      const complete = await decision;
      assert.equal((await this.containment.terminateBoundContainer(id, request.containmentBinding)).state, "empty");
      row.stoppedAt = Date.now();
      if (complete) {
        writeFileSync(join(request.cwd, "src", "value.txt"), `${request.workItemId}\n`);
        row.writtenAt = Date.now();
      }
      return { threadId: request.threadId, turnId: request.turnId, status: complete ? "completed" : "failed",
        message: complete ? "synthetic fixture written" : "synthetic fixture interrupted", sandboxEnforced: true, containmentProof: proof };
    } finally {
      removeAbort?.();
      this.pending.delete(request.runId);
      if (id) assert.equal((await this.containment.terminateBoundContainer(id, request.containmentBinding)).state, "empty");
    }
  }

  release(workItemId: string): void {
    const run = this.runs.get(workItemId);
    assert.ok(run, "barrier_not_started");
    const release = this.pending.get(run.request.runId);
    assert.ok(release, "barrier_not_pending");
    release(true);
  }
  async interrupt(runId: string): Promise<void> { this.pending.get(runId)?.(false); }
  abortAll(): void { this.aborting = true; for (const release of this.pending.values()) release(false); }
}

async function main(): Promise<void> {
  assert.equal(process.platform, "linux", "linux_controller_required");
  const suppliedRoot = process.env.OMB_REPOSITORY_CONCURRENCY_ROOT;
  const image = process.env.OMB_REPOSITORY_CONCURRENCY_IMAGE;
  assert.ok(suppliedRoot && isAbsolute(suppliedRoot), "explicit_root_required");
  assert.ok(image && /^sha256:[a-f0-9]{64}$/u.test(image), "explicit_fixed_image_required");
  assert.equal(lstatSync(suppliedRoot).isDirectory(), true, "root_must_be_existing_directory");
  assert.equal(realpathSync(suppliedRoot), resolve(suppliedRoot), "root_symlink_denied");
  const root = mkdtempSync(join(suppliedRoot, "repository-concurrency-"));
  const owner = randomUUID();
  const docker = new OwnedDocker(root, image, owner, basename(dirname(suppliedRoot)));
  const hostGeneration = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  assert.match(hostGeneration, /^[a-f0-9-]{36}$/u, "linux_boot_identity_required");
  const containment = new DockerCliContainmentSupervisor({ docker, hostGeneration, verifierKey: randomBytes(32) });
  const agent = new BarrierAgent(docker, containment);
  const fixtureHome = join(root, "git-home");
  mkdirSync(fixtureHome, { mode: 0o700 });
  const gitEnvironment = isolatedExecutionEnvironment({ PATH: "/usr/local/bin:/usr/bin:/bin" }, fixtureHome);
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args],
    { cwd, env: gitEnvironment, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = (name: string): Repository => {
    const path = join(root, name);
    mkdirSync(join(path, "src"), { recursive: true });
    git(root, ["init", "-b", "main", path]);
    writeFileSync(join(path, "src", "value.txt"), "before\n");
    git(path, ["add", "."]);
    git(path, ["-c", "user.name=Concurrency Probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "synthetic base"]);
    return { path, baseSha: git(path, ["rev-parse", "HEAD"]) };
  };
  const shared = repository("shared"), independentA = repository("independent-a"), independentB = repository("independent-b");
  const repositories = [shared, shared, independentA, independentB];
  const dataDirectory = join(root, "data");
  const planningPolicy = { ...policy, allowedRepositories: [shared.path, independentA.path, independentB.path] };
  const planner = { propose: () => validProposal() };
  const service = startCollaborationService({ dataDirectory, planning: { planner, policy: planningPolicy } });
  const items: string[] = [];
  try {
    for (const [index, repo] of repositories.entries()) {
      const created = service.ingestDingTalkMessage({ sourceEventId: `synthetic-${owner}-${index}`, transportMessageId: `synthetic-transport-${index}`,
        conversationId: `synthetic-private-${index}`, addressedToBot: true, text: `修改隔离测试仓库 ${index + 1}`,
        sender: { senderCorpId: "synthetic-corp", senderStaffId: "synthetic-contributor", senderId: "synthetic-sender", displayName: "Synthetic Fixture" }, receivedAt: Date.now() });
      assert.ok(created.workItemId);
      service.reviseWorkItemDefinition(created.workItemId, { goal: `完成隔离测试仓库 ${index + 1} 的修改`, goalConfirmed: true, repository: repo.path,
        acceptanceConditions: [{ description: "候选文件记录对应 Work Item", observation: "pnpm test target" }], blockingAmbiguities: [] }, Date.now() + index);
      items.push(created.workItemId);
    }
  } finally { service.close(); }
  const commandRunner = new DockerSandboxedCommandRunner({ docker, containment, image, exchangeRoot: join(root, "command-exchange"), user: "0:0", memory: "128m", cpus: "0.5", pidsLimit: 32 });
  const runtime = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: `repository-concurrency-${owner}`, executionIsolation: "docker_linux",
    autoExecuteReady: true, planner, planningPolicy, agent, containment, commandRunner, shutdownTimeoutMs: 30_000,
    execution: { managedWorktreeRoot: join(root, "worktrees"),
      repositories: Object.fromEntries([shared, independentA, independentB].map(repo => [repo.path, { baseSha: repo.baseSha,
        targetCommands: { "pnpm test target": { argv: ["node", "-e", "const fs=require('node:fs'),assert=require('node:assert/strict');assert.match(fs.readFileSync('src/value.txt','utf8'),/^WI-[^\\r\\n]+\\n$/);console.log('synthetic candidate verified')"], timeoutMs: 30_000, maxOutputBytes: 4096 } } }])),
      limits: { maxAttempts: 1, agentTimeoutMs: 180_000, maxAgentEventBytes: 4096, interruptGraceMs: 15_000 } } });
  const databaseFile = join(dataDirectory, "collaboration", "collaboration.sqlite");
  const db = new DatabaseSync(databaseFile);
  const gitChildren: Array<{ child: ChildProcess; completion: Promise<number>; indexLock: string }> = [];
  const count = (sql: string, ...args: string[]) => countSchema.parse(db.prepare(sql).get(...args)).n;
  const evidence: ProbeEvidence = { probe: "repository-concurrency", phase: "run", status: "failed", root, image, result: "INCONCLUSIVE", modelCalls: 0, realGroupMessages: 0,
    boundaries: { scheduler: "product", durableOccupancy: "product SQLite execution lifecycle", git: "real repositories and worktrees",
      containment: "product Docker supervisor with real task containers", candidateWriter: "trusted synthetic fixture; no model", delivery: "disabled" } };
  let failure: unknown;
  try {
    assert.equal((await runtime.start()).ready, true, "runtime_not_ready");
    const activeItems = [items[0], items[2], items[3]];
    await waitFor(() => activeItems.every(item => agent.runs.has(item)), "independent_repositories_failed_to_start");
    const snapshot: LiveTask[] = [];
    for (const item of activeItems) {
      const run = agent.runs.get(item)!;
      const value = await docker.inspect(run.containerId);
      assert.equal(value.State.Running, true);
      assert.equal(value.Config.User, "10001:10001");
      assert.deepEqual(value.Mounts, []);
      assert.equal(git(run.request.cwd, ["rev-parse", "HEAD"]), repositories[items.indexOf(item)].baseSha);
      assert.equal(git(run.request.cwd, ["status", "--porcelain"]), "");
      assert.equal(count("SELECT count(*) AS n FROM collaboration_runs WHERE id=? AND work_item_id=? AND repository_path=? AND worktree_path=? AND status='running'",
        run.request.runId, item, repositories[items.indexOf(item)].path, run.request.cwd), 1);
      assert.ok(git(repositories[items.indexOf(item)].path, ["worktree", "list", "--porcelain"]).includes(`worktree ${run.request.cwd}\n`));
      snapshot.push({ workItemId: item, containerId: run.containerId, pid: value.State.Pid, worktree: run.request.cwd });
    }
    assert.equal(agent.runs.has(items[1]), false, "same_repository_started_concurrently");
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_dispatches WHERE work_item_id=?", items[1]), 0);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_sessions WHERE work_item_id=?", items[1]), 0);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_runs WHERE work_item_id=?", items[1]), 0);
    assert.equal(git(shared.path, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 2);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_sessions s LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE f.session_id IS NULL"), 3);
    assert.equal(count("SELECT count(*) AS n FROM (SELECT s.repository_path FROM collaboration_execution_sessions s LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE f.session_id IS NULL GROUP BY s.repository_path HAVING count(*)>1)"), 0);
    // Independent connection challenges the durable mutex, bypassing only the in-memory scheduler queue.
    const contenderDb = new DatabaseSync(databaseFile);
    try {
      const lease = currentInstanceLease(contenderDb);
      assert.ok(lease);
      const revision = revisionSchema.parse(contenderDb.prepare("SELECT current_plan_revision AS revision FROM collaboration_work_items WHERE id=?").get(items[1]));
      const contenderId = randomUUID();
      assert.throws(() => new ExecutionLifecycle(contenderDb, contenderId, lease).reserve({ workItemId: items[1], planRevision: revision.revision,
        repository: shared.path, baseSha: shared.baseSha, attempt: 1, maxAttempts: 1 }), /execution_repository_unsettled/u);
      assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_sessions WHERE id=?", contenderId), 0);
    } finally { contenderDb.close(); }
    // Real Git writers keep their own index locks while stdin is held; no lock is mocked.
    for (const item of activeItems) {
      const cwd = agent.runs.get(item)!.request.cwd;
      const indexLock = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index.lock"]));
      assert.ok(inside(root, indexLock));
      const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "update-index", "--index-info"], { cwd, env: gitEnvironment, stdio: ["pipe", "ignore", "pipe"] });
      child.stderr?.resume();
      const completion = new Promise<number>((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("close", code => resolveExit(code ?? 127)); });
      void completion.catch(() => undefined);
      gitChildren.push({ child, completion, indexLock });
    }
    await waitFor(() => gitChildren.every(entry => existsSync(entry.indexLock) && entry.child.exitCode === null), "real_git_writers_did_not_overlap", 10_000);
    for (let pass = 0; pass < 3; pass++) {
      await runtime.drainOnce();
      assert.equal(agent.runs.has(items[1]), false, "same_repository_escaped_queue_during_git_write");
      assert.ok(gitChildren.every(entry => existsSync(entry.indexLock) && entry.child.exitCode === null));
    }
    evidence.concurrent = { liveTasks: snapshot, gitIndexLocks: gitChildren.map(entry => entry.indexLock), durableSessions: 3, sameRepositoryContenderRejected: true };
    for (const entry of gitChildren) entry.child.stdin!.end();
    assert.deepEqual(await Promise.all(gitChildren.map(entry => entry.completion)), [0, 0, 0]);
    assert.ok(gitChildren.every(entry => !existsSync(entry.indexLock)));
    agent.release(items[0]);
    await waitFor(() => agent.runs.has(items[1]), "same_repository_queue_did_not_resume");
    const first = agent.runs.get(items[0])!, second = agent.runs.get(items[1])!;
    assert.ok(first.stoppedAt && first.writtenAt && first.writtenAt <= second.startedAt);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_settlements WHERE session_id=?", first.request.runId), 1);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_runs WHERE id=? AND status='succeeded' AND result_sha IS NOT NULL", first.request.runId), 1);
    const serialBoundary = serialBoundarySchema.parse(db.prepare("SELECT f.created_at AS first_settled_at,s.created_at AS second_reserved_at FROM collaboration_execution_settlements f JOIN collaboration_execution_sessions s ON s.id=? WHERE f.session_id=?")
      .get(second.request.runId, first.request.runId));
    assert.ok(serialBoundary.first_settled_at <= serialBoundary.second_reserved_at, "sibling_reserved_before_prior_settlement");
    for (const item of [items[1], items[2], items[3]]) agent.release(item);
    await waitFor(() => count("SELECT count(*) AS n FROM collaboration_execution_settlements") === 4, "executions_did_not_settle");
    await waitFor(() => count("SELECT count(*) AS n FROM collaboration_execution_sessions s LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE f.session_id IS NULL") === 0
      && count("SELECT count(*) AS n FROM collaboration_verification_sessions s LEFT JOIN collaboration_verification_settlements f ON f.session_id=s.id WHERE f.session_id IS NULL") === 0,
    "verification_did_not_settle");
    const runs = z.array(runRowSchema).parse(db.prepare("SELECT id,work_item_id,repository_path,worktree_path,result_sha,status,finished_at FROM collaboration_runs ORDER BY started_at,id").all());
    assert.equal(runs.length, 4);
    for (const run of runs) {
      assert.equal(run.status, "succeeded");
      assert.ok(run.finished_at && run.result_sha);
      assert.equal(git(run.worktree_path, ["show", `${run.result_sha}:src/value.txt`]), run.work_item_id);
      assert.equal(git(run.worktree_path, ["status", "--porcelain"]), "");
      assert.equal(git(run.worktree_path, ["diff-tree", "--no-commit-id", "--name-only", "-r", run.result_sha]), "src/value.txt");
      assert.equal(git(run.worktree_path, ["rev-parse", `${run.result_sha}^`]), repositories[items.indexOf(run.work_item_id)].baseSha);
    }
    for (const repo of [shared, independentA, independentB]) {
      assert.equal(git(repo.path, ["rev-parse", "HEAD"]), repo.baseSha);
      assert.equal(git(repo.path, ["status", "--porcelain"]), "");
      assert.equal(readFileSync(join(repo.path, "src", "value.txt"), "utf8"), "before\n");
    }
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_dispatches"), 4);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_commands"), 8);
    assert.equal(count("SELECT count(*) AS n FROM collaboration_execution_proofs"), 8);
    evidence.serial = { first: items[0], second: items[1], firstWrittenAt: first.writtenAt, secondStartedAt: second.startedAt,
      first_settled_at: serialBoundary.first_settled_at, second_reserved_at: serialBoundary.second_reserved_at, releasedAfterSettlement: true };
    evidence.runs = runs;
    evidence.originalRepositoriesUnchanged = true;
    evidence.executionSessionsSettled = 4;
    evidence.cases = ["same_repository_serialized", "different_repositories_concurrent", "durable_repository_reservation_rejects_contender", "real_git_index_writers_overlap", "original_repositories_unchanged"];
    evidence.result = "VERIFIED";
  } catch (error) { failure = error; evidence.result = "NOT_VERIFIED"; evidence.error = error instanceof Error ? error.message : String(error); }
  finally {
    for (const entry of gitChildren) { entry.child.stdin?.end(); if (entry.child.exitCode === null) entry.child.kill("SIGTERM"); }
    await Promise.allSettled(gitChildren.map(entry => entry.completion));
    agent.abortAll();
    try { await runtime.stop(); } catch (error) { failure ??= error; evidence.shutdownFailed = true; }
    db.close();
    try { await docker.cleanup(); evidence.ownedContainersStopped = docker.stopped.size; evidence.ownedContainersRemoved = docker.removed.length; }
    catch (error) { failure ??= error; evidence.cleanupFailed = true; }
    if (failure) evidence.result = "NOT_VERIFIED";
    evidence.status = failure ? "failed" : "passed";
    writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stdout.write(JSON.stringify(evidence) + "\n");
  }
  if (failure) process.exitCode = 1;
}

void main().catch(error => {
  process.stdout.write(JSON.stringify({ probe: "repository-concurrency", phase: "run", status: "failed", result: "NOT_VERIFIED", error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
});
