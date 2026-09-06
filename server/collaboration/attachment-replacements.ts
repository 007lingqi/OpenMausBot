import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readAttachmentEvidenceNotification } from "./attachment-ingestion.ts";
import { redactSensitiveText } from "./sensitive-text.ts";

interface Material {
  id: string; ingest_state: string; source_event_id: string; principal_id: string;
  conversation_id: string; normalized_json: string; event_order: number; has_evidence: number;
  ordinal: number; display_name: string | null;
}
export interface AttachmentReplacementReceipt {
  originalAttachmentId: string; replacementAttachmentId: string;
  originalSourceEventId: string; sourceEventId: string; principalId: string;
  normalizedHash: string; originalNormalizedHash: string; replacementContentHash: string;
  originalOrdinal: number;
  selectionSources: Array<{ sourceEventId: string; normalizedHash: string }>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface SelectionQuestion {
  question: string;
  recommendedAnswer: string;
  respondent: { principalId: string; sourceEventId: string; quote: string };
}

type Target = { kind: "unspecified" } | { kind: "ordinal"; ordinal: number } | { kind: "name"; name: string } | { kind: "invalid" };

function target(value: string): Target {
  const text = value.trim().replace(/[。！!]$/u, "").replace(/^原消息(?:中|里)(?:的)?/u, "");
  if (/^(?:之前的|原来的|原)(?:文件|附件)$/u.test(text)) return { kind: "unspecified" };
  const ordinal = /^第([0-9]+|[一二三四五六七八九十百]+)(?:份|个)(?:文件|附件)?$/u.exec(text);
  if (ordinal) {
    const raw = ordinal[1]!, digits = "一二三四五六七八九";
    let number = Number(raw);
    if (!Number.isFinite(number)) {
      if (raw === "一百") number = 100;
      else if (raw.length === 1 && digits.includes(raw)) number = digits.indexOf(raw) + 1;
      else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(raw)) {
        const [tens, ones] = raw.split("十"); number = (tens ? digits.indexOf(tens) + 1 : 1) * 10 + (ones ? digits.indexOf(ones) + 1 : 0);
      }
    }
    return Number.isSafeInteger(number) && number >= 1 && number <= 100 ? { kind: "ordinal", ordinal: number - 1 } : { kind: "invalid" };
  }
  const quoted = /^(?:“([^”]+)”|"([^"]+)"|「([^」]+)」)$/u.exec(text);
  const name = quoted ? quoted[1] ?? quoted[2] ?? quoted[3]! : text;
  if (!name || name.length > 1024 || /[\r\n]/u.test(name) || (!quoted && /[“”"「」]/u.test(name))) return { kind: "invalid" };
  return { kind: "name", name };
}

function explicitReplacement(text: unknown): Target | null {
  if (typeof text !== "string") return null;
  if (/^这份是可读版本[，,]请替换原附件[。！!]?$/u.test(text.trim())) return { kind: "unspecified" };
  const match = /^(?:请)?(?:用)?(?:这份|这个)(?:文件|附件)?(?:来)?(?:替换|代替)([^\r\n]+)$/u.exec(text.trim());
  return match ? target(match[1]!) : null;
}

function selectionReply(text: unknown, originals: Material[]): Target | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  const action = /^(?:请)?(?:替换|代替)(.+)$/u.exec(value);
  if (action) return target(action[1]!);
  const candidate = target(value.replace(/^是/u, ""));
  if (candidate.kind === "ordinal") return candidate;
  if (candidate.kind === "name" && (originals.some(row => row.display_name === candidate.name) || /\.[\p{L}\p{N}]+$/u.test(candidate.name))) return candidate;
  return null;
}

/** Derived from saved group-message provenance, never from attachment text or filenames. */
export function readAttachmentReplacements(db: DatabaseSync, workItemId: string) {
  const rows = db.prepare("SELECT a.id,a.ingest_state,a.ordinal,a.display_name,e.source_event_id,e.principal_id,e.conversation_id,e.normalized_json,e.rowid AS event_order," +
    "EXISTS(SELECT 1 FROM collaboration_attachment_extractions x WHERE x.attachment_id=a.id AND x.status='succeeded') AS has_evidence " +
    "FROM collaboration_attachments a JOIN collaboration_external_events e ON e.id=a.external_event_id " +
    "WHERE e.source='dingtalk' AND e.work_item_id=? ORDER BY e.rowid,a.ordinal LIMIT 101").all(workItemId) as unknown as Material[];
  const receipts: AttachmentReplacementReceipt[] = [];
  const selectionQuestions: Array<{ originals: Material[]; question: SelectionQuestion }> = [];
  const replaced = new Set<string>();
  let needsClarification = false;
  if (rows.length > 100) return { receipts, replaced, needsClarification, selectionQuestion: undefined as SelectionQuestion | undefined };
  for (const row of rows) {
    let message: { text?: unknown; replyToSourceEventId?: unknown };
    try { message = JSON.parse(row.normalized_json); } catch { continue; }
    const initialTarget = message ? explicitReplacement(message.text) : null;
    if (!initialTarget) continue;
    const originals = rows.filter(old => old.source_event_id === message.replyToSourceEventId && old.event_order < row.event_order && old.conversation_id === row.conversation_id);
    const newFiles = rows.filter(other => other.source_event_id === row.source_event_id);
    if (newFiles.length !== 1 || originals.length === 0) {
      needsClarification = true; continue;
    }
    const followups = db.prepare("SELECT source_event_id,normalized_json FROM collaboration_external_events " +
      "WHERE source='dingtalk' AND work_item_id=? AND conversation_id=? AND principal_id=? AND rowid>? " +
      "AND json_valid(normalized_json) AND json_extract(normalized_json,'$.replyToSourceEventId')=? ORDER BY rowid LIMIT 21")
      .all(workItemId, row.conversation_id, row.principal_id, row.event_order, row.source_event_id) as Array<{ source_event_id: string; normalized_json: string }>;
    if (followups.length > 20) { needsClarification = true; continue; }
    const choices: Target[] = initialTarget.kind === "unspecified" ? [] : [initialTarget];
    const selectionSources: AttachmentReplacementReceipt["selectionSources"] = [];
    for (const followup of followups) {
      const value = JSON.parse(followup.normalized_json);
      // A new upload is not a selection-only reply.
      if (!value || (Array.isArray(value.resources) && value.resources.length)) continue;
      const choice = selectionReply(value.text, originals);
      if (choice) { choices.push(choice); selectionSources.push({ sourceEventId: followup.source_event_id, normalizedHash: hash(followup.normalized_json) }); }
    }
    if (!choices.length) choices.push({ kind: "unspecified" });
    if (choices.length === 1 && choices[0]!.kind === "unspecified" && originals.length > 1 &&
      originals.every(old => old.principal_id === row.principal_id && ["failed", "unsupported"].includes(old.ingest_state) && !old.has_evidence) && row.ingest_state === "ready") {
      try {
        const evidence = readAttachmentEvidenceNotification(db, row.id);
        if (evidence.workItemId === workItemId && evidence.source.sourceEventId === row.source_event_id && evidence.chunks.length &&
          evidence.chunks.every(c => !c.truncated && c.warnings.every(w => /^csv_formula_like_cells_present:\d+$/.test(w)))) {
          const label = (value: string | null) => redactSensitiveText(value ?? "未命名附件").replace(/[\r\n\u0000-\u001f\u007f“”]/gu, " ").slice(0, 60);
          const options = originals.slice(0, 3).map(old => `第 ${old.ordinal + 1} 份“${label(old.display_name)}”`).join("、");
          selectionQuestions.push({ originals, question: {
            question: `你上传的“${label(row.display_name)}”要替代原消息中的哪份文件？${options}${originals.length > 3 ? `等 ${originals.length} 份` : ""}。`,
            recommendedAnswer: "请回复你刚上传可读文件的那条消息，说明原消息中的第几份；原文件会保留，尚未开始修改。",
            respondent: { principalId: row.principal_id, sourceEventId: row.source_event_id, quote: redactSensitiveText(String(message.text)) },
          } });
        }
      } catch { /* Unread or unverifiable new material cannot be described as a usable replacement. */ }
    }
    const selected = choices.map(choice => originals.filter(original => choice.kind === "unspecified" ||
      (choice.kind === "ordinal" && original.ordinal === choice.ordinal) || (choice.kind === "name" && original.display_name === choice.name)));
    if (selected.some(matches => matches.length !== 1) || new Set(selected.map(matches => matches[0]!.id)).size !== 1) { needsClarification = true; continue; }
    const old = selected[0]![0]!;
    if (old.principal_id !== row.principal_id) { needsClarification = true; continue; }
    // Replacing unread material is not permission to discard already-used facts.
    if (!["failed", "unsupported"].includes(old.ingest_state) || old.has_evidence) { needsClarification = true; continue; }
    if (row.ingest_state !== "ready") continue;
    try {
      const evidence = readAttachmentEvidenceNotification(db, row.id);
      if (evidence.workItemId !== workItemId || evidence.source.sourceEventId !== row.source_event_id ||
        evidence.chunks.length === 0 || evidence.chunks.some(c => c.truncated || c.warnings.some(w => !/^csv_formula_like_cells_present:\d+$/.test(w)))) continue;
      receipts.push({ originalAttachmentId: old.id, replacementAttachmentId: row.id,
        originalSourceEventId: old.source_event_id, sourceEventId: row.source_event_id, principalId: row.principal_id,
        normalizedHash: hash(row.normalized_json), originalNormalizedHash: hash(old.normalized_json), replacementContentHash: evidence.source.contentHash,
        originalOrdinal: old.ordinal, selectionSources });
      replaced.add(old.id);
    } catch { /* Missing or unverifiable source evidence never releases the old gate. */ }
  }
  const counts = new Map<string, number>();
  for (const receipt of receipts) counts.set(receipt.originalAttachmentId, (counts.get(receipt.originalAttachmentId) ?? 0) + 1);
  const unambiguous = receipts.filter(receipt => counts.get(receipt.originalAttachmentId) === 1);
  if (unambiguous.length !== receipts.length) needsClarification = true;
  replaced.clear();
  for (const receipt of unambiguous) replaced.add(receipt.originalAttachmentId);
  // A later valid correction may resolve an earlier ambiguous suggestion. The
  // replacement gate is about unread inputs, never a permanent historical flag.
  needsClarification &&= rows.some(row => ["failed", "unsupported"].includes(row.ingest_state) && !replaced.has(row.id));
  const selectionQuestion = needsClarification
    ? selectionQuestions.find(entry => entry.originals.some(old => !replaced.has(old.id)))?.question : undefined;
  return { receipts: unambiguous, replaced, needsClarification, selectionQuestion };
}
