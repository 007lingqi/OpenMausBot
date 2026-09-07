import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertionReviewFixture } from "./assertion-review.test-fixtures.ts";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueInboundCard } from "./outbox.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { readApprovalPresentation, approvalPayloadHash, confirmApprovalPresentation } from "./approval-presentation.ts";
import { applyCollaborationMigrations } from "./migrations.ts";

import { startCollaborationService } from "./service.ts";
import { completeVerifiedLowRiskCandidate } from "./candidate-approval.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function seedCandidate(input: {
  changedPaths: string[];
  risk?: "low" | "medium" | "high";
  evidence?: boolean;
  goal?: string;
  acceptanceConditions?: Array<{ description: string; observation: string }>;
}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "candidate-approval-"));
  scratch.push(dataDirectory);
  const service = startCollaborationService({ dataDirectory });
  const workItemId = service.ingestDingTalkMessage({
    sourceEventId: "source-1",
    transportMessageId: "transport-1",
    conversationId: "conversation-1",
    addressedToBot: true,
    text: "让发布结果更容易理解",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "staff-1",
      senderId: "sender-1",
      displayName: "产品经理",
    },
    receivedAt: 100,
  }).workItemId!;
  service.close();

  const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  database.exec("PRAGMA foreign_keys = OFF");
  const goal = input.goal ?? "让发布结果更容易理解";
  database.prepare(
    "UPDATE collaboration_work_items SET current_plan_revision = 1, definition_status = 'ready_for_execution' WHERE id = ?",
  ).run(workItemId);
  database.prepare(
    "INSERT INTO collaboration_work_item_snapshots " +
      "(work_item_id,revision,source_work_item_version,goal,goal_confirmed,repository,facts_json," +
      "assumptions_json,acceptance_json,blocking_ambiguities_json,created_at) " +
      "VALUES (?,1,1,?,1,'/repo','[]','[]',?, '[]',100)",
  ).run(workItemId, goal, JSON.stringify(input.acceptanceConditions ?? [
    { description: "普通修改完成后直接显示结果", observation: "消息不再要求重复确认" },
  ]));
  database.prepare(
    "INSERT INTO collaboration_plan_revisions " +
      "(id,work_item_id,revision,snapshot_revision,status,summary,proposal_hash,created_at) " +
      "VALUES ('plan-1',?,1,1,'published','fixture','proposal-hash',100)",
  ).run(workItemId);
  database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
      "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
      "completion_definition,risk,budget_json,created_at,execution_status,control_state) " +
      "VALUES (?,1,'modify','modify','ready','codex-patch','modify','[]','modify','[]','[]','[]'," +
      "'[]','[]','change complete','low','{}',100,'candidate_ready','active')",
  ).run(workItemId);
  database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
      "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
      "completion_definition,risk,budget_json,created_at,execution_status,control_state) " +
      "VALUES (?,1,'validate','validate','ready','codex-verifier','verify','[]','verify','[]','[]','[]'," +
      "'[\"target\"]','[]','target passes',?,'{}',100,'candidate_ready','active')",
  ).run(workItemId, input.risk ?? "low");
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path," +
      "worktree_path,branch,base_sha,result_sha,started_at,finished_at) " +
      "VALUES ('run-1',?,1,'modify',1,'codex-patch','thread','turn','succeeded','/repo','/worktree'," +
      "'candidate',?,?,100,200)",
  ).run(workItemId, "1".repeat(40), "2".repeat(40));
  database.prepare(
    "INSERT INTO collaboration_candidates " +
      "(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) " +
      "VALUES ('candidate-1','run-1','target_tests_passed',?,?,?,'[]','{}',200)",
  ).run("1".repeat(40), "2".repeat(40), JSON.stringify(input.changedPaths));
  if (input.evidence !== false) {
    database.prepare(
      "INSERT INTO collaboration_test_evidence " +
        "(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at) " +
        "VALUES ('evidence-1','run-1','target','[]','/worktree',0,10,'passed','','target_passed',200)",
    ).run();
  }
  database.prepare(
    "INSERT INTO collaboration_candidate_reviews " +
      "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
      "VALUES ('verifier-review-1','run-1','verifier',1,'passed','deterministic-verifier-v1',1,'spec-hash',?,?,200)",
  ).run("2".repeat(40), JSON.stringify(assertionReviewFixture(database, workItemId, "target").verifier));
  database.prepare(
    "INSERT INTO collaboration_candidate_reviews " +
      "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
      "VALUES ('meta-review-1','run-1','meta',1,'passed','meta-acceptance-gate-v1',1,'spec-hash',?,? ,200)",
  ).run("2".repeat(40), JSON.stringify(assertionReviewFixture(database, workItemId, "target").meta));
  return { database, workItemId, dataDirectory };
}

