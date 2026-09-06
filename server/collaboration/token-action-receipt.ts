import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OwnerActionOutcome, PerformOwnerActionInput } from "./actions.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderCommandStatusCard, renderPlanStatusCard } from "./message-renderer.ts";

export interface TokenActionRequest {
  sourceEventId: string;
  origin: "text" | "card";
  /** Only supplied by a normalized message; never inferred from a candidate or card payload. */
  conversationId?: string;
}

export function prepareTokenActionReceipt(db: DatabaseSync, input: PerformOwnerActionInput): { hash: string; previous?: OwnerActionOutcome } | undefined {
  const request = input.request;
  if (!request) return undefined;
  if (!request.sourceEventId.trim() || request.sourceEventId.length > 256 || !["text", "card"].includes(request.origin) ||
      (request.conversationId !== undefined && (!request.conversationId.trim() || request.conversationId.length > 512 || /[\u0000-\u001f\u007f]/u.test(request.conversationId)))) throw new Error("token_action_request_invalid");
  const hash = createHash("sha256").update(JSON.stringify({ kind: "token_action", origin: request.origin, conversation: request.conversationId ?? null,
    tokenHash: createHash("sha256").update(input.actionToken.trim()).digest("hex"), reason: input.reason?.trim() ?? null,
    corp: input.sender.senderCorpId ?? null, staff: input.sender.senderStaffId ?? null, sender: input.sender.senderId })).digest("hex");
  const saved = db.prepare("SELECT payload_hash,outcome_json FROM collaboration_owner_text_commands WHERE source_event_id=?")
    .get(request.sourceEventId) as { payload_hash: string; outcome_json: string } | undefined;
  if (saved) {
    if (saved.payload_hash !== hash) throw new Error("token_action_event_conflict");
    return { hash, previous: { ...(JSON.parse(saved.outcome_json) as { outcome: OwnerActionOutcome }).outcome, duplicate: true } };
  }
  if (db.prepare("SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_attachment_recovery_requests WHERE source_event_id=? UNION ALL SELECT 1 FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?")
    .get(request.sourceEventId, request.sourceEventId, request.sourceEventId)) throw new Error("token_action_event_conflict");
  if (db.prepare("SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=?").get(request.sourceEventId)) {
    return { hash, previous: { allowed: false, duplicate: true, action: null, workItemId: null, workItemVersion: null, controlState: null,
      candidateSha: null, reason: "token_action_legacy_outcome_unavailable", revisedSnapshotRevision: null, interruptRequestedRunIds: [] } };
  }
  return { hash };
}

/** Called inside the same transaction that consumes the token and applies the control. */
export function persistTokenActionReceipt(db: DatabaseSync, request: TokenActionRequest, hash: string, outcome: OwnerActionOutcome, now: number): void {
  db.prepare("INSERT INTO collaboration_owner_text_commands(source_event_id,payload_hash,outcome_json,processed_at) VALUES(?,?,?,?)")
    .run(request.sourceEventId, hash, JSON.stringify({ kind: "token_action", conversationId: request.conversationId, outcome }), now);
  // Card callbacks lack a proven request-group identifier. Do not invent a group or a new message.
  if (request.origin !== "text") return;
  const status = !outcome.allowed ? "owner_action_denied" : outcome.action === "accept" ? "owner_accepted" : outcome.action === "reject" ? "owner_rejected" : "owner_action_denied";
  const card = outcome.allowed && outcome.action && outcome.action !== "accept" && outcome.action !== "reject"
    ? renderCommandStatusCard({ command: outcome.action, workItemId: outcome.workItemId ?? "unavailable",
        outcome: "allowed", summary: "负责人操作已生效；执行状态以最新进展为准。" })
    : renderPlanStatusCard({ workItemId: outcome.workItemId ?? "unavailable", status,
        ...(!outcome.allowed ? { summary: "该验收操作未通过身份、有效期或候选状态校验，请使用最新候选消息中的指令。" } : {}) });
  enqueueInboundCard(db, { sourceEventId: request.sourceEventId, aggregateType: outcome.workItemId ? "plan" : "association",
    aggregateId: outcome.workItemId ?? request.sourceEventId, aggregateVersion: outcome.workItemVersion ?? 1, card, now });
}
