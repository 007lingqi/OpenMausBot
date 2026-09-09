/** Synthetic fixture; real Linux processes, Docker proofs, SQLite and runtime recovery.
 * Never imported by the production entrypoint. The runner owns fault injection and cleanup.
 * Continuation exercises the execution lifecycle directly, not a model or business approval.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { containmentBindingHash, type ContainmentBinding } from "../containment.ts";
import { ExecutionLifecycle } from "../execution-lifecycle.ts";
import { currentInstanceLease, type InstanceLease } from "../leases.ts";
import { hasUnsettledRepositoryActivity } from "../repository-occupancy.ts";
import { startCollaborationService } from "../service.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import type { OutboxDeliveryPort } from "../outbox.ts";
import { renderDingTalkSessionMessage } from "../../integrations/dingtalk/session-message.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort } from "./docker-containment.ts";
import { DockerCoordinatorAuthority } from "./docker-coordinator.ts";
import { CollaborationHeadlessRuntime } from "./runtime.ts";

const LABEL = "com.openmausbot.runtime-crash-probe";
const OLD_SESSION = "synthetic-interrupted-execution";
const NEXT_SESSION = "synthetic-after-recovery-execution";

interface Fixture {
  originalWorkItemId: string;
  queuedWorkItemId: string;
  baseSha: string;
  taskContainerId: string;
  taskName: string;
  taskBindingHash: string;
  oldInstance: Pick<InstanceLease, "ownerId" | "fence">;
}

function readJson<T>(file: string): T {
  // SAFETY: Callers read only this probe's wx-created fixtures and receipts in its private volume.
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function saveJson<T>(file: string, value: T): void {
  writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
}

async function waitFor(check: () => boolean, code: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw Error(code);
    await delay(50);
  }
}

async function main(): Promise<void> {
  assert.equal(process.platform, "linux", "real_linux_required");
  const root = process.env.OMB_RUNTIME_SMOKE_ROOT ?? "";
  const image = process.env.OMB_RUNTIME_SMOKE_IMAGE ?? "";
  const controllerName = process.env.OMB_RUNTIME_SMOKE_CONTAINER ?? "";
  const keyHex = process.env.OMB_RUNTIME_SMOKE_KEY ?? "";
  const mode = process.env.OMB_RUNTIME_SMOKE_MODE;
  assert.match(root, /^\/var\/lib\/docker\/volumes\/omb-runtime-[a-z0-9-]+\/_data$/u);
  assert.equal(root, resolve(root)); assert.equal(root, realpathSync(root));
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  assert.match(controllerName, /^omb-runtime-[a-zA-Z0-9_.-]+$/u);
  assert.match(keyHex, /^[a-f0-9]{64}$/u);
  assert.ok(mode === "produce" || mode === "recover" || mode === "replay");
  const name = basename(dirname(root));
  const repo = join(root, "repo"), data = join(root, "data"), deliveries = join(root, "deliveries");
  const fixtureFile = join(root, "crash-fixture.json"), recoveredFile = join(root, "crash-recovered.json");
  const databaseFile = join(data, "collaboration", "collaboration.sqlite");
  const docker = new NodeDockerCommandPort();
  const hostGeneration = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const authorityOptions = { docker, image, hostGeneration, verifierKey: Buffer.from(keyHex, "hex") };
  const containment = new DockerCliContainmentSupervisor(authorityOptions);
  const coordinator = new DockerCoordinatorAuthority({ ...authorityOptions, container: controllerName });
  mkdirSync(deliveries, { recursive: true, mode: 0o700 });
  const localDelivery: OutboxDeliveryPort = {
    async deliver(message) {
      const path = join(deliveries, createHash("sha256").update(message.id).digest("hex") + ".json");
      const receipt = { id: message.id, dedupeKey: message.dedupeKey, message: renderDingTalkSessionMessage(message.payload) };
      if (existsSync(path)) assert.deepEqual(readJson(path), receipt);
      else saveJson(path, receipt);
      return { outcome: "sent", transportId: `synthetic-local:${message.id}` };
    },
  };
  const planningPolicy = { ...policy, allowedRepositories: [repo] };
  const runtime = new CollaborationHeadlessRuntime({
    dataDirectory: data, ownerId: `${name}:${mode}`, instanceLeaseTtlMs: 3_000,
    shutdownTimeoutMs: 3_000, lifecycleRecoveryTimeoutMs: 10_000,
    containment, coordinator, planner: { propose: validProposal }, planningPolicy,
    outboxDelivery: localDelivery,
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Synthetic Runtime Probe", "-c", "user.email=runtime-probe@example.invalid", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let db: DatabaseSync | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatFailure: unknown;
  const assertLive = () => { if (heartbeatFailure) throw heartbeatFailure; assert.equal(runtime.health().ready, true); };

  async function ownedTask(id: string, bindingHash: string) {
    assert.match(id, /^[a-f0-9]{64}$/u);
    const result = await docker.run(["inspect", "--type", "container", id], { timeoutMs: 5_000 });
    assert.equal(result.exitCode, 0);
    const actual = JSON.parse(result.stdout.toString())[0];
    assert.equal(actual.Id, id); assert.equal(actual.Image, image);
    assert.equal(actual.Config.Labels[LABEL], name);
    assert.equal(actual.Config.Labels["com.openmausbot.collaboration.binding"], bindingHash);
    assert.equal(actual.HostConfig.NetworkMode, "none"); assert.equal(actual.HostConfig.ReadonlyRootfs, true);
    assert.equal(actual.HostConfig.Privileged, false); assert.equal(actual.HostConfig.RestartPolicy.Name, "no");
    assert.deepEqual(actual.HostConfig.CapDrop, ["ALL"]);
    assert.ok(actual.Mounts.every((mount: { Source: string; Type: string }) =>
      mount.Type === "tmpfs" || mount.Source.startsWith(root + "/")));
    return actual;
  }

  async function createTask(suffix: string, binding: ContainmentBinding, source: string, control?: string) {
    const taskName = `${name}-${suffix}`;
    const made = await docker.run(["create", "--name", taskName, "--label", `${LABEL}=${name}`,
      "--label", `com.openmausbot.runtime-probe-child=${name}`,
      ...containment.labels(binding).flatMap(label => ["--label", label]),
      "--network", "none", "--read-only", "--restart", "no", "--user", "0:0", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5",
      "--mount", `type=bind,src=${repo},dst=/workspace`,
      ...(control ? ["--mount", `type=bind,src=${control},dst=/control,readonly`] : []),
      "--entrypoint", "node", image, "-e", source], { timeoutMs: 10_000 });
    assert.equal(made.exitCode, 0, "synthetic_task_create_failed");
    const id = made.stdout.toString().trim();
    await ownedTask(id, containmentBindingHash(binding));
    assert.equal((await docker.run(["start", id])).exitCode, 0);
    const proof = await containment.issueProof(id, binding);
    assert.equal((await containment.verifyProof(proof, binding)).verified, true);
    return { id, taskName, proof };
  }

  function lease(): InstanceLease { assert.ok(db); const current = currentInstanceLease(db); assert.ok(current); return current; }
  function digest() {
    assert.ok(db);
    const tables = ["collaboration_work_items", "collaboration_external_events", "collaboration_execution_sessions",
      "collaboration_execution_commands", "collaboration_execution_proofs", "collaboration_execution_settlements", "collaboration_outbox"];
    return {
      counts: Object.fromEntries(tables.map(table => [table, Number(db!.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)])),
      deliveryFiles: readdirSync(deliveries).sort(),
      ticks: readFileSync(join(repo, "src", "ticks.txt"), "utf8"),
      continuation: existsSync(join(repo, "src", "after-recovery.txt")) ? readFileSync(join(repo, "src", "after-recovery.txt"), "utf8") : null,
    };
  }
  async function drainAll(): Promise<void> {
    for (let n = 0; n < 64; n++) {
      assertLive();
      if (!(await runtime.drainOnce()).dispatched) return;
    }
    throw Error("synthetic_outbox_did_not_drain");
  }

  try {
    if (mode === "produce") {
      assert.equal(existsSync(fixtureFile), false); assert.equal(existsSync(databaseFile), false);
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "ticks.txt"), "0", { flag: "wx" });
      git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "synthetic runtime recovery fixture");
    } else {
      db = new DatabaseSync(databaseFile);
      await waitFor(() => (currentInstanceLease(db!)?.expiresAt ?? 0) <= Date.now(), "old_runtime_lease_not_expired", 10_000);
      db.close(); db = undefined;
    }
    assert.equal((await runtime.start()).ready, true);
    db = new DatabaseSync(databaseFile); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    heartbeat = setInterval(() => { void runtime.drainOnce().catch(error => { heartbeatFailure = error; }); }, 250);

    if (mode === "produce") {
      const service = startCollaborationService({ dataDirectory: data,
        planning: { planner: { propose: validProposal }, policy: planningPolicy } });
      const seed = (suffix: string, goal: string) => {
        const sourceEventId = `${name}:${suffix}`;
        const received = runtime.ingestDingTalkMessage({ sourceEventId, transportMessageId: sourceEventId,
          conversationId: `${name}:${suffix}`, addressedToBot: true, text: goal, receivedAt: Date.now(),
          sender: { senderCorpId: "synthetic", senderStaffId: "fixture", senderId: "fixture", displayName: "Synthetic" } });
        assert.ok(received.workItemId);
        service.reviseWorkItemDefinition(received.workItemId, { goal, goalConfirmed: true, repository: repo,
          acceptanceConditions: [{ description: "合成文件经确定性检查", observation: "pnpm test target" }], blockingAmbiguities: [] }, Date.now());
        return received.workItemId;
      };
      let originalWorkItemId: string, queuedWorkItemId: string;
      try {
        originalWorkItemId = seed("original", "合成在途恢复检查");
        queuedWorkItemId = seed("after", "合成恢复后独立检查");
      } finally { service.close(); }
      const oldInstance = lease(), baseSha = git("rev-parse", "HEAD");
      const session = new ExecutionLifecycle(db, OLD_SESSION, oldInstance);
      session.reserve({ workItemId: originalWorkItemId, planRevision: 1, repository: repo, baseSha, attempt: 1 });
      const binding: ContainmentBinding = { runId: OLD_SESSION, canonicalWorktreePath: repo,
        instanceOwner: oldInstance.ownerId, instanceFence: oldInstance.fence, nonce: randomBytes(32).toString("hex") };
      session.command(1, binding);
      const task = await createTask("interrupted", binding,
        "const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync('/workspace/src/ticks.txt',String(++n)),40);");
      session.proof(1, task.proof);
      await waitFor(() => Number(readFileSync(join(repo, "src", "ticks.txt"), "utf8")) > 0, "synthetic_writer_not_active");
      assert.equal(hasUnsettledRepositoryActivity(db, repo), true);
      assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_execution_finalization_intents").get()!.n, 0);
      const fixture: Fixture = { originalWorkItemId, queuedWorkItemId, baseSha, taskContainerId: task.id,
        taskName: task.taskName, taskBindingHash: containmentBindingHash(binding), oldInstance };
      saveJson(fixtureFile, fixture); assertLive();
      process.stdout.write(JSON.stringify({ event: "crash_ready", taskContainerId: task.id, taskName: task.taskName,
        probeLabelKey: LABEL, probeLabelValue: name, taskBindingHash: fixture.taskBindingHash,
        realRuntimeStarted: true, activeTaskProofPersisted: true, finalizationIntents: 0 }) + "\n");
      // Leave both runtime/SQLite connections live; only the owning runner SIGKILLs this container.
      await new Promise<void>(() => {});
      return;
    }

    const fixture = readJson<Fixture>(fixtureFile);
    const oldTask = await ownedTask(fixture.taskContainerId, fixture.taskBindingHash);
    assert.equal(oldTask.State.Status, "exited"); assert.equal(oldTask.State.Pid, 0);
    assert.equal(oldTask.State.Running, false);
    // SAFETY: Successful producer runtime.start persisted this instance's proof in the migrated ledger before crash_ready.
    const originalProof = db.prepare("SELECT proof_json FROM collaboration_coordinator_proofs WHERE instance_owner=? AND instance_fence=?")
      .get(fixture.oldInstance.ownerId, fixture.oldInstance.fence) as { proof_json: string };
    assert.equal((await coordinator.inspect(JSON.parse(originalProof.proof_json), fixture.oldInstance)).state, "stopped");
    const sourceEvent = `lifecycle-recovery:execution:${OLD_SESSION}:recovered`;
    await waitFor(() => !!db!.prepare("SELECT 1 FROM collaboration_execution_settlements WHERE session_id=?").get(OLD_SESSION), "runtime_did_not_settle");
    await waitFor(() => !!db!.prepare("SELECT 1 FROM collaboration_outbox WHERE source_event_id=? AND delivery_state='sent'").get(sourceEvent), "runtime_recovery_notice_not_delivered");
    const settlement = readJsonFromSettlement(db, OLD_SESSION);
    assert.equal(settlement.coordinator.state, "stopped");
    assert.equal(settlement.evidence.length, 1); assert.equal(settlement.evidence[0].state, "empty");
    assert.notEqual(settlement.recoveredBy.ownerId, fixture.oldInstance.ownerId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_execution_finalization_intents WHERE session_id=?").get(OLD_SESSION)!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_execution_sessions WHERE work_item_id=?").get(fixture.originalWorkItemId)!.n, 1);
    // SAFETY: Both selected columns are TEXT in the migrated Outbox; the preceding wait confirmed this source event was delivered.
    const notices = db.prepare("SELECT id,payload_json FROM collaboration_outbox WHERE source_event_id=?").all(sourceEvent) as Array<{ id: string; payload_json: string }>;
    assert.equal(notices.length, 1);
    const rendered = JSON.stringify(renderDingTalkSessionMessage(JSON.parse(notices[0].payload_json)));
    assert.match(rendered, /中断的修改不会擅自重做/u); assert.doesNotMatch(rendered, /修改完成/u);
    assert.equal(hasUnsettledRepositoryActivity(db, repo), false);
    const ticks = readFileSync(join(repo, "src", "ticks.txt"), "utf8"); await delay(150);
    assert.equal(readFileSync(join(repo, "src", "ticks.txt"), "utf8"), ticks);

    if (mode === "recover") {
      assert.equal(existsSync(recoveredFile), false);
      // A distinct synthetic Work Item proves the released repository accepts new work.
      // This is a direct lifecycle probe, not automatic retry or model execution.
      const current = lease(), session = new ExecutionLifecycle(db, NEXT_SESSION, current);
      session.reserve({ workItemId: fixture.queuedWorkItemId, planRevision: 1, repository: repo, baseSha: fixture.baseSha, attempt: 1 });
      const binding: ContainmentBinding = { runId: NEXT_SESSION, canonicalWorktreePath: repo,
        instanceOwner: current.ownerId, instanceFence: current.fence, nonce: randomBytes(32).toString("hex") };
      const control = join(root, "continuation-control"); mkdirSync(control, { mode: 0o700 });
      session.command(1, binding);
      const task = await createTask("continued", binding,
        "const fs=require('node:fs'),assert=require('node:assert/strict');const t=setInterval(()=>{if(!fs.existsSync('/control/start'))return;clearInterval(t);fs.writeFileSync('/workspace/src/after-recovery.txt','recovered\\n');assert.equal(fs.readFileSync('/workspace/src/after-recovery.txt','utf8'),'recovered\\n');process.exit(0)},25);", control);
      session.proof(1, task.proof);
      writeFileSync(join(control, "start"), "start", { flag: "wx", mode: 0o644 });
      const finished = await docker.run(["wait", task.id], { timeoutMs: 10_000 });
      assert.equal(finished.exitCode, 0); assert.equal(finished.stdout.toString().trim(), "0");
      const continued = await ownedTask(task.id, containmentBindingHash(binding));
      assert.equal(continued.State.Pid, 0); assert.equal(continued.State.Status, "exited");
      assert.equal(await session.settle(containment), true);
      assert.equal(readFileSync(join(repo, "src", "after-recovery.txt"), "utf8"), "recovered\n");
      assert.equal(hasUnsettledRepositoryActivity(db, repo), false);
      assert.equal(git("rev-parse", "HEAD"), fixture.baseSha);
      await drainAll();
      saveJson(recoveredFile, digest());
      process.stdout.write(JSON.stringify({ status: "passed", phase: mode, realLinux: true, realRuntimeRecovery: true, realTaskExitProof: true,
        oldCoordinatorStopped: true, oldWriterStopped: true, recoveredSettlements: 1, recoveryNotices: 1,
        originalAttempts: 1, repositoryReleased: true, continuation: "distinct_synthetic_lifecycle_completed",
        continuationDispatch: "direct_probe_lifecycle", syntheticPlanner: true, syntheticLocalDelivery: true,
        modelCalls: 0, realGroupMessages: 0, businessAcceptance: false }) + "\n");
    } else {
      await drainAll();
      assert.deepEqual(digest(), readJson(recoveredFile));
      assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_execution_settlements").get()!.n, 2);
      assert.equal(git("rev-parse", "HEAD"), fixture.baseSha);
      process.stdout.write(JSON.stringify({ status: "passed", phase: mode, realLinux: true, restartedRuntime: true,
        recoveryReplayDeduplicated: true, continuationNotReexecuted: true, deliveryFilesUnchanged: true,
        originalAttempts: 1, repositoryReleased: true, modelCalls: 0, realGroupMessages: 0, businessAcceptance: false }) + "\n");
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await runtime.stop(); db?.close();
  }
}

function readJsonFromSettlement(db: DatabaseSync, session: string): {
  coordinator: { state: string }; evidence: Array<{ state: string }>; recoveredBy: { ownerId: string };
} {
  // SAFETY: The only caller first waits for this session's settlement; the migrated schema stores evidence_json as TEXT.
  const row = db.prepare("SELECT evidence_json FROM collaboration_execution_settlements WHERE session_id=?").get(session) as { evidence_json: string };
  return JSON.parse(row.evidence_json);
}

void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