function presentationFixture() {
  const fixture = seedCandidate({ changedPaths: ["auth/login.ts"], risk: "high" });
  const { database: db, workItemId, dataDirectory } = fixture;
  const owner = new LocalOwnerRegistry(join(dataDirectory, "collaboration", "collaboration.sqlite"));
  owner.bootstrap({ senderCorpId: "corp-1", senderStaffId: "staff-1", now: 250 }); owner.close();
  // The ordinary intake acknowledgement is outside this presentation test.
  db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=250,delivery_sequence=1").run();
  const create = (sourceEventId = "approval-1", now = 300) => enqueueInboundCard(db, { sourceEventId,
    aggregateType: "plan", aggregateId: workItemId, aggregateVersion: 1, now,
    supersessionKey: `approval:${workItemId}`,
    card: { type: "plan_status_card", headline: "修改完成，需要负责人确认", status: "candidate_ready",
      workItemId, workItemVersion: 1, planRevision: 1, candidateSha: "2".repeat(40), approvalRequired: true,
      summary: "登录提示已调整，涉及权限逻辑，需要负责人确认。", approvalReasons: ["涉及权限逻辑。"] } });
  const lease = new InstanceLeaseCoordinator(db, "presentation-sender").acquire(300, 2_000_000)!;
  const options = { maxAttempts: 3, claimTtlMs: 10000, baseBackoffMs: 10, maxBackoffMs: 100 };
  return { ...fixture, create, lease, options };
}

