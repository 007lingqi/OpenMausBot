import { createHash } from "node:crypto";
import { extname } from "node:path";

import { redactSensitiveText } from "./sensitive-text.ts";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 250_000;
export const MAX_CSV_ROWS = 20_000;
export const MAX_CSV_COLUMNS = 100;
export const MAX_CSV_CELLS = 200_000;

const MAX_CHUNK_CHARACTERS = 8_000;

export type AttachmentTextFormat = "text" | "markdown" | "csv" | "docx" | "xlsx" | "pdf";

export interface AttachmentTextExtractionInput {
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
}

/** Trusted lifecycle controls; never derived from attachment contents. */
export interface AttachmentExtractionContext {
  signal?: AbortSignal;
  assertActive?: () => void;
}

export interface AttachmentTextChunk {
  ordinal: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  textHash: string;
  untrusted: true;
  truncated: boolean;
  warnings: string[];
}

export interface AttachmentTextExtraction {
  extractor?: { name: string; version: string };
  format: AttachmentTextFormat;
  characterCount: number;
  lineCount: number;
  chunks: AttachmentTextChunk[];
  truncated: boolean;
  warnings: string[];
}

interface ParsedMediaType {
  essence: string;
  charset?: string;
}

interface ParsedCsv {
  rows: string[][];
  formulaLikeCells: number;
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

function containsForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseMediaType(value: string): ParsedMediaType {
  if (!value || value !== value.trim() || value.length > 255 || containsForbiddenControl(value)) {
    throw new Error("attachment_media_type_invalid");
  }
  const [rawEssence, ...parameters] = value.split(";");
  const essence = rawEssence?.trim().toLowerCase() ?? "";
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(essence)) throw new Error("attachment_media_type_invalid");
  let charset: string | undefined;
  for (const parameter of parameters) {
    const [rawName, rawValue] = parameter.split("=", 2);
    if (rawName?.trim().toLowerCase() !== "charset") continue;
    charset = rawValue?.trim().replace(/^"|"$/gu, "").toLowerCase();
  }
  if (charset && charset !== "utf-8" && charset !== "utf8") throw new Error("attachment_charset_unsupported");
  const result: ParsedMediaType = { essence };
  if (charset) result.charset = charset;
  return result;
}

function extensionFormat(displayName: string): AttachmentTextFormat | undefined {
  if (!displayName || displayName !== displayName.trim() || displayName.length > 1_024 || containsForbiddenControl(displayName)) {
    throw new Error("attachment_display_name_invalid");
  }
  const extension = extname(displayName).toLowerCase();
  if (!extension) return undefined;
  if (extension === ".txt") return "text";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".csv") return "csv";
  throw new Error("attachment_extension_unsupported");
}

function selectFormat(mediaType: ParsedMediaType, displayName: string): AttachmentTextFormat {
  const fromExtension = extensionFormat(displayName);
  let fromMediaType: AttachmentTextFormat | "generic";
  if (mediaType.essence === "text/plain" || mediaType.essence === "application/octet-stream") {
    fromMediaType = "generic";
  } else if (mediaType.essence === "text/markdown" || mediaType.essence === "text/x-markdown") {
    fromMediaType = "markdown";
  } else if (mediaType.essence === "text/csv" || mediaType.essence === "application/csv") {
    fromMediaType = "csv";
  } else {
    throw new Error("attachment_media_type_unsupported");
  }
  if (fromMediaType !== "generic" && fromExtension && fromMediaType !== fromExtension) {
    throw new Error("attachment_extension_media_type_conflict");
  }
  if (fromExtension) return fromExtension;
  if (fromMediaType !== "generic") return fromMediaType;
  if (mediaType.essence === "text/plain") return "text";
  throw new Error("attachment_format_unknown");
}

function decodeUtf8(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error("attachment_bytes_invalid");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("attachment_file_too_large");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("attachment_text_not_utf8");
  }
  if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
  if (decoded.includes("\u0000")) throw new Error("attachment_text_contains_nul");
  return decoded;
}

