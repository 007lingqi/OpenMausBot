import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

const WORK_ITEM_REFERENCE = /\bWI-[A-Z0-9][A-Z0-9-]{2,63}\b/giu;
const EXPLICIT_NEW_TOPIC = /^\s*(?:这是(?:一个)?新(?:任务|需求|问题)|新任务|新需求|新问题|另一个(?:独立)?(?:问题|任务|需求)?|另外(?:一个)?(?:问题|任务|需求)?|还有一个(?:问题|任务|需求)?)(?:\s|[：:，,。.]|$)/u;
const CLEAR_CONTINUATION = /^\s*(?:(?:我|我们)?(?:再)?补充|继续|追加|更正|修正|确认|回答|答复|回复|复现|验收(?:条件|标准)?|预期(?:结果)?|实际(?:结果)?|关于(?:这个|这块|该问题)|这个(?:问题)?|这块|该问题|上面|刚才|已(?:发送|重试|确认|处理|完成)|(?:不)?可以|是的|不是|同意|不同意|按.+处理)/u;

export interface AssociationCandidate {
  id: string;
  title: string;
}

interface CandidateRow extends Record<string, SQLOutputValue> {
  id: string;
  title: string;
}

interface ReplyRow extends Record<string, SQLOutputValue> {
  work_item_id: string | null;
}

interface ConversationAliasRow extends Record<string, SQLOutputValue> {
  conversation_id: string;
}

export type AssociationDecision =
  | { kind: "create" }
  | { kind: "associate"; workItemId: string }
  | { kind: "ambiguous"; workItemIds: string[]; candidateWorkItems: AssociationCandidate[] }
  | { kind: "invalid_reference"; reference: string };

function activeWorkItems(database: DatabaseSync, conversationId: string): AssociationCandidate[] {
  // SAFETY: The fixed SELECT projects the required string id and title columns from a constrained schema table.
  return database
    .prepare(
      "SELECT id, title FROM collaboration_work_items " +
        "WHERE conversation_id = ? AND status NOT IN ('cancelled', 'accepted') " +
        "ORDER BY updated_at DESC, id LIMIT 3",
    )
    .all(conversationId) as CandidateRow[];
}

function validReference(database: DatabaseSync, conversationId: string, reference: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM collaboration_work_items WHERE id = ? AND conversation_id = ?")
      .get(reference, conversationId),
  );
}

function candidatesForIds(
  database: DatabaseSync,
  conversationId: string,
  workItemIds: string[],
): AssociationCandidate[] {
  const find = database.prepare(
    "SELECT id, title FROM collaboration_work_items WHERE id = ? AND conversation_id = ?",
  );
  return workItemIds.flatMap((id) => {
    // SAFETY: The fixed SELECT returns only schema-defined string id and title columns.
    const candidate = find.get(id, conversationId) as CandidateRow | undefined;
    return candidate ? [candidate] : [];
  });
}

function ambiguous(candidateWorkItems: AssociationCandidate[]): AssociationDecision {
  const candidates = candidateWorkItems.slice(0, 3);
  return {
    kind: "ambiguous",
    workItemIds: candidates.map((candidate) => candidate.id),
    candidateWorkItems: candidates,
  };
}

export function decideMessageAssociation(
  database: DatabaseSync,
  input: { source: "dingtalk"; conversationId: string; text: string; replyToSourceEventId?: string },
): AssociationDecision {
  const references = [...new Set((input.text.match(WORK_ITEM_REFERENCE) ?? []).map((value) => value.toUpperCase()))];
  if (references.length) {
    const valid = references.filter((reference) => validReference(database, input.conversationId, reference));
    if (valid.length > 1) {
      return ambiguous(candidatesForIds(database, input.conversationId, valid.sort()));
    }
    if (valid.length === 1 && references.length === 1) return { kind: "associate", workItemId: valid[0] };
    return { kind: "invalid_reference", reference: references.find((reference) => !valid.includes(reference))! };
  }

  if (input.replyToSourceEventId) {
    // SAFETY: The fixed SELECT returns the nullable string foreign-key column declared by the schema.
    const reply = database
      .prepare(
        "SELECT work_item_id FROM collaboration_external_events " +
          "WHERE source = ? AND source_event_id = ? AND conversation_id = ?",
      )
      .get(input.source, input.replyToSourceEventId, input.conversationId) as ReplyRow | undefined;
    if (reply?.work_item_id) {
      return { kind: "associate", workItemId: reply.work_item_id };
    }
  }

  if (EXPLICIT_NEW_TOPIC.test(input.text)) return { kind: "create" };

  const candidates = activeWorkItems(database, input.conversationId);
  if (candidates.length === 0) return { kind: "create" };
  if (CLEAR_CONTINUATION.test(input.text)) {
    const normalized = input.text.replace(/\s+/gu, "");
    const titleMatches = candidates.filter((candidate) => {
      const title = candidate.title.replace(/\s+/gu, "");
      return title.length >= 4 && normalized.includes(title);
    });
    if (titleMatches.length === 1) return { kind: "associate", workItemId: titleMatches[0].id };
  }
  if (candidates.length === 1 && CLEAR_CONTINUATION.test(input.text)) {
    return { kind: "associate", workItemId: candidates[0].id };
  }
  return ambiguous(candidates);
}

export function resolveConversationAlias(
  database: DatabaseSync,
  source: "dingtalk",
  externalConversationId: string,
  now: number,
): string {
  // SAFETY: The fixed SELECT returns the required string conversation_id declared by the alias schema.
  const existing = database
    .prepare("SELECT conversation_id FROM collaboration_conversation_aliases WHERE source = ? AND external_id = ?")
    .get(source, externalConversationId) as ConversationAliasRow | undefined;
  if (existing) return existing.conversation_id;
  const id = randomUUID();
  database.prepare("INSERT INTO collaboration_conversations (id, created_at) VALUES (?, ?)").run(id, now);
  database
    .prepare(
      "INSERT INTO collaboration_conversation_aliases (source, external_id, conversation_id, created_at) " +
        "VALUES (?, ?, ?, ?)",
    )
    .run(source, externalConversationId, id, now);
  return id;
}
