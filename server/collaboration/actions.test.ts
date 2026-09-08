import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertionReviewFixture } from "./assertion-review.test-fixtures.ts";
import { afterEach, describe, expect, it } from "vitest";

import type { DingTalkInboundMessage, DingTalkSender } from "../integrations/dingtalk/types.ts";
import { startCollaborationService, type CollaborationService } from "./service.ts";
import { parseDingTalkOwnerTextAction } from "../integrations/dingtalk/text-actions.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";
import { readConversationContext, type ConversationJob } from "./conversation-context.ts";

const scratch: string[] = [];
const CANDIDATE_SHA = "a".repeat(40);

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function ownerSender(staffId = "owner-1"): DingTalkSender {
  return {
    senderCorpId: "corp-1",
    senderStaffId: staffId,
    senderId: `sender-${staffId}`,
    displayName: "Owner",
  };
}

function contributorSender(): DingTalkSender {
  return {
    senderCorpId: "corp-1",
    senderStaffId: "contributor-1",
    senderId: "sender-contributor-1",
    displayName: "Contributor",
  };
}

function message(input: {
  sourceEventId: string;
  text: string;
  sender?: DingTalkSender;
  replyToSourceEventId?: string;
}): DingTalkInboundMessage {
  return {
    sourceEventId: input.sourceEventId,
    transportMessageId: `transport-${input.sourceEventId}`,
    conversationId: "control-conversation",
    addressedToBot: true,
    text: input.text,
    ...(input.replyToSourceEventId ? { replyToSourceEventId: input.replyToSourceEventId } : {}),
    sender: input.sender ?? contributorSender(),
    receivedAt: 1_000,
  };
}

function harness(): {
  root: string;
  databaseFile: string;
  service: CollaborationService;
  workItemId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "openmausbot-owner-action-"));
  scratch.push(root);
  const service = startCollaborationService({ dataDirectory: root });
  service.bootstrapOwnerLocally({ senderCorpId: "corp-1", senderStaffId: "owner-1", now: 500 });
  const accepted = service.ingestDingTalkMessage(message({ sourceEventId: "event-1", text: "Create controlled task" }));
  if (!accepted.workItemId) throw new Error("Expected Work Item");
  return {
    root,
    databaseFile: join(root, "collaboration", "collaboration.sqlite"),
    service,
    workItemId: accepted.workItemId,
  };
}

