import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertionReviewFixture } from "../assertion-review.test-fixtures.ts";
import { verificationRuntimePolicyHash } from "../verification-runtime-policy.ts";
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
import { policy, validProposal } from "../planner.test-fixtures.ts";
import {
  CollaborationHeadlessRuntime,
  enqueueExecutionOutcomeStatus,
  enqueueOwnerDecisionForWorkItem,
  enqueuePendingOwnerDecisionCards,
  type RuntimeStream,
  type RuntimeDingTalkSinks,
  type RuntimeAttachmentIngestionContext,
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
  it("wires natural approval to the durable service and fences it before writes after lease loss", async () => {
    const dataDirectory = temporaryDirectory();
    let now = 1000;
    let sinks: RuntimeDingTalkSinks | undefined;
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux", ownerId: "natural-runtime",
      instanceLeaseTtlMs: 1000, clock: { now: () => now }, dingTalk: { enabled: true,
        credentials: { load: () => ({ clientId: "synthetic", clientSecret: "synthetic" }) },
        createStream: (_credentials, input) => { sinks = input; return { start: async () => "connected", stop() {}, state: () => "connected" }; } } });
    await runtime.start();
    const db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      expect(sinks).toBeDefined();
      expect(sinks!.performNaturalApproval({ ...message("natural-command"), text: "批准这次改动" }))
        .toMatchObject({ allowed: false, reason: "owner_not_configured" });
      expect(db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 1 });
      now = 2001;
      expect(() => sinks!.performNaturalApproval({ ...message("lost-lease"), text: "批准这次改动" })).toThrow();
      expect(db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { await runtime.stop(); db.close(); }
  });

  it.each([false, true])("publishes an empty execution policy only outside probe mode (probe=%s)", async probeOnly => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux", probeOnly });
    await runtime.start();
    const db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      const rows = db.prepare("SELECT policies_json FROM collaboration_verification_runtime_policies").all();
      expect(rows).toEqual(probeOnly ? [] : [{ policies_json: "{}" }]);
    } finally { db.close(); await runtime.stop(); }
  });
  it("stops the drain when maintenance returns after lease expiry", async () => {
    let now = 1000;
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: temporaryDirectory(), platform: "linux",
      instanceLeaseTtlMs: 1000, clock: { now: () => now },
      maintenanceFactory: () => ({ run: async () => { now += 1001; } }) });
    await runtime.start();
    try {
      expect(await runtime.drainOnce()).toEqual({ dispatched: null, maintained: true });
      expect(runtime.health()).toMatchObject({ ready: false, reason: "lease_failed", instanceLease: "not_held" });
    } finally { await runtime.stop(); }
  });
  it.each(["pending", "dead_letter"])("does not begin %s work with a lease that expired during Stream maintenance", async state => {
    const dataDirectory = temporaryDirectory(); let now = 1000;
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    const query = vi.fn(async () => ({ outcome: "sent" as const }));
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux", instanceLeaseTtlMs: 1000,
      clock: { now: () => now }, outboxDelivery: { retryPolicy: "only-confirmed-unsent", deliver, reconcile: query },
      dingTalk: { enabled: true, credentials: { load: () => ({ clientId: "synthetic", clientSecret: "synthetic" }) },
        createStream: () => ({ start: async () => "connected", stop() {}, state: () => "connected",
          maintain: async () => { now += 1001; return "connected"; } }) } });
    await runtime.start();
    const db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      runtime.ingestDingTalkMessage(message("expired-maintenance"));
      if (state === "dead_letter") db.exec("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1,last_error='proactive_delivery_unconfirmed'");
      expect(await runtime.drainOnce()).toEqual({ dispatched: null, maintained: false });
      expect(deliver).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS n FROM collaboration_delivery_queries").get()).toEqual({ n: 0 });
      expect(runtime.health()).toMatchObject({ ready: false, reason: "lease_failed", instanceLease: "not_held" });
    } finally { await runtime.stop(); db.close(); }
  });
  it("queries an uncertain reply after service restart without a new send", async () => {
    const dataDirectory = temporaryDirectory();
    const deliver = vi.fn(async () => ({ outcome: "unknown" as const, error: "proactive_delivery_unconfirmed" }));
    const first = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "query-first", platform: "linux",
      outboxDelivery: { retryPolicy: "only-confirmed-unsent", deliver } });
    await first.start();
    first.ingestDingTalkMessage(message("query-restart"));
    expect(await first.drainOnce()).toMatchObject({ dispatched: { state: "dead_letter" } });
    await first.stop();
    const query = vi.fn(async () => ({ outcome: "sent" as const }));
    const second = new CollaborationHeadlessRuntime({ dataDirectory, ownerId: "query-second", platform: "linux",
      outboxDelivery: { retryPolicy: "only-confirmed-unsent", deliver, reconcile: query } });
    try {
      await second.start();
      expect(await second.drainOnce()).toMatchObject({ dispatched: { state: "sent", operation: "reconcile" } });
      expect(await second.drainOnce()).toMatchObject({ dispatched: null });
      expect(query).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledTimes(1);
    } finally { await second.stop(); }
  });
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
    const targetCommands = { pilot: { argv: ["node", "--test", "pilot.test.mjs"] as const, timeoutMs: 1000, maxOutputBytes: 32000 } };
    const runtimePolicyHash = verificationRuntimePolicyHash(targetCommands);
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
        "VALUES (?,1,1,'登录错误提示',1,?,'[]','[]',?,'[]',1)",
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
    ).run(resultSha, JSON.stringify(assertionReviewFixture(database, workItemId, "pilot", runtimePolicyHash).verifier));
    database.prepare(
      "INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "VALUES ('meta-review-existing','run-existing','meta',1,'passed','meta-acceptance-gate-v1',1,'spec-hash',?,?,2)",
    ).run(resultSha, JSON.stringify(assertionReviewFixture(database, workItemId, "pilot", runtimePolicyHash).meta));
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
    const snapshot = database.prepare("SELECT goal FROM collaboration_work_item_snapshots WHERE work_item_id=? AND revision=1").get(workItemId) as { goal: string };
    expect(JSON.parse(row.payload_json).approvalTopic).toBe(snapshot.goal);
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
      approvalTopic: snapshot.goal,
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_outbox WHERE source_event_id = 'refresh-command-1'",
    ).get()).toEqual({ count: 1 });
    database.close();

    const unexpectedExecution = vi.fn(async () => { throw new Error("approval_fixture_must_not_execute"); });
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux",
      agent: { run: unexpectedExecution, interrupt: unexpectedExecution },
      commandRunner: { run: unexpectedExecution },
      containment: { verifyProof: unexpectedExecution, inspect: unexpectedExecution, terminateAndWaitEmpty: unexpectedExecution },
      execution: {
      managedWorktreeRoot: join(dataDirectory, "worktrees"), repositories: { [repository]: { baseSha, targetCommands } },
      limits: { maxAttempts: 1, agentTimeoutMs: 1000, maxAgentEventBytes: 32000, interruptGraceMs: 1000 },
    } });
    await runtime.start();
    const refreshRequest = { transportEventId: "durable-refresh", transportMessageId: "durable-refresh", conversationId: "conversation",
      command: "refresh_approval" as const, workItemId, sender: message("owner-refresh").sender, receivedAt: 4500 };
    const refreshDb = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      const before = refreshDb.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      refreshDb.exec("CREATE TRIGGER fail_refresh_receipt BEFORE INSERT ON collaboration_owner_text_commands BEGIN SELECT RAISE(ABORT,'synthetic_refresh_receipt_failure'); END");
      expect(() => runtime.performDingTalkOwnerTextCommand(refreshRequest)).toThrow("synthetic_refresh_receipt_failure");
      expect(refreshDb.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(before);
      refreshDb.exec("DROP TRIGGER fail_refresh_receipt");
      expect(runtime.performDingTalkOwnerTextCommand(refreshRequest)).toMatchObject({ allowed: true, duplicate: false, reason: "approval_refreshed" });
      const after = refreshDb.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all();
      expect(runtime.performDingTalkOwnerTextCommand(refreshRequest)).toMatchObject({ allowed: true, duplicate: true, reason: "approval_refreshed" });
      expect(refreshDb.prepare("SELECT * FROM collaboration_outbox ORDER BY id").all()).toEqual(after);
      const receipt = refreshDb.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id='durable-refresh'").get() as { outcome_json: string };
      expect(JSON.parse(receipt.outcome_json)).toMatchObject({ kind: "owner_query", conversationId: "conversation", outcome: { allowed: true } });
    } finally { refreshDb.close(); }
    const approveRequest = {
      transportEventId: "approve-command-1",
      transportMessageId: "approve-transport-1",
      command: "approve_candidate" as const,
      workItemId,
      sender: message("owner-approval").sender,
      receivedAt: 5_000,
    };
    const failureDb = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      const before = failureDb.prepare("SELECT * FROM collaboration_work_items WHERE id=?").get(workItemId);
      failureDb.exec("CREATE TRIGGER fail_approval_reply BEFORE INSERT ON collaboration_outbox WHEN NEW.source_event_id='approve-command-1' BEGIN SELECT RAISE(ABORT,'synthetic_approval_reply_failure'); END");
      expect(() => runtime.performDingTalkOwnerTextCommand(approveRequest)).toThrow("synthetic_approval_reply_failure");
      expect(failureDb.prepare("SELECT * FROM collaboration_work_items WHERE id=?").get(workItemId)).toEqual(before);
      expect(failureDb.prepare("SELECT count(*) n FROM collaboration_owner_text_commands WHERE source_event_id='approve-command-1'").get()).toEqual({ n: 0 });
      failureDb.exec("DROP TRIGGER fail_approval_reply");
    } finally { failureDb.close(); }
    const approved = runtime.performDingTalkOwnerTextCommand(approveRequest);
    expect(runtime.performDingTalkOwnerTextCommand(approveRequest)).toMatchObject({ allowed: true, duplicate: true });
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
    expect(unexpectedExecution).not.toHaveBeenCalled();
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

  it("keeps draining while natural interpretation waits for a model and aborts it on stop", async () => {
    let started = false;
    let signal: AbortSignal | undefined;
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(), platform: "linux", planner: { propose: validProposal }, planningPolicy: policy,
      naturalIntake: { interpret(_request, abortSignal) { started = true; signal = abortSignal; return new Promise(() => {}); } },
    });
    await runtime.start();
    try {
      runtime.ingestDingTalkMessage(message("natural-delay"));
      await runtime.drainOnce();
      expect(started).toBe(true);
      await runtime.drainOnce();
      expect(runtime.health().ready).toBe(true);
    } finally { await runtime.stop(); }
    expect(signal?.aborted).toBe(true);
  });

  it("recovers from initial registration delay without leaving intake and outbox gated", async () => {
    let streamState: "connected" | "reconnecting" = "reconnecting";
    const delivered: string[] = [];
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      outboxDelivery: { async deliver(item) { delivered.push(item.id); return { outcome: "sent" }; } },
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: () => ({ start: async () => streamState, stop() {}, state: () => streamState,
          maintain: async () => streamState }),
      },
    });
    try {
      expect(await runtime.start()).toMatchObject({ ready: false, reason: "dingtalk_reconnecting" });
      streamState = "connected";
      await runtime.drainOnce();
      expect(runtime.health()).toMatchObject({ ready: true, status: "healthy" });
      runtime.ingestDingTalkMessage(message("after-registration"));
      expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
      expect(delivered).toHaveLength(1);
    } finally { await runtime.stop(); }
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

  it("routes attachment capabilities to durable ingestion and resumes pending work during maintenance", async () => {
    let sinks: RuntimeDingTalkSinks | undefined;
    const process = vi.fn(async () => undefined);
    const persist = vi.fn(() => undefined);
    const runtime = new CollaborationHeadlessRuntime({
      dataDirectory: temporaryDirectory(),
      platform: "linux",
      attachmentIngestionFactory: () => ({ persist, process }),
      dingTalk: {
        enabled: true,
        credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream: (_credentials, captured) => {
          sinks = captured;
          return {
            start: async () => "connected",
            stop() {},
            state: () => "connected",
          };
        },
      },
    });
    await runtime.start();
    if (!sinks?.ingestAttachments) throw new Error("Expected attachment sink");
    const requirementRecovery = { ...message("requirement-recovery"), text: "继续整理需求" };
    expect(sinks.recoverRequirements(requirementRecovery)).toMatchObject({ allowed: false, duplicate: false, recoveredInputs: 0, reason: "owner_not_configured" });
    expect(sinks.recoverRequirements(requirementRecovery)).toMatchObject({ duplicate: true });
    expect(() => sinks!.ingest({ ...requirementRecovery, text: "新建任务" })).toThrow("natural_intake_recovery_event_conflict");
    expect(() => sinks!.performCommand({ transportEventId: requirementRecovery.sourceEventId, transportMessageId: requirementRecovery.transportMessageId,
      command: "retry", workItemId: "WI-000000000001", sender: requirementRecovery.sender, receivedAt: requirementRecovery.receivedAt })).toThrow("natural_intake_recovery_event_conflict");
    const recovery = { ...message("attachment-recovery"), text: "继续整理附件" };
    expect(sinks.recoverProjection(recovery)).toMatchObject({ allowed: false, duplicate: false, reason: "owner_not_configured" });
    expect(sinks.recoverProjection(recovery)).toMatchObject({ duplicate: true });
    expect(() => sinks!.ingest({ ...recovery, text: "新建任务" })).toThrow("attachment_recovery_event_conflict");
    expect(() => sinks!.performCommand({ transportEventId: recovery.sourceEventId, transportMessageId: recovery.transportMessageId,
      command: "retry", workItemId: "WI-000000000001", sender: recovery.sender, receivedAt: recovery.receivedAt })).toThrow("attachment_recovery_event_conflict");
    await sinks.ingestAttachments([{ capabilityRef: "a".repeat(64), downloadCode: "private-code" }]);
    expect(persist).toHaveBeenNthCalledWith(1, [
      { capabilityRef: "a".repeat(64), downloadCode: "private-code" },
    ], expect.any(Number));
    expect(process).not.toHaveBeenCalled();
    await runtime.drainOnce();
    await new Promise(resolve => setTimeout(resolve, 0));
    await runtime.drainOnce();
    expect(process).toHaveBeenNthCalledWith(2, [], expect.any(Number));
    await runtime.stop();
  });

  it("acknowledges durable capabilities and keeps renewing while one background attachment batch waits", async () => {
    let sinks!: RuntimeDingTalkSinks;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let context!: Parameters<NonNullable<ConstructorParameters<typeof CollaborationHeadlessRuntime>[0]["attachmentIngestionFactory"]>>[0];
    const process = vi.fn(() => gate);
    const persist = vi.fn(() => undefined);
    const delivered: string[] = [];
    let now = 1000;
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: temporaryDirectory(), platform: "linux", clock: { now: () => now },
      outboxDelivery: { async deliver(item) { delivered.push(item.id); return { outcome: "sent" }; } },
      attachmentIngestionFactory(value) { context = value; return { persist, process }; },
      dingTalk: { enabled: true, credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream(_credentials, value) { sinks = value; return { start: async () => "connected", stop() {}, state: () => "connected" }; } },
    });
    await runtime.start();
    try {
      const intake = sinks.ingestAttachments!([{ capabilityRef: "a".repeat(64), downloadCode: "fixture-code" }]);
      expect(await Promise.race([intake.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))])).toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(process).not.toHaveBeenCalled();
      await runtime.drainOnce();
      await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
      for (let index = 0; index < 3; index++) { now += 20000; await runtime.drainOnce(); }
      expect(runtime.ingestDingTalkMessage(message("while-downloading", now)).accepted).toBe(true);
      expect((await runtime.drainOnce()).dispatched?.state).toBe("sent");
      expect(delivered).toHaveLength(1);
      expect(process).toHaveBeenCalledTimes(1);
      expect(() => context.assertActive()).not.toThrow();
      release();
      await runtime.stop();
      expect(context.signal.aborted).toBe(true);
      expect(() => context.assertActive()).toThrow();
    } finally { release(); await runtime.stop(); }
  });

  it.each(["stop", "lease-loss"])("rejects late attachment projection after %s and never reports unsettled processing as stopped safely", async (mode) => {
    const dataDirectory = temporaryDirectory();
    let context!: RuntimeAttachmentIngestionContext;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const process = vi.fn(() => gate);
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux", shutdownTimeoutMs: 20,
      clock: { now: () => 1000 },
      attachmentIngestionFactory(value) { context = value; return { persist() {}, process }; },
    });
    await runtime.start();
    try {
      await runtime.drainOnce();
      await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
      if (mode === "lease-loss") {
        const db = new DatabaseSync(context.databaseFile);
        db.prepare("UPDATE collaboration_instance_lease SET owner_id='replacement',fencing_token=fencing_token+1").run();
        db.close();
        expect(() => context.assertActive()).toThrow();
        await runtime.drainOnce();
      }
      const stopped = await runtime.stop();
      expect(stopped.reason).toBe("shutdown_attachments_unsettled");
      expect(context.signal.aborted).toBe(true);
      expect(() => context.assertActive()).toThrow("attachment_ingestion_inactive");
      expect(() => context.onEvidence("WI-late", {
        attachmentId: "late", sourceEventId: "late", contentHash: "a".repeat(64),
        displayName: "late.txt", format: "text", chunks: [], truncated: false, warnings: [],
      })).toThrow("attachment_ingestion_inactive");
      await expect(runtime.start()).rejects.toThrow("collaboration_attachments_still_settling");
      const db = new DatabaseSync(context.databaseFile);
      expect(db.prepare("SELECT expires_at FROM collaboration_instance_lease").get()).toEqual({ expires_at: 31000 });
      db.close();
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { release(); await runtime.stop(); }
  });

  it("does not acknowledge or start downloads when capability persistence fails", async () => {
    let sinks!: RuntimeDingTalkSinks;
    const process = vi.fn(async () => undefined);
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory: temporaryDirectory(), platform: "linux",
      attachmentIngestionFactory: () => ({ persist() { throw new Error("fixture_storage_failed"); }, process }),
      dingTalk: { enabled: true, credentials: { load: () => ({ clientId: "id", clientSecret: "secret" }) },
        createStream(_credentials, value) { sinks = value; return { start: async () => "connected", stop() {}, state: () => "connected" }; } },
    });
    await runtime.start();
    try {
      await expect(sinks.ingestAttachments!([{ capabilityRef: "a".repeat(64), downloadCode: "fixture-code" }])).rejects.toThrow("fixture_storage_failed");
      expect(process).not.toHaveBeenCalled();
    } finally { await runtime.stop(); }
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
    const reviewed = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(reviewed.prepare("SELECT count(*) AS n FROM collaboration_verification_runtime_policies").get()).toEqual({ n: 0 });
    reviewed.close();
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
