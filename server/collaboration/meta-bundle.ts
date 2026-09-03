import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { redactSensitiveText } from "./sensitive-text.ts";

const BUNDLE_SCHEMA_VERSION = 1 as const;
const BUNDLE_FILES = ["SPEC.md", "PROGRESS.md", "DECISIONS.md", "VERIFY.md"] as const;

type BundleFileName = (typeof BUNDLE_FILES)[number];

interface WorkItemRow {
  id: string;
  title: string;
  status: string;
  version: number;
  definition_status: string;
  current_plan_revision: number | null;
  control_state: string;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  revision: number;
  source_work_item_version: number;
  goal: string | null;
  goal_confirmed: number;
  repository: string | null;
  facts_json: string;
  assumptions_json: string;
  acceptance_json: string;
  blocking_ambiguities_json: string;
  created_at: number;
}

interface PlanRow {
  revision: number;
  snapshot_revision: number;
  status: string;
  summary: string | null;
  created_at: number;
}

interface NodeRow {
  node_id: string;
  node_type: string;
  status: string;
  assigned_agent_id: string;
  objective: string;
  commands_json: string;
  completion_definition: string;
  risk: string;
  active: number;
  execution_status: string;
  control_state: string;
  runtime_state: string;
  version: number;
  created_at: number;
}

interface RunRow {
  id: string;
  node_id: string;
  attempt: number;
  agent_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  recovery_state: string;
  containment_state: string;
  version: number;
}

interface EvidenceRow {
  run_id: string;
  command_id: string;
  exit_code: number | null;
  duration_ms: number;
  state: string;
  created_at: number;
}

interface ReviewRow {
  candidate_run_id: string;
  stage: "verifier" | "meta";
  attempt: number;
  status: string;
  agent_id: string;
  snapshot_revision: number;
  created_at: number;
}

interface AuditRow {
  action: string;
  outcome: string;
  policy_rule: string | null;
  created_at: number;
}

interface AcceptanceCondition {
  description: string;
  observation: string;
}

interface BlockingAmbiguity {
  id: string;
  question: string;
  dependsOn: string[];
  recommendedAnswer: string;
}

interface ProjectionState {
  workItem: WorkItemRow;
  snapshot: {
    revision: number;
    sourceWorkItemVersion: number;
    goal: string | null;
    goalConfirmed: boolean;
    repository: string | null;
    facts: string[];
    assumptions: string[];
    acceptanceConditions: AcceptanceCondition[];
    blockingAmbiguities: BlockingAmbiguity[];
    createdAt: number;
  } | null;
  plan: PlanRow | null;
  nodes: Array<Omit<NodeRow, "commands_json"> & { commandIds: string[] }>;
  runs: RunRow[];
  evidence: EvidenceRow[];
  reviews: ReviewRow[];
  audit: AuditRow[];
}

export interface MetaBundleFileMetadata {
  sha256: string;
  bytes: number;
}

export interface MetaBundleManifest {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  workItemId: string;
  revision: string;
  stateHash: string;
  source: {
    workItemVersion: number;
    snapshotRevision: number | null;
    planRevision: number | null;
    projectedThrough: number;
  };
  files: Record<BundleFileName, MetaBundleFileMetadata>;
}

