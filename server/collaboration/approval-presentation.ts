import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { candidateHasPassedMetaReview } from "./candidate-verification.ts";
import type { InboundCard, PlanStatusCard } from "./message-renderer.ts";

const PRESENTATION_TTL_MS = 15 * 60_000;

interface ApprovalBinding {
  work_item_id: string;
  work_item_version: number;
  conversation_id: string;
  plan_revision: number;
  snapshot_revision: number;
  run_id: string;
  candidate_sha: string;
  spec_hash: string;
  verifier_review_id: string;
  meta_review_id: string;
  owner_binding_id: string;
  owner_generation: number;
}

export interface ApprovalPresentation extends ApprovalBinding {
  outbox_id: string;
  payload_hash: string;
  created_at: number;
  expires_at: number;
  sent_at: number | null;
  source_event_id: string | null;
  delivery_sequence: number | null;
}

export interface ApprovalDeliveryProof { sourceEventId: string; payloadHash: string }

export function approvalPayloadHash(payload: InboundCard): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Only the unchanged Markdown path can attest this digest. Legacy interactive
 * cards materialize bearer actions after enqueue and are deliberately excluded. */
export function isApprovalPresentationCard(card: InboundCard): card is PlanStatusCard {
  return card.type === "plan_status_card" && card.status === "candidate_ready" &&
    card.approvalRequired === true && card.cardTemplateId === undefined && card.actions === undefined;
}

function currentBinding(db: DatabaseSync, card: InboundCard): ApprovalBinding | null {
  if (!isApprovalPresentationCard(card) || !card.workItemId || !card.candidateSha ||
      !Number.isSafeInteger(card.workItemVersion)) return null;
  const rows = db.prepare(`
    SELECT w.id AS work_item_id,w.version AS work_item_version,w.conversation_id,
      w.current_plan_revision AS plan_revision,p.snapshot_revision,r.id AS run_id,c.result_sha AS candidate_sha,
      v.spec_hash,v.id AS verifier_review_id,m.id AS meta_review_id,o.id AS owner_binding_id,o.generation AS owner_generation
    FROM collaboration_work_items w
    JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision
    JOIN collaboration_runs r ON r.work_item_id=w.id AND r.plan_revision=w.current_plan_revision
    JOIN collaboration_candidates c ON c.run_id=r.id
    JOIN collaboration_candidate_reviews v ON v.candidate_run_id=r.id AND v.stage='verifier'
      AND v.attempt=(SELECT MAX(attempt) FROM collaboration_candidate_reviews WHERE candidate_run_id=r.id AND stage='verifier')
    JOIN collaboration_candidate_reviews m ON m.candidate_run_id=r.id AND m.stage='meta'
      AND m.attempt=(SELECT MAX(attempt) FROM collaboration_candidate_reviews WHERE candidate_run_id=r.id AND stage='meta')
    JOIN collaboration_owner_bindings o ON o.active=1 AND o.source='dingtalk'
    WHERE w.id=? AND w.version=? AND w.definition_status='ready_for_execution'
      AND w.control_state='active' AND w.accepted_candidate_sha IS NULL
      AND r.status='succeeded' AND c.state='target_tests_passed' AND c.result_sha=?
      AND r.attempt=(SELECT MAX(attempt) FROM collaboration_runs WHERE work_item_id=w.id AND plan_revision=w.current_plan_revision)
  `).all(card.workItemId, card.workItemVersion!, card.candidateSha) as unknown as ApprovalBinding[];
  // Ambiguous current candidates never confer approval provenance.
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || (card.planRevision !== undefined && card.planRevision !== row.plan_revision) ||
      (card.snapshotRevision !== undefined && card.snapshotRevision !== row.snapshot_revision) ||
      !candidateHasPassedMetaReview(db, row.run_id, row.candidate_sha)) return null;
  return row;
}

function currentPresentation(db: DatabaseSync, outboxId: string, now: number): ApprovalPresentation | null {
  const row = db.prepare("SELECT * FROM collaboration_approval_presentations WHERE outbox_id=?")
    .get(outboxId) as unknown as ApprovalPresentation | undefined;
  if (!row || !Number.isSafeInteger(now) || now < row.created_at || now >= row.expires_at) return null;
  const outbox = db.prepare("SELECT payload_json,aggregate_id,superseded_at FROM collaboration_outbox WHERE id=?")
    .get(outboxId) as { payload_json: string; aggregate_id: string; superseded_at: number | null } | undefined;
  if (!outbox || outbox.superseded_at !== null || outbox.aggregate_id !== row.work_item_id) return null;
  let card: InboundCard;
  try { card = JSON.parse(outbox.payload_json) as InboundCard; } catch { return null; }
  if (!card || typeof card !== "object" || approvalPayloadHash(card) !== row.payload_hash) return null;
  const binding = currentBinding(db, card);
  if (!binding || (Object.keys(binding) as Array<keyof ApprovalBinding>).some(key => binding[key] !== row[key])) return null;
  return row;
}

