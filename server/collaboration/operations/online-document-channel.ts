import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstatSync, realpathSync } from "node:fs";
import { createServer, request, type ServerResponse } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { CommandCleanupError } from "../execution-limits.ts";
import { DwsOnlineDocumentReader, onlineReadSourceSchema, type OnlineDocumentReader, type OnlineReadGrant,
  type OnlineReadSource, type OnlineBodyReceipt } from "./dws-online-reader.ts";

const ROUTE = "/v1/documents/read", INPUT_LIMIT = 8192, OUTPUT_LIMIT = 4 * 1024 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.object({ sourceEventId: z.string(), normalizedHash: sha, grantFingerprint: sha, contentHash: sha,
  product: z.enum(["doc", "sheet"]), scope: z.enum(["full_document", "all_worksheets"]), complete: z.literal(true),
  records: z.array(z.object({ location: z.string().min(1).max(512), text: z.string().min(1), untrusted: z.literal(true) }).strict()).min(1).max(20000),
  worksheets: z.array(z.object({ sheetId: z.string().min(1).max(256), title: z.string().max(2000) }).strict()).max(20),
  responseHashes: z.array(sha).min(1).max(22) }).strict();

export function validateOnlineDocumentSocketPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || Buffer.byteLength(path) > 100) {
    throw new Error("online_document_socket_invalid");
  }
}
function privateSocket(path: string): void {
  validateOnlineDocumentSocketPath(path);
  try {
    const parent = dirname(path), directory = lstatSync(parent), socket = lstatSync(path), uid = process.getuid?.();
    if (uid === undefined || !directory.isDirectory() || realpathSync(parent) !== parent || directory.uid !== uid ||
      (directory.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) throw new Error();
  } catch { throw new Error("online_document_socket_unavailable"); }
}
function unconfirmed(): CommandCleanupError { return new CommandCleanupError(new Error("online_document_remote_cleanup_unconfirmed")); }

/** The controller sends a source, never CLI argv, profile overrides or credentials.
 * A lost/invalid response cannot prove the host read settled; quarantine instead of retrying it. */
abstract class SourceBoundOnlineDocumentReader implements OnlineDocumentReader {
  private readonly authority: DwsOnlineDocumentReader;
  private readonly grants: readonly OnlineReadGrant[];
  constructor(grants: readonly OnlineReadGrant[]) {
    this.authority = new DwsOnlineDocumentReader(grants, { async run() { throw new Error("online_document_local_execution_denied"); } });
    this.grants = structuredClone(grants);
  }
  protected abstract exchange(source: OnlineReadSource, signal: AbortSignal): Promise<unknown>;
  authorizationFingerprint(input: OnlineReadSource): string { return this.authority.authorizationFingerprint(input); }
  async read(input: OnlineReadSource, signal: AbortSignal): Promise<OnlineBodyReceipt> {
    signal.throwIfAborted();
    const source = onlineReadSourceSchema.parse(input), fingerprint = this.authorizationFingerprint(source);
    const raw = await this.exchange(source, signal);
    signal.throwIfAborted();
    const value = decodeReceipt(raw, source), grant = this.grants.find(g => g.conversationId === source.conversationId && g.node === source.node)!;
    if (value.grantFingerprint !== fingerprint || value.product !== grant.product ||
      value.scope !== (grant.product === "doc" ? "full_document" : "all_worksheets")) throw unconfirmed();
    return value;
  }
}

function exchange(transport: { socketPath: string } | { port: number }, body: string, signal: AbortSignal, status = 200, timeoutMs = 160000): Promise<unknown> {
  signal.throwIfAborted();
  if (Buffer.byteLength(body) > INPUT_LIMIT) throw new Error("online_document_source_invalid");
  return new Promise<unknown>((resolveResponse, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        call.destroy(); if (error) reject(error); else resolveResponse(value);
      };
      const abort = () => finish(unconfirmed());
      const call = request({ ...transport, ...("port" in transport ? { hostname: "127.0.0.1" } : {}), path: ROUTE, method: "POST", agent: false, maxHeaderSize: 4096,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== status || response.headers["content-type"] !== "application/json") { response.resume(); finish(unconfirmed()); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("error", () => finish(unconfirmed())); response.on("aborted", () => finish(unconfirmed()));
        response.on("data", (chunk: Buffer) => { size += chunk.length;
          if (size > OUTPUT_LIMIT) { response.destroy(); finish(unconfirmed()); } else chunks.push(chunk); });
        response.on("end", () => { try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(unconfirmed()); } });
      });
      // Host budget is 120s plus at most one bounded 35s CLI cleanup.
      const timer = setTimeout(() => finish(unconfirmed()), timeoutMs);
      call.on("error", () => finish(unconfirmed()));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else call.end(body);
  });
}
function decodeReceipt(raw: unknown, source: OnlineReadSource): OnlineBodyReceipt {
    const envelope = z.object({ version: z.literal(1), status: z.enum(["success", "failure"]), cleanupConfirmed: z.boolean(), receipt: z.unknown().optional() }).strict().safeParse(raw);
    if (!envelope.success || !envelope.data.cleanupConfirmed) throw unconfirmed();
    if (envelope.data.status !== "success") throw new Error("online_document_read_unverified");
    const parsed = receiptSchema.safeParse(envelope.data.receipt);
    if (!parsed.success) throw unconfirmed();
    const value = parsed.data;
    if (value.sourceEventId !== source.sourceEventId || value.normalizedHash !== source.normalizedHash ||
      value.contentHash !== hash({ records: value.records, worksheets: value.worksheets })) throw unconfirmed();
    return value;
}

