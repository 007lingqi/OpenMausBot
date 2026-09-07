import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { CommandCleanupError, runArgv, type ArgvResult } from "../execution-limits.ts";
import { redactSensitiveText } from "../sensitive-text.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/u);
const grantSchema = z.object({ id, profile: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]*:[A-Za-z0-9_][A-Za-z0-9_.@-]*$/u),
  conversationId: z.string().min(1).max(512), node: z.string().min(1).max(2048), canonicalId: id.optional(), product: z.enum(["doc", "sheet"]) }).strict();
const sourceSchema = z.object({ conversationId: z.string().min(1).max(512), sourceEventId: z.string().min(1).max(256),
  normalizedHash: z.string().regex(/^[a-f0-9]{64}$/u), node: z.string().min(1).max(2048) }).strict();
export type OnlineReadGrant = z.infer<typeof grantSchema>;
export type OnlineReadSource = z.infer<typeof sourceSchema>;
export interface DwsReadCommandPort {
  run(args: readonly string[], signal: AbortSignal): Promise<Pick<ArgvResult, "exitCode" | "stdout" | "stderr" | "timedOut" | "outputLimitExceeded">>;
}
export interface OnlineBodyRecord { location: string; text: string; untrusted: true }
export interface OnlineBodyReceipt {
  sourceEventId: string; normalizedHash: string; grantFingerprint: string; contentHash: string;
  product: "doc" | "sheet"; scope: "full_document" | "all_worksheets"; complete: true;
  records: OnlineBodyRecord[]; worksheets: Array<{ sheetId: string; title: string }>; responseHashes: string[];
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid(): never { throw new Error("online_document_read_unverified"); }
function active(signal: AbortSignal): void { if (signal.aborted) throw new Error("online_document_read_cancelled"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function completeness(value: Record<string, unknown>): void {
  if (value.hasMore === true || value.complete === false || value.truncated === true || value.ok === false || value.success === false ||
    value.error != null || [value.failures, value.warnings, value.truncationReasons].some(v => v !== undefined && (!Array.isArray(v) || v.length > 0))) invalid();
}
function rejectMock(value: unknown, depth = 0): void {
  if (depth > 64) invalid();
  // JSON numbers outside the safe integer range may already have lost identifier digits.
  // Do not publish rounded IDs or non-finite values as precise document evidence.
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) invalid();
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && (value as Record<string, unknown>)._mock === true) invalid();
  for (const child of Object.values(value)) rejectMock(child, depth + 1);
}
function grantTarget(grant: OnlineReadGrant): void {
  if (id.safeParse(grant.node).success) return;
  try {
    const url = new URL(grant.node);
    if (url.protocol !== "https:" || url.hostname !== "alidocs.dingtalk.com" || url.username || url.password || url.port ||
      !grant.canonicalId || url.pathname.includes("/i/p/") || url.hash ||
      [...url.searchParams.keys()].some(key => !["dentryKey", "type"].includes(key))) invalid();
    if (!/^\/i\/nodes\/[^/]+\/?$/u.test(url.pathname) && !/^\/document\/(edit|preview)$/u.test(url.pathname) && !url.pathname.startsWith("/spreadsheetv2/")) invalid();
  } catch { throw new Error("online_document_grant_invalid"); }
}

/** No shell, no inherited project env/secrets, no write commands, no identity selection.
 * Cancellation waits for the bounded read/cleanup before discarding output; it is not a detached Promise.race.
 */
export class NodeDwsReadCommandPort implements DwsReadCommandPort {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(input: { executable: string; configDirectory: string; home: string; cwd: string; path: string }) {
    if (![input.executable, input.configDirectory, input.home, input.cwd].every(isAbsolute) || !input.path) throw new Error("online_document_cli_configuration_invalid");
    this.executable = input.executable; this.cwd = input.cwd;
    this.environment = { PATH: input.path, HOME: input.home, DWS_CONFIG_DIR: input.configDirectory, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1" };
  }
  async run(args: readonly string[], signal: AbortSignal) {
    active(signal);
    validateReadArgs(args);
    let result: ArgvResult;
    try { result = await runArgv({ argv: [this.executable, ...args], timeoutMs: 35_000, maxOutputBytes: MAX_BYTES }, { cwd: this.cwd, env: this.environment }); }
    catch (error) {
      if (error instanceof CommandCleanupError) throw new CommandCleanupError(new Error("dws_read_cleanup_unconfirmed"));
      active(signal); return invalid();
    }
    active(signal);
    return result;
  }
}

/** Trusted configuration grants exact targets to exact groups. Message data cannot choose an identity.
 * This reader has no retry loop or external write capability. Persistence/lease policy belongs to its coordinator.
 */
export class DwsOnlineDocumentReader {
  private readonly grants: readonly OnlineReadGrant[];
  private readonly port: DwsReadCommandPort;
  constructor(grants: readonly OnlineReadGrant[], port: DwsReadCommandPort) {
    this.port = port;
    this.grants = grants.map(value => { const grant = grantSchema.parse(value); grantTarget(grant); return Object.freeze(grant); });
    if (new Set(this.grants.map(g => g.id)).size !== this.grants.length ||
      new Set(this.grants.map(g => JSON.stringify([g.conversationId, g.node]))).size !== this.grants.length) throw new Error("online_document_grant_ambiguous");
  }
  async read(input: OnlineReadSource, signal: AbortSignal): Promise<OnlineBodyReceipt> {
    active(signal);
    const source = sourceSchema.parse(input);
    const grant = this.grants.find(value => value.conversationId === source.conversationId && value.node === source.node);
    if (!grant) throw new Error("online_document_not_authorized");
    let bytes = 0;
    const responseHashes: string[] = [];
    const call = async (command: string, extra: readonly string[] = []) => {
      active(signal);
      const args = [grant.product, command, "--node", grant.node, ...extra, "--profile", grant.profile, "--format", "json", "--timeout", "30"];
      let response: Awaited<ReturnType<DwsReadCommandPort["run"]>>;
      try { response = await this.port.run(args, signal); }
      catch (error) { if (error instanceof CommandCleanupError) throw error; active(signal); return invalid(); }
      active(signal);
      bytes += response.stdout.length + response.stderr.length;
      if (response.exitCode !== 0 || response.timedOut || response.outputLimitExceeded || bytes > MAX_BYTES) invalid();
      responseHashes.push(createHash("sha256").update(response.stdout).digest("hex"));
      let parsed: unknown;
      try { parsed = JSON.parse(response.stdout.toString("utf8")); } catch { return invalid(); }
      rejectMock(parsed);
      const envelope = object(parsed); completeness(envelope);
      return envelope;
    };
    const records: OnlineBodyRecord[] = [];
    const add = (location: string, value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof text !== "string" || !text.length || records.length >= 20_000) invalid();
      records.push({ location, text: redactSensitiveText(text), untrusted: true });
    };
    let worksheets: Array<{ sheetId: string; title: string }> = [];
    if (grant.product === "doc") {
      const envelope = await call("+fetch", ["--scope", "full", "--detail", "simple"]);
      const target = object(envelope.target);
      if (envelope.contractVersion !== "doc.content.v1" || envelope.status !== "success" || envelope.complete !== true ||
        target.product !== "doc" || target.canonicalId !== (grant.canonicalId ?? grant.node) || typeof envelope.content !== "string") invalid();
      // The documented simple projection is Markdown. Unknown object wrappers are not body evidence.
      // Media referenced by Markdown is not read by this text-only adapter.
      if (/!\[|<\s*(?:img|video|audio|iframe|object|embed|svg)\b/iu.test(envelope.content)) invalid();
      add(`document:${target.canonicalId}`, envelope.content);
    } else {
      const sheets = async () => {
        const envelope = await call("+list-sheets");
        if (envelope.ok !== true || envelope.outcome !== "success") invalid();
        const data = object(envelope.data); completeness(data);
        const schema = z.object({ count: z.number().int().nonnegative().max(20), sheets: z.array(z.object({ sheetId: id, title: z.string().max(2000) }).passthrough()).max(20) });
        const parsed = schema.safeParse(data);
        if (!parsed.success || parsed.data.count !== parsed.data.sheets.length || new Set(parsed.data.sheets.map(s => s.sheetId)).size !== parsed.data.count) return invalid();
        return parsed.data.sheets.map(({ sheetId, title }) => ({ sheetId, title }));
      };
      const initial = await sheets();
      // A workbook without any worksheets is not an actionable Bug document.
      if (!initial.length) invalid();
      for (const sheet of initial) {
        const envelope = await call("+read", ["--sheet-id", sheet.sheetId]);
        if (envelope.ok !== true || envelope.outcome !== "success") invalid();
        const data = object(envelope.data); completeness(data);
        const parsed = sheetData.safeParse(data);
        if (!parsed.success) invalid();
        const value = parsed.data;
        if (value.cells.length !== value.rowIndices.length || value.cells.some(row => row.length !== value.colIndices.length) ||
          value.rowIndices.some((row, i) => i > 0 && row !== value.rowIndices[i - 1] + 1) ||
          value.colIndices.some((col, i) => i > 0 && column(col) !== column(value.colIndices[i - 1]) + 1)) invalid();
        if (value.cells.length) {
          const expected = `${value.colIndices[0]}${value.rowIndices[0]}:${value.colIndices.at(-1)}${value.rowIndices.at(-1)}`;
          if (range(value.returnedRange) !== expected || range(value.resolvedRange) !== expected) invalid();
        } else if (value.rowIndices.length || value.colIndices.length) invalid();
        value.cells.forEach((row, r) => row.forEach((cell, c) => add(`sheet:${sheet.sheetId}!${value.colIndices[c]}${value.rowIndices[r]}`, cell)));
      }
      if (JSON.stringify(await sheets()) !== JSON.stringify(initial)) invalid();
      worksheets = initial.map(sheet => ({ ...sheet, title: redactSensitiveText(sheet.title) }));
    }
    active(signal);
    return { sourceEventId: source.sourceEventId, normalizedHash: source.normalizedHash, grantFingerprint: hash(grant),
      product: grant.product, scope: grant.product === "doc" ? "full_document" : "all_worksheets", complete: true,
      contentHash: hash({ records, worksheets }), records, worksheets, responseHashes };
  }
}
const sheetData = z.object({ complete: z.literal(true), hasMore: z.literal(false), truncationReasons: z.array(z.string()).max(0),
  cells: z.array(z.array(z.record(z.string(), z.unknown()))), rowIndices: z.array(z.number().int().positive().max(1_000_000_000)),
  colIndices: z.array(z.string().regex(/^[A-Z]{1,6}$/u)), returnedRange: z.string().optional(), resolvedRange: z.string().optional() });
function column(value: string): number { return [...value].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0); }
function range(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  return /^[A-Z]+\d+$/u.test(normalized) ? `${normalized}:${normalized}` : normalized;
}
function validateReadArgs(args: readonly string[]): void {
  const deny = (): never => { throw new Error("online_document_command_denied"); };
  const extra = args[0] === "doc" && args[1] === "+fetch" ? ["--scope", "--detail"] :
    args[0] === "sheet" && args[1] === "+read" ? ["--sheet-id"] :
      args[0] === "sheet" && args[1] === "+list-sheets" ? [] : deny();
  const required = ["--node", "--profile", "--format", "--timeout", ...extra];
  if (args.length !== 2 + required.length * 2) deny();
  const flags = new Map<string, string>();
  for (let i = 2; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!required.includes(key) || flags.has(key) || !value || value.startsWith("-") || /[\0\r\n]/u.test(value)) deny();
    flags.set(key, value);
  }
  if (required.some(key => !flags.has(key)) || flags.get("--format") !== "json" || flags.get("--timeout") !== "30" ||
    !grantSchema.shape.profile.safeParse(flags.get("--profile")).success ||
    (extra.includes("--scope") && (flags.get("--scope") !== "full" || flags.get("--detail") !== "simple"))) deny();
}
