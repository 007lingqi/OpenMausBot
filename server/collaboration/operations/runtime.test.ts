import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "../containment.ts";
import { openCollaborationLedger } from "../db.ts";
import { markRestoredLedgerForReview } from "../restore-guard.ts";
import { startCollaborationService } from "../service.ts";
import {
  CollaborationHeadlessRuntime,
  enqueueExecutionOutcomeStatus,
  enqueueOwnerDecisionForWorkItem,
  enqueuePendingOwnerDecisionCards,
  type RuntimeStream,
} from "./runtime.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "collaboration-runtime-"));
  scratch.push(path);
  return path;
}

function message(sourceEventId: string, receivedAt = 1_000) {
  return {
    sourceEventId,
    transportMessageId: `transport-${sourceEventId}`,
    conversationId: "conversation",
    addressedToBot: true,
    text: `work ${sourceEventId}`,
    sender: {
      senderCorpId: "corp",
      senderStaffId: "staff",
      senderId: "sender",
      displayName: "Contributor",
    },
    receivedAt,
  };
}

function seedRunningRun(dataDirectory: string, ownerId: string): { proof: ContainmentProof; binding: ContainmentBinding } {
  const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  database.exec("PRAGMA foreign_keys = OFF");
  const lease = database
    .prepare("SELECT fencing_token FROM collaboration_instance_lease WHERE owner_id = ?")
    .get(ownerId) as { fencing_token: number };
  const binding: ContainmentBinding = {
    runId: "RUN-SHUTDOWN",
    canonicalWorktreePath: "/managed/shutdown-worktree",
    instanceOwner: ownerId,
    instanceFence: lease.fencing_token,
    nonce: "shutdown-containment-nonce-000000000001",
  };
  const proof: ContainmentProof = {
    identity: {
      backend: "verified_service",
      opaqueId: "openmausbot-shutdown-scope-0001",
      hostGeneration: "boot-1",
      verifierVersion: "v1",
    },
    receipt: "trusted-receipt",
  };
  database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
      "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
      "completion_definition, risk, budget_json, created_at, runtime_state, lease_owner, lease_fence, lease_expires_at) " +
      "VALUES ('WI-SHUTDOWN', 1, 'modify', 'modify', 'ready', 'developer', 'shutdown', '[]', 'shutdown', '[]', '[]', " +
      "'[]', '[]', '[]', 'done', 'low', '{}', 1, 'running', ?, 1, 999999)",
  ).run(ownerId);
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at, runtime_identity_json, containment_state, instance_owner, " +
      "instance_fence, node_lease_fence, containment_binding_json, containment_fingerprint) " +
      "VALUES ('RUN-SHUTDOWN', 'WI-SHUTDOWN', 1, 'modify', 1, 'developer', 'thread', 'turn', 'running', '/repo', " +
      "'/managed/shutdown-worktree', 'branch', ?, 1, ?, 'verified', ?, ?, 1, ?, ?)",
  ).run(
    "a".repeat(40),
    JSON.stringify(proof),
    ownerId,
    lease.fencing_token,
    JSON.stringify(binding),
    runtimeIdentityFingerprint(proof.identity),
  );
  database.close();
  return { proof, binding };
}