function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let insideQuotes = false;
  let closedQuote = false;
  let cells = 0;
  let formulaLikeCells = 0;

  const pushField = (): void => {
    if (row.length >= MAX_CSV_COLUMNS) throw new Error("attachment_csv_too_many_columns");
    cells += 1;
    if (cells > MAX_CSV_CELLS) throw new Error("attachment_csv_too_many_cells");
    if (/^[=+\-@]/u.test(field)) formulaLikeCells += 1;
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const pushRow = (): void => {
    pushField();
    if (rows.length >= MAX_CSV_ROWS) throw new Error("attachment_csv_too_many_rows");
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (insideQuotes) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        insideQuotes = false;
        closedQuote = true;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ",") {
        pushField();
        continue;
      }
      if (character === "\r" || character === "\n") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        pushRow();
        continue;
      }
      throw new Error("attachment_csv_invalid");
    }
    if (character === '"') {
      if (field.length > 0) throw new Error("attachment_csv_invalid");
      insideQuotes = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }

  if (insideQuotes) throw new Error("attachment_csv_invalid");
  if (closedQuote || field.length > 0 || row.length > 0 || text.endsWith(",")) pushRow();
  return { rows, formulaLikeCells };
}

function normalizedPlainText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function boundedText(text: string, warnings: string[]): BoundedText {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= MAX_EXTRACTED_CHARACTERS) return { text: redacted, truncated: false };
  warnings.push("output_truncated");
  let bounded = redacted.slice(0, MAX_EXTRACTED_CHARACTERS);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) bounded = bounded.slice(0, -1);
  return { text: bounded, truncated: true };
}

function buildChunks(text: string, truncated: boolean, warnings: string[]): AttachmentTextChunk[] {
  if (!text) return [];
  const lines = text.split("\n");
  const chunks: AttachmentTextChunk[] = [];
  let currentText = "";
  let currentLineStart = 1;
  let currentLineEnd = 1;
  let hasCurrent = false;

  const emit = (): void => {
    if (!hasCurrent) return;
    chunks.push({
      ordinal: chunks.length,
      lineStart: currentLineStart,
      lineEnd: currentLineEnd,
      text: currentText,
      textHash: createHash("sha256").update(currentText).digest("hex"),
      untrusted: true,
      truncated,
      warnings: [...warnings],
    });
    currentText = "";
    hasCurrent = false;
  };

  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const prefix = hasCurrent ? "\n" : "";
    if (hasCurrent && currentText.length + prefix.length + line.length > MAX_CHUNK_CHARACTERS) emit();
    if (line.length <= MAX_CHUNK_CHARACTERS) {
      if (!hasCurrent) currentLineStart = lineNumber;
      currentText += `${hasCurrent ? "\n" : ""}${line}`;
      hasCurrent = true;
      currentLineEnd = lineNumber;
      continue;
    }
    emit();
    for (let offset = 0; offset < line.length;) {
      let end = Math.min(line.length, offset + MAX_CHUNK_CHARACTERS);
      const last = line.charCodeAt(end - 1);
      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
      currentLineStart = lineNumber;
      currentLineEnd = lineNumber;
      currentText = line.slice(offset, end);
      hasCurrent = true;
      emit();
      offset = end;
    }
  }
  emit();
  return chunks;
}

export function extractAttachmentText(input: AttachmentTextExtractionInput): AttachmentTextExtraction {
  const parsedMediaType = parseMediaType(input.mediaType);
  const format = selectFormat(parsedMediaType, input.displayName);
  const decoded = decodeUtf8(input.bytes);
  const warnings: string[] = [];
  let prepared: string;
  if (format === "csv") {
    const csv = parseCsv(decoded);
    prepared = csv.rows.map((row) => JSON.stringify(row)).join("\n");
    if (csv.formulaLikeCells > 0) warnings.push(`csv_formula_like_cells_present:${csv.formulaLikeCells}`);
  } else {
    prepared = normalizedPlainText(decoded);
  }
  const bounded = boundedText(prepared, warnings);
  const chunks = buildChunks(bounded.text, bounded.truncated, warnings);
  return {
    format,
    characterCount: bounded.text.length,
    lineCount: bounded.text ? bounded.text.split("\n").length : 0,
    chunks,
    truncated: bounded.truncated,
    warnings,
  };
}
