import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DingTalkInboundMessage, DingTalkRequirementRecoveryOutcome } from "../integrations/dingtalk/types.ts";
import { parseDingTalkRequirementRecoveryRequest } from "../integrations/dingtalk/text-actions.ts";
import { evaluateOwnerPolicy } from "./policy.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { appendControlAudit } from "./audit.ts";
import { enqueueInboundCard } from "./outbox.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function recoverNaturalIntake(db: DatabaseSync, message: DingTalkInboundMessage, now: number, assertActive: () => void): DingTalkRequirementRecoveryOutcome {
  if (!parseDingTalkRequirementRecoveryRequest(message)) throw new Error("natural_intake_recovery_request_invalid");
  const payloadHash = digest(JSON.stringify({ conversationId: message.conversationId, reply: message.replyToSourceEventId ?? null,
    text: message.text.trim(), corp: message.sender.senderCorpId?.trim() ?? null, staff: message.sender.senderStaffId?.trim() ?? null, senderId: message.sender.senderId }));
  db.exec("BEGIN IMMEDIATE");
  try {
    assertActive(); assertLedgerArmed(db);
    const previous = db.prepare("SELECT payload_hash,outcome_json FROM collaboration_natural_intake_recovery_requests WHERE source_event_id=?")
      .get(message.sourceEventId) as { payload_hash: string; outcome_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new Error("natural_intake_recovery_event_conflict");
      db.exec("COMMIT"); return { ...JSON.parse(previous.outcome_json) as DingTalkRequirementRecoveryOutcome, duplicate: true };
    }
    if (db.prepare("SELECT 1 FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_owner_text_commands WHERE source_event_id=? UNION ALL SELECT 1 FROM collaboration_outbox WHERE source='dingtalk' AND source_event_id=? UNION ALL SELECT 1 FROM collaboration_attachment_recovery_requests WHERE source_event_id=?")
      .get(message.sourceEventId, message.sourceEventId, message.sourceEventId, message.sourceEventId)) throw new Error("natural_intake_recovery_event_conflict");
    const policy = evaluateOwnerPolicy(db, { sender: message.sender, capability: "work.retry", now });
    let outcome: DingTalkRequirementRecoveryOutcome = { allowed: false, duplicate: false, workItemId: null, reason: policy.reason, recoveredInputs: 0 };
    let summary = "只有当前负责人可以恢复需求整理，请由负责人确认后操作。";
    let version = 1;
    if (policy.decision === "allow") {
      const candidates = db.prepare("SELECT w.id,w.version FROM collaboration_work_items w " +
        "WHERE w.conversation_id=(SELECT conversation_id FROM collaboration_conversation_aliases WHERE source='dingtalk' AND external_id=?) " +
        "AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
        "AND (? IS NULL OR EXISTS(SELECT 1 FROM collaboration_external_events e WHERE e.source='dingtalk' AND e.source_event_id=? AND e.work_item_id=w.id AND e.conversation_id=w.conversation_id)) " +
        "AND EXISTS(SELECT 1 FROM collaboration_natural_intake_jobs j WHERE j.work_item_id=w.id AND j.status='failed' AND j.attempts=3 AND j.error_code='natural_intake_unavailable') " +
        "AND NOT EXISTS(SELECT 1 FROM collaboration_natural_intake_jobs j WHERE j.work_item_id=w.id AND j.status='running' AND j.lease_until>?) LIMIT 2")
        .all(message.conversationId, message.replyToSourceEventId ?? null, message.replyToSourceEventId ?? null, now) as Array<{ id: string; version: number }>;
      if (candidates.length === 1) {
        const target = candidates[0]; version = target.version;
        const failed = db.prepare("SELECT j.source_event_id,j.attempts,e.normalized_json,coalesce((SELECT max(generation) FROM collaboration_natural_intake_recoveries r WHERE r.input_source_event_id=j.source_event_id),0)+1 AS generation " +
          "FROM collaboration_natural_intake_jobs j JOIN collaboration_external_events e ON e.source='dingtalk' AND e.source_event_id=j.source_event_id AND e.work_item_id=j.work_item_id " +
          "WHERE j.work_item_id=? AND j.status='failed' AND j.attempts=3 AND j.error_code='natural_intake_unavailable' ORDER BY j.created_at,e.rowid")
          .all(target.id) as Array<{ source_event_id: string; attempts: number; normalized_json: string; generation: number }>;
        for (const job of failed) {
          db.prepare("INSERT INTO collaboration_natural_intake_recoveries(id,request_source_event_id,input_source_event_id,work_item_id,generation,prior_attempts,prior_error_code,input_hash,actor_principal_id,owner_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), message.sourceEventId, job.source_event_id, target.id, job.generation, job.attempts, "natural_intake_unavailable", digest(job.normalized_json), policy.principalId, policy.ownerGeneration!, now);
          const changed = db.prepare("UPDATE collaboration_natural_intake_jobs SET status='pending',attempts=0,error_code=NULL,claim_token=NULL,lease_until=NULL WHERE source_event_id=? AND status='failed' AND attempts=3")
            .run(job.source_event_id);
          if (changed.changes !== 1) throw new Error("natural_intake_recovery_claim_changed");
        }
        if (!failed.length) throw new Error("natural_intake_recovery_source_missing");
        outcome = { allowed: true, duplicate: false, workItemId: target.id, reason: "natural_intake_recovered", recoveredInputs: failed.length };
        summary = `已允许继续整理这个事项中尚未成功的 ${failed.length} 条补充。原消息和失败记录均保留；需要确认的内容仍会追问，这不代表代码修改已完成。`;
      } else {
        outcome.reason = candidates.length ? "natural_intake_recovery_ambiguous" : "natural_intake_not_recoverable";
        summary = candidates.length ? "有多个事项需要继续整理。请回复要处理的原需求或补充消息，说“继续整理需求”，我会只恢复那个事项。"
          : "没有找到当前可恢复的需求整理。请确认正在回复原需求消息；已暂停、取消、完成或仍在整理的事项不会重新启动。";
      }
    }
    appendControlAudit(db, { actorPrincipalId: policy.principalId, ...(outcome.workItemId ? { workItemId: outcome.workItemId } : {}), requestId: message.sourceEventId,
      action: "natural.intake.recover", outcome: outcome.allowed ? "allow" : "deny", policyRule: policy.ruleId, resource: { recoveredInputs: outcome.recoveredInputs, ownerGeneration: policy.ownerGeneration }, now });
    enqueueInboundCard(db, { sourceEventId: message.sourceEventId, aggregateType: outcome.workItemId ? "work_item" : "association", aggregateId: outcome.workItemId ?? message.sourceEventId,
      aggregateVersion: version, now, card: { type: "clarification_card", headline: outcome.allowed ? "已恢复需求整理" : "需要澄清", workItemId: outcome.workItemId ?? "", snapshotRevision: 0, questions: [], contextSummary: summary } });
    db.prepare("INSERT INTO collaboration_natural_intake_recovery_requests(source_event_id,payload_hash,outcome_json,created_at) VALUES(?,?,?,?)")
      .run(message.sourceEventId, payloadHash, JSON.stringify(outcome), now);
    db.exec("COMMIT"); return outcome;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function naturalIntakeFailureEventId(db: DatabaseSync, sourceEventId: string, snapshotRevision: number): string {
  const row = db.prepare("SELECT coalesce(max(generation),0) generation FROM collaboration_natural_intake_recoveries WHERE input_source_event_id=?")
    .get(sourceEventId) as { generation: number };
  return `natural-intake-failed:${sourceEventId}${row.generation ? `:recovery:${row.generation}` : ""}:snapshot:${snapshotRevision}`;
}

export function isCurrentNaturalIntakeFailureNotice(db: DatabaseSync, row: { source_event_id: string; aggregate_id: string; aggregate_version: number }): boolean {
  if (!row.source_event_id.startsWith("natural-intake-failed:")) return true;
  const jobs = db.prepare("SELECT j.source_event_id FROM collaboration_natural_intake_jobs j JOIN collaboration_work_items w ON w.id=j.work_item_id " +
    "WHERE j.work_item_id=? AND j.status='failed' AND w.control_state='active' AND w.status NOT IN ('accepted','cancelled') " +
    "AND ?=(SELECT max(revision) FROM collaboration_work_item_snapshots WHERE work_item_id=w.id)").all(row.aggregate_id, row.aggregate_version) as Array<{ source_event_id: string }>;
  return jobs.some(job => naturalIntakeFailureEventId(db, job.source_event_id, row.aggregate_version) === row.source_event_id);
}
