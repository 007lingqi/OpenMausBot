import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DockerCoordinatorAuthority } from "./docker-coordinator.ts";
import { NodeDockerCommandPort } from "./docker-containment.ts";
import { registerCoordinator } from "../coordinator-lifecycle.ts";
import { InstanceLeaseCoordinator } from "../leases.ts";
import { ExecutionLifecycle } from "../execution-lifecycle.ts";
import { recoverLifecycleSession } from "../lifecycle-recovery.ts";
import { startCollaborationService } from "../service.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import { hasUnsettledExecution } from "../repository-occupancy.ts";

async function main() {
  const repo = "/probe/repo", database = "/probe/data/collaboration/collaboration.sqlite", instance = { ownerId: "synthetic-old-coordinator", fence: 1 };
  const authority = new DockerCoordinatorAuthority({ docker: new NodeDockerCommandPort(), container: process.env.OMB_COORDINATOR_SMOKE_NAME!,
    image: process.env.OMB_COORDINATOR_SMOKE_IMAGE!, hostGeneration: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    verifierKey: Buffer.from(process.env.OMB_COORDINATOR_SMOKE_KEY!, "hex") });
  const actualController = await new NodeDockerCommandPort().run(["inspect", process.env.OMB_COORDINATOR_SMOKE_NAME!]);
  assert.equal(actualController.exitCode, 0);
  assert.deepEqual(JSON.parse(actualController.stdout.toString())[0].HostConfig.CapAdd.slice().sort(), ["CAP_CHOWN", "CAP_SETGID", "CAP_SETUID"]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  if (process.env.OMB_COORDINATOR_SMOKE_MODE === "observe") {
    const db = new DatabaseSync(database), proof = JSON.parse(readFileSync("/probe/proof.json", "utf8"));
    try {
      assert.equal((await authority.inspect(proof, instance)).state, "stopped");
      const lease = new InstanceLeaseCoordinator(db, "synthetic-new-coordinator").acquire(Date.now(), 60000); assert.ok(lease);
      assert.equal(hasUnsettledExecution(db, repo), true);
      const input = { kind: "execution" as const, sessionId: "synthetic-native-git", instance: lease, coordinator: authority, now: Date.now,
        containment: { async verifyProof() { throw Error("no task commands expected"); }, async inspect() { throw Error("no task commands expected"); }, async terminateAndWaitEmpty() { throw Error("passive recovery cannot kill"); } } };
      assert.equal((await recoverLifecycleSession(db, input)).state, "recovered");
      assert.equal((await recoverLifecycleSession(db, input)).state, "already_settled");
      assert.equal(hasUnsettledExecution(db, repo), false);
      assert.equal(db.prepare("SELECT count(*) AS n FROM collaboration_execution_finalization_intents").get()!.n, 0);
      const before = [git("rev-parse", "HEAD"), readFileSync("/probe/count", "utf8")]; await delay(300);
      assert.deepEqual([git("rev-parse", "HEAD"), readFileSync("/probe/count", "utf8")], before);
      process.stdout.write(JSON.stringify({ oldEpochStopped: true, nativeGitStable: true, recoveredWithoutInventedFinalization: true, recoveryIdempotent: true, modelCalls: 0, realGroupMessages: 0 }) + "\n");
    } finally { db.close(); }
    return;
  }
  if (existsSync("/probe/proof.json")) {
    const old = JSON.parse(readFileSync("/probe/proof.json", "utf8"));
    assert.equal((await authority.inspect(old, instance)).state, "stopped");
    const fresh = await authority.capture({ ownerId: "synthetic-restarted", fence: 3 });
    assert.equal(fresh.containerId, old.containerId); assert.notEqual(fresh.startedAt, old.startedAt);
    assert.equal((await authority.inspect(fresh, fresh.instance)).state, "active");
    writeFileSync("/probe/restart.json", JSON.stringify({ sameContainerNewEpoch: true, oldStoppedWhileNewActive: true }), { flag: "wx", mode: 0o600 });
    setInterval(() => {}, 1000); return;
  }
  mkdirSync(repo); git("init", "-q"); writeFileSync(repo + "/count.txt", "0"); git("add", "."); git("commit", "-qm", "fixture");
  const service = startCollaborationService({ dataDirectory: "/probe/data", planning: { planner: { propose: validProposal }, policy: { ...policy, allowedRepositories: [repo] } } });
  const item = service.ingestDingTalkMessage({ sourceEventId: "synthetic-coordinator-only", transportMessageId: "synthetic-coordinator-only", conversationId: "synthetic",
    addressedToBot: true, text: "合成恢复测试", sender: { senderCorpId: "synthetic", senderStaffId: "test", senderId: "test", displayName: "Synthetic" }, receivedAt: 1000 });
  service.reviseWorkItemDefinition(item.workItemId!, { goal: "测试原生Git退出", goalConfirmed: true, repository: repo, acceptanceConditions: [{ description: "Git停止", observation: "合成进程结束" }], blockingAmbiguities: [] }, 2000); service.close();
  const db = new DatabaseSync(database), lease = new InstanceLeaseCoordinator(db, instance.ownerId).acquire(Date.now(), 1000)!;
  await registerCoordinator(db, lease, authority, Date.now);
  const session = new ExecutionLifecycle(db, "synthetic-native-git", lease); session.reserve({ workItemId: item.workItemId!, planRevision: 1, repository: repo, baseSha: git("rev-parse", "HEAD"), attempt: 1 });
  const proof = db.prepare("SELECT proof_json FROM collaboration_coordinator_proofs").get() as { proof_json: string }; writeFileSync("/probe/proof.json", proof.proof_json, { flag: "wx", mode: 0o600 }); db.close();
  // The native detached writer is OUTSIDE any task container but inside this
  // coordinator's PID namespace. No hooks, model, user files or network.
  const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'),cp=require('node:child_process');let n=0;setInterval(()=>{n++;fs.writeFileSync('${repo}/count.txt',String(n));for(const args of [['add','.'],['commit','-qm','tick']])cp.execFileSync('git',['-C','${repo}','-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=test@example.invalid',...args],{stdio:'ignore'});fs.writeFileSync('/probe/count',String(n));},60);`], { detached: true, stdio: "ignore" }); child.unref();
  const deadline = Date.now() + 5000;
  while (!existsSync("/probe/count") && Date.now() < deadline) await delay(25);
  assert.ok(existsSync("/probe/count")); process.stdout.write("native-git-running\n"); setInterval(() => {}, 1000);
}
void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exit(1); });
