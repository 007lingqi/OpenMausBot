import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NaturalIntakeInterpreter } from "./natural-intake.ts";
import { validateConversationDecision, type ConversationIntentDecision, type ConversationIntentRequest } from "./conversation-intent.ts";
import { conversationSourceHash, readConversationContext, conversationReply, type ConversationJob } from "./conversation-context.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { renderConversationReplyCard, renderPrimaryStatusCard } from "./message-renderer.ts";

type Classifier = NonNullable<NaturalIntakeInterpreter["classifyConversation"]>;
const actions = new Set(["create_work", "contribute", "read_status", "explain_reply", "offer_advice", "select_option", "acknowledge", "ask_context", "control_requires_authorization"]);

/** Neither a model result nor a plugin implementation is a ledger authority. */
function validateResult(request: ConversationIntentRequest, result: ConversationIntentDecision): ConversationIntentDecision {
  if (!result || !actions.has(result.action) || result.sourceEventId !== request.sourceEventId ||
    typeof result.quote !== "string" || !result.quote.trim() || !request.text.includes(result.quote)) throw new Error("conversation_result_invalid");
  if (["create_work", "acknowledge"].includes(result.action) && result.target) throw new Error("conversation_target_invalid");
  if (["contribute", "read_status"].includes(result.action) && !result.target) throw new Error("conversation_target_invalid");
  if (result.target) {
    const offered = request.candidates.find(item => item.id === result.target!.id);
    if (!offered || JSON.stringify(offered) !== JSON.stringify(result.target)) throw new Error("conversation_target_invalid");
    if (result.action === "contribute" && offered.state !== "open") throw new Error("conversation_target_closed");
  }
  if (result.action === "explain_reply" && (!result.reply || !request.history.some(item => item.role === "assistant" &&
    item.sourceEventId === result.reply!.sourceEventId && JSON.stringify(item) === JSON.stringify(result.reply)))) throw new Error("conversation_reply_invalid");
  if (request.referencedWorkItemId && ["create_work", "contribute", "read_status"].includes(result.action) &&
    result.target?.id !== request.referencedWorkItemId) throw new Error("conversation_reference_conflict");
  if (request.contextTruncated && ["create_work", "contribute", "read_status", "explain_reply"].includes(result.action)) throw new Error("conversation_context_incomplete");
  return validateConversationDecision(request, result);
}

