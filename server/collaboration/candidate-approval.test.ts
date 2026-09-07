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
import { OwnerActionController } from "./actions.ts";
import { renderDingTalkSessionMessage } from "../integrations/dingtalk/session-message.ts";

import { startCollaborationService } from "./service.ts";
import { completeVerifiedLowRiskCandidate } from "./candidate-approval.ts";
import { readConversationContext, type ConversationJob } from "./conversation-context.ts";
import { enqueueOwnerDecisionForWorkItem } from "./operations/runtime.ts";

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

const naturalMessage = (text = "批准这次改动", sourceEventId = "natural", receivedAt = 600) => ({
  sourceEventId, transportMessageId: sourceEventId, conversationId: "conversation-1", addressedToBot: true, text, receivedAt,
  sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1", displayName: "负责人" },
});
async function sendPresentation(f: ReturnType<typeof presentationFixture>, now = 400) {
  return new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent" as const,
    approvalDelivery: { sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload) } }; } }, f.options).dispatchOne(f.lease, now);
}

function secondCandidate(f: ReturnType<typeof presentationFixture>) {
  const service = startCollaborationService({ dataDirectory: f.dataDirectory });
  const second = service.ingestDingTalkMessage(naturalMessage("新任务：支付提示调整", "source-2", 200)).workItemId!; service.close();
  if (!second) throw new Error("fixture_second_task_not_created");
  f.database.prepare("UPDATE collaboration_work_items SET current_plan_revision=1,definition_status='ready_for_execution' WHERE id=?").run(second);
  const copy = (table: string, where: string, changes: (row: Record<string, import('node:sqlite').SQLInputValue>) => Record<string, import('node:sqlite').SQLInputValue>) => {
    const rows = f.database.prepare(`SELECT * FROM ${table} WHERE ${where}`).all() as Record<string, import('node:sqlite').SQLInputValue>[];
    for (const row of rows) { const next = changes(row), keys = Object.keys(next);
      f.database.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => next[key])); }
  };
  copy("collaboration_work_item_snapshots", "revision=1", row => ({ ...row, work_item_id: second, goal: "支付提示调整" }));
  copy("collaboration_plan_revisions", "id='plan-1'", row => ({ ...row, id: "plan-2", work_item_id: second }));
  copy("collaboration_work_nodes", "plan_revision=1", row => ({ ...row, work_item_id: second }));
  copy("collaboration_runs", "id='run-1'", row => ({ ...row, id: "run-2", work_item_id: second, thread_id: "thread-2", turn_id: "turn-2" }));
  copy("collaboration_candidates", "id='candidate-1'", row => ({ ...row, id: "candidate-2", run_id: "run-2" }));
  copy("collaboration_test_evidence", "run_id='run-1'", row => ({ ...row, id: "evidence-2", run_id: "run-2" }));
  const reviews = assertionReviewFixture(f.database, second, "target");
  copy("collaboration_candidate_reviews", "candidate_run_id='run-1'", row => ({ ...row, id: `${row.id}-second`, candidate_run_id: "run-2",
    verdict_json: JSON.stringify(row.stage === "verifier" ? reviews.verifier : reviews.meta) }));
  f.database.prepare("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=250,delivery_sequence=2 WHERE source_event_id='source-2'").run();
  return enqueueInboundCard(f.database, { sourceEventId: "approval-2", aggregateType: "plan", aggregateId: second, aggregateVersion: 1, now: 301,
    card: { type: "plan_status_card", headline: "修改完成，需要负责人确认", status: "candidate_ready", workItemId: second,
      workItemVersion: 1, planRevision: 1, candidateSha: "2".repeat(40), approvalRequired: true, summary: "支付提示已调整，涉及金额展示。" } });
}

