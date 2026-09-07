import { DatabaseSync } from "node:sqlite";
import type { OutboxDeliveryPort } from "./outbox.ts";

const FIELD = "OMB_DINGTALK_PROACTIVE_CONVERSATION_MAP";

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
