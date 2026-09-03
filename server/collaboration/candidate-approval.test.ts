import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

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
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
      "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
      "completion_definition,risk,budget_json,created_at,execution_status,control_state) " +
      "VALUES (?,1,'validate','validate','ready','developer','verify','[]','verify','[]','[]','[]'," +
      "'[\"target\"]','[]','target passes',?,'{}',100,'candidate_ready','active')",
  ).run(workItemId, input.risk ?? "low");
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path," +
      "worktree_path,branch,base_sha,result_sha,started_at,finished_at) " +
      "VALUES ('run-1',?,1,'validate',1,'developer','thread','turn','succeeded','/repo','/worktree'," +
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
  return { database, workItemId };
}

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
