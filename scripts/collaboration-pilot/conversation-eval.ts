import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { startCollaborationService } from "../../server/collaboration/service.ts";
import { ModelNaturalIntakeInterpreter, type NaturalIntakeModelPort } from "../../server/collaboration/natural-intake.ts";
import { ResponsesNaturalIntakeModel } from "../../server/collaboration/operations/natural-intake-model.ts";
import { policy, validProposal } from "../../server/collaboration/planner.test-fixtures.ts";
import { OutboxDispatcher } from "../../server/collaboration/outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "../../server/collaboration/leases.ts";
import { renderDingTalkSessionMessage } from "../../server/integrations/dingtalk/session-message.ts";
import { redactSensitiveText } from "../../server/collaboration/sensitive-text.ts";

export interface ConversationScenario {
  id: string;
  turns: Array<{ speaker: string; text: string; expect: {
    action: string | string[]; items: number; unchangedRequirements?: boolean; targetTurn?: number;
    pendingTasks?: number; maxReplyLength?: number;
  } }>;
}
interface TurnReport {
  scenario: string; turn: number; speaker: string; text: string; action: string | null; target: string | null;
  replies: string[]; checks: Record<string, boolean>; passed: boolean;
  snapshot: unknown; intentStatus: string | null; naturalStatus: string | null;
}
interface EvaluationReport {
  version: 2; status: "running" | "checks_passed" | "failed" | "stopped"; startedAt: string; finishedAt?: string;
  naturalnessReview: "pending"; sourceFingerprint: string; sourceUnchanged: boolean | null;
  scope: { realModel: boolean; realDingTalk: false; execution: false; isolatedLedger: true };
  model: string; reasoningEffort: string; modelCalls: number; stopReason?: string;
  turns: TurnReport[]; requests: Array<{ scenario: string; turn: number; phase: string; status: string; error?: string; request?: unknown; response?: unknown }>;
}

export const CONVERSATION_SCENARIOS: ConversationScenario[] = [
  { id: "clear-request-and-status", turns: [
    { speaker: "product", text: "登录失败后保留用户名、清空密码。账号不存在或密码错误，都提示“账号或密码不正确”；网络断开则提示“网络异常，请稍后重试”。", expect: { action: "create_work", items: 1 } },
    { speaker: "tester", text: "登录这个现在改好了吗？", expect: { action: "read_status", items: 1, unchangedRequirements: true, targetTurn: 0, maxReplyLength: 90 } },
    { speaker: "tester", text: "好的，谢谢。", expect: { action: "acknowledge", items: 1, unchangedRequirements: true } },
  ] },
  { id: "clarification-and-answer", turns: [
    { speaker: "product", text: "登录提示友好一点。", expect: { action: "create_work", items: 1 } },
    { speaker: "product", text: "只改账号不存在和密码错误的提示，统一为“账号或密码不正确”，不要区分这两种原因。网络异常的提示保持现在这样，其他功能不改。", expect: { action: "contribute", items: 1, targetTurn: 0 } },
  ] },
  { id: "interleaved-topics", turns: [
    { speaker: "product", text: "登录失败时保留用户名，密码必须清空。", expect: { action: "create_work", items: 1 } },
    { speaker: "tester", text: "另外一个独立问题：支付失败后，订单列表需要显示失败原因，不要再显示支付成功。", expect: { action: "create_work", items: 2 } },
    { speaker: "manager", text: "那个现在进展怎么样？", expect: { action: "ask_context", items: 2, unchangedRequirements: true } },
    { speaker: "manager", text: "我说的是登录那个。", expect: { action: "read_status", items: 2, unchangedRequirements: true, targetTurn: 0 } },
  ] },
  { id: "multiple-participants", turns: [
    { speaker: "product", text: "登录失败时保留用户名，密码必须清空。", expect: { action: "create_work", items: 1 } },
    { speaker: "tester", text: "测试补充：登录接口超时时也要保留用户名、清空密码；我会负责核对超时场景。", expect: { action: "contribute", items: 1, targetTurn: 0 } },
    { speaker: "developer", text: "登录那项现在到哪一步了？", expect: { action: "read_status", items: 1, unchangedRequirements: true, targetTurn: 0 } },
  ] },
  { id: "unapproved-control", turns: [
    { speaker: "tester", text: "我同意现在发布到生产。", expect: { action: "control_requires_authorization", items: 0, unchangedRequirements: true } },
  ] },
  { id: "unanswered-topics-and-short-answer", turns: [
    { speaker: "product", text: "登录提示友好一点。", expect: { action: "create_work", items: 1 } },
    { speaker: "product", text: "另外一个独立问题：支付失败后的提示也要改得容易理解。", expect: { action: "create_work", items: 2 } },
    { speaker: "product", text: "对，就这样。", expect: { action: "ask_context", items: 2, unchangedRequirements: true, pendingTasks: 2 } },
    { speaker: "product", text: "我说的是登录，账号或密码错误时统一显示“账号或密码不正确”。支付那个先不补充。", expect: { action: "contribute", items: 2, targetTurn: 0 } },
  ] },
];

