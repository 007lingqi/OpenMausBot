import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { directControlText } from "../integrations/dingtalk/text-actions.ts";
import type { OwnerActionOutcome } from "./actions.ts";
import { naturalApprovalHash } from "./natural-approval.ts";
import { commandSummary } from "./owner-command-reply.ts";

export interface NaturalRetryOutcome extends OwnerActionOutcome {
  kind: "natural_retry";
  retryRunId?: string;
  retryOutboxId?: string;
}

/** A bounded direct retry request, not instructions found in quoted material.
 * A topic is required; "刚才的任务" alone is not a reliable target. */
export function naturalRetryTopic(message: DingTalkInboundMessage): string | null {
  const text = directControlText(message);
  if (text === null || message.replyToSourceEventId || /WI-|[`"“”「」<>?？，,；;：:]|如果|但是|之后|然后|不要|能否|是否/iu.test(text)) return null;
  const match = /^(?:请)?重试\s*(?:(?:刚才|之前)(?:的)?)?(.{2,80}?)[。！!]?$/u.exec(text);
  const topic = match?.[1].replace(/(?:的)?(?:任务|事项|问题)$/u, "").trim();
  return topic && topic.length >= 2 && !/^(?:这|那|这个|那个|刚才|之前|上一个|前一个)(?:的)?$/u.test(topic) ? topic : null;
}

export const naturalRetryHash = (message: DingTalkInboundMessage): string =>
  createHash("sha256").update(`natural_retry:${naturalApprovalHash(message)}`).digest("hex");

export interface RetryTarget { workItemId: string; runId: string; outboxId: string }
type RetryResolution = { target: RetryTarget; reason?: never } | { target: null;
  reason: "retry_topic_ambiguous" | "retry_target_unavailable" | "retry_attempt_limit" };

/** Call under the same Ledger write transaction as authorization and apply.
 * Titles identify topics, not authority. Match all same-group items before
 * eligibility filtering so a newer or successful namesake cannot be ignored. */
export function currentShownRetryTarget(db: DatabaseSync, conversationId: string, topic: string, receivedAt: number, recent = false, maxAttempts = 3): RetryResolution {
  const unavailable = { target: null, reason: "retry_target_unavailable" } as const;
  const ambiguous = { target: null, reason: "retry_topic_ambiguous" } as const;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) return unavailable;
  const matches = db.prepare("SELECT w.id,w.conversation_id FROM collaboration_work_items w JOIN collaboration_conversation_aliases a " +
    "ON a.conversation_id=w.conversation_id AND a.source='dingtalk' WHERE a.external_id=? AND instr(w.title,?)>0 LIMIT 21")
    .all(conversationId, topic) as Array<{ id: string; conversation_id: string }>;
  if (!matches.length) return unavailable;
  if (matches.length > 20) return ambiguous;
  let selected = matches.length === 1 ? matches[0].id : null;
  if (recent) {
    // "刚才" must point to real delivered task speech, not updated_at ordering,
    // a model's routing proposal or the only currently retryable namesake.
    const latest = db.prepare("SELECT o.aggregate_id,o.sent_at,o.source_event_id FROM collaboration_outbox o " +
      "JOIN collaboration_work_items w ON w.id=o.aggregate_id AND o.aggregate_type IN ('plan','work_item') " +
      "WHERE w.conversation_id=? AND o.delivery_state='sent' AND o.sent_at<=? AND o.superseded_at IS NULL " +
      "ORDER BY o.delivery_sequence DESC LIMIT 1").get(matches[0].conversation_id, receivedAt) as
      { aggregate_id: string; sent_at: number; source_event_id: string } | undefined;
    if (!latest || !latest.source_event_id.startsWith('candidate:') || !matches.some(item => item.id === latest.aggregate_id)) return ambiguous;
    if (db.prepare("SELECT 1 FROM collaboration_external_events WHERE conversation_id=? AND received_at>? AND received_at<=? " +
      "AND work_item_id IS NOT NULL AND work_item_id<>? LIMIT 1")
      .get(matches[0].conversation_id, latest.sent_at, receivedAt, latest.aggregate_id)) return ambiguous;
    selected = latest.aggregate_id;
  }
  if (!selected) return ambiguous;
  const row = db.prepare(`SELECT w.id AS workItemId,r.id AS runId,o.id AS outboxId,r.attempt FROM collaboration_work_items w
    JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision
    JOIN collaboration_work_item_snapshots s ON s.work_item_id=w.id AND s.revision=p.snapshot_revision
    JOIN collaboration_runs r ON r.work_item_id=w.id AND r.plan_revision=w.current_plan_revision
    JOIN collaboration_outbox o ON o.source='dingtalk' AND o.source_event_id='candidate:'||r.id
    WHERE w.id=? AND w.status NOT IN ('accepted','cancelled') AND w.control_state='active'
      AND w.definition_status='ready_for_execution' AND p.status='published'
      AND s.revision=(SELECT MAX(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id)
      AND w.version>=s.source_work_item_version AND w.version-s.source_work_item_version=(
        SELECT count(DISTINCT c.work_item_version) FROM collaboration_control_events c WHERE c.work_item_id=w.id
          AND c.work_item_version>s.source_work_item_version AND c.work_item_version<=w.version AND c.action IN ('pause','resume','retry'))
      AND r.attempt=(SELECT MAX(attempt) FROM collaboration_runs WHERE work_item_id=w.id AND plan_revision=w.current_plan_revision)
      AND r.status IN ('failed','needs_configuration','invalid','timed_out') AND r.finished_at IS NOT NULL
      AND o.aggregate_type='plan' AND o.aggregate_id=w.id AND o.aggregate_version=w.current_plan_revision
      AND json_extract(o.payload_json,'$.type')='plan_status_card'
      AND json_extract(o.payload_json,'$.status')='execution_failed'
      AND json_extract(o.payload_json,'$.workItemId')=w.id AND json_extract(o.payload_json,'$.planRevision')=w.current_plan_revision
      AND o.delivery_state='sent' AND o.sent_at IS NOT NULL AND o.sent_at<=? AND o.superseded_at IS NULL
      AND w.updated_at<=o.created_at AND r.finished_at<=o.created_at
      AND NOT EXISTS(SELECT 1 FROM collaboration_runs WHERE work_item_id=w.id AND status='running')
      AND NOT EXISTS(SELECT 1 FROM collaboration_execution_sessions e WHERE e.work_item_id=w.id
        AND NOT EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=e.id))
      AND NOT EXISTS(SELECT 1 FROM collaboration_verification_sessions e JOIN collaboration_runs vr ON vr.id=e.candidate_run_id WHERE vr.work_item_id=w.id
        AND NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=e.id))
      AND EXISTS(SELECT 1 FROM collaboration_work_nodes n WHERE n.work_item_id=w.id AND n.plan_revision=w.current_plan_revision
        AND n.node_type='modify' AND n.active=1 AND n.control_state='active' AND n.execution_status IN ('failed','invalid','needs_configuration'))`)
    .get(selected, receivedAt) as unknown as (RetryTarget & { attempt: number }) | undefined;
  if (!row) return unavailable;
  if (row.attempt >= Math.min(maxAttempts, 3)) return { target: null, reason: "retry_attempt_limit" };
  return { target: { workItemId: row.workItemId, runId: row.runId, outboxId: row.outboxId } };
}

export function naturalRetryReply(result: NaturalRetryOutcome, topic: string): string {
  if (result.allowed) return `已重新安排「${topic}」这项修改，仍按原来的要求执行。完成修改和测试后，我会告诉你结果。`;
  if (result.reason === "retry_topic_ambiguous") return `还没重试。你指的是「${topic}」的哪个页面或哪项功能？`;
  if (result.reason === "retry_attempt_limit") return "这项修改已达到本轮尝试上限，尚未重试。需要先处理失败原因，不能直接继续重复执行。";
  if (result.reason === "retry_target_unavailable") return `「${topic}」当前没有可直接重试的失败记录，我还没有执行。请先核对这项修改的当前进度。`;
  return `${commandSummary("retry", false, result.reason)}这次没有重试。`;
}