export interface MetaBundleSyncResult {
  revision: string;
  directory: string;
  currentPointer: string;
  manifest: MetaBundleManifest;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeText(value: string | null | undefined): string {
  if (!value) return "";
  return redactSensitiveText(value)
    .replace(/[\r\n]+/gu, " ")
    .trim();
}

function md(value: string | null | undefined, fallback = "未提供"): string {
  const safe = safeText(value);
  return safe ? safe.replace(/([\\`*_[\]<>])/gu, "\\$1") : fallback;
}

function iso(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

function list(values: readonly string[], fallback = "- 暂无"): string {
  if (!values.length) return fallback;
  return values.map((value) => `- ${md(value)}`).join("\n");
}

function readProjection(database: DatabaseSync, workItemId: string): ProjectionState {
  database.exec("BEGIN DEFERRED");
  try {
    const workItem = database
      .prepare(
        "SELECT id,title,status,version,definition_status,current_plan_revision,control_state,created_at,updated_at " +
          "FROM collaboration_work_items WHERE id = ?",
      )
      .get(workItemId) as WorkItemRow | undefined;
    if (!workItem) throw new Error(`Unknown Work Item: ${workItemId}`);

    const snapshotRow = database
      .prepare(
        "SELECT revision,source_work_item_version,goal,goal_confirmed,repository,facts_json,assumptions_json," +
          "acceptance_json,blocking_ambiguities_json,created_at FROM collaboration_work_item_snapshots " +
          "WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(workItemId) as SnapshotRow | undefined;
    const snapshot = snapshotRow
      ? {
          revision: snapshotRow.revision,
          sourceWorkItemVersion: snapshotRow.source_work_item_version,
          goal: snapshotRow.goal,
          goalConfirmed: snapshotRow.goal_confirmed === 1,
          repository: snapshotRow.repository,
          facts: parseStringArray(snapshotRow.facts_json),
          assumptions: parseStringArray(snapshotRow.assumptions_json),
          acceptanceConditions: parseArray<AcceptanceCondition>(snapshotRow.acceptance_json),
          blockingAmbiguities: parseArray<BlockingAmbiguity>(snapshotRow.blocking_ambiguities_json),
          createdAt: snapshotRow.created_at,
        }
      : null;
    const plan =
      workItem.current_plan_revision === null
        ? null
        : ((database
            .prepare(
              "SELECT revision,snapshot_revision,status,summary,created_at FROM collaboration_plan_revisions " +
                "WHERE work_item_id = ? AND revision = ?",
            )
            .get(workItemId, workItem.current_plan_revision) as PlanRow | undefined) ?? null);
    const nodeRows = (
      workItem.current_plan_revision === null
        ? []
        : database
            .prepare(
              "SELECT node_id,node_type,status,assigned_agent_id,objective,commands_json,completion_definition,risk," +
                "active,execution_status,control_state,runtime_state,version,created_at FROM collaboration_work_nodes " +
                "WHERE work_item_id = ? AND plan_revision = ? ORDER BY rowid",
            )
            .all(workItemId, workItem.current_plan_revision)
    ) as unknown as NodeRow[];
    const nodes = nodeRows.map(({ commands_json, ...node }) => ({ ...node, commandIds: parseStringArray(commands_json) }));
    const runs = (
      workItem.current_plan_revision === null
        ? []
        : database
            .prepare(
              "SELECT id,node_id,attempt,agent_id,status,started_at,finished_at,recovery_state,containment_state,version " +
                "FROM collaboration_runs WHERE work_item_id = ? AND plan_revision = ? ORDER BY started_at,id",
            )
            .all(workItemId, workItem.current_plan_revision)
    ) as unknown as RunRow[];
    const evidence = database
      .prepare(
        "SELECT e.run_id,e.command_id,e.exit_code,e.duration_ms,e.state,e.created_at " +
          "FROM collaboration_test_evidence e JOIN collaboration_runs r ON r.id = e.run_id " +
          "WHERE r.work_item_id = ?" +
          (workItem.current_plan_revision === null ? " AND 0" : " AND r.plan_revision = ?") +
          " ORDER BY e.created_at,e.command_id",
      )
      .all(...(workItem.current_plan_revision === null ? [workItemId] : [workItemId, workItem.current_plan_revision])) as unknown as EvidenceRow[];
    const reviews = database
      .prepare(
        "SELECT review.candidate_run_id,review.stage,review.attempt,review.status,review.agent_id," +
          "review.snapshot_revision,review.created_at FROM collaboration_candidate_reviews review " +
          "JOIN collaboration_runs r ON r.id = review.candidate_run_id WHERE r.work_item_id = ?" +
          (workItem.current_plan_revision === null ? " AND 0" : " AND r.plan_revision = ?") +
          " ORDER BY review.created_at,review.stage,review.attempt",
      )
      .all(...(workItem.current_plan_revision === null ? [workItemId] : [workItemId, workItem.current_plan_revision])) as unknown as ReviewRow[];
    const audit = database
      .prepare(
        "SELECT action,outcome,policy_rule,created_at FROM collaboration_audit_events " +
          "WHERE work_item_id = ? OR run_id IN (SELECT id FROM collaboration_runs WHERE work_item_id = ?) " +
          "ORDER BY created_at,id",
      )
      .all(workItemId, workItemId) as unknown as AuditRow[];
    database.exec("COMMIT");
    return { workItem, snapshot, plan, nodes, runs, evidence, reviews, audit };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function renderSpec(state: ProjectionState): string {
  const snapshot = state.snapshot;
  const acceptance = snapshot?.acceptanceConditions ?? [];
  const ambiguities = snapshot?.blockingAmbiguities ?? [];
  return [
    `# SPEC — ${md(state.workItem.id)}`,
    "",
    "## 目标",
    "",
    md(snapshot?.goal ?? state.workItem.title),
    "",
    `- 目标已确认：${snapshot?.goalConfirmed ? "是" : "否"}`,
    `- 当前定义状态：${md(state.workItem.definition_status)}`,
    `- 代码仓库：${md(snapshot?.repository)}`,
    "",
    "## 已确认事实",
    "",
    list(snapshot?.facts ?? []),
    "",
    "## 当前假设",
    "",
    list(snapshot?.assumptions ?? []),
    "",
    "## 验收标准",
    "",
    acceptance.length
      ? acceptance
          .map((item, index) => `${index + 1}. ${md(item.description)}\n   - 验证方式：${md(item.observation)}`)
          .join("\n")
      : "- 暂无",
    "",
    "## 待澄清问题",
    "",
    ambiguities.length
      ? ambiguities
          .map((item) => `- ${md(item.question)}\n  - 建议答案：${md(item.recommendedAnswer)}`)
          .join("\n")
      : "- 无阻塞问题",
    "",
  ].join("\n");
}

function renderProgress(state: ProjectionState): string {
  const nodeLines = state.nodes.length
    ? [
        "| 节点 | 类型 | 负责人 | 风险 | 执行状态 | 运行状态 | 控制状态 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...state.nodes.map(
          (node) =>
            `| ${md(node.node_id)} | ${md(node.node_type)} | ${md(node.assigned_agent_id)} | ${md(node.risk)} | ${md(node.execution_status)} | ${md(node.runtime_state)} | ${md(node.control_state)} |`,
        ),
      ].join("\n")
    : "- 尚未生成执行节点";
  const runLines = state.runs.length
    ? [
        "| 节点 | 尝试 | 执行者 | 状态 | 开始 | 结束 | 恢复状态 |",
        "| --- | ---: | --- | --- | --- | --- | --- |",
        ...state.runs.map(
          (run) =>
            `| ${md(run.node_id)} | ${run.attempt} | ${md(run.agent_id)} | ${md(run.status)} | ${iso(run.started_at)} | ${iso(run.finished_at)} | ${md(run.recovery_state)} |`,
        ),
      ].join("\n")
    : "- 尚无执行记录";
  return [
    `# PROGRESS — ${md(state.workItem.id)}`,
    "",
    `- 工作项状态：${md(state.workItem.status)}`,
    `- 控制状态：${md(state.workItem.control_state)}`,
    `- 工作项版本：${state.workItem.version}`,
    `- 当前计划版本：${state.workItem.current_plan_revision ?? "无"}`,
    `- 最近更新：${iso(state.workItem.updated_at)}`,
    "",
    "## 执行节点",
    "",
    nodeLines,
    "",
    "## 执行记录",
    "",
    runLines,
    "",
    "## 恢复入口",
    "",
    "从 SQLite 权威账本重新同步本目录，再从第一个未完成且未阻塞的节点继续。",
    "",
  ].join("\n");
}

function renderDecisions(state: ProjectionState): string {
  const events = state.audit.length
    ? state.audit
        .map(
          (event) =>
            `- ${iso(event.created_at)} · ${md(event.action)} · ${md(event.outcome)}${event.policy_rule ? ` · 规则：${md(event.policy_rule)}` : ""}`,
        )
        .join("\n")
    : "- 暂无审计决策";
  return [
    `# DECISIONS — ${md(state.workItem.id)}`,
    "",
    "## 当前计划决定",
    "",
    state.plan
      ? `- 计划版本：${state.plan.revision}\n- 状态：${md(state.plan.status)}\n- 摘要：${md(state.plan.summary)}`
      : "- 尚未形成执行计划",
    "",
    "## 假设",
    "",
    list(state.snapshot?.assumptions ?? []),
    "",
    "## 审计决策",
    "",
    events,
    "",
    "> 仅投影动作、结果和适用规则；敏感参数及执行输出保留在受控系统中。",
    "",
  ].join("\n");
}

function renderVerify(state: ProjectionState): string {
  const required = state.nodes.filter((node) => node.node_type === "validate").flatMap((node) => node.commandIds);
  const evidence = state.evidence.length
    ? [
        "| 验证项 | 状态 | 退出码 | 耗时（毫秒） | 记录时间 |",
        "| --- | --- | ---: | ---: | --- |",
        ...state.evidence.map(
          (item) =>
            `| ${md(item.command_id)} | ${md(item.state)} | ${item.exit_code ?? "-"} | ${item.duration_ms} | ${iso(item.created_at)} |`,
        ),
      ].join("\n")
    : "- 尚无验证证据";
  const observed = new Map(state.evidence.map((item) => [item.command_id, item.state]));
  const reviews = state.reviews.length
    ? [
        "| 阶段 | 尝试 | 复核者 | 状态 | 记录时间 |",
        "| --- | ---: | --- | --- | --- |",
        ...state.reviews.map(
          (review) =>
            `| ${review.stage === "verifier" ? "独立复核" : "最终验收"} | ${review.attempt} | ${md(review.agent_id)} | ${md(review.status)} | ${iso(review.created_at)} |`,
        ),
      ].join("\n")
    : "- 尚无独立复核记录";
  return [
    `# VERIFY — ${md(state.workItem.id)}`,
    "",
    "## 必需验证",
    "",
    required.length
      ? required.map((commandId) => `- ${md(commandId)}：${md(observed.get(commandId) ?? "尚未执行")}`).join("\n")
      : "- 当前计划未声明验证命令",
    "",
    "## 验证证据",
    "",
    evidence,
    "",
    "## 三级验证",
    "",
    reviews,
    "",
    "## 验收条件对应关系",
    "",
    state.snapshot?.acceptanceConditions.length
      ? state.snapshot.acceptanceConditions
          .map((item) => `- ${md(item.description)} → ${md(item.observation)}`)
          .join("\n")
      : "- 暂无验收条件",
    "",
    "> 本文件不包含命令参数、标准输出、错误输出或完整差异内容。",
    "",
  ].join("\n");
}

function projectedThrough(state: ProjectionState): number {
  return Math.max(
    state.workItem.updated_at,
    state.snapshot?.createdAt ?? 0,
    state.plan?.created_at ?? 0,
    ...state.nodes.map((node) => node.created_at),
    ...state.runs.map((run) => run.finished_at ?? run.started_at),
    ...state.evidence.map((item) => item.created_at),
    ...state.reviews.map((item) => item.created_at),
    ...state.audit.map((item) => item.created_at),
  );
}

function verifyExistingBundle(directory: string, expected: MetaBundleManifest): MetaBundleManifest {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as MetaBundleManifest;
    if (
      manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION ||
      manifest.workItemId !== expected.workItemId ||
      manifest.revision !== expected.revision ||
      manifest.stateHash !== expected.stateHash
    ) {
      throw new Error("manifest identity mismatch");
    }
    for (const name of BUNDLE_FILES) {
      const contents = readFileSync(join(directory, name));
      const metadata = manifest.files[name];
      if (!metadata || metadata.sha256 !== hash(contents) || metadata.bytes !== contents.byteLength) {
        throw new Error(`${name} hash mismatch`);
      }
      const expectedMetadata = expected.files[name];
      if (metadata.sha256 !== expectedMetadata.sha256 || metadata.bytes !== expectedMetadata.bytes) {
        throw new Error(`${name} does not match current ledger state`);
      }
    }
    return manifest;
  } catch (error) {
    throw new Error(`Meta bundle integrity check failed for ${expected.workItemId}/${expected.revision}`, {
      cause: error,
    });
  }
}

function updateCurrentPointer(workItemDirectory: string, revision: string): string {
  const current = join(workItemDirectory, "CURRENT");
  const value = `${revision}\n`;
  if (existsSync(current) && readFileSync(current, "utf8") === value) return current;
  const temporary = join(workItemDirectory, `.CURRENT.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, current);
  } finally {
    rmSync(temporary, { force: true });
  }
  return current;
}

export function syncWorkItemMetaBundle(
  database: DatabaseSync,
  input: { artifactRoot: string; workItemId: string },
): MetaBundleSyncResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.workItemId) || input.workItemId === "." || input.workItemId === "..") {
    throw new Error("Invalid Work Item ID for Meta bundle path");
  }
  const state = readProjection(database, input.workItemId);
  const serializedState = JSON.stringify(state);
  const stateHash = hash(serializedState);
  const revision = `b1-${stateHash.slice(0, 16)}`;
  const contents: Record<BundleFileName, string> = {
    "SPEC.md": renderSpec(state),
    "PROGRESS.md": renderProgress(state),
    "DECISIONS.md": renderDecisions(state),
    "VERIFY.md": renderVerify(state),
  };
  const files = Object.fromEntries(
    BUNDLE_FILES.map((name) => [
      name,
      { sha256: hash(contents[name]), bytes: Buffer.byteLength(contents[name], "utf8") },
    ]),
  ) as Record<BundleFileName, MetaBundleFileMetadata>;
  const manifest: MetaBundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    workItemId: state.workItem.id,
    revision,
    stateHash,
    source: {
      workItemVersion: state.workItem.version,
      snapshotRevision: state.snapshot?.revision ?? null,
      planRevision: state.plan?.revision ?? null,
      projectedThrough: projectedThrough(state),
    },
    files,
  };

  const root = resolve(input.artifactRoot);
  const workItemDirectory = join(root, input.workItemId);
  const bundlesDirectory = join(workItemDirectory, "bundles");
  const directory = join(bundlesDirectory, revision);
  mkdirSync(bundlesDirectory, { recursive: true, mode: 0o700 });
  if (existsSync(directory)) {
    const verified = verifyExistingBundle(directory, manifest);
    const currentPointer = updateCurrentPointer(workItemDirectory, revision);
    return { revision, directory, currentPointer, manifest: verified };
  }

  const temporary = join(bundlesDirectory, `.tmp-${revision}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const name of BUNDLE_FILES) {
      writeFileSync(join(temporary, name), contents[name], { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      renameSync(temporary, directory);
    } catch (error) {
      if (!existsSync(directory)) throw error;
      verifyExistingBundle(directory, manifest);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (!statSync(directory).isDirectory()) throw new Error(`Meta bundle path is not a directory: ${directory}`);
  const verified = verifyExistingBundle(directory, manifest);
  const currentPointer = updateCurrentPointer(workItemDirectory, revision);
  return { revision, directory, currentPointer, manifest: verified };
}