function seedExecution(
  databaseFile: string,
  workItemId: string,
  input: {
    runStatus?: "running" | "succeeded";
    candidateState?: "target_tests_passed" | "test_failed" | "not_verified";
    evidence?: boolean;
  } = {},
): { runId: string; candidateSha: string } {
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON");
  const item = database.prepare("SELECT version FROM collaboration_work_items WHERE id = ?").get(workItemId) as {
    version: number;
  };
  database
    .prepare(
      "INSERT INTO collaboration_work_item_snapshots " +
        "(work_item_id, revision, source_work_item_version, goal, goal_confirmed, repository, facts_json, " +
        "assumptions_json, acceptance_json, blocking_ambiguities_json, created_at) " +
        "VALUES (?, 1, ?, 'Fix fixture', 1, '/tmp/repo', '[]', '[]', ?, '[]', 1000)",
    )
    .run(workItemId, item.version, JSON.stringify([{ description: "passes", observation: "target command" }]));
  database
    .prepare(
      "INSERT INTO collaboration_plan_revisions " +
        "(id, work_item_id, revision, snapshot_revision, status, summary, proposal_hash, created_at) " +
        "VALUES (?, ?, 1, 1, 'published', 'fixture plan', 'hash', 1000)",
    )
    .run(randomUUID(), workItemId);
  const insertNode = database.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
      "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
      "completion_definition, risk, budget_json, execution_status, created_at) " +
      "VALUES (?, 1, ?, ?, ?, 'developer-1', 'fixture', '[]', 'fixture', '[]', '[]', '[]', ?, '[]', " +
      "'done', 'low', '{}', ?, 1000)",
  );
  insertNode.run(workItemId, "analyze", "analyze", "ready", "[]", "candidate_ready");
  insertNode.run(
    workItemId,
    "modify",
    "modify",
    "pending",
    "[]",
    input.runStatus === "running" ? "running" : (input.candidateState === "target_tests_passed" ? "candidate_ready" : "failed"),
  );
  insertNode.run(workItemId, "validate", "validate", "pending", JSON.stringify(["target"]), "candidate_ready");
  insertNode.run(workItemId, "report", "report", "pending", "[]", "candidate_ready");
  database.prepare(
    "UPDATE collaboration_work_nodes SET assigned_agent_id = CASE node_type " +
      "WHEN 'modify' THEN 'codex-patch' WHEN 'validate' THEN 'codex-verifier' ELSE 'meta-coordinator' END " +
      "WHERE work_item_id = ? AND plan_revision = 1",
  ).run(workItemId);
  database
    .prepare(
      "UPDATE collaboration_work_items SET definition_status = 'ready_for_execution', current_plan_revision = 1 WHERE id = ?",
    )
    .run(workItemId);
  const runId = randomUUID();
  const runStatus = input.runStatus ?? "succeeded";
  database
    .prepare(
      "INSERT INTO collaboration_runs " +
        "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
        "worktree_path, branch, base_sha, result_sha, started_at, finished_at) " +
        "VALUES (?, ?, 1, 'modify', 1, 'developer-1', 'thread', 'turn', ?, '/tmp/repo', '/tmp/worktree', " +
        "'ai/fixture', ?, ?, 1000, ?)",
    )
    .run(runId, workItemId, runStatus, "b".repeat(40), runStatus === "succeeded" ? CANDIDATE_SHA : null, runStatus === "succeeded" ? 1100 : null);
  if (input.candidateState) {
    database
      .prepare(
        "INSERT INTO collaboration_candidates " +
          "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, '[\"src/value.ts\"]', '[]', '{}', 1100)",
      )
      .run(randomUUID(), runId, input.candidateState, "b".repeat(40), CANDIDATE_SHA);
    if (input.evidence ?? input.candidateState === "target_tests_passed") {
      database
        .prepare(
          "INSERT INTO collaboration_test_evidence " +
            "(id, run_id, command_id, argv_json, cwd, exit_code, duration_ms, stdout, stderr, state, created_at) " +
            "VALUES (?, ?, 'target', '[\"test\"]', '/tmp/worktree', 0, 5, 'ok', '', 'target_passed', 1100)",
        )
        .run(randomUUID(), runId);
    }
    if (input.candidateState === "target_tests_passed") {
      database
        .prepare(
          "INSERT INTO collaboration_candidate_reviews " +
            "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
            "VALUES (?,?,'verifier',1,'passed','deterministic-verifier-v1',1,'spec-hash',?,?,1100)",
        )
        .run(randomUUID(), runId, CANDIDATE_SHA, JSON.stringify(assertionReviewFixture(database, workItemId, "target").verifier));
      database
        .prepare(
          "INSERT INTO collaboration_candidate_reviews " +
            "(id,candidate_run_id,stage,attempt,status,agent_id,snapshot_revision,spec_hash,candidate_sha,verdict_json,created_at) " +
            "VALUES (?,?,'meta',1,'passed','meta-acceptance-gate-v1',1,'spec-hash',?,?,1100)",
        )
        .run(randomUUID(), runId, CANDIDATE_SHA, JSON.stringify(assertionReviewFixture(database, workItemId, "target").meta));
    }
  }
  database.close();
  return { runId, candidateSha: CANDIDATE_SHA };
}

function retryFixture() {
  const f = harness();
  const { runId } = seedExecution(f.databaseFile, f.workItemId, { candidateState: "test_failed", evidence: false });
  const db = new DatabaseSync(f.databaseFile);
  db.prepare("UPDATE collaboration_work_items SET title='检查项列表增加优先级筛选，与状态筛选组合'").run();
  db.prepare("UPDATE collaboration_runs SET status='failed'").run();
  enqueueInboundCard(db, { sourceEventId: `candidate:${runId}`, aggregateType: "plan", aggregateId: f.workItemId,
    aggregateVersion: 1, now: 1200, card: { type: "plan_status_card", headline: "执行未完成", status: "execution_failed",
      workItemId: f.workItemId, planRevision: 1, failures: ["provider_sandbox_unavailable"] } });
  db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=1300,delivery_sequence=rowid").run();
  return { ...f, runId, db };
}

function item(databaseFile: string, workItemId: string): Record<string, unknown> {
  const database = new DatabaseSync(databaseFile);
  const row = database
    .prepare(
      "SELECT status, version, control_state, current_plan_revision, accepted_candidate_sha FROM collaboration_work_items WHERE id = ?",
    )
    .get(workItemId) as Record<string, unknown>;
  database.close();
  return row;
}