describe("fixed approval presentation provenance", () => {
  it("stages without authorizing and activates only with a proven original-group send, surviving restart", async () => {
    const f = presentationFixture(), card = f.create();
    expect(readApprovalPresentation(f.database, card.id, 301)).toBeNull();
    const before = f.database.prepare("SELECT status,version,control_state FROM collaboration_work_items").get();
    const dispatcher = new OutboxDispatcher(f.database, { async deliver(message) {
      return { outcome: "sent", approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } };
    } }, f.options);
    try {
      expect(await dispatcher.dispatchOne(f.lease, 400)).toMatchObject({ state: "sent" });
      const proof = readApprovalPresentation(f.database, card.id, 500);
      expect(proof).toMatchObject({ work_item_id: f.workItemId, work_item_version: 1, plan_revision: 1,
        snapshot_revision: 1, candidate_sha: "2".repeat(40), run_id: "run-1", owner_generation: 1,
        delivery_sequence: 2, source_event_id: "source-1" });
      expect(f.database.prepare("SELECT status,version,control_state FROM collaboration_work_items").get()).toEqual(before);
      expect(f.database.prepare("SELECT count(*) AS n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      expect(f.database.prepare("SELECT count(*) AS n FROM collaboration_action_tokens").get()).toEqual({ n: 0 });
      const reopened = new DatabaseSync(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
      try { expect(readApprovalPresentation(reopened, card.id, 500)).toEqual(proof); } finally { reopened.close(); }
    } finally { f.database.close(); }
  });

  it.each(["plain-success", "wrong-source", "wrong-payload", "unknown", "rejected"])("does not turn %s into shown approval authority", async scenario => {
    const f = presentationFixture(), card = f.create();
    const dispatcher = new OutboxDispatcher(f.database, { async deliver(message) {
      if (scenario === "unknown") return { outcome: "unknown", error: "fixture_unknown" };
      if (scenario === "rejected") return { outcome: "permanent_failure", error: "fixture_rejected" };
      return { outcome: "sent", ...(scenario !== "plain-success" ? { approvalDelivery: {
        sourceEventId: scenario === "wrong-source" ? "missing-source" : "source-1",
        payloadHash: scenario === "wrong-payload" ? "0".repeat(64) : approvalPayloadHash(message.payload),
      } } : {}) };
    } }, f.options);
    try { await dispatcher.dispatchOne(f.lease, 400); expect(readApprovalPresentation(f.database, card.id, 500)).toBeNull(); }
    finally { f.database.close(); }
  });

  it.each(["version", "spec", "owner", "payload", "expiry", "cancelled"])("invalidates a shown presentation after %s changes", async boundary => {
    const f = presentationFixture(), card = f.create();
    const dispatcher = new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent",
      approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } }; } }, f.options);
    try {
      await dispatcher.dispatchOne(f.lease, 400);
      expect(readApprovalPresentation(f.database, card.id, 500)).not.toBeNull();
      if (boundary === "version") f.database.prepare("UPDATE collaboration_work_items SET version=version+1").run();
      if (boundary === "spec") f.database.exec("INSERT INTO collaboration_work_item_snapshots " +
        "(work_item_id,revision,source_work_item_version,goal,goal_confirmed,repository,facts_json,assumptions_json,acceptance_json,blocking_ambiguities_json,created_at) " +
        "SELECT work_item_id,2,source_work_item_version,'changed',goal_confirmed,repository,facts_json,assumptions_json,acceptance_json,blocking_ambiguities_json,450 FROM collaboration_work_item_snapshots WHERE revision=1");
      if (boundary === "payload") f.database.prepare("UPDATE collaboration_outbox SET payload_json='{}' WHERE id=?").run(card.id);
      if (boundary === "cancelled") f.database.prepare("UPDATE collaboration_work_items SET control_state='cancelled',status='cancelled'").run();
      if (boundary === "owner") {
        const owners = new LocalOwnerRegistry(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
        owners.recover({ expectedGeneration: 1, senderCorpId: "corp-1", senderStaffId: "other-owner", now: 450 }); owners.close();
      }
      expect(readApprovalPresentation(f.database, card.id, boundary === "expiry" ? 300 + 15 * 60000 : 501)).toBeNull();
    } finally { f.database.close(); }
  });

  it("cannot rebind the staged object, extend expiry, reset a delivery or bypass atomic enqueue", async () => {
    const f = presentationFixture(), card = f.create();
    try {
      for (const change of ["candidate_sha='changed'", "owner_generation=2", "expires_at=expires_at+1", "payload_hash='changed'"]) {
        expect(() => f.database.exec(`UPDATE collaboration_approval_presentations SET ${change}`)).toThrow("immutable");
      }
      f.database.exec("CREATE TRIGGER fail_presentation BEFORE INSERT ON collaboration_approval_presentations BEGIN SELECT RAISE(ABORT,'fixture_stage_failure'); END");
      expect(() => f.create("failed-stage", 301)).toThrow("fixture_stage_failure");
      expect(f.database.prepare("SELECT id FROM collaboration_outbox WHERE source_event_id='failed-stage'").get()).toBeUndefined();
      expect(f.database.prepare("SELECT delivery_state,superseded_at FROM collaboration_outbox WHERE id=?").get(card.id))
        .toEqual({ delivery_state: "pending", superseded_at: null });
      f.database.exec("DROP TRIGGER fail_presentation");
      await new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent",
        approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } }; } }, f.options).dispatchOne(f.lease, 400);
      expect(readApprovalPresentation(f.database, card.id, 500)).not.toBeNull();
      expect(() => f.database.exec("UPDATE collaboration_approval_presentations SET sent_at=NULL,source_event_id=NULL,delivery_sequence=NULL")).toThrow("immutable");
    } finally { f.database.close(); }
  });

  it.each(["wrong-group", "owner-during-send", "version-during-send", "expiry-during-send"])("does not activate %s", async boundary => {
    const f = presentationFixture(), card = f.create();
    if (boundary === "wrong-group") {
      const service = startCollaborationService({ dataDirectory: f.dataDirectory });
      service.ingestDingTalkMessage({ sourceEventId: "foreign-source", transportMessageId: "foreign-source", conversationId: "other-group",
        addressedToBot: true, text: "另一个问题", receivedAt: 600,
        sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1", displayName: "产品经理" } });
      service.close();
    }
    try {
      await new OutboxDispatcher(f.database, { async deliver(message) {
        if (boundary === "version-during-send") f.database.exec("UPDATE collaboration_work_items SET version=version+1");
        if (boundary === "owner-during-send") {
          const owners = new LocalOwnerRegistry(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
          owners.recover({ expectedGeneration: 1, senderCorpId: "corp-1", senderStaffId: "other-owner", now: 450 }); owners.close();
        }
        return { outcome: "sent", approvalDelivery: { sourceEventId: boundary === "wrong-group" ? "foreign-source" : "source-1",
          payloadHash: approvalPayloadHash(message.payload) } };
      } }, f.options).dispatchOne(f.lease, boundary === "expiry-during-send" ? 900300 : 400);
      expect(readApprovalPresentation(f.database, card.id, boundary === "expiry-during-send" ? 900400 : 500)).toBeNull();
      expect(f.database.prepare("SELECT sent_at FROM collaboration_approval_presentations WHERE outbox_id=?").get(card.id)).toEqual({ sent_at: null });
    } finally { f.database.close(); }
  });

  it("does not convert a reconciled delivery into a new approval window", async () => {
    const f = presentationFixture(), card = f.create();
    let sends = 0;
    const transport = { retryPolicy: "only-confirmed-unsent" as const,
      async deliver() { sends++; return { outcome: "unknown" as const, error: "fixture_unknown" }; },
      async reconcile() { return { outcome: "sent" as const }; } };
    try {
      expect(await new OutboxDispatcher(f.database, transport, f.options).dispatchOne(f.lease, 400)).toMatchObject({ state: "dead_letter" });
      expect(await new OutboxDispatcher(f.database, transport, f.options).dispatchOne(f.lease, 500)).toMatchObject({ operation: "reconcile", state: "sent" });
      expect(sends).toBe(1);
      expect(readApprovalPresentation(f.database, card.id, 600)).toBeNull();
    } finally { f.database.close(); }
  });

  it.each(["original", "missing", "nested-only"])("requires the persisted original group on an Owner command reply: %s", async origin => {
    const f = presentationFixture(), card = f.create();
    try {
      f.database.prepare("INSERT INTO collaboration_owner_text_commands(source_event_id,payload_hash,outcome_json,processed_at) VALUES('owner-command','fixture',?,350)")
        .run(JSON.stringify(origin === "original" ? { conversationId: "conversation-1" } : origin === "missing" ? {} : { outcome: { conversationId: "conversation-1" } }));
      await new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent", approvalDelivery: {
        sourceEventId: "owner-command", payloadHash: approvalPayloadHash(message.payload),
      } }; } }, f.options).dispatchOne(f.lease, 400);
      const proof = readApprovalPresentation(f.database, card.id, 500);
      if (origin === "original") expect(proof).toMatchObject({ source_event_id: "owner-command" });
      else expect(proof).toBeNull();
    } finally { f.database.close(); }
  });

  it("makes send confirmation idempotent and rolls the sent receipt back if proof storage fails", async () => {
    const f = presentationFixture(), card = f.create();
    const transport = { async deliver(message: Parameters<import("./outbox.ts").OutboxDeliveryPort["deliver"]>[0]) {
      return { outcome: "sent" as const, approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } };
    } };
    try {
      f.database.exec("CREATE TRIGGER fail_confirmation BEFORE UPDATE OF sent_at ON collaboration_approval_presentations BEGIN SELECT RAISE(ABORT,'fixture_confirmation_failure'); END");
      await expect(new OutboxDispatcher(f.database, transport, f.options).dispatchOne(f.lease, 400)).rejects.toThrow("fixture_confirmation_failure");
      expect(f.database.prepare("SELECT delivery_state,sent_at,delivery_sequence FROM collaboration_outbox WHERE id=?").get(card.id))
        .toEqual({ delivery_state: "claimed", sent_at: null, delivery_sequence: null });
      expect(readApprovalPresentation(f.database, card.id, 500)).toBeNull();
      f.database.exec("DROP TRIGGER fail_confirmation");
      // Synthetic idempotent transport only; real uncertain remote sends are query-only.
      await new OutboxDispatcher(f.database, transport, f.options).dispatchOne(f.lease, 11000);
      const proof = readApprovalPresentation(f.database, card.id, 12000)!;
      expect(proof).not.toBeNull();
      confirmApprovalPresentation(f.database, card.id, { sourceEventId: "source-1", payloadHash: proof.payload_hash }, 12000);
      expect(readApprovalPresentation(f.database, card.id, 12000)).toEqual(proof);
    } finally { f.database.close(); }
  });

  it.each(["owner-missing", "template", "actions", "wrong-sha", "wrong-plan", "evidence-missing"])("does not stage %s", scenario => {
    const f = presentationFixture();
    try {
      if (scenario === "owner-missing") f.database.exec("UPDATE collaboration_owner_bindings SET active=0,revoked_at=299");
      if (scenario === "evidence-missing") f.database.exec("INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "SELECT id||'-failed',candidate_run_id,stage,2,'failed',agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,299 FROM collaboration_candidate_reviews");
      const payload = f.create().card;
      expect(payload.type).toBe("plan_status_card");
      if (payload.type !== "plan_status_card") throw new Error("fixture_card");
      if (scenario === "template") payload.cardTemplateId = "legacy-template";
      if (scenario === "actions") payload.actions = [];
      if (scenario === "wrong-sha") payload.candidateSha = "3".repeat(40);
      if (scenario === "wrong-plan") payload.planRevision = 2;
      const card = enqueueInboundCard(f.database, { sourceEventId: "unsupported", aggregateType: "plan", aggregateId: f.workItemId,
        aggregateVersion: 1, card: payload, now: 301 });
      expect(f.database.prepare("SELECT 1 FROM collaboration_approval_presentations WHERE outbox_id=?").get(card.id)).toBeUndefined();
    } finally { f.database.close(); }
  });

  it("invalidates the display if a newer review exists, even with the same candidate and contract", async () => {
    const f = presentationFixture(), card = f.create();
    try {
      await new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent",
        approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } }; } }, f.options).dispatchOne(f.lease, 400);
      expect(readApprovalPresentation(f.database, card.id, 500)).not.toBeNull();
      f.database.exec("INSERT INTO collaboration_candidate_reviews " +
        "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
        "SELECT id||'-new',candidate_run_id,stage,2,status,agent_id,snapshot_revision,spec_hash,candidate_sha,json_set(verdict_json,'$.verifierAttempt',2),501 FROM collaboration_candidate_reviews");
      expect(readApprovalPresentation(f.database, card.id, 502)).toBeNull();
    } finally { f.database.close(); }
  });

  it("upgrades v36 without inventing approval authority for old sent candidate messages", () => {
    const f = presentationFixture(), card = f.create();
    try {
      f.database.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=400,delivery_sequence=2 WHERE id=?").run(card.id);
      const tables = ["collaboration_work_items", "collaboration_external_events", "collaboration_outbox", "collaboration_candidate_reviews", "collaboration_owner_bindings"];
      const before = tables.map(table => f.database.prepare(`SELECT * FROM ${table}`).all());
      const migrations = f.database.prepare("SELECT * FROM collaboration_schema_migrations WHERE version<=36").all();
      f.database.exec("DROP TABLE collaboration_approval_presentations; DELETE FROM collaboration_schema_migrations WHERE version=37; PRAGMA user_version=36");
      expect(applyCollaborationMigrations(f.database)).toEqual({ schemaVersion: 37, appliedMigrations: 37 });
      expect(tables.map(table => f.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(f.database.prepare("SELECT * FROM collaboration_schema_migrations WHERE version<=36").all()).toEqual(migrations);
      expect(f.database.prepare("SELECT * FROM collaboration_approval_presentations").all()).toEqual([]);
      expect(readApprovalPresentation(f.database, card.id, 500)).toBeNull();
    } finally { f.database.close(); }
  });
});