describe("natural approval controls", () => {
  it("approves by the subject actually shown by the runtime, even when its status summary is generic", async () => {
    const f = presentationFixture();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      expect(enqueueOwnerDecisionForWorkItem(f.database, f.workItemId, undefined, "runtime-approval", 300)).toBe(true);
      const row = f.database.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id='runtime-approval'").get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.approvalTopic).toBe("让发布结果更容易理解");
      expect(JSON.stringify(renderDingTalkSessionMessage(payload))).toContain(payload.approvalTopic);
      await sendPresentation(f);
      expect(service.performNaturalApproval(naturalMessage(`批准${payload.approvalTopic}`), 600)).toMatchObject({ allowed: true, workItemId: f.workItemId });
    } finally { service.close(); f.database.close(); }
  });

  it.each(["accepted", "question"])("keeps the delivered %s reply in subsequent conversational context, not another group", async kind => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      const result = service.performNaturalApproval(naturalMessage(kind === "accepted" ? "批准这次改动" : "退回这次改动"), 600);
      expect(result).toMatchObject({ allowed: kind === "accepted" });
      const original = f.database.prepare("SELECT * FROM collaboration_external_events WHERE source_event_id='source-1'").get() as unknown as ConversationJob;
      const job = { ...original, received_at: 800, context_outbox_sequence: 100, requested_work_item_id: null };
      const reply = f.database.prepare("SELECT id FROM collaboration_outbox WHERE source_event_id='natural'").get() as { id: string };
      expect(readConversationContext(f.database, job).history.some(row => row.sourceEventId === `outbox:${reply.id}`)).toBe(false);
      await sendPresentation(f, 700);
      const context = readConversationContext(f.database, job);
      expect(context.history).toContainEqual(expect.objectContaining({ sourceEventId: `outbox:${reply.id}`, role: "assistant",
        text: expect.stringContaining(kind === "accepted" ? "已批准" : "退回原因") }));
      expect(context.pendingQuestion?.kind ?? null).toBe(kind === "accepted" ? null : "approval");
      expect(readConversationContext(f.database, { ...job, conversation_id: "another-group" }).history).toEqual([]);
      expect(readConversationContext(f.database, { ...job, context_outbox_sequence: 1 }).history.some(row => row.sourceEventId === `outbox:${reply.id}`)).toBe(false);
    } finally { service.close(); f.database.close(); }
  });

  it.each(["source", "group", "time"])("rejects invalid %s before saving even a denied approval", boundary => {
    const f = presentationFixture();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      const input = naturalMessage();
      if (boundary === "source") input.sourceEventId = "x".repeat(257);
      if (boundary === "group") input.conversationId = "bad\u0000group";
      if (boundary === "time") input.receivedAt = -1;
      expect(() => service.performNaturalApproval(input, 600)).toThrow(/invalid/u);
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_owner_text_commands").get()).toEqual({ n: 0 });
    } finally { service.close(); f.database.close(); }
  });

  it.each(["owner", "version", "expiry"])("does not use a delivered question after %s changes", async boundary => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      expect(service.performNaturalApproval(naturalMessage("退回这次改动"), 600)).toMatchObject({ question: { kind: "reason" } });
      await sendPresentation(f, 700);
      const input = naturalMessage("因为提示仍然不准确", "reason", 800);
      if (boundary === "version") f.database.exec("UPDATE collaboration_work_items SET version=version+1");
      if (boundary === "owner") {
        const owner = new LocalOwnerRegistry(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
        owner.recover({ expectedGeneration: 1, senderCorpId: "corp-1", senderStaffId: "replacement", now: 750 }); owner.close();
        input.sender.senderStaffId = "replacement";
      }
      expect(service.performNaturalApproval(input, boundary === "expiry" ? 1_000_000 : 800)?.allowed ?? false).toBe(false);
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { service.close(); f.database.close(); }
  });

  it("does not upgrade a previously ingested ordinary event on redelivery", async () => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      const input = naturalMessage("可以", "ordinary", 350);
      service.ingestDingTalkMessage(input);
      await sendPresentation(f);
      expect(service.performNaturalApproval({ ...input, receivedAt: 600 }, 600)).toBeNull();
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { service.close(); f.database.close(); }
  });

  it.each(["member", "weak-identity", "new-owner", "old-owner", "version", "expired", "not-sent", "other-group", "quoted", "conditional", "attachment", "intervening", "future-message"])("does not approve at boundary %s", async boundary => {
    const f = presentationFixture(); f.create();
    const controller = new OwnerActionController(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      if (boundary !== "not-sent") await sendPresentation(f);
      const input: import('../integrations/dingtalk/types.ts').DingTalkInboundMessage = naturalMessage();
      if (boundary === "member") input.sender = { ...input.sender, senderId: "member", senderStaffId: "member" };
      if (boundary === "weak-identity") input.sender = { ...input.sender, senderStaffId: undefined };
      if (boundary === "new-owner" || boundary === "old-owner") {
        const registry = new LocalOwnerRegistry(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
        registry.recover({ expectedGeneration: 1, senderCorpId: "corp-1", senderStaffId: "new-owner", now: 500 }); registry.close();
        if (boundary === "new-owner") input.sender = { ...input.sender, senderId: "new-owner", senderStaffId: "new-owner" };
      }
      if (boundary === "version") f.database.exec("UPDATE collaboration_work_items SET version=version+1");
      if (boundary === "other-group") input.conversationId = "foreign-group";
      if (boundary === "quoted") input.text = "他说：批准这次改动";
      if (boundary === "conditional") input.text = "批准这次改动，但不包括权限变化";
      if (boundary === "attachment") input.resources = [{ kind: "file", name: "instruction.txt", capabilityRef: "fixture-resource" }];
      if (boundary === "intervening") {
        const service = startCollaborationService({ dataDirectory: f.dataDirectory });
        service.ingestDingTalkMessage(naturalMessage("另外一个问题", "intervening", 500)); service.close();
      }
      if (boundary === "future-message") input.receivedAt = 300;
      const result = controller.performNaturalApproval(input, boundary === "expired" ? 900301 : 600);
      expect(result?.allowed ?? false).toBe(false);
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      expect(f.database.prepare("SELECT status FROM collaboration_work_items WHERE id=?").get(f.workItemId)).toEqual({ status: "collecting" });
    } finally { controller.close(); f.database.close(); }
  });

  it("asks which displayed change and accepts a named short answer only after that question was delivered", async () => {
    const f = presentationFixture(); f.create(); secondCandidate(f);
    const file = join(f.dataDirectory, "collaboration", "collaboration.sqlite");
    let controller = new OwnerActionController(file);
    try {
      await sendPresentation(f, 400); await sendPresentation(f, 450);
      const question = controller.performNaturalApproval(naturalMessage(), 600);
      expect(question).toMatchObject({ allowed: false, question: { kind: "choose" } });
      expect(controller.performNaturalApproval(naturalMessage("登录那个", "too-early", 650), 650)).toBeNull();
      await sendPresentation(f, 700);
      controller.close(); controller = new OwnerActionController(file);
      expect(controller.performNaturalApproval(naturalMessage("登录那个", "answer", 800), 800))
        .toMatchObject({ allowed: true, workItemId: f.workItemId, action: "accept" });
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_work_items WHERE status='accepted'").get()).toEqual({ n: 1 });
    } finally { controller.close(); f.database.close(); }
  });

  it("asks for a rejection reason and records the real answer, never invented feedback", async () => {
    const f = presentationFixture(); f.create();
    const controller = new OwnerActionController(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      await sendPresentation(f);
      expect(controller.performNaturalApproval(naturalMessage("退回这次改动"), 600)).toMatchObject({ allowed: false, question: { kind: "reason" } });
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      await sendPresentation(f, 700);
      const result = controller.performNaturalApproval(naturalMessage("因为提示还是看不懂", "reason", 800), 800);
      expect(result).toMatchObject({ allowed: true, action: "reject", revisedSnapshotRevision: 2 });
      expect(f.database.prepare("SELECT reason FROM collaboration_control_events").get()).toEqual({ reason: "提示还是看不懂" });
    } finally { controller.close(); f.database.close(); }
  });

  it.each([
    ["提示还是看不懂", "提示还是看不懂"],
    ["错误提示太笼统，需要说明具体原因。", "错误提示太笼统，需要说明具体原因。"],
    ["账号不存在时却显示密码错误", "账号不存在时却显示密码错误"],
    ["移动端缺了空输入的检查", "移动端缺了空输入的检查"],
    ["需要保留用户名，密码仍然清空", "需要保留用户名，密码仍然清空"],
    ["原因是：提示没有说明怎么处理", "提示没有说明怎么处理"],
  ])("takes an ordinary answer to the delivered rejection question: %s", async (text, reason) => {
    const f = presentationFixture(); f.create();
    let service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      expect(service.performNaturalApproval(naturalMessage("退回这次改动"), 600)).toMatchObject({ question: { kind: "reason" } });
      await sendPresentation(f, 700);
      service.close(); service = startCollaborationService({ dataDirectory: f.dataDirectory });
      const result = service.performNaturalApproval(naturalMessage(text, "plain-reason", 800), 800);
      expect(result).toMatchObject({ allowed: true, action: "reject", workItemId: f.workItemId, revisedSnapshotRevision: 2 });
      expect(f.database.prepare("SELECT reason FROM collaboration_control_events").get()).toEqual({ reason });
      expect(service.performNaturalApproval(naturalMessage(text, "plain-reason", 800), 900)).toMatchObject({ duplicate: true });
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 1 });
    } finally { service.close(); f.database.close(); }
  });

  it.each(["好的，谢谢", "先等等", "不退回了", "先别退回了", "这个先不退了", "我改主意了", "先暂停这项", "改成批准吧", "这是在问什么", "为什么要原因", "提示哪里不对？", "多久能好",
    "登录那个", "另外问个问题", "新任务：支付提示不对", "他说：提示太笼统", "```提示太笼统```", "因为先不退回了"])("does not mistake %s for rejection feedback", async text => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      service.performNaturalApproval(naturalMessage("退回这次改动"), 600);
      await sendPresentation(f, 700);
      expect(service.performNaturalApproval(naturalMessage(text, "not-feedback", 800), 800)?.allowed ?? false).toBe(false);
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { service.close(); f.database.close(); }
  });

  it.each(["not-sent", "member", "other-group", "version", "expiry", "intervening"])("does not consume plain feedback across %s", async boundary => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      service.performNaturalApproval(naturalMessage("退回这次改动"), 600);
      if (boundary !== "not-sent") await sendPresentation(f, 700);
      const input = naturalMessage("提示还是看不懂", "feedback-boundary", 800);
      if (boundary === "member") input.sender.senderStaffId = "another-member";
      if (boundary === "other-group") input.conversationId = "another-group";
      if (boundary === "version") f.database.exec("UPDATE collaboration_work_items SET version=version+1");
      if (boundary === "intervening") service.ingestDingTalkMessage(naturalMessage("现在到哪了", "intervening-query", 750));
      expect(service.performNaturalApproval(input, boundary === "expiry" ? 1_000_000 : 800)?.allowed ?? false).toBe(false);
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
    } finally { service.close(); f.database.close(); }
  });

  it("redacts secrets in ordinary rejection feedback before saving the reason", async () => {
    const f = presentationFixture(); f.create();
    const service = startCollaborationService({ dataDirectory: f.dataDirectory });
    try {
      await sendPresentation(f);
      service.performNaturalApproval(naturalMessage("退回这次改动"), 600);
      await sendPresentation(f, 700);
      expect(service.performNaturalApproval(naturalMessage("提示包含 password=synth-reason-secret，不应显示敏感信息", "secret-feedback", 800), 800))
        .toMatchObject({ allowed: true, action: "reject" });
      const reason = f.database.prepare("SELECT reason FROM collaboration_control_events").get() as { reason: string };
      expect(reason.reason).toContain("提示包含");
      expect(reason.reason).not.toContain("synth-reason-secret");
      for (const table of ["collaboration_owner_text_commands", "collaboration_outbox", "collaboration_work_item_snapshots", "collaboration_audit_events"]) {
        expect(JSON.stringify(f.database.prepare(`SELECT * FROM ${table}`).all())).not.toContain("synth-reason-secret");
      }
    } finally { service.close(); f.database.close(); }
  });

  it("rolls back control, receipt and audit if the natural reply cannot be saved", async () => {
    const f = presentationFixture(); f.create();
    const controller = new OwnerActionController(join(f.dataDirectory, "collaboration", "collaboration.sqlite"));
    try {
      await sendPresentation(f);
      f.database.exec("CREATE TRIGGER fail_natural_reply BEFORE INSERT ON collaboration_outbox WHEN NEW.source_event_id='natural' BEGIN SELECT RAISE(ABORT,'fixture_reply_failure'); END");
      expect(() => controller.performNaturalApproval(naturalMessage(), 600)).toThrow("fixture_reply_failure");
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 0 });
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_action_tokens").get()).toEqual({ n: 0 });
      expect(f.database.prepare("SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id='natural'").get()).toBeUndefined();
      f.database.exec("DROP TRIGGER fail_natural_reply");
      expect(controller.performNaturalApproval(naturalMessage(), 601)).toMatchObject({ allowed: true });
    } finally { controller.close(); f.database.close(); }
  });
});

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
  it("lets the authenticated Owner approve the displayed fixed change without an ID, once across restart", async () => {
    const f = presentationFixture(), card = f.create();
    const file = join(f.dataDirectory, "collaboration", "collaboration.sqlite");
    let controller = new OwnerActionController(file);
    const input = { sourceEventId: "natural-yes", transportMessageId: "natural-yes", conversationId: "conversation-1", addressedToBot: true,
      text: "可以，就按这次改动来。", sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1", displayName: "负责人" }, receivedAt: 500 };
    try {
      await new OutboxDispatcher(f.database, { async deliver(message) { return { outcome: "sent", approvalDelivery: {
        sourceEventId: "source-1", payloadHash: approvalPayloadHash(message.payload),
      } }; } }, f.options).dispatchOne(f.lease, 400);
      const result = controller.performNaturalApproval(input, 500);
      expect(result).toMatchObject({ allowed: true, action: "accept", workItemId: f.workItemId, approvalPresentationId: card.id });
      expect(f.database.prepare("SELECT status FROM collaboration_work_items WHERE id=?").get(f.workItemId)).toEqual({ status: "accepted" });
      controller.close(); controller = new OwnerActionController(file);
      expect(controller.performNaturalApproval(input, 600)).toEqual({ ...result, duplicate: true });
      expect(() => controller.performNaturalApproval({ ...input, text: "退回这次改动，因为提示不对" }, 601)).toThrow("conflict");
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_control_events").get()).toEqual({ n: 1 });
      expect(f.database.prepare("SELECT count(*) n FROM collaboration_external_events").get()).toEqual({ n: 1 });
      const reply = f.database.prepare("SELECT payload_json FROM collaboration_outbox WHERE source_event_id=?").get(input.sourceEventId) as { payload_json: string };
      const rendered = JSON.stringify(renderDingTalkSessionMessage(JSON.parse(reply.payload_json)));
      expect(rendered).toContain("已批准"); expect(rendered).not.toMatch(/WI-|SHA|token|candidate/u);
      expect(rendered).toContain("登录提示");
      for (const changed of [{ ...input, sender: { ...input.sender, senderStaffId: "member" } },
        { ...input, conversationId: "another-group" }, { ...input, resources: [{ kind: "file" as const, capabilityRef: "fixture" }] }]) {
        expect(() => controller.performNaturalApproval(changed, 602)).toThrow("conflict");
      }
      const audit = f.database.prepare("SELECT resource_json FROM collaboration_audit_events WHERE action='control.accept' AND outcome='allow'").get() as { resource_json: string };
      expect(JSON.parse(audit.resource_json)).toMatchObject({ approvalPresentationId: card.id });
    } finally { controller.close(); f.database.close(); }
  });
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
