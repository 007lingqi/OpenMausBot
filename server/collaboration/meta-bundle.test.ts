import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { startCollaborationService } from "./service.ts";
import { syncWorkItemMetaBundle, type MetaBundleManifest } from "./meta-bundle.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "openmausbot-meta-bundle-"));
  scratch.push(root);
  const dataDirectory = join(root, "data");
  const artifactRoot = join(root, "artifacts");
  const service = startCollaborationService({ dataDirectory });
  const workItemId = service.ingestDingTalkMessage({
    sourceEventId: "source-meta-1",
    transportMessageId: "transport-meta-1",
    conversationId: "conversation-meta-1",
    addressedToBot: true,
    text: "修复发布筛选并补齐自动回归",
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
  database.prepare(
    "UPDATE collaboration_work_items SET current_plan_revision = 1, definition_status = 'ready_for_execution' WHERE id = ?",
  ).run(workItemId);
  database.prepare(
    "INSERT INTO collaboration_work_item_snapshots " +
      "(work_item_id,revision,source_work_item_version,goal,goal_confirmed,repository,facts_json," +
      "assumptions_json,acceptance_json,blocking_ambiguities_json,created_at) " +
      "VALUES (?,1,1,'发布页可以按优先级筛选',1,'/repo',?, ?, ?, ?,110)",
  ).run(
    workItemId,
    JSON.stringify([
      "现有状态筛选保持不变",
      "api_key=must-not-project-snapshot-secret",
      "clientSecret must-not-project-client-secret",
      "钉钉密钥 must-not-project-chinese-secret",
      "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtdXN0LW5vdC1wcm9qZWN0In0.must-not-project-signature",
      "https://example.invalid/callback?access_token=must-not-project-query-secret",
    ]),
    JSON.stringify(["筛选条件可以组合"]),
    JSON.stringify([{ description: "支持 P0、P1、P2 筛选", observation: "目标回归测试通过" }]),
    JSON.stringify([{ id: "empty-state", question: "无结果时显示什么？", dependsOn: [], recommendedAnswer: "沿用空状态" }]),
  );
  database.prepare(
    "INSERT INTO collaboration_plan_revisions " +
      "(id,work_item_id,revision,snapshot_revision,status,summary,proposal_hash,created_at) " +
      "VALUES ('plan-1',?,1,1,'published','实现筛选并验证组合条件','proposal-hash',120)",
  ).run(workItemId);
  for (const node of [
    { id: "modify", type: "modify", status: "ready", execution: "candidate_ready", runtime: "succeeded" },
    { id: "validate", type: "validate", status: "ready", execution: "candidate_ready", runtime: "succeeded" },
  ]) {
    database.prepare(
      "INSERT INTO collaboration_work_nodes " +
        "(work_item_id,plan_revision,node_id,node_type,status,assigned_agent_id,objective,input_evidence_json," +
        "instructions,read_scope_json,write_scope_json,deny_scope_json,commands_json,expected_artifacts_json," +
        "completion_definition,risk,budget_json,active,created_at,execution_status,control_state,runtime_state) " +
        "VALUES (?,1,?,?,?,'developer',?,'[]','internal instructions','[]','[]','[]',?, '[]',?,'low','{}',1,130,?,'active',?)",
    ).run(
      workItemId,
      node.id,
      node.type,
      node.status,
      node.type === "modify" ? "实现优先级筛选" : "运行目标回归",
      node.type === "validate" ? JSON.stringify(["target-filter"]) : "[]",
      node.type === "validate" ? "全部目标检查通过" : "筛选功能完成",
      node.execution,
      node.runtime,
    );
  }
  database.prepare(
    "INSERT INTO collaboration_runs " +
      "(id,work_item_id,plan_revision,node_id,attempt,agent_id,thread_id,turn_id,status,repository_path," +
      "worktree_path,branch,base_sha,result_sha,started_at,finished_at,error) " +
      "VALUES ('run-1',?,1,'validate',1,'developer','thread','turn','succeeded','/repo','/worktree'," +
      "'candidate',?,?,140,160,'must-not-project-error-secret')",
  ).run(workItemId, "1".repeat(40), "2".repeat(40));
  database.prepare(
    "INSERT INTO collaboration_candidates " +
      "(id,run_id,state,base_sha,result_sha,changed_paths_json,violations_json,quality_json,created_at) " +
      "VALUES ('candidate-1','run-1','target_tests_passed',?,?,?,'[]',?,160)",
  ).run(
    "1".repeat(40),
    "2".repeat(40),
    JSON.stringify(["app/release-board.tsx"]),
    JSON.stringify({ fullDiff: "must-not-project-full-diff" }),
  );
  database.prepare(
    "INSERT INTO collaboration_test_evidence " +
      "(id,run_id,command_id,argv_json,cwd,exit_code,duration_ms,stdout,stderr,state,created_at) " +
      "VALUES ('evidence-1','run-1','target-filter',?,'/worktree',0,25,?,?,'target_passed',160)",
  ).run(
    JSON.stringify(["test", "--token=must-not-project-token"]),
    "must-not-project-stdout",
    "must-not-project-stderr",
  );
  database.prepare(
    "INSERT INTO collaboration_audit_events " +
      "(id,run_id,action,outcome,resource_json,created_at,work_item_id,request_id,policy_rule) " +
      "VALUES ('audit-1','run-1','candidate.verify','allow',?,170,?,'request-1','verified_evidence')",
  ).run(JSON.stringify({ secret: "must-not-project-audit-secret", diff: "must-not-project-audit-diff" }), workItemId);
  return { artifactRoot, database, workItemId };
}

describe("per-Work-Item Meta state bundle", () => {
  it("projects a consistent, hash-verifiable bundle without execution output or credentials", () => {
    const { artifactRoot, database, workItemId } = createHarness();

    const result = syncWorkItemMetaBundle(database, { artifactRoot, workItemId });
    const expectedNames = ["DECISIONS.md", "PROGRESS.md", "SPEC.md", "VERIFY.md", "manifest.json"];
    expect(readdirSync(result.directory).sort()).toEqual(expectedNames);
    expect(readFileSync(result.currentPointer, "utf8")).toBe(`${result.revision}\n`);

    const manifest = JSON.parse(readFileSync(join(result.directory, "manifest.json"), "utf8")) as MetaBundleManifest;
    expect(manifest).toMatchObject({ schemaVersion: 1, workItemId, revision: result.revision });
    expect(Object.keys(manifest.files).sort()).toEqual(["DECISIONS.md", "PROGRESS.md", "SPEC.md", "VERIFY.md"]);
    for (const [name, metadata] of Object.entries(manifest.files)) {
      const content = readFileSync(join(result.directory, name), "utf8");
      expect(metadata).toEqual({ sha256: sha256(content), bytes: Buffer.byteLength(content) });
    }

    const projected = expectedNames.map((name) => readFileSync(join(result.directory, name), "utf8")).join("\n");
    expect(projected).toContain("发布页可以按优先级筛选");
    expect(projected).toContain("target-filter");
    expect(projected).toContain("candidate.verify");
    expect(projected).not.toContain("must-not-project");
    expect(projected).not.toContain("1111111111111111111111111111111111111111");
    expect(projected).not.toContain("2222222222222222222222222222222222222222");
    expect(readdirSync(join(artifactRoot, workItemId, "bundles")).some((name) => name.startsWith(".tmp-"))).toBe(false);
    database.close();
  });

  it("is idempotent for unchanged SQLite state and verifies existing hashes before reuse", () => {
    const { artifactRoot, database, workItemId } = createHarness();
    const first = syncWorkItemMetaBundle(database, { artifactRoot, workItemId });
    const manifestMtime = statSync(join(first.directory, "manifest.json")).mtimeMs;

    const second = syncWorkItemMetaBundle(database, { artifactRoot, workItemId });
    expect(second.revision).toBe(first.revision);
    expect(second.directory).toBe(first.directory);
    expect(statSync(join(second.directory, "manifest.json")).mtimeMs).toBe(manifestMtime);

    const specPath = join(first.directory, "SPEC.md");
    const originalSpec = readFileSync(specPath, "utf8");
    rmSync(specPath);
    expect(() => syncWorkItemMetaBundle(database, { artifactRoot, workItemId })).toThrow(/integrity/i);
    expect(existsSync(specPath)).toBe(false);
    expect(originalSpec).not.toBe("");
    database.close();
  });

  it("publishes a new immutable revision and advances CURRENT when ledger state changes", () => {
    const { artifactRoot, database, workItemId } = createHarness();
    const first = syncWorkItemMetaBundle(database, { artifactRoot, workItemId });
    database.prepare(
      "UPDATE collaboration_work_nodes SET runtime_state = 'failed', execution_status = 'failed', version = version + 1 " +
        "WHERE work_item_id = ? AND node_id = 'validate'",
    ).run(workItemId);

    const second = syncWorkItemMetaBundle(database, { artifactRoot, workItemId });
    expect(second.revision).not.toBe(first.revision);
    expect(existsSync(first.directory)).toBe(true);
    expect(readFileSync(second.currentPointer, "utf8")).toBe(`${second.revision}\n`);
    expect(readFileSync(join(second.directory, "PROGRESS.md"), "utf8")).toContain("failed");
    database.close();
  });

  it("rejects unknown Work Items and unsafe path segments", () => {
    const { artifactRoot, database } = createHarness();
    expect(() => syncWorkItemMetaBundle(database, { artifactRoot, workItemId: "WI-UNKNOWN" })).toThrow(/Unknown Work Item/);
    expect(() => syncWorkItemMetaBundle(database, { artifactRoot, workItemId: "../escape" })).toThrow(/invalid Work Item/i);
    database.close();
  });
});
