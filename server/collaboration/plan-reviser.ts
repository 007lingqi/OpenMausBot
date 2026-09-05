import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateSequentialPlan, type PlanningPolicy, type ValidatedSequentialPlan } from "./graph.ts";
import { renderClarificationCard, renderPlanStatusCard, type InboundCard } from "./message-renderer.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { parsePlannerProposal, PlanValidationError, type PlannerPort, type WorkNodeType } from "./planner.ts";
import { evaluateDefinitionReadiness, type ClarificationQuestion } from "./readiness.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import { buildDefinitionPatchFromText } from "./spec-builder.ts";
import { redactSensitiveText } from "./sensitive-text.ts";
import { NaturalIntakeCoordinator, type NaturalIntakeInterpreter, type NaturalProjection } from "./natural-intake.ts";
import { NaturalAssociationCoordinator } from "./natural-association.ts";
import { clarificationRecipient } from "./clarification-recipients.ts";
import { attachmentCompletenessGates, attachmentExcerpts, readNaturalAttachmentContext } from "./attachment-completeness.ts";
import { readAttachmentEvidenceNotification } from "./attachment-ingestion.ts";
import {
  appendWorkItemSnapshot,
  readLatestWorkItemSnapshot,
  readWorkItemSnapshotRevision,
  type WorkItemSnapshot,
  type WorkItemSnapshotPatch,
} from "./snapshot.ts";

export type PriorNodeClassification = "valid" | "revalidate" | "obsolete";

export interface DefinitionRevisionOutcome {
  workItemId: string;
  snapshotRevision: number;
  definitionStatus: "waiting_clarification" | "ready_for_execution" | "planning_failed";
  clarificationQuestions: ClarificationQuestion[];
  planRevision: number | null;
  card: InboundCard;
  failures?: string[];
}

export interface AcceptedAttachmentEvidence {
  attachmentId: string;
  sourceEventId: string;
  contentHash: string;
  displayName: string;
  format: string;
  chunks: Array<{
    ordinal: number;
    lineStart: number;
    lineEnd: number;
    text: string;
    textHash: string;
    untrusted: true;
  }>;
  truncated: boolean;
  warnings: string[];
}

interface DefinitionProjectionInput {
  attachmentId?: string;
  contentHash?: string;
  contextSummary?: string;
  enqueueNaturalEvent?: string;
  natural?: NaturalProjection;
}

export interface PlanningCoordinatorOptions {
  planner: PlannerPort;
  policy: PlanningPolicy;
  naturalIntake?: NaturalIntakeInterpreter;
  defaultDefinition?: {
    repository: string;
    acceptanceConditions: WorkItemSnapshot["acceptanceConditions"];
  };
}

function equal(value: unknown, other: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(other);
}

export function classifyPreviousPlanNodes(
  previous: WorkItemSnapshot,
  current: WorkItemSnapshot,
): Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }> {
  if (previous.goal !== current.goal || previous.repository !== current.repository) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "obsolete", reason: "goal or repository changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  if (!equal(previous.facts, current.facts) || !equal(previous.assumptions, current.assumptions)) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "revalidate", reason: "facts or assumptions changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  if (!equal(previous.acceptanceConditions, current.acceptanceConditions)) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "revalidate", reason: "acceptance conditions changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  return {
    analyze: { classification: "valid", reason: "definition unchanged" },
    modify: { classification: "valid", reason: "definition unchanged" },
    validate: { classification: "valid", reason: "definition unchanged" },
    report: { classification: "valid", reason: "definition unchanged" },
  };
}

function unknownHash(value: unknown): string {
  let representation: string;
  try {
    representation = JSON.stringify(value) ?? String(value);
  } catch {
    representation = Object.prototype.toString.call(value);
  }
  return createHash("sha256").update(representation).digest("hex");
}

function plannerFailures(error: unknown): string[] {
  if (error instanceof PlanValidationError) return error.issues;
  const message = error instanceof Error ? error.message : String(error);
  return [`planner failed: ${message.slice(0, 500)}`];
}