interface DeliveredCard { type?: string; status?: string; snapshotRevision?: number; questions?: Array<{ id?: string }> }

export function stageReplyDelivered(status: string, snapshotRevision: number, replies: DeliveredCard[]): boolean {
  if (!["waiting_clarification", "planning", "planning_failed", "ready_for_execution"].includes(status)) return false;
  return replies.some(reply => reply.snapshotRevision === snapshotRevision && (status === "waiting_clarification"
    ? reply.type === "clarification_card" : reply.type === "plan_status_card" && reply.status === status));
}

export function selectConversationScenarios(args: string[]): ConversationScenario[] {
  if (args.length === 1 && args[0] === "--live") return CONVERSATION_SCENARIOS;
  if (args.length === 3 && args[0] === "--live" && args[1] === "--scenario") {
    const scenario = CONVERSATION_SCENARIOS.find(scenario => scenario.id === args[2]);
    if (scenario) return [scenario];
  }
  throw new Error("Explicit --live [--scenario <known-id>] required; authorized host channel and synthetic text only");
}

// Capture actual local inputs, not a Git HEAD that may predate the tested edits.
function sourceFingerprint(): string {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = ["server", "scripts/collaboration-pilot"].flatMap(directory => readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .filter(path => /\.(ts|mjs)$/u.test(path)).map(path => `${directory}/${path}`));
  files.push("package.json", "pnpm-lock.yaml");
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  return hash.digest("hex");
}

