import type { DatabaseSync } from "node:sqlite";
import type { ClarificationQuestion } from "./readiness.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

export interface ClarificationRecipient { targetId: string; displayName: string }

/** Recipient hints never alter a principal, role binding, capability or Owner record. */
export function clarificationRecipient(db: DatabaseSync, workItemId: string, question: ClarificationQuestion): ClarificationRecipient | undefined {
  let principalId: string;
  if (question.role === "requester") {
    const item = db.prepare("SELECT created_by FROM collaboration_work_items WHERE id=?").get(workItemId) as { created_by: string } | undefined;
    if (!item) return;
    principalId = item.created_by;
  } else {
    const reference = question.respondent;
    if (!reference) return;
    const event = db.prepare("SELECT normalized_json FROM collaboration_external_events WHERE work_item_id=? AND source_event_id=? AND principal_id=?")
      .get(workItemId, reference.sourceEventId, reference.principalId) as { normalized_json: string } | undefined;
    if (!event) return;
    const source = JSON.parse(event.normalized_json) as { text?: unknown };
    if (typeof source.text !== "string" || !reference.quote.trim() || !redactSensitiveText(source.text).includes(reference.quote)) return;
    principalId = reference.principalId;
  }
  // Only a staff alias actually observed for a participant in this group may become an @ target.
  // Sender IDs, guessed names and arbitrary mentions are not staff identity evidence.
  const rows = db.prepare("SELECT DISTINCT a.scope_id,a.external_id,p.display_name FROM collaboration_principals p " +
    "JOIN collaboration_principal_aliases a ON a.principal_id=p.id " +
    "WHERE p.id=? AND p.resolution='resolved' AND a.source='dingtalk' AND a.alias_kind='corp_staff' " +
    "AND EXISTS (SELECT 1 FROM collaboration_external_events e WHERE e.principal_id=p.id AND e.work_item_id=?) LIMIT 2")
    .all(principalId, workItemId) as unknown as Array<{ external_id: string; display_name: string }>;
  if (rows.length !== 1) return;
  const row = rows[0];
  if (!row.external_id || row.external_id.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(row.external_id)) return;
  return { targetId: row.external_id, displayName: redactSensitiveText(row.display_name).slice(0, 128) };
}
