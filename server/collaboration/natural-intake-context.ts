import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkItemSnapshot } from "./snapshot.ts";
import type { NaturalIntakeEvent } from "./natural-intake.ts";
import { redactSensitiveText } from "./sensitive-text.ts";
import { turnSourceOrigin } from "./turn-sources.ts";

const MAX_EVENTS = 12;
const MAX_CHARACTERS = 24_000;
interface EventRow {
  source_event_id: string;
  principal_id: string;
  normalized_json: string;
  received_at: number;
  event_order: number;
  result_revision: number | null;
  proposal_json: string | null;
}
interface ContextEntry { row: EventRow; event: NaturalIntakeEvent; covered: boolean }

function evidence(row: EventRow) {
  return { sourceEventId: row.source_event_id, principalId: row.principal_id,
    normalizedHash: createHash("sha256").update(row.normalized_json).digest("hex") };
}

/** Only an applied, source-matching receipt is compactable; superseded does not mean read. */
function isCovered(row: EventRow, revision: number): boolean {
  if (!row.result_revision || row.result_revision > revision || !row.proposal_json) return false;
  try {
    const receipt = JSON.parse(row.proposal_json);
    const expected = evidence(row);
    return receipt.sourceEventId === row.source_event_id && receipt.eventEvidence?.sourceEventId === expected.sourceEventId &&
      receipt.eventEvidence?.principalId === expected.principalId && receipt.eventEvidence?.normalizedHash === expected.normalizedHash;
  } catch { return false; }
}

export function readNaturalIntakeContext(db: DatabaseSync, snapshot: WorkItemSnapshot, sourceEventId: string) {
  turnSourceOrigin(db, sourceEventId);
  const pinned = new Set([sourceEventId, ...snapshot.blockingAmbiguities.flatMap(q => q.respondent ? [q.respondent.sourceEventId] : [])]);
  const current = db.prepare("SELECT normalized_json FROM collaboration_external_events WHERE source='dingtalk' AND work_item_id=? AND source_event_id=?")
    .get(snapshot.workItemId, sourceEventId) as { normalized_json: string } | undefined;
  if (!current) throw new Error("natural_intake_event_missing");
  const reply: unknown = JSON.parse(current.normalized_json).replyToSourceEventId;
  if (typeof reply === "string") pinned.add(reply);
  const required: ContextEntry[] = [], unread: ContextEntry[] = [], recent: ContextEntry[] = [];
  let uncovered = 0;
  // Stream the ledger audit locally; model context stays bounded regardless of conversation length.
  const rows = db.prepare("SELECT e.source_event_id,e.principal_id,e.normalized_json,e.received_at,e.rowid AS event_order,j.result_revision,j.proposal_json " +
    "FROM collaboration_external_events e LEFT JOIN collaboration_natural_intake_jobs j ON j.source_event_id=e.source_event_id " +
    "AND j.work_item_id=e.work_item_id AND j.status='applied' " +
    "WHERE e.source='dingtalk' AND e.work_item_id=? ORDER BY e.received_at DESC,e.rowid DESC").iterate(snapshot.workItemId);
  for (const value of rows) {
    const row = value as unknown as EventRow;
    const covered = isCovered(row, snapshot.revision);
    if (!covered) uncovered++;
    const entry = { row, covered, event: { sourceEventId: row.source_event_id, principalId: row.principal_id,
      text: redactSensitiveText(String(JSON.parse(row.normalized_json).text)) } };
    if (pinned.has(row.source_event_id)) required.push(entry);
    else if (!covered && unread.length < MAX_EVENTS) unread.push(entry);
    else if (covered && recent.length < MAX_EVENTS) recent.push(entry);
  }
  required.sort((a, b) => Number(b.event.sourceEventId === sourceEventId) - Number(a.event.sourceEventId === sourceEventId));
  const selected: ContextEntry[] = [];
  let characters = 0, missingPinned = false;
  for (const entry of [...required, ...unread, ...recent]) {
    if (selected.length < MAX_EVENTS && characters + entry.event.text.length <= MAX_CHARACTERS) {
      selected.push(entry); characters += entry.event.text.length;
    } else if (pinned.has(entry.event.sourceEventId)) missingPinned = true;
  }
  const event = selected.find(entry => entry.event.sourceEventId === sourceEventId);
  if (!event) throw new Error("natural_intake_current_event_exceeds_context");
  selected.sort((a, b) => a.row.received_at - b.row.received_at || a.row.event_order - b.row.event_order);
  return { event: event.event, history: selected.map(entry => entry.event), eventEvidence: evidence(event.row),
    contextTruncated: missingPinned || selected.filter(entry => !entry.covered).length !== uncovered };
}