function requirements(db: DatabaseSync): string {
  const tables = ["work_items", "work_item_snapshots", "work_item_events", "natural_intake_jobs", "owner_bindings", "runs"];
  return createHash("sha256").update(JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM collaboration_${table} ORDER BY rowid`).all()))).digest("hex");
}

/** Always uses freshly created scratch ledgers. This program has neither a
 * DingTalk transport nor an executor, credentials, repository or Owner binding.
 * The static fixture planner only exercises plan presentation; it runs nothing. */
export async function runConversationEvaluation(options: { model: NaturalIntakeModelPort; scenarios?: ConversationScenario[];
  realModel?: boolean; onProgress?: (event: Record<string, unknown>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "omb-conversation-eval-"));
  const report: EvaluationReport = { version: 2, status: "running", startedAt: new Date().toISOString(),
    naturalnessReview: "pending", sourceFingerprint: sourceFingerprint(), sourceUnchanged: null,
    scope: { realModel: options.realModel === true, realDingTalk: false, execution: false, isolatedLedger: true },
    model: options.realModel ? "gpt-6-astra" : "explicit-test-double", reasoningEffort: "medium", modelCalls: 0, turns: [], requests: [] };
  const save = () => {
    writeFileSync(join(directory, "report.pending.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    renameSync(join(directory, "report.pending.json"), join(directory, "report.json"));
  };
  save(); options.onProgress?.({ event: "started", directory });
  let failures = 0;
  const scenarios = options.scenarios ?? CONVERSATION_SCENARIOS;
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    if (failures >= 3) break;
    const dataDirectory = join(directory, `scenario-${scenarioIndex}`); mkdirSync(dataDirectory, { mode: 0o700 });
    let turnIndex = 0;
    const naturalIntake = new ModelNaturalIntakeInterpreter({ async complete(input) {
      if (failures >= 3 || report.modelCalls >= 40) throw new Error("evaluation_model_budget_stopped");
      const request = JSON.parse(input.user);
      const record: EvaluationReport["requests"][number] = { scenario: scenario.id, turn: turnIndex,
        phase: request.candidates ? "intent" : "requirements", status: "running", request };
      report.requests.push(record); report.modelCalls++; save();
      options.onProgress?.({ event: "model_started", scenario: scenario.id, turn: turnIndex, phase: record.phase });
      try {
        const raw = await options.model.complete(input); record.status = "completed";
        record.response = JSON.parse(redactSensitiveText(JSON.stringify(raw))); failures = 0; save(); return raw;
      } catch (error) {
        failures++; record.status = "failed";
        const code = error instanceof Error ? error.message : "";
        record.error = /^natural_model_[a-z0-9_]+$/u.test(code) ? code : "model_call_failed";
        save(); throw new Error(record.error);
      }
    } });
    const service = startCollaborationService({ dataDirectory, planning: { planner: { propose: validProposal }, policy,
      naturalIntake, defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] } } });
    const db = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    const scenarioTurns: TurnReport[] = [];
    const leases = new InstanceLeaseCoordinator(db, "conversation-evaluation");
    const rendered: Array<DeliveredCard & { text: string }> = [];
    const dispatcher = new OutboxDispatcher(db, { async deliver(message) {
      const card = message.payload as DeliveredCard;
      rendered.push({ ...card, text: (renderDingTalkSessionMessage(message.payload).markdown as { text: string }).text });
      return { outcome: "sent" };
    } }, { maxAttempts: 1, claimTtlMs: 10000, baseBackoffMs: 100, maxBackoffMs: 100 });
    try {
      for (const turn of scenario.turns) {
        if (failures >= 3 || report.modelCalls >= 40) break;
        const sourceEventId = `${scenario.id}:${turnIndex}`;
        const message = { sourceEventId, transportMessageId: sourceEventId, conversationId: `synthetic-group-${scenarioIndex}`, addressedToBot: true,
          text: turn.text, receivedAt: Date.now(), sender: { senderId: turn.speaker, senderCorpId: "synthetic-corp", senderStaffId: turn.speaker, displayName: turn.speaker } };
        const before = requirements(db), firstReply = rendered.length;
        service.ingestDingTalkMessage(message);
        await service.processNaturalIntake(); // one attempt per input, never hide a retry
        const lease = leases.acquire(Date.now(), 120000)!;
        for (let i=0;i<20;i++) if (!await dispatcher.dispatchOne(lease, Date.now())) break;
        const intent = db.prepare("SELECT j.* FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id WHERE e.source_event_id=?")
          .get(sourceEventId) as { status: string; proposal_json: string | null; target_work_item_id: string | null };
        const proposal = intent.proposal_json ? JSON.parse(intent.proposal_json) as { action: string } : null;
        const natural = db.prepare("SELECT status FROM collaboration_natural_intake_jobs WHERE source_event_id=?").get(sourceEventId) as { status: string } | undefined;
        const changed = requirements(db), duplicate = service.ingestDingTalkMessage({ ...message, text: "重复投递不能改写原文" });
        const replies = rendered.slice(firstReply);
        const snapshot = intent.target_work_item_id ? db.prepare("SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id=? ORDER BY revision DESC LIMIT 1")
          .get(intent.target_work_item_id) : null;
        const checks: Record<string, boolean> = {
          action: [turn.expect.action].flat().includes(proposal?.action ?? ""),
          items: (db.prepare("SELECT count(*) n FROM collaboration_work_items").get() as { n: number }).n === turn.expect.items,
          replayIdempotent: duplicate.duplicate && requirements(db) === changed,
          replied: replies.length > 0,
          noFalseCompletion: replies.every(reply => !["completed", "owner_accepted"].includes(reply.status ?? "")),
          noExecution: (db.prepare("SELECT count(*) n FROM collaboration_runs").get() as { n: number }).n === 0,
          questionLimit: replies.every(reply => !reply.questions || reply.questions.length <= 3),
          noTechnicalFormat: replies.every(reply => !/任务编号|Work Item|execution_failed|provider_sandbox|Ledger|\/Users\/|\/tmp\//u.test(reply.text)),
          interpreted: !["create_work", "contribute"].includes(proposal?.action ?? "") || natural?.status === "applied",
          noRedundantGoalQuestion: replies.every(reply => !reply.questions?.some(q => q.id?.startsWith("natural-") &&
            !["natural-input-pending", "natural-context-incomplete"].includes(q.id)) ||
            !reply.questions.some(q => ["goal", "acceptance"].includes(q.id ?? ""))),
        };
        if (["create_work", "contribute"].includes(proposal?.action ?? "")) {
          const item = db.prepare("SELECT definition_status FROM collaboration_work_items WHERE id=?").get(intent.target_work_item_id);
          checks.stageReplyDelivered = stageReplyDelivered(String(item?.definition_status), Number(snapshot?.revision), replies);
        }
        if (turn.expect.unchangedRequirements) checks.unchangedRequirements = before === changed;
        if (turn.expect.targetTurn !== undefined) checks.target = intent.target_work_item_id === scenarioTurns[turn.expect.targetTurn]?.target;
        if (turn.expect.maxReplyLength !== undefined) checks.replyLength = replies.every(reply => reply.text.length <= turn.expect.maxReplyLength!);
        if (turn.expect.pendingTasks !== undefined) {
          const request = report.requests.find(request => request.scenario === scenario.id && request.turn === turnIndex && request.phase === "intent")?.request as
            { pendingQuestion?: { workItemIds: string[] } | null } | undefined;
          checks.pendingTasks = request?.pendingQuestion?.workItemIds.length === turn.expect.pendingTasks;
        }
        const result: TurnReport = { scenario: scenario.id, turn: turnIndex, speaker: turn.speaker, text: turn.text,
          action: proposal?.action ?? null, target: intent.target_work_item_id, replies: replies.map(reply => reply.text),
          checks, passed: Object.values(checks).every(Boolean), snapshot,
          intentStatus: intent.status, naturalStatus: natural?.status ?? null };
        scenarioTurns.push(result); report.turns.push(result); save();
        options.onProgress?.({ event: "turn_finished", scenario: scenario.id, turn: turnIndex, action: result.action,
          passed: result.passed, failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([check]) => check) });
        turnIndex++;
        if (intent.status !== "applied" || (natural && natural.status !== "applied")) break;
      }
    } finally { service.close(); db.close(); }
  }
  report.sourceUnchanged = report.sourceFingerprint === sourceFingerprint();
  report.status = failures >= 3 || report.modelCalls >= 40 ? "stopped"
    : report.sourceUnchanged && report.turns.length === scenarios.reduce((n, scenario) => n + scenario.turns.length, 0) && report.turns.every(turn => turn.passed) ? "checks_passed" : "failed";
  if (report.status === "stopped") report.stopReason = failures >= 3 ? "three_consecutive_model_failures" : "evaluation_call_limit";
  report.finishedAt = new Date().toISOString(); save();
  return { directory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenarios = selectConversationScenarios(process.argv.slice(2));
  const result = await runConversationEvaluation({ realModel: true, scenarios,
    model: new ResponsesNaturalIntakeModel({ endpoint: "http://127.0.0.1:18101/v1/responses", model: "gpt-6-astra", reasoningEffort: "medium", transport: "opencodex_local" }),
    onProgress: event => process.stdout.write(JSON.stringify(event) + "\n") });
  process.stdout.write(JSON.stringify({ event: "finished", directory: result.directory, status: result.report.status, modelCalls: result.report.modelCalls }) + "\n");
  process.exitCode = result.report.status === "checks_passed" ? 0 : 1;
}
