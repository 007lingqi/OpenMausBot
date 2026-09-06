import { isAbsolute } from "node:path";
import { ModelNaturalIntakeInterpreter, type NaturalIntakeModelPort } from "../natural-intake.ts";
import { readSecureCredentialFile } from "./credentials.ts";
import { abortable, readOpenCodexStream } from "./opencodex-stream.ts";

type ModelInput = Parameters<NaturalIntakeModelPort["complete"]>[0];
interface Options {
  endpoint: string;
  model: string;
  credential?: () => string;
  transport?: "responses" | "opencodex_local";
  reasoningEffort?: string;
  fetch?: typeof globalThis.fetch;
  allowInsecureLoopback?: boolean;
}

function endpoint(value: string, allowInsecureLoopback = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("natural_model_endpoint_invalid"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && local && url.protocol === "http:"))) {
    throw new Error("natural_model_endpoint_invalid");
  }
  return url.href;
}

async function boundedBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("natural_model_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) throw new Error("natural_model_output_limit");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new Error("natural_model_response_invalid"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only text goes over this wire. There is deliberately no tool dispatcher or tool result loop. */
export class ResponsesNaturalIntakeModel implements NaturalIntakeModelPort {
  private readonly url: string;
  private readonly model: string;
  private readonly credential: (() => string) | undefined;
  private readonly streaming: boolean;
  private readonly effort: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(options: Options) {
    if (options.transport && !["responses", "opencodex_local"].includes(options.transport)) throw new Error("natural_model_configuration_required");
    this.streaming = options.transport === "opencodex_local";
    this.effort = options.reasoningEffort ?? "medium";
    if (this.streaming) {
      let url: URL; try { url = new URL(options.endpoint); } catch { throw new Error("natural_model_endpoint_invalid"); }
      if (!["127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.pathname !== "/v1/responses") throw new Error("natural_model_endpoint_invalid");
      if (options.credential || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(this.effort)) throw new Error("natural_model_configuration_required");
    } else if (!options.credential || options.reasoningEffort !== undefined) throw new Error("natural_model_configuration_required");
    this.url = endpoint(options.endpoint, this.streaming || options.allowInsecureLoopback);
    this.model = options.model.trim();
    if (!this.model || this.model.length > 200 || /[\r\n]/u.test(this.model)) throw new Error("natural_model_name_invalid");
    this.credential = options.credential;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async complete(input: ModelInput): Promise<unknown> {
    if (input.signal.aborted) throw new Error("natural_model_cancelled");
    const body = JSON.stringify({ model: this.model, instructions: input.system,
      input: [{ role: "user", content: [{ type: "input_text", text: input.user }] }],
      store: false, tools: [], tool_choice: "none", parallel_tool_calls: false,
      ...(this.streaming ? { stream: true, reasoning: { effort: this.effort } } : {}),
      text: { format: { type: "json_schema", name: "natural_intake", strict: true, schema: input.responseSchema } },
    });
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error("natural_model_input_limit");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!this.streaming) {
      let key: string;
      try { key = this.credential!().trim(); } catch { throw new Error("natural_model_credentials_unavailable"); }
      if (!key || key.length > 16_384 || /[^\x21-\x7e]/u.test(key)) throw new Error("natural_model_credentials_unavailable");
      headers.Authorization = `Bearer ${key}`;
    }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
    let response: Response;
    try {
      response = await abortable(this.fetcher(this.url, { method: "POST", redirect: "error", headers, body, signal }), signal,
        late => { void late.body?.cancel().catch(() => undefined); });
    } catch { throw new Error(input.signal.aborted ? "natural_model_cancelled" : "natural_model_transport_unavailable"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`natural_model_http_${response.status}`);
    }
    if (this.streaming) {
      try { return await readOpenCodexStream(response, this.model, this.effort, signal); }
      catch (error) { if (input.signal.aborted) throw new Error("natural_model_cancelled"); throw error; }
    }
    let raw: unknown;
    try { raw = await boundedBody(response); } catch (error) {
      if (error instanceof Error && ["natural_model_output_limit", "natural_model_response_invalid"].includes(error.message)) throw error;
      throw new Error(input.signal.aborted ? "natural_model_cancelled" : "natural_model_transport_unavailable");
    }
    const root = record(raw);
    if (root?.status !== "completed" || root.error || !Array.isArray(root.output)) throw new Error("natural_model_response_invalid");
    const text: string[] = [];
    for (const raw of root.output) {
      const item = record(raw);
      if (item?.type === "reasoning") continue;
      if (item?.type !== "message" || !Array.isArray(item.content)) throw new Error("natural_model_response_invalid");
      for (const value of item.content) {
        const part = record(value);
        if (part?.type !== "output_text" || typeof part.text !== "string") throw new Error("natural_model_response_invalid");
        text.push(part.text);
      }
    }
    try { return JSON.parse(text.join("")) as unknown; }
    catch { throw new Error("natural_model_response_invalid"); }
  }
}

export function configuredNaturalIntake(environment: NodeJS.ProcessEnv): ModelNaturalIntakeInterpreter | undefined {
  if (environment.OMB_NATURAL_INTAKE_ENABLED !== "1") return undefined;
  const model = environment.OMB_NATURAL_INTAKE_MODEL?.trim();
  const url = environment.OMB_NATURAL_INTAKE_ENDPOINT?.trim();
  const file = environment.OMB_NATURAL_INTAKE_CREDENTIAL_FILE?.trim();
  const transport = environment.OMB_NATURAL_INTAKE_TRANSPORT?.trim() || "responses";
  if (transport === "opencodex_local") {
    if (!model || !url || file) throw new Error("natural_model_configuration_required");
    return new ModelNaturalIntakeInterpreter(new ResponsesNaturalIntakeModel({ model, endpoint: url, transport,
      reasoningEffort: environment.OMB_NATURAL_INTAKE_REASONING_EFFORT?.trim() || "medium" }));
  }
  if (transport !== "responses" || environment.OMB_NATURAL_INTAKE_REASONING_EFFORT) throw new Error("natural_model_configuration_required");
  if (!model || !url || !file || !isAbsolute(file)) throw new Error("natural_model_configuration_required");
  return new ModelNaturalIntakeInterpreter(new ResponsesNaturalIntakeModel({ model, endpoint: url,
    allowInsecureLoopback: environment.OMB_NATURAL_INTAKE_ALLOW_LOOPBACK_HTTP === "1",
    credential: () => { const raw = readSecureCredentialFile(file); try { return raw.toString("utf8").trim(); } finally { raw.fill(0); } },
  }));
}