export class PlanningCoordinator {
  private readonly database: DatabaseSync;
  private readonly options: PlanningCoordinatorOptions;
  private closed = false;
  private readonly naturalIntake: NaturalIntakeCoordinator | null;
  private readonly naturalAssociation: NaturalAssociationCoordinator | null;

  constructor(databaseFile: string, options: PlanningCoordinatorOptions) {
    this.options = options;
    this.database = new DatabaseSync(databaseFile);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 3) throw new Error("Collaboration planning schema is not installed");
    this.naturalIntake = options.naturalIntake ? new NaturalIntakeCoordinator(this.database, options.naturalIntake,
      options.policy.allowedRepositories, (workItemId, patch, now, natural) =>
        this.reviseDefinition(workItemId, patch, now, { natural }) !== null) : null;
    this.naturalAssociation = options.naturalIntake?.associate ? new NaturalAssociationCoordinator(this.database,
      options.naturalIntake.associate.bind(options.naturalIntake), (workItemId, sourceEventId, now) => {
        this.observeAcceptedEvent(workItemId, "", now, sourceEventId);
      }) : null;
  }

  reviseDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now?: number,
  ): DefinitionRevisionOutcome;
  reviseDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now: number,
    projection: DefinitionProjectionInput,
  ): DefinitionRevisionOutcome | null;
  reviseDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now = Date.now(),
    projection?: DefinitionProjectionInput,
  ): DefinitionRevisionOutcome | null {
    if (this.closed) throw new Error("Planning coordinator is closed");
    this.database.exec("BEGIN IMMEDIATE");
    let snapshots: { previous: WorkItemSnapshot | null; current: WorkItemSnapshot };
    try {
      assertLedgerArmed(this.database);
      if (projection?.enqueueNaturalEvent && this.database.prepare(
        "SELECT 1 FROM collaboration_natural_intake_jobs WHERE source_event_id=?",
      ).get(projection.enqueueNaturalEvent)) {
        this.database.exec("COMMIT");
        return null;
      }
      if (projection?.natural) {
        const natural = projection.natural;
        const current = readLatestWorkItemSnapshot(this.database, workItemId);
        const claim = this.database.prepare("SELECT 1 FROM collaboration_natural_intake_jobs j " +
          "JOIN collaboration_work_items w ON w.id=j.work_item_id WHERE j.source_event_id=? AND j.work_item_id=? " +
          "AND j.claim_token=? AND j.status='running' AND j.lease_until > ? AND w.status NOT IN ('cancelled','accepted') AND w.version=?")
          .get(natural.sourceEventId, workItemId, natural.claimToken, now, current?.sourceWorkItemVersion ?? -1);
        if (!claim || current?.revision !== natural.expectedRevision ||
          readNaturalAttachmentContext(this.database, workItemId).fingerprint !== natural.attachmentContextHash) {
          this.database.exec("COMMIT");
          return null;
        }
      }
      if (projection?.attachmentId && this.database.prepare(
        "SELECT 1 FROM collaboration_attachment_spec_projections WHERE attachment_id = ? AND content_hash = ?",
        ).get(projection.attachmentId, projection.contentHash!)) {
        this.database.exec("COMMIT");
        return null;
      }
      if (projection?.natural && this.database.prepare("SELECT 1 FROM collaboration_natural_intake_jobs WHERE work_item_id=? AND source_event_id<>? AND status IN ('pending','running','failed')")
        .get(workItemId, projection.natural.sourceEventId)) {
        const ambiguities = patch.blockingAmbiguities ?? readLatestWorkItemSnapshot(this.database, workItemId)?.blockingAmbiguities ?? [];
        patch = { ...patch, blockingAmbiguities: [...ambiguities.filter(q => typeof q === "string" || q.id !== "natural-input-pending"), {
          id: "natural-input-pending", question: "还有前面的补充需要整理，我会一起核对后再开始修改。", dependsOn: [],
          recommendedAnswer: "不需要重复发送；整理遇到问题时会说明。",
        }] };
      }
      snapshots = appendWorkItemSnapshot(this.database, workItemId, patch, now);
      if (projection?.enqueueNaturalEvent) {
        this.database.prepare("INSERT INTO collaboration_natural_intake_jobs (source_event_id,work_item_id,status,base_revision,created_at) " +
          "VALUES (?,?,'pending',?,?)").run(projection.enqueueNaturalEvent, workItemId, snapshots.current.revision, now);
      }
      if (projection?.natural) {
        this.database.prepare("UPDATE collaboration_natural_intake_jobs SET status='applied', result_revision=?, proposal_json=?, claim_token=NULL, lease_until=NULL " +
          "WHERE source_event_id=? AND claim_token=?").run(snapshots.current.revision,
          projection.natural.proposalJson, projection.natural.sourceEventId, projection.natural.claimToken);
      }
      if (projection?.attachmentId) {
        this.database.prepare(
          "INSERT INTO collaboration_attachment_spec_projections " +
            "(attachment_id, content_hash, work_item_id, snapshot_revision, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          projection.attachmentId,
          projection.contentHash!,
          workItemId,
          snapshots.current.revision,
          now,
        );
      }
      const readiness = evaluateDefinitionReadiness(snapshots.current, this.options.policy.allowedRepositories);
      if (!readiness.ready) {
        this.database
          .prepare("UPDATE collaboration_work_items SET definition_status = 'waiting_clarification', updated_at = ? WHERE id = ?")
          .run(now, workItemId);
        this.database
          .prepare(
            "INSERT INTO collaboration_clarification_rounds " +
              "(id, work_item_id, snapshot_revision, questions_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(randomUUID(), workItemId, snapshots.current.revision, JSON.stringify(readiness.frontier), now);
        const questions = readiness.frontier.map(question => {
          const { id, title, recommendedAnswer } = question;
          const recipient = clarificationRecipient(this.database, workItemId, question);
          return { id, title, question: question.question, recommendedAnswer,
            ...(recipient ? { requestedResponder: recipient } : {}) };
        });
        const responders = [...new Map(questions.flatMap(question => question.requestedResponder
          ? [[question.requestedResponder.targetId, question.requestedResponder] as const] : [])).values()];
        const card = renderClarificationCard({
          workItemId,
          snapshotRevision: snapshots.current.revision,
          questions,
          ...(responders.length ? { requestedResponders: responders } : {}),
          ...(projection?.contextSummary ? { contextSummary: projection.contextSummary } : {}),
        });
        enqueueInboundCard(this.database, {
          sourceEventId: `definition:${workItemId}:snapshot:${snapshots.current.revision}`,
          aggregateType: "plan",
          aggregateId: workItemId,
          aggregateVersion: snapshots.current.revision,
          card,
          supersessionKey: `work-item:${workItemId}:planning-status`,
          now,
        });
        this.database.exec("COMMIT");
        return {
          workItemId,
          snapshotRevision: snapshots.current.revision,
          definitionStatus: "waiting_clarification",
          clarificationQuestions: readiness.frontier,
          planRevision: null,
          card,
        };
      }
      this.database
        .prepare("UPDATE collaboration_work_items SET definition_status = 'planning', updated_at = ? WHERE id = ?")
        .run(now, workItemId);
      this.database
        .prepare(
          "INSERT INTO collaboration_planning_attempts " +
            "(id, work_item_id, snapshot_revision, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(randomUUID(), workItemId, snapshots.current.revision, now);
      const planningCard = renderPlanStatusCard({
        workItemId,
        snapshotRevision: snapshots.current.revision,
        status: "planning",
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `planning:${workItemId}:snapshot:${snapshots.current.revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: snapshots.current.revision,
        card: planningCard,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    let rawProposal: unknown;
    let plan: ValidatedSequentialPlan;
    try {
      rawProposal = this.options.planner.propose(snapshots.current);
      plan = validateSequentialPlan(parsePlannerProposal(rawProposal), this.options.policy);
    } catch (error) {
      return this.persistPlanningFailure(workItemId, snapshots.current, rawProposal, plannerFailures(error), now);
    }
    return this.persistPublishedPlan(workItemId, snapshots.current, plan, now);
  }

  async processNaturalIntake(now = Date.now()): Promise<string | null> {
    if (this.closed) throw new Error("Planning coordinator is closed");
    if (this.naturalAssociation) await this.naturalAssociation.processOne(now);
    if (this.closed) return null;
    return this.naturalIntake?.processOne(now) ?? Promise.resolve(null);
  }

  observeAcceptedEvent(workItemId: string, text: string, now = Date.now(), sourceEventId?: string): DefinitionRevisionOutcome | null {
    assertLedgerArmed(this.database);
    if (this.naturalIntake && sourceEventId) {
      // Only the durable source can feed the model; changed redeliveries cannot inject a new definition.
      const event = this.database.prepare("SELECT normalized_json FROM collaboration_external_events WHERE source='dingtalk' AND source_event_id=? AND work_item_id=?")
        .get(sourceEventId, workItemId) as { normalized_json: string } | undefined;
      if (!event) throw new Error("natural_intake_event_missing");
      const sourceText = redactSensitiveText(String(JSON.parse(event.normalized_json).text)).slice(0, 2_000);
      const latest = readLatestWorkItemSnapshot(this.database, workItemId);
      const facts = [...(latest?.facts ?? []).filter(fact => fact !== sourceText), sourceText].slice(-100);
      const ambiguities = (latest?.blockingAmbiguities ?? []).filter(q => q.id !== "natural-input-pending");
      const unread = this.database.prepare("SELECT 1 FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
        "WHERE e.work_item_id=? AND a.ingest_state <> 'ready' LIMIT 1").get(workItemId);
      if (unread && !ambiguities.some(q => q.id === "attachment-content-pending")) ambiguities.push({
        id: "attachment-content-pending", question: "还有附件内容未读取完成，我会在读取后一起核对。", dependsOn: [],
        recommendedAnswer: "暂时不用重复发送；如果读取失败，我会说明需要补充什么。",
      });
      return this.reviseDefinition(workItemId, {
        ...(!latest ? { goal: sourceText, goalConfirmed: false, repository: this.options.defaultDefinition?.repository ?? null } : {}),
        facts,
        blockingAmbiguities: [...ambiguities, {
          id: "natural-input-pending", question: "我正在结合前面的沟通整理这条补充。", dependsOn: [],
          recommendedAnswer: "暂时不需要填写格式或编号；有新信息直接补充即可。",
        }],
      }, now, { enqueueNaturalEvent: sourceEventId });
    }
    const latest = readLatestWorkItemSnapshot(this.database, workItemId);
    const normalized = text.trim();
    if (latest?.facts.includes(normalized)) return null;
    const patch = buildDefinitionPatchFromText(normalized, latest, this.options.defaultDefinition);
    const pendingAttachments = this.database.prepare(
      "SELECT count(*) AS count FROM collaboration_attachments a " +
        "JOIN collaboration_external_events e ON e.id = a.external_event_id " +
        "WHERE e.work_item_id = ? AND a.ingest_state <> 'ready'",
    ).get(workItemId) as { count: number };
    const attachmentAmbiguityId = "attachment-content-pending";
    const ambiguities = (patch.blockingAmbiguities ?? latest?.blockingAmbiguities ?? [])
      .filter((ambiguity) => typeof ambiguity === "string" || ambiguity.id !== attachmentAmbiguityId);
    if (pendingAttachments.count > 0) {
      ambiguities.push({
        id: attachmentAmbiguityId,
        question: "附件内容还在安全读取中；如果附件不是本任务输入，请直接说明。",
        dependsOn: [],
        recommendedAnswer: "等待读取完成即可；读取失败时请重新上传支持的文件，或用文字补充关键内容。",
      });
      patch.blockingAmbiguities = ambiguities;
      if (!latest && /^收到 \d+ 个附件，内容待安全读取。$/u.test(normalized)) {
        patch.goal = null;
        patch.goalConfirmed = false;
      }
    } else if (latest?.blockingAmbiguities.some((ambiguity) => ambiguity.id === attachmentAmbiguityId)) {
      patch.blockingAmbiguities = ambiguities;
    }
    return this.reviseDefinition(
      workItemId,
      patch,
      now,
    );
  }

  observeAcceptedEvidence(
    workItemId: string,
    evidence: AcceptedAttachmentEvidence,
    now = Date.now(),
  ): DefinitionRevisionOutcome | null {
    assertLedgerArmed(this.database);
    if (!/^[0-9a-f]{64}$/u.test(evidence.contentHash)) throw new Error("attachment_evidence_hash_invalid");
    if (!evidence.chunks.length || evidence.chunks.some((chunk) => chunk.untrusted !== true)) {
      throw new Error("attachment_evidence_chunks_invalid");
    }
    const source = this.database.prepare(
      "SELECT a.display_name, e.source_event_id FROM collaboration_attachments a " +
        "JOIN collaboration_external_events e ON e.id = a.external_event_id " +
        "JOIN collaboration_work_item_evidence w ON w.attachment_id = a.id " +
        "WHERE a.id = ? AND e.work_item_id = ? AND e.source_event_id = ? " +
        "AND a.ingest_state = 'ready' AND a.content_hash = ? AND w.work_item_id = ? " +
        "AND w.evidence_kind = 'attachment' AND w.evidence_hash = ? LIMIT 1",
    ).get(
      evidence.attachmentId,
      workItemId,
      evidence.sourceEventId,
      evidence.contentHash,
      workItemId,
      evidence.contentHash,
    ) as { display_name: string | null; source_event_id: string } | undefined;
    if (!source) throw new Error("attachment_evidence_source_invalid");
    const stored = readAttachmentEvidenceNotification(this.database, evidence.attachmentId);
    if (stored.workItemId !== workItemId || stored.format !== evidence.format || stored.source.sourceEventId !== evidence.sourceEventId ||
      stored.chunks.length !== evidence.chunks.length ||
      stored.chunks.some((chunk, index) => {
        const supplied = evidence.chunks[index];
        return chunk.ordinal !== supplied.ordinal || chunk.lineStart !== supplied.lineStart || chunk.lineEnd !== supplied.lineEnd ||
          chunk.text !== supplied.text || chunk.textHash !== supplied.textHash;
      }) || evidence.truncated !== stored.chunks.some(c => c.truncated) ||
      JSON.stringify([...new Set(evidence.warnings)].sort()) !== JSON.stringify([...new Set(stored.chunks.flatMap(c => c.warnings))].sort())) {
      throw new Error("attachment_evidence_projection_mismatch");
    }
    const chunkExists = this.database.prepare(
      "SELECT 1 FROM collaboration_attachment_chunks c " +
        "JOIN collaboration_attachment_extractions x ON x.id = c.extraction_id " +
        "WHERE x.attachment_id = ? AND x.status = 'succeeded' AND c.ordinal = ? " +
        "AND c.content_hash = ? AND c.content = ? LIMIT 1",
    );
    for (const chunk of evidence.chunks) {
      if (
        !/^[0-9a-f]{64}$/u.test(chunk.textHash) ||
        createHash("sha256").update(chunk.text).digest("hex") !== chunk.textHash ||
        !chunkExists.get(evidence.attachmentId, chunk.ordinal, chunk.textHash, chunk.text)
      ) throw new Error("attachment_evidence_chunk_invalid");
    }
    const latest = readLatestWorkItemSnapshot(this.database, workItemId);
    const sourceLabel = redactSensitiveText((source.display_name ?? evidence.displayName).trim()).slice(0, 120) || "附件";
    const excerpts = evidence.chunks.slice(0, 12).flatMap(chunk => attachmentExcerpts(sourceLabel, chunk));
    const facts = [...(latest?.facts ?? [])];
    for (const excerpt of excerpts) {
      if (!facts.includes(excerpt) && facts.length < 100) facts.push(excerpt);
    }
    const pending = this.database.prepare(
      "SELECT count(*) AS count FROM collaboration_attachments a " +
        "JOIN collaboration_external_events e ON e.id = a.external_event_id " +
        "WHERE e.work_item_id = ? AND a.ingest_state <> 'ready'",
    ).get(workItemId) as { count: number };
    const attachmentAmbiguityId = "attachment-content-pending";
    const ambiguities = (latest?.blockingAmbiguities ?? [])
      .filter((ambiguity) => ambiguity.id !== attachmentAmbiguityId);
    if (pending.count > 0) {
      ambiguities.push({
        id: attachmentAmbiguityId,
        question: "仍有附件尚未读取完成；如果附件不是本任务输入，请直接说明。",
        dependsOn: [],
        recommendedAnswer: "等待读取完成，或用文字补充未读取附件的关键内容。",
      });
    }
    return this.reviseDefinition(workItemId, {
      ...(!latest
        ? {
            goal: null,
            goalConfirmed: false,
            ...(this.options.defaultDefinition ? { repository: this.options.defaultDefinition.repository } : {}),
            acceptanceConditions: [],
          }
        : {}),
      facts,
      blockingAmbiguities: ambiguities,
    }, now, {
      attachmentId: evidence.attachmentId,
      contentHash: evidence.contentHash,
      contextSummary: attachmentCompletenessGates(this.database, workItemId, facts).length
        ? `已保存附件“${sourceLabel}”的可读部分；仍有材料或需求内容未核对完整，尚未开始修改。`
        : `已安全读取附件“${sourceLabel}”，内容已按来源保存，正在确认目标和验收标准。`,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.naturalIntake?.close();
    this.naturalAssociation?.close();
    this.database.close();
  }

  private nextPlanRevision(workItemId: string): number {
    const row = this.database
      .prepare("SELECT coalesce(max(revision), 0) AS revision FROM collaboration_plan_revisions WHERE work_item_id = ?")
      .get(workItemId) as { revision: number };
    return row.revision + 1;
  }

  private persistPlanningFailure(
    workItemId: string,
    snapshot: WorkItemSnapshot,
    rawProposal: unknown,
    failures: string[],
    now: number,
  ): DefinitionRevisionOutcome {
    if (!this.beginCurrentAttempt(workItemId, snapshot.revision, now)) {
      throw new Error(`Planning snapshot ${snapshot.revision} was superseded before failure persistence`);
    }
    try {
      const revision = this.nextPlanRevision(workItemId);
      this.database
        .prepare(
          "INSERT INTO collaboration_plan_revisions " +
            "(id, work_item_id, revision, snapshot_revision, status, proposal_hash, failure_json, created_at) " +
            "VALUES (?, ?, ?, ?, 'planning_failed', ?, ?, ?)",
        )
        .run(randomUUID(), workItemId, revision, snapshot.revision, unknownHash(rawProposal), JSON.stringify(failures), now);
      this.database
        .prepare("UPDATE collaboration_work_items SET definition_status = 'planning_failed', updated_at = ? WHERE id = ?")
        .run(now, workItemId);
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'failed', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshot.revision);
      const card = renderPlanStatusCard({
        workItemId,
        planRevision: revision,
        status: "planning_failed",
        failures,
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `plan:${workItemId}:revision:${revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: revision,
        card,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
      return {
        workItemId,
        snapshotRevision: snapshot.revision,
        definitionStatus: "planning_failed",
        clarificationQuestions: [],
        planRevision: revision,
        card,
        failures,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private persistPublishedPlan(
    workItemId: string,
    snapshot: WorkItemSnapshot,
    plan: ValidatedSequentialPlan,
    now: number,
  ): DefinitionRevisionOutcome {
    if (!this.beginCurrentAttempt(workItemId, snapshot.revision, now)) {
      throw new Error(`Planning snapshot ${snapshot.revision} was superseded before publication`);
    }
    try {
      const revision = this.nextPlanRevision(workItemId);
      const planHash = unknownHash(plan);
      this.database
        .prepare(
          "INSERT INTO collaboration_plan_revisions " +
            "(id, work_item_id, revision, snapshot_revision, status, summary, proposal_hash, created_at) " +
            "VALUES (?, ?, ?, ?, 'published', ?, ?, ?)",
        )
        .run(randomUUID(), workItemId, revision, snapshot.revision, plan.summary, planHash, now);
      const insertNode = this.database.prepare(
        "INSERT INTO collaboration_work_nodes " +
          "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
          "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
          "completion_definition, risk, budget_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const node of plan.nodes) {
        insertNode.run(
          workItemId,
          revision,
          node.id,
          node.type,
          node.type === "analyze" ? "ready" : "pending",
          node.agentId,
          node.objective,
          JSON.stringify(node.inputEvidence),
          node.instructions,
          JSON.stringify(node.readScope),
          JSON.stringify(node.writeScope),
          JSON.stringify(node.denyScope),
          JSON.stringify(node.commands),
          JSON.stringify(node.expectedArtifacts),
          node.completionDefinition,
          node.risk,
          JSON.stringify(node.budget),
          now,
        );
      }
      const insertEdge = this.database.prepare(
        "INSERT INTO collaboration_work_edges " +
          "(work_item_id, plan_revision, from_node_id, to_node_id, kind) VALUES (?, ?, ?, ?, 'blocks')",
      );
      for (const node of plan.nodes) {
        for (const dependency of node.dependsOn) insertEdge.run(workItemId, revision, dependency, node.id);
      }

      const previousPlan = this.database
        .prepare(
          "SELECT revision, snapshot_revision, proposal_hash FROM collaboration_plan_revisions " +
            "WHERE work_item_id = ? AND status = 'published' AND revision < ? ORDER BY revision DESC LIMIT 1",
        )
        .get(workItemId, revision) as
        | { revision: number; snapshot_revision: number; proposal_hash?: string }
        | undefined;
      const previousSnapshot = previousPlan
        ? readWorkItemSnapshotRevision(this.database, workItemId, previousPlan.snapshot_revision)
        : null;
      if (previousPlan && previousSnapshot) {
        let classifications = classifyPreviousPlanNodes(previousSnapshot, snapshot);
        if (
          previousPlan.proposal_hash &&
          previousPlan.proposal_hash !== planHash &&
          Object.values(classifications).every((value) => value.classification === "valid")
        ) {
          classifications = Object.fromEntries(
            ["analyze", "modify", "validate", "report"].map((type) => [
              type,
              { classification: "revalidate", reason: "planner contract changed" },
            ]),
          ) as typeof classifications;
        }
        const priorNodes = this.database
          .prepare(
            "SELECT node_id, node_type FROM collaboration_work_nodes " +
              "WHERE work_item_id = ? AND plan_revision = ? ORDER BY rowid",
          )
          .all(workItemId, previousPlan.revision) as Array<{ node_id: string; node_type: WorkNodeType }>;
        const insertClassification = this.database.prepare(
          "INSERT INTO collaboration_plan_node_classifications " +
            "(work_item_id, new_plan_revision, previous_plan_revision, previous_node_id, classification, reason) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const prior of priorNodes) {
          const classification = classifications[prior.node_type];
          insertClassification.run(
            workItemId,
            revision,
            previousPlan.revision,
            prior.node_id,
            classification.classification,
            classification.reason,
          );
        }
        this.database
          .prepare(
            "UPDATE collaboration_work_nodes SET active = 0, version = version + 1 " +
              "WHERE work_item_id = ? AND plan_revision = ?",
          )
          .run(workItemId, previousPlan.revision);
      }

      this.database
        .prepare(
          "UPDATE collaboration_work_items SET definition_status = 'ready_for_execution', " +
            "current_plan_revision = ?, updated_at = ? WHERE id = ?",
        )
        .run(revision, now, workItemId);
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'published', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshot.revision);
      const card = renderPlanStatusCard({
        workItemId,
        planRevision: revision,
        status: "ready_for_execution",
        summary: plan.summary,
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `plan:${workItemId}:revision:${revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: revision,
        card,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
      return {
        workItemId,
        snapshotRevision: snapshot.revision,
        definitionStatus: "ready_for_execution",
        clarificationQuestions: [],
        planRevision: revision,
        card,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private beginCurrentAttempt(workItemId: string, snapshotRevision: number, now: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.database
        .prepare("SELECT max(revision) AS revision FROM collaboration_work_item_snapshots WHERE work_item_id = ?")
        .get(workItemId) as { revision: number };
      if (latest.revision === snapshotRevision) return true;
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'stale', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshotRevision);
      this.database.exec("COMMIT");
      return false;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