describe("Owner action tokens and Work Item controls", () => {
  it("denies a reasonless parsed rejection durably without inventing feedback or changing the candidate", () => {
    const context = harness();
    seedExecution(context.databaseFile, context.workItemId, { candidateState: "target_tests_passed", evidence: true });
    const issued = context.service.issueOwnerAction({ action: "reject", workItemId: context.workItemId,
      expectedVersion: 1, candidateSha: CANDIDATE_SHA, now: 2000 });
    const parsed = parseDingTalkOwnerTextAction(message({ sourceEventId: "no-rejection-reason",
      text: `拒绝 ${issued.token}`, sender: ownerSender() }));
    expect(parsed).not.toBeNull();
    const input = { actionToken: parsed!.actionToken, sender: parsed!.sender, reason: parsed!.reason,
      request: { sourceEventId: "no-rejection-reason", origin: "text" as const, conversationId: "control-conversation" }, now: 2100 };
    const before = item(context.databaseFile, context.workItemId);
    try {
      const result = context.service.performOwnerAction(input);
      expect(result).toMatchObject({ allowed: false, duplicate: false, reason: "Reject requires a reason" });
      expect(context.service.performOwnerAction(input)).toMatchObject({ allowed: false, duplicate: true });
      expect(item(context.databaseFile, context.workItemId)).toEqual(before);
      const db = new DatabaseSync(context.databaseFile);
      try {
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_control_events").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM collaboration_owner_text_commands WHERE source_event_id='no-rejection-reason'").get()).toEqual({ n: 1 });
        const persisted = JSON.stringify(db.prepare("SELECT * FROM collaboration_owner_text_commands").all()) +
          JSON.stringify(db.prepare("SELECT * FROM collaboration_outbox").all());
        expect(persisted).not.toContain(issued.token);
      } finally { db.close(); }
    } finally { context.service.close(); }
  });
  it("denies contributors without consuming the opaque token and returns the Owner's decision on replay", () => {
    const context = harness();
    const issued = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    const database = new DatabaseSync(context.databaseFile);
    const persisted = database.prepare("SELECT token_hash, consumed_at FROM collaboration_action_tokens").get() as {
      token_hash: string;
      consumed_at: number | null;
    };
    expect(persisted.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.token_hash).not.toContain(issued.token);
    expect(persisted.consumed_at).toBeNull();
    expect(JSON.stringify(database.prepare("SELECT * FROM collaboration_action_tokens").get())).not.toContain(issued.token);
    database.close();

    expect(context.service.performOwnerAction({
      actionToken: issued.token,
      sender: contributorSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "not_active_owner" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 1, control_state: "active" });
    const deniedAudit = new DatabaseSync(context.databaseFile);
    expect(deniedAudit
      .prepare("SELECT outcome, error FROM collaboration_audit_events WHERE action = 'control.pause' AND outcome = 'deny'")
      .get()).toEqual({ outcome: "deny", error: "not_active_owner" });
    deniedAudit.close();

    const applied = context.service.performOwnerAction({ actionToken: issued.token, sender: ownerSender(), now: 2_200 });
    expect(applied).toMatchObject({
      allowed: true,
      duplicate: false,
      action: "pause",
      workItemVersion: 2,
      controlState: "paused",
    });
    expect(context.service.performOwnerAction({
      actionToken: issued.token,
      sender: ownerSender(),
      now: 2_300,
    })).toMatchObject({ allowed: true, duplicate: true, workItemVersion: 2, controlState: "paused" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 2, control_state: "paused" });

    const resume = context.service.issueOwnerAction({
      action: "resume",
      workItemId: context.workItemId,
      expectedVersion: 2,
      now: 2_400,
    });
    expect(context.service.performOwnerAction({
      actionToken: resume.token,
      sender: ownerSender(),
      now: 2_500,
    })).toMatchObject({ allowed: true, controlState: "active", workItemVersion: 3 });
    context.service.close();
  });

  it("consumes stale Owner actions once and invalidates old cards after local recovery", () => {
    const context = harness();
    const stale = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    context.service.ingestDingTalkMessage(
      message({ sourceEventId: "event-2", text: "More evidence", replyToSourceEventId: "event-1" }),
    );
    expect(context.service.performOwnerAction({
      actionToken: stale.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "work_item_version_changed", workItemVersion: 2 });
    expect(context.service.performOwnerAction({
      actionToken: stale.token,
      sender: ownerSender(),
      now: 2_200,
    })).toMatchObject({ allowed: false, duplicate: true, reason: "work_item_version_changed" });

    const expiring = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 2,
      ttlMs: 1_000,
      now: 2_300,
    });
    expect(context.service.performOwnerAction({
      actionToken: expiring.token,
      sender: ownerSender(),
      now: 3_300,
    })).toMatchObject({ allowed: false, reason: "action_token_expired" });

    const oldOwnerCard = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 2,
      now: 3_400,
    });
    context.service.recoverOwnerLocally({
      expectedGeneration: 1,
      senderCorpId: "corp-1",
      senderStaffId: "owner-2",
      now: 3_500,
    });
    expect(context.service.performOwnerAction({
      actionToken: oldOwnerCard.token,
      sender: ownerSender("owner-2"),
      now: 3_600,
    })).toMatchObject({ allowed: false, reason: "owner_generation_changed" });
    expect(context.service.performOwnerAction({
      actionToken: "forged-token",
      sender: ownerSender("owner-2"),
      now: 3_700,
    })).toMatchObject({ allowed: false, reason: "invalid_action_token" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 2, control_state: "active" });
    context.service.close();
  });

  it("accepts only the current candidate with every required target-test evidence row", () => {
    const context = harness();
    seedExecution(context.databaseFile, context.workItemId, { candidateState: "target_tests_passed", evidence: true });
    const accept = context.service.issueOwnerAction({
      action: "accept",
      workItemId: context.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_000,
    });
    expect(context.service.performOwnerAction({
      actionToken: accept.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, action: "accept", controlState: "accepted", candidateSha: CANDIDATE_SHA });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({
      status: "accepted",
      version: 2,
      control_state: "accepted",
      current_plan_revision: 1,
      accepted_candidate_sha: CANDIDATE_SHA,
    });
    const database = new DatabaseSync(context.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 1 });
    database.close();
    context.service.close();

    const missing = harness();
    seedExecution(missing.databaseFile, missing.workItemId, { candidateState: "target_tests_passed", evidence: false });
    expect(() =>
      missing.service.issueOwnerAction({
        action: "accept",
        workItemId: missing.workItemId,
        expectedVersion: 1,
        candidateSha: CANDIDATE_SHA,
        now: 2_000,
      }),
    ).toThrow("required_evidence_missing");
    missing.service.close();
  });

  it("requires rejection feedback, preserves candidates, creates a new revision, and keeps cancellation separate", () => {
    const rejected = harness();
    seedExecution(rejected.databaseFile, rejected.workItemId, { candidateState: "test_failed", evidence: false });
    const missingReason = rejected.service.issueOwnerAction({
      action: "reject",
      workItemId: rejected.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_000,
    });
    expect(rejected.service.performOwnerAction({
      actionToken: missingReason.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, reason: "Reject requires a reason" });
    const reject = rejected.service.issueOwnerAction({
      action: "reject",
      workItemId: rejected.workItemId,
      expectedVersion: 1,
      candidateSha: CANDIDATE_SHA,
      now: 2_200,
    });
    expect(rejected.service.performOwnerAction({
      actionToken: reject.token,
      sender: ownerSender(),
      reason: "错误提示仍然不符合验收条件",
      now: 2_300,
    })).toMatchObject({
      allowed: true,
      action: "reject",
      workItemVersion: 2,
      controlState: "active",
      revisedSnapshotRevision: 2,
    });
    expect(item(rejected.databaseFile, rejected.workItemId)).toMatchObject({
      status: "collecting",
      version: 2,
      control_state: "active",
      current_plan_revision: null,
    });
    const rejectedDb = new DatabaseSync(rejected.databaseFile);
    expect(rejectedDb.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    expect(rejectedDb.prepare("SELECT count(*) AS count FROM collaboration_work_item_snapshots").get()).toEqual({ count: 2 });
    expect(rejectedDb.prepare("SELECT action, reason FROM collaboration_control_events").get()).toEqual({
      action: "reject",
      reason: "错误提示仍然不符合验收条件",
    });
    expect((rejectedDb.prepare("SELECT facts_json FROM collaboration_work_item_snapshots WHERE revision = 2").get() as {
      facts_json: string;
    }).facts_json).toContain("错误提示仍然不符合验收条件");
    rejectedDb.close();
    rejected.service.close();

    const cancelled = harness();
    seedExecution(cancelled.databaseFile, cancelled.workItemId, { candidateState: "test_failed", evidence: false });
    const cancel = cancelled.service.issueOwnerAction({
      action: "cancel",
      workItemId: cancelled.workItemId,
      expectedVersion: 1,
      now: 3_000,
    });
    expect(cancelled.service.performOwnerAction({
      actionToken: cancel.token,
      sender: ownerSender(),
      now: 3_100,
    })).toMatchObject({ allowed: true, action: "cancel", controlState: "cancelled", revisedSnapshotRevision: null });
    const cancelledDb = new DatabaseSync(cancelled.databaseFile);
    expect(cancelledDb.prepare("SELECT count(*) AS count FROM collaboration_work_item_snapshots").get()).toEqual({ count: 1 });
    expect(cancelledDb.prepare("SELECT action, reason FROM collaboration_control_events").get()).toEqual({
      action: "cancel",
      reason: null,
    });
    cancelledDb.close();
    cancelled.service.close();
  });

  it("rolls back state and interrupt requests when the mandatory audit insert fails", () => {
    const context = harness();
    const running = seedExecution(context.databaseFile, context.workItemId, { runStatus: "running" });
    const pause = context.service.issueOwnerAction({
      action: "pause",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    const database = new DatabaseSync(context.databaseFile);
    database.exec(`
      CREATE TRIGGER reject_pause_audit
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'control.pause'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    database.close();
    expect(() =>
      context.service.performOwnerAction({ actionToken: pause.token, sender: ownerSender(), now: 2_100 }),
    ).toThrow("audit unavailable");
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ version: 1, control_state: "active" });
    const afterFailure = new DatabaseSync(context.databaseFile);
    expect(afterFailure.prepare("SELECT consumed_at FROM collaboration_action_tokens WHERE token_hash IS NOT NULL").get()).toEqual({
      consumed_at: null,
    });
    expect(afterFailure.prepare("SELECT interrupt_requested_at FROM collaboration_runs WHERE id = ?").get(running.runId)).toEqual({
      interrupt_requested_at: null,
    });
    afterFailure.exec("DROP TRIGGER reject_pause_audit");
    afterFailure.close();

    const applied = context.service.performOwnerAction({ actionToken: pause.token, sender: ownerSender(), now: 2_200 });
    expect(applied).toMatchObject({ allowed: true, controlState: "paused" });
    expect(applied.interruptRequestedRunIds).toEqual([running.runId]);
    const afterSuccess = new DatabaseSync(context.databaseFile);
    expect(afterSuccess.prepare("SELECT interrupt_requested_at FROM collaboration_runs WHERE id = ?").get(running.runId)).toEqual({
      interrupt_requested_at: 2_200,
    });
    expect(afterSuccess.prepare("SELECT DISTINCT control_state FROM collaboration_work_nodes").all()).toEqual([
      { control_state: "paused" },
    ]);
    afterSuccess.close();
    context.service.close();
  });

  it.each(["重试刚才的优先级筛选任务", "请重试优先级筛选", "@研发助手 重试优先级筛选任务。"])("retries the named, delivered failure through natural Owner ingress: %s", text => {
    const f = retryFixture();
    try {
      // The captured pilot run was needs_configuration, not a generic failed run.
      if (text === "重试刚才的优先级筛选任务") {
        f.db.prepare("UPDATE collaboration_runs SET status='needs_configuration'").run();
        f.db.prepare("UPDATE collaboration_work_nodes SET execution_status='needs_configuration' WHERE node_id='modify'").run();
      }
      const input = { ...message({ sourceEventId: "natural-retry", text, sender: ownerSender() }), receivedAt: 2000 };
      expect(f.service.performNaturalRetry(input, 2000)).toMatchObject({ allowed: true, action: "retry", workItemId: f.workItemId, workItemVersion: 2 });
      const receipt = f.db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id='natural-retry'").get()!;
      expect(JSON.parse(String(receipt.outcome_json))).toMatchObject({ kind: "natural_retry", retryRunId: f.runId });
      const reply = f.service.pendingOutbox().find(row => row.sourceEventId === "natural-retry")!;
      const rendered = renderDingTalkSessionMessage(reply.card);
      expect(JSON.stringify(rendered)).toContain("已重新安排");
      expect(JSON.stringify(rendered)).not.toMatch(/WI-|审批|修改完成|受控执行/u);
      f.db.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=2050,delivery_sequence=10 WHERE source_event_id='natural-retry'").run();
      const current = f.db.prepare("SELECT * FROM collaboration_external_events WHERE source_event_id='event-1'").get()!;
      const history = readConversationContext(f.db, { ...current, context_outbox_sequence: 10, requested_work_item_id: null,
        status: "pending", target_work_item_id: null, proposal_json: null, source_hash: "test" } as unknown as ConversationJob);
      expect(history.history.some(row => row.role === "assistant" && row.workItemId === f.workItemId && row.text.includes("已重新安排"))).toBe(true);
      const before = f.db.prepare("SELECT * FROM collaboration_control_events").all();
      f.service.close(); f.service = startCollaborationService({ dataDirectory: f.root });
      expect(f.service.performNaturalRetry(input, 2100)).toMatchObject({ allowed: true, duplicate: true });
      expect(f.db.prepare("SELECT * FROM collaboration_control_events").all()).toEqual(before);
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_runs").get()).toEqual({ n: 1 });
      expect(f.db.prepare("SELECT attempt FROM collaboration_runs").get()).toEqual({ attempt: 1 });
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_candidates").get()).toEqual({ n: 1 });
      expect(f.db.prepare("SELECT execution_status FROM collaboration_work_nodes WHERE node_id='modify'").get()).toEqual({ execution_status: "not_started" });
      expect(() => f.service.performNaturalRetry({ ...input, text: "重试支付筛选任务" }, 2200)).toThrow(/conflict/u);
    } finally { f.db.close(); f.service.close(); }
  });

  it.each(["not_owner", "unstable", "wrong_group", "undelivered", "new_version", "new_plan", "running", "cancelled", "attempt_limit", "unknown_topic", "ambiguous"])("does not retry without current unambiguous authority/evidence: %s", boundary => {
    const f = retryFixture();
    try {
      const input = { ...message({ sourceEventId: "natural-denied", text: "重试刚才的优先级筛选任务", sender: ownerSender() }), receivedAt: 2000 };
      if (boundary === "not_owner") input.sender = contributorSender();
      if (boundary === "unstable") input.sender = { senderId: "owner-1", displayName: "Owner" };
      if (boundary === "wrong_group") input.conversationId = "another-group";
      if (boundary === "unknown_topic") input.text = "重试支付筛选任务";
      if (boundary === "undelivered") f.db.prepare("UPDATE collaboration_outbox SET delivery_state='pending',sent_at=NULL WHERE source_event_id=?").run(`candidate:${f.runId}`);
      if (boundary === "new_version") f.db.prepare("UPDATE collaboration_work_items SET version=2").run();
      if (boundary === "new_plan") f.db.prepare("UPDATE collaboration_work_items SET current_plan_revision=NULL").run();
      if (boundary === "running") f.db.prepare("UPDATE collaboration_runs SET status='running',finished_at=NULL").run();
      if (boundary === "cancelled") f.db.prepare("UPDATE collaboration_work_items SET control_state='cancelled'").run();
      if (boundary === "attempt_limit") f.db.prepare("UPDATE collaboration_runs SET attempt=3").run();
      if (boundary === "ambiguous") {
        f.service.ingestDingTalkMessage({ ...message({ sourceEventId: "other-task", text: "新任务：优先级筛选的另一个页面" }), receivedAt: 1700 });
      }
      expect(f.service.performNaturalRetry(input, 2000)?.allowed).toBe(false);
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      const reply = f.service.pendingOutbox().find(row => row.sourceEventId === input.sourceEventId)!;
      expect(JSON.stringify(renderDingTalkSessionMessage(reply.card))).not.toMatch(/WI-|需要由负责人确认具体动作/u);
    } finally { f.db.close(); f.service.close(); }
  });

  it.each(["不要重试优先级筛选任务", "重试优先级筛选任务吗？", "如果成功就重试优先级筛选任务", "他说重试优先级筛选任务", "重试优先级筛选任务，然后部署", "重试刚才的任务", "重试 WI-INVALID", "重试“优先级筛选”任务"])("keeps uncertain/quoted retry text out of control: %s", text => {
    const f = retryFixture();
    try {
      expect(f.service.performNaturalRetry({ ...message({ sourceEventId: "discussion", text, sender: ownerSender() }), receivedAt: 2000 }, 2000)).toBeNull();
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { f.db.close(); f.service.close(); }
  });

  it("never reinterprets an already ingested event, and rolls back a retry when its reply cannot persist", () => {
    const f = retryFixture();
    try {
      const input = { ...message({ sourceEventId: "old-event", text: "重试刚才的优先级筛选任务", sender: ownerSender() }), receivedAt: 2000 };
      f.service.ingestDingTalkMessage(input);
      expect(f.service.performNaturalRetry(input, 2100)).toBeNull();
      f.db.exec("CREATE TRIGGER fixture_reply_failure BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT,'fixture_retry_reply_failure'); END");
      expect(() => f.service.performNaturalRetry({ ...input, sourceEventId: "fresh-retry" }, 2100)).toThrow("fixture_retry_reply_failure");
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
    } finally { f.db.close(); f.service.close(); }
  });

  it("resolves '刚才' from the last actually delivered failure even with an older completed namesake", () => {
    const f = retryFixture();
    try {
      const old = f.service.ingestDingTalkMessage({ ...message({ sourceEventId: "old-namesake", text: "新任务：优先级筛选的旧页面" }), receivedAt: 1050 }).workItemId!;
      f.db.prepare("UPDATE collaboration_work_items SET status='accepted',control_state='accepted' WHERE id=?").run(old);
      const input = { ...message({ sourceEventId: "recent-retry", text: "重试刚才的优先级筛选任务", sender: ownerSender() }), receivedAt: 2000 };
      expect(f.service.performNaturalRetry({ ...input, text: "重试优先级筛选任务", sourceEventId: "ambiguous-name" }, 2000)).toMatchObject({ allowed: false });
      expect(f.service.performNaturalRetry(input, 2100)).toMatchObject({ allowed: true, workItemId: f.workItemId });
    } finally { f.db.close(); f.service.close(); }
  });

  it("records an Owner retry request while preserving the failed candidate", () => {
    const context = harness();
    seedExecution(context.databaseFile, context.workItemId, { candidateState: "test_failed", evidence: false });
    const retry = context.service.issueOwnerAction({
      action: "retry",
      workItemId: context.workItemId,
      expectedVersion: 1,
      now: 2_000,
    });
    expect(context.service.performOwnerAction({
      actionToken: retry.token,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, action: "retry", workItemVersion: 2, controlState: "active" });
    const database = new DatabaseSync(context.databaseFile);
    expect(database.prepare("SELECT execution_status FROM collaboration_work_nodes WHERE node_id = 'modify'").get()).toEqual({
      execution_status: "not_started",
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_candidates").get()).toEqual({ count: 1 });
    database.close();
    context.service.close();
  });

  it("atomically deduplicates direct Owner text controls and rejects conflicting replays", () => {
    const context = harness();
    const first = context.service.performDirectOwnerAction({
      sourceEventId: "text-command-1",
      conversationId: "request-group",
      action: "pause",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_000,
    });
    expect(first).toMatchObject({ allowed: true, duplicate: false, action: "pause", controlState: "paused", conversationId: "request-group" });
    expect(context.service.performDirectOwnerAction({
      sourceEventId: "text-command-1",
      conversationId: "request-group",
      action: "pause",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, duplicate: true, action: "pause", controlState: "paused" });
    expect(context.service.performDirectOwnerAction({
      sourceEventId: "text-command-state-denied",
      action: "pause",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_150,
    })).toMatchObject({ allowed: false, reason: "work_item_not_active" });
    expect(() => context.service.performDirectOwnerAction({
      sourceEventId: "text-command-1",
      action: "resume",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_200,
    })).toThrow("owner_text_command_event_conflict");

    const denied = context.service.performDirectOwnerAction({
      sourceEventId: "text-command-non-owner",
      action: "resume",
      workItemId: context.workItemId,
      sender: contributorSender(),
      now: 2_300,
    });
    expect(denied).toMatchObject({ allowed: false, reason: "not_active_owner" });
    const database = new DatabaseSync(context.databaseFile);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_owner_text_commands").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_control_events").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT outcome, error FROM collaboration_audit_events " +
        "WHERE action = 'control.pause' AND outcome = 'deny' ORDER BY created_at DESC LIMIT 1",
    ).get()).toEqual({ outcome: "deny", error: "work_item_not_active" });
    database.close();
    context.service.close();
  });

  it("refuses a direct command that reuses an already recorded inbound event", () => {
    const context = harness();
    try {
      expect(() => context.service.performDirectOwnerAction({ sourceEventId: "event-1", action: "pause", workItemId: context.workItemId,
        sender: ownerSender(), now: 2000 })).toThrow("owner_text_command_event_conflict");
      expect(item(context.databaseFile, context.workItemId)).toMatchObject({ control_state: "active", version: 1 });
    } finally { context.service.close(); }
  });

  it("does not create a new task by replaying a direct control event as ordinary inbound text", () => {
    const context = harness();
    try {
      context.service.performDirectOwnerAction({ sourceEventId: "control-not-inbound", action: "pause", workItemId: context.workItemId,
        sender: ownerSender(), now: 2000 });
      expect(() => context.service.ingestDingTalkMessage(message({ sourceEventId: "control-not-inbound", text: "新需求" })))
        .toThrow("owner_text_command_event_conflict");
    } finally { context.service.close(); }
  });

  it("persists a token action event and reply atomically without retaining the executable token", () => {
    const context = harness();
    const db = new DatabaseSync(context.databaseFile);
    try {
      const issued = context.service.issueOwnerAction({ action: "pause", workItemId: context.workItemId, expectedVersion: 1, now: 2000 });
      const input = { actionToken: issued.token, sender: ownerSender(), now: 2100,
        request: { sourceEventId: "token-request", origin: "text" as const, conversationId: "request-group" } };
      const before = db.prepare("SELECT * FROM collaboration_work_items").all();
      db.exec("CREATE TRIGGER fail_token_reply BEFORE INSERT ON collaboration_outbox WHEN NEW.source_event_id='token-request' BEGIN SELECT RAISE(ABORT,'synthetic_token_reply_failure'); END");
      expect(() => context.service.performOwnerAction(input)).toThrow("synthetic_token_reply_failure");
      expect(db.prepare("SELECT * FROM collaboration_work_items").all()).toEqual(before);
      expect(db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT consumed_at FROM collaboration_action_tokens").get()).toEqual({ consumed_at: null });
      db.exec("DROP TRIGGER fail_token_reply");
      expect(context.service.performOwnerAction(input)).toMatchObject({ allowed: true, duplicate: false });
      expect(JSON.stringify(db.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id='token-request'").get())).not.toContain(issued.token);
      const receipt = db.prepare("SELECT outcome_json FROM collaboration_owner_text_commands WHERE source_event_id='token-request'").get() as { outcome_json: string };
      expect(JSON.parse(receipt.outcome_json)).toMatchObject({ kind: "token_action", conversationId: "request-group", outcome: { allowed: true } });
      expect(receipt.outcome_json).not.toContain(issued.token);
      expect(context.service.performOwnerAction(input)).toMatchObject({ allowed: true, duplicate: true });
      expect(db.prepare("SELECT count(*) n FROM collaboration_outbox WHERE source_event_id='token-request'").get()).toEqual({ n: 1 });
      expect(() => context.service.performOwnerAction({ ...input, request: { ...input.request, conversationId: "other-group" } })).toThrow("event_conflict");
    } finally { db.close(); context.service.close(); }
  });

  it("keeps a denied token event denied after a separate Owner action and rejects sender replacement", () => {
    const context = harness();
    const db = new DatabaseSync(context.databaseFile);
    try {
      const issued = context.service.issueOwnerAction({ action: "pause", workItemId: context.workItemId, expectedVersion: 1, now: 2000 });
      const deniedRequest = { actionToken: issued.token, sender: contributorSender(), now: 2100,
        request: { sourceEventId: "denied-token", origin: "text" as const, conversationId: "request-group" } };
      expect(context.service.performOwnerAction(deniedRequest)).toMatchObject({ allowed: false, duplicate: false, reason: "not_active_owner" });
      expect(() => context.service.performOwnerAction({ ...deniedRequest, sender: ownerSender() })).toThrow("event_conflict");
      expect(db.prepare("SELECT consumed_at FROM collaboration_action_tokens").get()).toEqual({ consumed_at: null });
      expect(context.service.performOwnerAction({ ...deniedRequest, sender: ownerSender(), request: { ...deniedRequest.request, sourceEventId: "owner-token" } })).toMatchObject({ allowed: true });
      expect(context.service.performOwnerAction(deniedRequest)).toMatchObject({ allowed: false, duplicate: true, reason: "not_active_owner" });
      expect(db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 1 });
    } finally { db.close(); context.service.close(); }
  });

  it("rolls back the control mutation when its origin receipt cannot be persisted", () => {
    const context = harness();
    const db = new DatabaseSync(context.databaseFile);
    try {
      const before = db.prepare("SELECT * FROM collaboration_work_items").all();
      const audits = db.prepare("SELECT count(*) n FROM collaboration_audit_events").get();
      db.exec("CREATE TRIGGER fail_origin_receipt BEFORE INSERT ON collaboration_owner_text_commands BEGIN SELECT RAISE(ABORT,'synthetic_origin_failure'); END");
      expect(() => context.service.performDirectOwnerAction({ sourceEventId: "origin-failure", conversationId: "request-group", action: "pause",
        workItemId: context.workItemId, sender: ownerSender(), now: 2000 })).toThrow("synthetic_origin_failure");
      expect(db.prepare("SELECT * FROM collaboration_work_items").all()).toEqual(before);
      expect(db.prepare("SELECT count(*) n FROM collaboration_audit_events").get()).toEqual(audits);
      expect(db.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { db.close(); context.service.close(); }
  });

  it("atomically deduplicates direct candidate decisions without turning a denied replay into success", () => {
    const deniedContext = harness();
    seedExecution(deniedContext.databaseFile, deniedContext.workItemId, {
      candidateState: "target_tests_passed",
      evidence: true,
    });
    const denied = deniedContext.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-denied",
      action: "accept",
      workItemId: deniedContext.workItemId,
      candidateSha: CANDIDATE_SHA,
      sender: contributorSender(),
      now: 2_000,
    });
    expect(denied).toMatchObject({ allowed: false, duplicate: false, reason: "not_active_owner" });
    expect(deniedContext.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-denied",
      action: "accept",
      workItemId: deniedContext.workItemId,
      candidateSha: CANDIDATE_SHA,
      sender: contributorSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, duplicate: true, reason: "not_active_owner" });
    expect(item(deniedContext.databaseFile, deniedContext.workItemId)).toMatchObject({ control_state: "active" });
    deniedContext.service.close();

    const acceptedContext = harness();
    seedExecution(acceptedContext.databaseFile, acceptedContext.workItemId, {
      candidateState: "target_tests_passed",
      evidence: true,
    });
    const accepted = acceptedContext.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-accepted",
      action: "accept",
      workItemId: acceptedContext.workItemId,
      candidateSha: CANDIDATE_SHA,
      sender: ownerSender(),
      now: 2_000,
    });
    expect(accepted).toMatchObject({
      allowed: true,
      duplicate: false,
      action: "accept",
      candidateSha: CANDIDATE_SHA,
      controlState: "accepted",
    });
    expect(acceptedContext.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-accepted",
      action: "accept",
      workItemId: acceptedContext.workItemId,
      candidateSha: CANDIDATE_SHA,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: true, duplicate: true, controlState: "accepted" });
    acceptedContext.service.close();
  });

  it("does not let a previously unavailable candidate command act on a later candidate", () => {
    const context = harness();
    const first = context.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-before-ready",
      action: "accept",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_000,
    });
    expect(first).toMatchObject({ allowed: false, duplicate: false, reason: "candidate_not_current" });

    seedExecution(context.databaseFile, context.workItemId, {
      candidateState: "target_tests_passed",
      evidence: true,
    });
    expect(context.service.performDirectOwnerAction({
      sourceEventId: "candidate-command-before-ready",
      action: "accept",
      workItemId: context.workItemId,
      sender: ownerSender(),
      now: 2_100,
    })).toMatchObject({ allowed: false, duplicate: true, reason: "candidate_not_current" });
    expect(item(context.databaseFile, context.workItemId)).toMatchObject({ control_state: "active" });
    context.service.close();
  });
});
