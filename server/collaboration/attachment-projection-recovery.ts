import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkInboundMessage, DingTalkProjectionRecoveryOutcome } from "../integrations/dingtalk/types.ts";
import { parseDingTalkProjectionRecoveryRequest } from "../integrations/dingtalk/text-actions.ts";
import { evaluateOwnerPolicy } from "./policy.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { appendControlAudit } from "./audit.ts";
import { enqueueInboundCard } from "./outbox.ts";

export function recoverAttachmentProjection(db: DatabaseSync, message: DingTalkInboundMessage, now: number, assertActive: () => void): DingTalkProjectionRecoveryOutcome {
  const request = parseDingTalkProjectionRecoveryRequest(message);
  if (!request) throw new Error("attachment_projection_recovery_request_invalid");
  const payloadHash = createHash("sha256").update(JSON.stringify({ conversationId: message.conversationId, reply: message.replyToSourceEventId ?? null,
    ordinal: request.ordinal ?? null, text: message.text.trim(), senderCorpId: message.sender.senderCorpId?.trim() ?? null,
    senderStaffId: message.sender.senderStaffId?.trim() ?? null, senderId: message.sender.senderId })).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive();
    assertLedgerArmed(db);
    if (db.prepare("SELECT 1 FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?").get(message.sourceEventId)) {
      throw new Error("natural_intake_recovery_event_conflict");
    }
    const previous = db.prepare("SELECT payload_hash,outcome_json FROM collaboration_attachment_recovery_requests WHERE source_event_id=?")
      .get(message.sourceEventId) as { payload_hash: string; outcome_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new Error("attachment_recovery_event_conflict");
      db.exec("COMMIT");
      return { ...JSON.parse(previous.outcome_json) as DingTalkProjectionRecoveryOutcome, duplicate: true };
    }
    if (db.prepare("SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=? UNION ALL SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=?")
      .get(message.sourceEventId, message.sourceEventId, message.sourceEventId)) throw new Error("attachment_recovery_event_conflict");
    const policy = evaluateOwnerPolicy(db, { sender: message.sender, capability: "work.retry", now });
    let outcome: DingTalkProjectionRecoveryOutcome = { conversationId: message.conversationId, allowed: false, duplicate: false, workItemId: null, reason: policy.reason };
    let summary = "只有当前负责人可以恢复附件整理，请由负责人确认后操作。";
    let version = 1;
    let boundary: number | null = null;
    if (policy.decision === "allow") {
      const candidates = db.prepare("SELECT a.id,w.id AS work_item_id,w.version," +
        "(SELECT max(sequence) FROM collaboration_attachment_projection_failures WHERE attachment_id=a.id) AS boundary " +
        "FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id JOIN collaboration_work_items w ON w.id=e.work_item_id " +
        "WHERE e.conversation_id=(SELECT conversation_id FROM collaboration_conversation_aliases WHERE source='dingtalk' AND external_id=?) AND (? IS NULL OR e.source_event_id=?) AND (? IS NULL OR a.ordinal=?) " +
        "AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') AND a.ingest_state='ready' AND a.evidence_projected_at IS NULL " +
        "AND (a.evidence_projection_expires_at IS NULL OR a.evidence_projection_expires_at<=?) " +
        "AND (SELECT count(*)=3 AND count(DISTINCT error_code)=1 FROM (SELECT f.error_code FROM collaboration_attachment_projection_failures f WHERE f.attachment_id=a.id " +
        "AND f.sequence>coalesce((SELECT max(boundary_sequence) FROM collaboration_attachment_projection_recoveries WHERE attachment_id=a.id),0) ORDER BY f.sequence DESC LIMIT 3))=1 LIMIT 2")
        .all(message.conversationId, message.replyToSourceEventId ?? null, message.replyToSourceEventId ?? null, request.ordinal ?? null, request.ordinal ? request.ordinal - 1 : null, now) as Array<{ id: string; work_item_id: string; version: number; boundary: number }>;
      if (candidates.length === 1) {
        const target = candidates[0]!;
        boundary = target.boundary;
        version = target.version;
        db.prepare("INSERT INTO collaboration_attachment_projection_recoveries(id,attachment_id,boundary_sequence,source_event_id,actor_principal_id,owner_generation,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), target.id, boundary, message.sourceEventId, policy.principalId, policy.ownerGeneration!, now);
        outcome = { conversationId: message.conversationId, allowed: true, duplicate: false, workItemId: target.work_item_id, reason: "attachment_projection_recovered" };
        summary = "已允许从保存的附件内容继续整理需求。历史记录会保留，需要确认的事项仍会单独追问；这不代表代码修改已完成。";
      } else {
        outcome.reason = candidates.length ? "attachment_projection_recovery_ambiguous" : "attachment_projection_not_recoverable";
        summary = candidates.length ? "有多份附件需要继续整理。请回复要处理的原附件消息，说“继续整理附件”；同一条消息有多份附件时，请说明第几份。"
          : "没有找到当前可恢复的附件整理。请确认正在回复原附件消息；已取消、已完成或仍在处理的事项不会被重新启动。";
      }
    }
    appendControlAudit(db, { actorPrincipalId: policy.principalId, ...(outcome.workItemId ? { workItemId: outcome.workItemId } : {}),
      requestId: message.sourceEventId, action: "attachment.projection.recover", outcome: outcome.allowed ? "allow" : "deny", policyRule: policy.ruleId,
      resource: { boundarySequence: boundary, ownerGeneration: policy.ownerGeneration }, now });
    enqueueInboundCard(db, { sourceEventId: message.sourceEventId, aggregateType: outcome.workItemId ? "work_item" : "association",
      aggregateId: outcome.workItemId ?? message.sourceEventId, aggregateVersion: version, now,
      card: { type: "clarification_card", headline: outcome.allowed ? "已恢复需求整理" : "需要澄清", workItemId: outcome.workItemId ?? "", snapshotRevision: 0, questions: [], contextSummary: summary } });
    db.prepare("INSERT INTO collaboration_attachment_recovery_requests(source_event_id,payload_hash,outcome_json,created_at) VALUES(?,?,?,?)")
      .run(message.sourceEventId, payloadHash, JSON.stringify(outcome), now);
    db.exec("COMMIT");
    return outcome;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