describe("candidate approval routing", () => {
  it("automatically completes a verified low-risk candidate in one audited transaction", () => {
    const { database, workItemId } = seedCandidate({ changedPaths: ["app/release-board.tsx"] });
    const result = completeVerifiedLowRiskCandidate(database, {
      workItemId,
      runId: "run-1",
      sourceEventId: "candidate:run-1",
      now: 300,
    });
    expect(result).toMatchObject({
      completed: true,
      approvalRequired: false,
      summary: "让发布结果更容易理解",
      resultHighlights: ["普通修改完成后直接显示结果"],
    });
    expect(database.prepare(
      "SELECT status,control_state,version,accepted_candidate_sha,accepted_by FROM collaboration_work_items WHERE id = ?",
    ).get(workItemId)).toEqual({
      status: "accepted",
      control_state: "accepted",
      version: 2,
      accepted_candidate_sha: "2".repeat(40),
      accepted_by: null,
    });
    const payload = database.prepare(
      "SELECT payload_json FROM collaboration_outbox WHERE source_event_id = 'candidate:run-1'",
    ).get() as { payload_json: string };
    expect(JSON.parse(payload.payload_json)).toMatchObject({
      headline: "修改已完成",
      status: "completed",
      approvalRequired: false,
    });
    expect(payload.payload_json).not.toContain("app/release-board.tsx");
    expect(payload.payload_json).not.toContain("actionToken");
    expect(database.prepare(
      "SELECT action,actor_principal_id FROM collaboration_audit_events WHERE action = 'candidate.auto_complete'",
    ).get()).toEqual({ action: "candidate.auto_complete", actor_principal_id: null });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_action_tokens").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_control_events").get()).toEqual({ count: 0 });
    database.close();
  });

  it("keeps high-impact or incompletely verified candidates behind Owner approval", () => {
    const highImpact = seedCandidate({ changedPaths: ["package.json"] });
    const highImpactResult = completeVerifiedLowRiskCandidate(highImpact.database, {
      workItemId: highImpact.workItemId,
      runId: "run-1",
      sourceEventId: "candidate:run-1",
      now: 300,
    });
    expect(highImpactResult).toMatchObject({ completed: false, approvalRequired: true });
    expect(highImpactResult.approvalReasons).toContain("涉及项目依赖，可能影响整体构建或运行。");
    expect(highImpact.database.prepare(
      "SELECT status,control_state FROM collaboration_work_items WHERE id = ?",
    ).get(highImpact.workItemId)).toEqual({ status: "collecting", control_state: "active" });
    highImpact.database.close();

    const incomplete = seedCandidate({ changedPaths: ["app/release-board.tsx"], evidence: false });
    const incompleteResult = completeVerifiedLowRiskCandidate(incomplete.database, {
      workItemId: incomplete.workItemId,
      runId: "run-1",
      sourceEventId: "candidate:run-1",
      now: 300,
    });
    expect(incompleteResult).toMatchObject({ completed: false, approvalRequired: true });
    expect(incompleteResult.approvalReasons).toContain("验证信息不完整，需要负责人判断是否继续。");
    incomplete.database.close();
  });

  it("removes implementation constraints from the user-facing result summary", () => {
    const { database, workItemId } = seedCandidate({
      changedPaths: ["app/release-board.tsx"],
      goal: "创建非生产 UI 测试任务：在发布检查清单中增加优先级筛选。筛选可以与搜索同时生效。只允许修改 app/** 和 tests/**，不得新增网络请求。验收：测试证据通过。",
      acceptanceConditions: [
        { description: "Requested behavior is implemented", observation: "target command passes" },
      ],
    });
    const result = completeVerifiedLowRiskCandidate(database, {
      workItemId,
      runId: "run-1",
      sourceEventId: "candidate:run-1",
      now: 300,
    });
    expect(result.summary).toBe("在发布检查清单中增加优先级筛选");
    expect(result.resultHighlights).toEqual([
      "在发布检查清单中增加优先级筛选",
      "筛选可以与搜索同时生效",
    ]);
    expect(JSON.stringify(result)).not.toContain("app/**");
    expect(JSON.stringify(result)).not.toContain("测试证据");
    database.close();
  });
});