/** Called within enqueue's savepoint. Staging is not approval and grants no control. */
export function stageApprovalPresentation(db: DatabaseSync, outboxId: string, now: number): void {
  const outbox = db.prepare("SELECT payload_json,aggregate_id,source,kind,delivery_state,attempt FROM collaboration_outbox WHERE id=?")
    .get(outboxId) as { payload_json: string; aggregate_id: string; source: string; kind: string; delivery_state: string; attempt: number } | undefined;
  if (!outbox || outbox.source !== "dingtalk" || outbox.kind !== "plan_status_card" ||
      outbox.delivery_state !== "pending" || outbox.attempt !== 0) return;
  const card = JSON.parse(outbox.payload_json) as InboundCard;
  const binding = currentBinding(db, card);
  if (!binding || binding.work_item_id !== outbox.aggregate_id) return;
  const keys = Object.keys(binding) as Array<keyof ApprovalBinding>;
  db.prepare(`INSERT INTO collaboration_approval_presentations
    (outbox_id,${keys.join(",")},payload_hash,created_at,expires_at)
    VALUES (?,${keys.map(() => "?").join(",")},?,?,?)`)
    .run(outboxId, ...keys.map(key => binding[key]), approvalPayloadHash(card), now, now + PRESENTATION_TTL_MS);
}

function sourceConversation(db: DatabaseSync, sourceEventId: string): string | null {
  const rows = db.prepare(`SELECT conversation_id FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=?
    UNION SELECT a.conversation_id FROM collaboration_owner_text_commands c
    JOIN collaboration_conversation_aliases a ON a.source='dingtalk' AND a.external_id=json_extract(c.outcome_json,'$.conversationId')
    WHERE c.source_event_id=?`).all(sourceEventId, sourceEventId) as Array<{ conversation_id: string }>;
  return rows.length === 1 ? rows[0]!.conversation_id : null;
}

/** Transport-owned proof from an actual accepted send, never from reconciliation
 * or model output. Called in the same transaction as the Outbox sent receipt. */
export function confirmApprovalPresentation(db: DatabaseSync, outboxId: string, proof: ApprovalDeliveryProof, now: number): void {
  const row = currentPresentation(db, outboxId, now);
  if (!row || row.sent_at !== null || proof.payloadHash !== row.payload_hash ||
      typeof proof.sourceEventId !== "string" || !proof.sourceEventId || proof.sourceEventId.length > 512 ||
      sourceConversation(db, proof.sourceEventId) !== row.conversation_id) return;
  const sent = db.prepare("SELECT sent_at,delivery_sequence FROM collaboration_outbox WHERE id=? AND delivery_state='sent' AND superseded_at IS NULL")
    .get(outboxId) as { sent_at: number | null; delivery_sequence: number | null } | undefined;
  if (!sent || sent.sent_at !== now || sent.delivery_sequence === null) return;
  db.prepare("UPDATE collaboration_approval_presentations SET sent_at=?,source_event_id=?,delivery_sequence=? WHERE outbox_id=? AND sent_at IS NULL")
    .run(now, proof.sourceEventId, sent.delivery_sequence, outboxId);
}

/** This is a fresh, read-only presentation proof, not an authorization decision.
 * A future control caller must revalidate inside the sole control transaction. */
export function readApprovalPresentation(db: DatabaseSync, outboxId: string, now: number): ApprovalPresentation | null {
  db.exec("SAVEPOINT read_approval_presentation");
  try {
    const row = currentPresentation(db, outboxId, now);
    if (!row || row.sent_at === null || row.sent_at > now || row.source_event_id === null ||
        sourceConversation(db, row.source_event_id) !== row.conversation_id) return null;
    const sent = db.prepare("SELECT 1 FROM collaboration_outbox WHERE id=? AND delivery_state='sent' AND sent_at=? AND delivery_sequence=? AND superseded_at IS NULL")
      .get(outboxId, row.sent_at, row.delivery_sequence);
    return sent ? row : null;
  } finally { db.exec("RELEASE read_approval_presentation"); }
}