describe("production-isomorphic collaboration runtime", () => {
  it("includes a concrete bounded diff in the candidate status delivered to DingTalk", () => {
    const repository = temporaryDirectory();
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Pilot Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "pilot@example.invalid"]);
    writeFileSync(join(repository, "pilot-output.txt"), "pending\n");
    execFileSync("git", ["-C", repository, "add", "--", "pilot-output.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "baseline"]);
    const baseSha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repository, "pilot-output.txt"), "hello pilot\n");
    execFileSync("git", ["-C", repository, "add", "--", "pilot-output.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "candidate"]);
    const resultSha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const dataDirectory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory });
    const workItemId = service.ingestDingTalkMessage(message("candidate-preview")).workItemId!;
    service.close();
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    enqueueExecutionOutcomeStatus({
      database,
      outcome: {
        runId: "run-preview",
        workItemId,
        planRevision: 1,
        nodeId: "modify",
        baseSha,
        resultSha,
        branch: "candidate",
        worktreePath: repository,
        changedPaths: ["pilot-output.txt"],
        report: {
          state: "target_tests_passed",
          modified: true,
          targetTestsPassed: true,
          fullGatePassed: false,
          label: "目标测试通过；完整门禁未执行",
          reasons: [],
        },
        evidence: [],
      },
      now: 1_000,
    });
    const row = database
      .prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id = 'candidate:run-preview'")
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { candidatePreview?: string };
    expect(payload.candidatePreview).toContain("-pending");
    expect(payload.candidatePreview).toContain("+hello pilot");
    database.close();
  });

  it("enqueues a durable SHA-bound Owner decision card for a passing candidate", () => {
    const dataDirectory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory });
    const workItemId = service.ingestDingTalkMessage(message("candidate-card")).workItemId!;
    service.close();
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    enqueueExecutionOutcomeStatus({
      database,
      cardTemplateId: "template-1",
      outcome: {
        runId: "run-1",
        workItemId,
        planRevision: 1,
        nodeId: "modify",
        baseSha: "1".repeat(40),
        resultSha: "2".repeat(40),
        branch: "candidate",
        worktreePath: "/managed/worktree",
        changedPaths: ["pilot-output.txt"],
        report: {
          state: "target_tests_passed",
          modified: true,
          targetTestsPassed: true,
          fullGatePassed: false,
          label: "目标测试通过；完整门禁未执行",
          reasons: [],
        },
        evidence: [],
      },
      now: 1_000,
    });
    const row = database
      .prepare("SELECT kind, payload_json FROM collaboration_outbox WHERE source_event_id = 'candidate:run-1'")
      .get() as { kind: string; payload_json: string };
    expect(row.kind).toBe("plan_status_card");
    expect(JSON.parse(row.payload_json)).toMatchObject({
      type: "plan_status_card",
      cardTemplateId: "template-1",
      workItemId,
      workItemVersion: 1,
      candidateSha: "2".repeat(40),
      summary: "本次改动已完成并通过基础验证，但存在需要负责人确认的风险。",
      approvalRequired: true,
    });
    expect(row.payload_json).not.toContain("隔离执行");
    expect(row.payload_json).not.toContain("opaque-token");
    database.close();
  });

  it("idempotently recovers an Owner decision card and accepts a high-risk candidate by plain command", async () => {
    const repository = temporaryDirectory();
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Pilot Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "pilot@example.invalid"]);
    writeFileSync(join(repository, "pilot-output.txt"), "pending\n");
    execFileSync("git", ["-C", repository, "add", "--", "pilot-output.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "baseline"]);
    const baseSha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repository, "pilot-output.txt"), "hello pilot\n");
    execFileSync("git", ["-C", repository, "add", "--", "pilot-output.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "candidate"]);
    const resultSha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const dataDirectory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory });
    service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "staff", now: 100 });
    const workItemId = service.ingestDingTalkMessage(message("existing-candidate")).workItemId!;
    service.close();
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      "UPDATE collaboration_work_items SET current_plan_revision = 1, definition_status = 'ready_for_execution' WHERE id = ?",
    ).run(workItemId);
    database.prepare(
      "INSERT INTO collaboration_work_item_snapshots " +
        "(work_item_id,revision,source_work_item_version,goal,goal_confirmed,repository,facts_json,assumptions_json," +
        "acceptance_json,blocking_ambiguities_json,created_at) " +
        "VALUES (?,1,1,'existing candidate',1,?,'[]','[]',?,'[]',1)",
    ).run(workItemId, repository, JSON.stringify([{ description: "pilot passes", observation: "pilot" }]));
    database.prepare(
      "INSERT INTO collaboration_plan_revisions " +
        "(id,work_item_id,revision,snapshot_revision,status,summary,proposal_hash,created_at) " +
        "VALUES ('plan-existing',?,1,1,'published','fixture','proposal-hash',1)",
    ).run(workItemId);
    database.prepare(
      "INSERT INTO collaboration_work_nodes " +
        "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
        "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
        "completion_definition,risk,budget_json,created_at,execution_status,control_state) " +
        "VALUES (?,1,'modify','modify','ready','codex-patch','modify','[]','modify','[]','[]','[]'," +
        "'[]','[]','change complete','high','{}',1,'candidate_ready','active')",
    ).run(workItemId);
    database.prepare(
      "INSERT INTO collaboration_work_nodes " +
        "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
        "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
        "completion_definition,risk,budget_json,created_at,execution_status,control_state) " +
        "VALUES (?,1,'validate','validate','ready','codex-verifier','verify','[]','verify','[]','[]','[]'," +
        "'[\"pilot\"]','[]','target passes','high','{}',1,'candidate_ready','active')",
    ).run(workItemId);
    database.prepare(
      "INSERT INTO collaboration_runs " +
        "(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path," +
        "worktree_path,branch,base_sha,result_sha,started_at,finished_at) " +
        "VALUES ('run-existing',?,1,'modify',4,'developer','thread','turn','succeeded',?,?,'candidate',?,?,1,2)",
    ).run(workItemId, repository, repository, baseSha, resultSha);
    database.prepare(
      "INSERT INTO collaboration_candidates " +
        "(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) " +
        "VALUES ('candidate-existing','run-existing','target_tests_passed',?,?,'[\"pilot-output.txt\"]','[]','{}',2)",
    ).run(baseSha, resultSha);
    database.prepare(
      "INSERT INTO collaboration_test_evidence " +
        "(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at) " +
        "VALUES ('evidence-existing','run-existing','pilot','[\"node\",\"verify.mjs\"]','/worktree',0,10," +
        "'passed','', 'target_passed',2)",
    ).run();
    database.prepare(
      "INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "VALUES ('verifier-review-existing','run-existing','verifier',1,'passed','deterministic-verifier-v1',1,'spec-hash',?,?,2)",
    ).run(resultSha, JSON.stringify({ contractSchemaVersion: 1 }));
    database.prepare(
      "INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "VALUES ('meta-review-existing','run-existing','meta',1,'passed','meta-acceptance-gate-v1',1,'spec-hash',?,?,2)",
    ).run(resultSha, JSON.stringify({ contractSchemaVersion: 1, verifierAttempt: 1 }));
    expect(enqueuePendingOwnerDecisionCards(database, "template-1", 1_000)).toBe(1);
    expect(enqueuePendingOwnerDecisionCards(database, "template-1", 2_000)).toBe(0);
    const row = database.prepare(
      "SELECT payload_json FROM collaboration_outbox WHERE source_event_id = 'owner-decision:run-existing:v1'",
    ).get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({
      cardTemplateId: "template-1",
      outTrackId: "candidate-run-existing",
      workItemId,
      workItemVersion: 1,
      candidateSha: resultSha,
      candidatePreview: expect.stringContaining("+hello pilot"),
      changedPaths: ["pilot-output.txt"],
      testStates: ["pilot: target_passed"],
    });
    expect(row.payload_json).not.toContain("actionToken");
    expect(enqueueOwnerDecisionForWorkItem(database, workItemId, undefined, "refresh-command-1", 3_000)).toBe(true);
    expect(enqueueOwnerDecisionForWorkItem(database, workItemId, undefined, "refresh-command-1", 4_000)).toBe(true);
    const refreshed = database.prepare(
      "SELECT aggregate_type, payload_json FROM collaboration_outbox WHERE source_event_id = 'refresh-command-1'",
    ).get() as { aggregate_type: string; payload_json: string };
    expect(refreshed.aggregate_type).toBe("work_item");
    expect(JSON.parse(refreshed.payload_json)).toMatchObject({
      workItemId,
      status: "candidate_ready",
      candidateSha: resultSha,
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_outbox WHERE source_event_id = 'refresh-command-1'",
    ).get()).toEqual({ count: 1 });
    database.close();

    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux" });
    await runtime.start();
    const approved = runtime.performDingTalkOwnerTextCommand({
      transportEventId: "approve-command-1",
      transportMessageId: "approve-transport-1",
      command: "approve_candidate",
      workItemId,
      sender: message("owner-approval").sender,
      receivedAt: 5_000,
    });
    expect(approved).toMatchObject({ allowed: true, duplicate: false, reason: "owner_action_applied" });
    const approvedDb = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(approvedDb.prepare(
      "SELECT status,control_state,accepted_candidate_sha,accepted_by FROM collaboration_work_items WHERE id = ?",
    ).get(workItemId)).toMatchObject({
      status: "accepted",
      control_state: "accepted",
      accepted_candidate_sha: resultSha,
      accepted_by: expect.any(String),
    });
    const response = approvedDb.prepare(
      "SELECT payload_json FROM collaboration_outbox WHERE source_event_id = 'approve-command-1'",
    ).get() as { payload_json: string };
    expect(JSON.parse(response.payload_json)).toMatchObject({ status: "owner_accepted" });
    expect(response.payload_json).not.toContain("actionToken");
    approvedDb.close();
    await runtime.stop();
  });

  it("returns status to contributors and applies direct controls only for the sole Owner", async () => {
    const dataDirectory = temporaryDirectory();
    const setup = startCollaborationService({ dataDirectory });
    setup.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "owner", now: 500 });
    const workItemId = setup.ingestDingTalkMessage(message("text-control-setup")).workItemId!;
    setup.close();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux" });
    await runtime.start();
    expect(runtime.performDingTalkOwnerTextCommand({
      transportEventId: "status-command",
      transportMessageId: "transport-status-command",
      command: "status",
      workItemId,
      sender: message("status-sender").sender,
      receivedAt: 1_000,
    })).toMatchObject({ allowed: true, duplicate: false, reason: "status_returned" });
    expect(runtime.performDingTalkOwnerTextCommand({
      transportEventId: "pause-command-denied",
      transportMessageId: "transport-pause-command-denied",
      command: "pause",
      workItemId,
      sender: message("contributor").sender,
      receivedAt: 1_100,
    })).toMatchObject({ allowed: false, reason: "not_active_owner" });
    expect(runtime.performDingTalkOwnerTextCommand({
      transportEventId: "pause-command",
      transportMessageId: "transport-pause-command",
      command: "pause",
      workItemId,
      sender: {
        senderCorpId: "corp",
        senderStaffId: "owner",
        senderId: "owner-sender",
        displayName: "Owner",
      },
      receivedAt: 1_200,
    })).toMatchObject({ allowed: true, reason: "owner_action_applied" });
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    const cards = database.prepare(
      "SELECT source_event_id, payload_json FROM collaboration_outbox " +
        "WHERE source_event_id IN ('status-command','pause-command-denied','pause-command') ORDER BY source_event_id",
    ).all() as unknown as Array<{ source_event_id: string; payload_json: string }>;
    expect(cards).toHaveLength(3);
    expect(cards.map((row) => JSON.parse(row.payload_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "command_status_card", command: "status", outcome: "allowed" }),
      expect.objectContaining({ type: "command_status_card", command: "pause", outcome: "denied" }),
      expect.objectContaining({ type: "command_status_card", command: "pause", outcome: "allowed", controlState: "paused" }),
    ]));
    database.close();
    await runtime.stop();
  });

  it("holds one fenced instance lease and can restart against the same durable ledger", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "runtime-one", platform: "linux" });
    expect(await runtime.start()).toMatchObject({ state: "running", ready: true, instanceLease: "held" });
    runtime.ingestDingTalkMessage(message("persisted"));

    const competing = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "runtime-two", platform: "linux" });
    await expect(competing.start()).rejects.toThrow("instance_lease_unavailable");
    await runtime.stop();

    const delivered: string[] = [];
    const restarted = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "runtime-three",
      platform: "linux",
      outboxDelivery: {
        async deliver(item) {
          delivered.push(item.dedupeKey);
          return { outcome: "sent" };
        },
      },
    });
    await restarted.start();
    expect(await restarted.drainOnce()).toMatchObject({ dispatched: { state: "sent" } });
    expect(delivered).toEqual(["dingtalk:event:persisted:ack"]);
    await restarted.stop();
  });

  it("dispatches at most one durable outbox row per deterministic drain", async () => {
    const delivered: string[] = [];
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      ownerId: "runtime",
      platform: "linux",
      clock: { now: () => 1_000 },
      outboxDelivery: {
        async deliver(item) {
          delivered.push(item.id);
          return { outcome: "sent" };
        },
      },
    });
    await runtime.start();
    runtime.ingestDingTalkMessage(message("one"));
    runtime.ingestDingTalkMessage(message("two"));
    expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
    expect(delivered).toHaveLength(2);
    await runtime.stop();
  });

  it("does not create Stream and reports needs_configuration when enabled credentials are missing", async () => {
    const createStream = vi.fn<() => RuntimeStream>();
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      dingTalk: {
        enabled: true,
        credentials: { load: () => null },
        createStream,
      },
    });
    expect(await runtime.start()).toMatchObject({
      state: "degraded",
      ready: false,
      reason: "dingtalk_credentials_missing",
      dingtalk: { state: "needs_configuration" },
    });
    expect(createStream).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("reports live Stream degradation and maintains reconnection from the runtime loop", async () => {
    let streamState = "connected";
    const maintain = vi.fn(async () => streamState);
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({
          start: async () => "connected",
          stop() {},
          state: () => streamState,
          maintain,
        }),
      },
    });
    await runtime.start();

    streamState = "reconnecting";
    expect(runtime.health()).toMatchObject({
      status: "degraded",
      ready: false,
      reason: "dingtalk_reconnecting",
      dingtalk: { state: "reconnecting" },
    });
    await runtime.drainOnce();
    expect(maintain).toHaveBeenCalledTimes(1);

    streamState = "connected";
    expect(runtime.health()).toMatchObject({
      status: "healthy",
      ready: true,
      dingtalk: { state: "connected" },
    });
    await runtime.stop();
  });

  it("keeps restored ledgers in review and does not dispatch or maintain them", async () => {
    const dataDirectory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const database = new DatabaseSync(ledger.filePath);
    markRestoredLedgerForReview(database, Buffer.from("backup"), 1_000);
    database.close();
    ledger.close();
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const maintain = vi.fn(async () => undefined);
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory,
      platform: "linux",
      outboxDelivery: { deliver },
      maintenance: { run: maintain },
    });
    expect(await runtime.start()).toMatchObject({
      state: "degraded",
      ready: false,
      reason: "restore_review_required",
    });
    expect(await runtime.drainOnce()).toEqual({ dispatched: null, maintained: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("shares one awaited shutdown and bounds a hung Stream stop", async () => {
    let releaseStop: (() => void) | undefined;
    const streamStop = new Promise<void>((resolve) => (releaseStop = resolve));
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      shutdownTimeoutMs: 30,
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({
          start: async () => "connected",
          stop: () => streamStop,
          state: () => "connected",
        }),
      },
    });
    await runtime.start();
    const first = runtime.stop();
    const second = runtime.stop();
    expect(runtime.health().state).toBe("draining");
    const [firstHealth, secondHealth] = await Promise.all([first, second]);
    expect(firstHealth).toMatchObject({ state: "stopped", status: "stopped", reason: "shutdown_timeout" });
    expect(secondHealth).toEqual(firstHealth);
    releaseStop!();
  });

  it("continues cleanup when Stream stop throws synchronously", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "sync-stop-runtime",
      platform: "linux",
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({
          start: async () => "connected",
          stop: () => { throw new Error("adapter stop failed"); },
          state: () => "connected",
        }),
      },
    });
    await runtime.start();
    await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped", instanceLease: "not_held" });
    const replacement = new CollaborationHeadlessRuntime({
      dataDirectory,
      ownerId: "replacement-runtime",
      platform: "linux",
    });
    await expect(replacement.start()).resolves.toMatchObject({ state: "running", ready: true });
    await replacement.stop();
  });

  it("kills verified unresolved containment and retains the lease when empty cannot be proven", async () => {
    for (const finalState of ["empty", "unknown"] as const) {
      const dataDirectory = temporaryDirectory();
      const terminated: string[] = [];
      let expectedBinding: ContainmentBinding | undefined;
      const containment: ContainmentPort = {
        async verifyProof(proof, binding) {
          expectedBinding = binding;
          return {
            verified: true,
            fingerprint: runtimeIdentityFingerprint(proof.identity),
            bindingHash: containmentBindingHash(binding),
          };
        },
        async inspect(identity) {
          return { state: "active", fingerprint: runtimeIdentityFingerprint(identity) };
        },
        async terminateAndWaitEmpty(identity) {
          terminated.push(identity.opaqueId);
          return finalState === "empty"
            ? { state: "empty", fingerprint: runtimeIdentityFingerprint(identity) }
            : { state: "unknown", reason: "containment_not_empty" };
        },
      };
      const runtime = new CollaborationHeadlessRuntime({
        dataDirectory,
        ownerId: `shutdown-${finalState}`,
        platform: "linux",
        containment,
        clock: { now: () => 1_000 },
        instanceLeaseTtlMs: 1_000,
      });
      await runtime.start();
      const seeded = seedRunningRun(dataDirectory, `shutdown-${finalState}`);
      const stopped = await runtime.stop();
      expect(expectedBinding).toEqual(seeded.binding);
      expect(terminated).toEqual([seeded.proof.identity.opaqueId]);
      expect(stopped.reason).toBe(finalState === "empty" ? undefined : "shutdown_containment_unverified");
      const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
      const lease = database
        .prepare("SELECT expires_at FROM collaboration_instance_lease WHERE singleton = 1")
        .get() as { expires_at: number };
      expect(lease.expires_at).toBe(finalState === "empty" ? 1_000 : 2_000);
      expect(database.prepare("SELECT status, recovery_state FROM collaboration_runs WHERE id = 'RUN-SHUTDOWN'").get())
        .toEqual({ status: "needs_configuration", recovery_state: "unsafe_to_retry" });
      database.close();
    }
  });

  it("keeps execution fail-closed on macOS even when execution dependencies are presented incompletely", () => {
    expect(
      () =>
        new CollaborationHeadlessRuntime({
          dataDirectory: temporaryDirectory(),
          platform: "darwin",
          agent: { run: vi.fn(), interrupt: vi.fn() },
        }),
    ).toThrow("agent, containment, commandRunner, and execution must be configured together");
  });
});