export class PrivateSocketOnlineDocumentReader extends SourceBoundOnlineDocumentReader {
  private readonly socketPath: string;
  constructor(grants: readonly OnlineReadGrant[], socketPath: string) { super(grants); validateOnlineDocumentSocketPath(socketPath); this.socketPath = socketPath; }
  protected exchange(source: OnlineReadSource, signal: AbortSignal): Promise<unknown> {
    privateSocket(this.socketPath); return exchange({ socketPath: this.socketPath }, JSON.stringify({ version: 1, source }), signal);
  }
}
/** Controller-side access only to the explicitly configured unprivileged in-container relay. */
export class DockerRelayOnlineDocumentReader extends SourceBoundOnlineDocumentReader {
  private readonly port: number;
  constructor(grants: readonly OnlineReadGrant[], port: number) {
    super(grants); if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("online_document_relay_configuration_invalid"); this.port = port;
  }
  protected exchange(source: OnlineReadSource, signal: AbortSignal): Promise<unknown> {
    return exchange({ port: this.port }, JSON.stringify({ version: 1, source }), signal);
  }
}
export async function forwardOnlineDocumentSource(socketPath: string, source: OnlineReadSource, signal: AbortSignal): Promise<OnlineBodyReceipt> {
  privateSocket(socketPath);
  return decodeReceipt(await exchange({ socketPath }, JSON.stringify({ version: 1, source: onlineReadSourceSchema.parse(source) }), signal), source);
}
/** A deliberately invalid request proves protocol availability without reading a document. */
export async function probeOnlineDocumentSocket(socketPath: string): Promise<void> {
  privateSocket(socketPath);
  const result = await exchange({ socketPath }, "{}", new AbortController().signal, 400, 1500);
  const parsed = z.object({ version: z.literal(1), status: z.literal("failure"), cleanupConfirmed: z.literal(true) }).strict().safeParse(result);
  if (!parsed.success) throw new Error("online_document_relay_probe_failed");
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
/** Loopback host endpoint for a separately restricted private SSH socket. It has
 * its own immutable grants and no model, shell, write, identity-selection or log API. */
export async function startOnlineDocumentGateway(options: { port?: number } & ({ reader: OnlineDocumentReader; forward?: never } |
  { reader?: never; forward(source: OnlineReadSource, signal: AbortSignal): Promise<OnlineBodyReceipt> })): Promise<{ url: string; close(): Promise<void> }> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("online_document_gateway_configuration_invalid");
  const pending = new Set<Promise<void>>(), controllers = new Set<AbortController>(); let closing = false;
  const server = createServer((incoming, response) => {
    const reject = (status: number) => { incoming.resume(); reply(response, status, { version: 1, status: "failure", cleanupConfirmed: true }); };
    if (closing || pending.size >= 4) { reject(503); return; }
    if (incoming.method !== "POST" || incoming.url !== ROUTE || incoming.headers.origin !== undefined ||
      incoming.headers.authorization !== undefined || incoming.headers.cookie !== undefined || incoming.headers["sec-fetch-site"] !== undefined ||
      incoming.headers["content-type"] !== "application/json" || Number(incoming.headers["content-length"]) > INPUT_LIMIT) { reject(400); return; }
    const controller = new AbortController(); controllers.add(controller);
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.on("close", disconnect);
    const timer = setTimeout(() => { controller.abort(); if (!incoming.complete) incoming.destroy(); }, 120000);
    const task = (async () => {
      let readStarted = false;
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of incoming) { controller.signal.throwIfAborted(); size += chunk.length;
          if (size > INPUT_LIMIT) throw new Error("input_limit"); chunks.push(Buffer.from(chunk)); }
        const input = z.object({ version: z.literal(1), source: onlineReadSourceSchema }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        options.reader?.authorizationFingerprint(input.source);
        controller.signal.throwIfAborted(); readStarted = true;
        const receipt = options.reader ? await options.reader.read(input.source, controller.signal) : await options.forward(input.source, controller.signal);
        controller.signal.throwIfAborted();
        const output = { version: 1, status: "success", cleanupConfirmed: true, receipt };
        if (Buffer.byteLength(JSON.stringify(output)) > OUTPUT_LIMIT) throw new Error("output_limit");
        reply(response, 200, output);
      } catch (error) {
        reply(response, readStarted ? 200 : 400, { version: 1, status: "failure", cleanupConfirmed: !(error instanceof CommandCleanupError) });
      } finally { clearTimeout(timer); controllers.delete(controller); response.off("close", disconnect); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.headersTimeout = 10000; server.requestTimeout = 120000; server.maxHeadersCount = 32;
  const listening = once(server, "listening"); server.listen(port, "127.0.0.1"); await listening;
  const address = server.address(); if (!address || typeof address === "string") throw new Error("online_document_gateway_configuration_invalid");
  let stop: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${address.port}${ROUTE}`, close() {
    stop ??= (async () => { closing = true; for (const controller of controllers) controller.abort();
      const closed = new Promise<void>(resolveClosed => server.close(() => resolveClosed())); server.closeAllConnections();
      await Promise.all([...pending]); await closed;
    })(); return stop;
  } };
}
