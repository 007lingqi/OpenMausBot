import { DatabaseSync } from "node:sqlite";
import type { OutboxDeliveryPort } from "./outbox.ts";

const FIELD = "OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP";

/** A retried run's result belongs to the authenticated retry that started that
 * exact next attempt, not the old requirement's expired session. The receipt,
 * control event, prior failure and result are all durable coordinator records;
 * neither message text nor the latest unrelated command grants a destination. */
export function naturalRetryResultOrigin(databaseFile: string, message: Parameters<OutboxDeliveryPort["deliver"]>[0]): string | undefined {
  if (message.source !== "dingtalk" || message.aggregateType !== "plan") return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT DISTINCT c.source_event_id FROM collaboration_outbox o
      JOIN collaboration_runs r ON o.source_event_id='candidate:'||r.id AND o.aggregate_id=r.work_item_id AND o.aggregate_version=r.plan_revision
      JOIN collaboration_work_items w ON w.id=r.work_item_id
      JOIN collaboration_owner_text_commands c ON json_extract(c.outcome_json,'$.workItemId')=r.work_item_id
      JOIN collaboration_runs previous ON previous.id=json_extract(c.outcome_json,'$.retryRunId')
        AND previous.work_item_id=r.work_item_id AND previous.plan_revision=r.plan_revision AND previous.node_id=r.node_id
        AND previous.attempt+1=r.attempt
      JOIN collaboration_outbox failure ON failure.id=json_extract(c.outcome_json,'$.retryOutboxId')
        AND failure.source='dingtalk' AND failure.source_event_id='candidate:'||previous.id
        AND failure.aggregate_type='plan' AND failure.aggregate_id=r.work_item_id AND failure.aggregate_version=r.plan_revision
      JOIN collaboration_control_events control ON control.work_item_id=r.work_item_id AND control.action='retry'
        AND control.work_item_version=json_extract(c.outcome_json,'$.workItemVersion') AND control.created_at=c.processed_at
      JOIN collaboration_conversation_aliases a ON a.conversation_id=w.conversation_id AND a.source='dingtalk'
        AND a.external_id=json_extract(c.outcome_json,'$.conversationId')
      WHERE o.id=? AND o.dedupe_key=? AND o.aggregate_id=? AND o.aggregate_version=? AND o.payload_json=?
        AND o.source='dingtalk' AND o.aggregate_type='plan'
        AND json_extract(c.outcome_json,'$.kind')='natural_retry' AND json_extract(c.outcome_json,'$.action')='retry'
        AND json_extract(c.outcome_json,'$.allowed')=1 AND json_extract(c.outcome_json,'$.reason')='owner_action_applied'
        AND previous.status IN ('failed','needs_configuration','invalid','timed_out')
        AND previous.finished_at<=c.processed_at AND c.processed_at<=r.started_at AND r.started_at<=o.created_at
        AND failure.delivery_state='sent' AND failure.sent_at<=c.processed_at
      LIMIT 2`).all(message.id, message.dedupeKey, message.aggregateId, message.aggregateVersion, JSON.stringify(message.payload)) as Array<{ source_event_id: string }>;
    return rows.length === 1 ? rows[0].source_event_id : undefined;
  } finally { db.close(); }
}

/** Resolve only a persisted outbound binding, never strip a user-looking prefix
 * and hope it names a real event or borrow another task's latest destination. */
export function conversationReplyOrigin(databaseFile: string, message: Parameters<OutboxDeliveryPort["deliver"]>[0]): string | undefined {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT e.source_event_id FROM collaboration_outbox o " +
      "JOIN collaboration_external_events e ON e.id=o.aggregate_id " +
      "JOIN collaboration_conversation_intents j ON j.event_id=e.id " +
      "WHERE o.id=? AND o.dedupe_key=? AND o.aggregate_type='association' AND o.aggregate_id=? " +
      "AND e.source='dingtalk' AND o.source_event_id IN ('conversation:'||e.source_event_id,'conversation-failed:'||e.source_event_id)")
      .get(message.id, message.dedupeKey, message.aggregateId) as { source_event_id: string } | undefined;
    return row?.source_event_id;
  } finally { db.close(); }
}

/** Trusted deployment configuration, never inferred from message text or payloads. */
export function proactiveConversationRoutes(environment: NodeJS.ProcessEnv, allowed: ReadonlySet<string>): ReadonlyMap<string, string> {
  const routes = new Map<string, string>();
  const raw = environment[FIELD]?.trim();
  const legacy = environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID?.trim();
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${FIELD}_invalid`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${FIELD}_invalid`);
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 32) throw new Error(`${FIELD}_invalid`);
    for (const [source, target] of entries) {
      if (!allowed.has(source) || typeof target !== "string" || !target.trim() || target !== target.trim() ||
          target.length > 512 || /[\u0000-\u001f\u007f]/u.test(target) || [...routes.values()].includes(target)) {
        throw new Error(`${FIELD}_invalid`);
      }
      routes.set(source, target);
    }
    // Mixing two declarations must never silently choose a different destination.
    if (legacy && (allowed.size !== 1 || routes.get([...allowed][0]!) !== legacy)) throw new Error(`${FIELD}_conflict`);
  } else if (legacy && allowed.size === 1) {
    if (legacy.length > 512 || /[\u0000-\u001f\u007f]/u.test(legacy)) throw new Error("dingtalk_proactive_destination_invalid");
    routes.set([...allowed][0]!, legacy);
  }
  return routes;
}

/** A missing durable origin is not permission to send into the configured default group. */
export function proactiveDestination(databaseFile: string, sourceEventId: string | undefined, routes: ReadonlyMap<string, string>): string | undefined {
  if (!sourceEventId || routes.size === 0) return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const origins = db.prepare(
      "SELECT a.external_id AS conversation FROM collaboration_external_events e " +
      "JOIN collaboration_conversation_aliases a ON a.conversation_id=e.conversation_id AND a.source='dingtalk' " +
      "WHERE e.source='dingtalk' AND e.source_event_id=? UNION " +
      "SELECT json_extract(outcome_json,'$.conversationId') AS conversation FROM collaboration_owner_text_commands " +
      "WHERE source_event_id=? UNION " +
      "SELECT json_extract(outcome_json,'$.conversationId') AS conversation FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=? UNION " +
      "SELECT json_extract(outcome_json,'$.conversationId') AS conversation FROM collaboration_attachment_recovery_requests WHERE source_event_id=?",
    ).all(sourceEventId, sourceEventId, sourceEventId, sourceEventId) as Array<{ conversation: string | null }>;
    return origins.length === 1 && origins[0]!.conversation ? routes.get(origins[0]!.conversation) : undefined;
  } finally { db.close(); }
}

/** Even legacy control receipts must not fall back to a target item's latest group. */
export function hasOwnerTextCommandReceipt(databaseFile: string, sourceEventId: string | undefined): boolean {
  if (!sourceEventId) return false;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try { return !!db.prepare("SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=?").get(sourceEventId); }
  finally { db.close(); }
}