export class ConversationIngressCoordinator {
  private stopped = false;
  private readonly controllers = new Set<AbortController>();
  private readonly db: DatabaseSync;
  private readonly classify: Classifier;
  private readonly project: (workItemId: string, sourceEventId: string, now: number) => void;
  constructor(db: DatabaseSync, classify: Classifier, project: (workItemId: string, sourceEventId: string, now: number) => void) {
    this.db = db; this.classify = classify; this.project = project;
  }
  close(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); }

  async processOne(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    assertLedgerArmed(this.db);
    this.db.prepare("UPDATE collaboration_conversation_intents SET status='failed',claim_token=NULL,lease_until=NULL " +
      "WHERE (status='running' AND lease_until<=? AND attempts>=3) OR (status='routed' AND projection_attempts>=3 AND (lease_until IS NULL OR lease_until<=?))").run(now, now);
    this.failureNotices(now);
    const job = this.db.prepare("SELECT e.*,j.* FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id " +
      "WHERE j.status='pending' OR (j.status='running' AND j.lease_until<=? AND j.attempts<3) " +
      "OR (j.status='routed' AND (j.lease_until IS NULL OR j.lease_until<=?)) ORDER BY e.received_at,e.rowid LIMIT 1").get(now, now) as ConversationJob | undefined;
    if (!job) return;
    if (job.status === "routed") { this.finishProjection(job, now); return; }
    const token = randomUUID();
    const claimed = this.db.prepare("UPDATE collaboration_conversation_intents SET status='running',attempts=attempts+1,claim_token=?,lease_until=? " +
      "WHERE event_id=? AND attempts<3 AND (status='pending' OR (status='running' AND lease_until<=?))").run(token, now + 120000, job.id, now);
    if (!claimed.changes) return;
    const controller = new AbortController(); this.controllers.add(controller);
    const started = Date.now(), timer = setTimeout(() => controller.abort(), 90000);
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error("conversation_cancelled"));
      controller.signal.addEventListener("abort", abort, { once: true }); });
    try {
      if (conversationSourceHash(job.normalized_json) !== job.source_hash) throw new Error("conversation_source_changed");
      const request = readConversationContext(this.db, job);
      const proposed = await Promise.race([cancelled, this.classify(request, controller.signal)]);
      if (this.stopped) return;
      const result = validateResult(request, proposed);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        assertLedgerArmed(this.db);
        const current = this.db.prepare("SELECT e.normalized_json FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id " +
          "WHERE j.event_id=? AND j.status='running' AND j.claim_token=? AND j.lease_until>? AND e.conversation_id=? AND e.principal_id=? " +
          "AND e.work_item_id IS NULL AND e.association_state='ambiguous'").get(job.id, token, now + Math.max(0, Date.now() - started), job.conversation_id, job.principal_id) as { normalized_json: string } | undefined;
        if (!current || conversationSourceHash(current.normalized_json) !== job.source_hash) throw new Error("conversation_claim_stale");
        if (result.action === "select_option") {
          const fresh = readConversationContext(this.db, job);
          validateResult(fresh, result);
          if (JSON.stringify(fresh.discussionOptions) !== JSON.stringify(request.discussionOptions)) throw new Error("conversation_selection_stale");
        }
        if (result.action === "offer_advice") {
          // The suggestion may have used earlier messages or delivered replies.
          // Recheck those exact sources under the same transaction as publication.
          const fresh = readConversationContext(this.db, job);
          validateResult(fresh, result);
          for (const source of result.advice.basisSourceEventIds) {
            if (source === request.sourceEventId) continue;
            if (JSON.stringify(request.history.find(entry => entry.sourceEventId === source)) !==
              JSON.stringify(fresh.history.find(entry => entry.sourceEventId === source))) throw new Error("conversation_advice_source_stale");
          }
        }
        if (result.target) {
          const candidate = this.db.prepare("SELECT version,status FROM collaboration_work_items WHERE id=? AND conversation_id=?")
            .get(result.target.id, job.conversation_id) as { version: number; status: string } | undefined;
          if (!candidate || candidate.version !== result.target.version || (readLatestWorkItemSnapshot(this.db, result.target.id)?.revision ?? 0) !== result.target.snapshotRevision) {
            throw new Error("conversation_target_stale");
          }
          if (result.action === "contribute" && ["accepted", "cancelled"].includes(candidate.status)) throw new Error("conversation_target_closed");
        }
        const modifies = result.action === "create_work" || result.action === "contribute";
        let targetId = result.target?.id ?? null;
        if (modifies) {
          if (!targetId) {
            targetId = `WI-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
            this.db.prepare("INSERT INTO collaboration_work_items (id,conversation_id,title,status,version,created_by,created_at,updated_at) VALUES (?,?,?,'collecting',1,?,?,?)")
              .run(targetId, job.conversation_id, request.text.replace(/\s+/gu, " ").slice(0, 120), job.principal_id, now, now);
          } else this.db.prepare("UPDATE collaboration_work_items SET version=version+1,updated_at=? WHERE id=?").run(now, targetId);
          this.db.prepare("UPDATE collaboration_external_events SET association_state=?,work_item_id=? WHERE id=?")
            .run(result.action === "create_work" ? "created" : "associated", targetId, job.id);
          this.db.prepare("INSERT INTO collaboration_work_item_events (id,work_item_id,external_event_id,event_type,payload_json,principal_id,created_at) VALUES (?,?,?,?,?,?,?)")
            .run(randomUUID(), targetId, job.id, result.action === "create_work" ? "problem.reported" : "contribution.added", JSON.stringify({ text: request.text }), job.principal_id, now);
        }
        // Read-only associations live here, never in the requirements event relation.
        this.db.prepare("UPDATE collaboration_conversation_intents SET status=?,target_work_item_id=?,proposal_json=?,claim_token=NULL,lease_until=NULL WHERE event_id=?")
          .run(modifies ? "routed" : "applied", targetId, JSON.stringify(result), job.id);
        this.supersedeProgress(job, now);
        enqueueInboundCard(this.db, { sourceEventId: `conversation:${job.source_event_id}`, aggregateType: "association", aggregateId: job.id,
          aggregateVersion: 1, now, card: modifies ? renderPrimaryStatusCard({ workItemId: targetId!, status: "collecting",
            version: (result.target?.version ?? 0) + 1, association: result.action === "create_work" ? "created" : "associated" }) : renderConversationReplyCard(conversationReply(this.db, result, request)) });
        this.db.exec("COMMIT");
        if (modifies) { job.target_work_item_id = targetId; job.status = "routed"; this.finishProjection(job, now); }
      } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    } catch {
      if (!this.stopped) {
        this.db.prepare("UPDATE collaboration_conversation_intents SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,claim_token=NULL,lease_until=NULL " +
          "WHERE event_id=? AND status='running' AND claim_token=?").run(job.id, token);
        this.failureNotices(now);
      }
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); this.controllers.delete(controller); }
  }

  private finishProjection(job: ConversationJob, now: number): void {
    const token = randomUUID();
    const claimed = this.db.prepare("UPDATE collaboration_conversation_intents SET projection_attempts=projection_attempts+1,claim_token=?,lease_until=? " +
      "WHERE event_id=? AND status='routed' AND projection_attempts<3 AND (lease_until IS NULL OR lease_until<=?)").run(token, now + 120000, job.id, now);
    if (!claimed.changes) return;
    try {
      this.project(job.target_work_item_id!, job.source_event_id, now);
      this.db.prepare("UPDATE collaboration_conversation_intents SET status='applied',claim_token=NULL,lease_until=NULL WHERE event_id=? AND status='routed' AND claim_token=?").run(job.id, token);
    } catch {
      this.db.prepare("UPDATE collaboration_conversation_intents SET status=CASE WHEN projection_attempts>=3 THEN 'failed' ELSE 'routed' END,claim_token=NULL,lease_until=NULL " +
        "WHERE event_id=? AND status='routed' AND claim_token=?").run(job.id, token);
      this.failureNotices(now);
    }
  }
  private supersedeProgress(job: ConversationJob, now: number): void {
    this.db.prepare("UPDATE collaboration_outbox SET delivery_state='superseded',superseded_at=? WHERE source_event_id=? " +
      "AND delivery_state='pending' AND attempt=0 AND sent_at IS NULL AND superseded_at IS NULL").run(now, job.source_event_id);
  }
  private failureNotices(now: number): void {
    this.db.exec("SAVEPOINT conversation_failure_notice");
    try {
      const jobs = this.db.prepare("SELECT e.*,j.* FROM collaboration_conversation_intents j JOIN collaboration_external_events e ON e.id=j.event_id WHERE j.status='failed' " +
        "AND NOT EXISTS(SELECT 1 FROM collaboration_outbox o WHERE o.source_event_id=" +
        "CASE WHEN j.proposal_json IS NULL THEN 'conversation:' ELSE 'conversation-failed:' END||e.source_event_id) LIMIT 20").all() as unknown as ConversationJob[];
      for (const job of jobs) {
        this.supersedeProgress(job, now);
        const prefix = job.proposal_json ? "conversation-failed:" : "conversation:";
        if (!this.db.prepare("SELECT 1 FROM collaboration_outbox WHERE source_event_id=?").get(prefix + job.source_event_id)) {
          enqueueInboundCard(this.db, { sourceEventId: prefix + job.source_event_id, aggregateType: "association", aggregateId: job.id, aggregateVersion: 1, now,
            card: renderConversationReplyCard("这条消息已保留，但还没能确认该如何继续处理，已停止自动重试。请负责人检查后再继续；目前不能确认修改完成。") });
        }
      }
      this.db.exec("RELEASE conversation_failure_notice");
    } catch (error) { this.db.exec("ROLLBACK TO conversation_failure_notice; RELEASE conversation_failure_notice"); throw error; }
  }
}
