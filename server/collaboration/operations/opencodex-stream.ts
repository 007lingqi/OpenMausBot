/** A bounded, tool-free Responses stream. No partial text is a completed proposal. */
// SSE includes per-token envelopes and repeated done snapshots. Bound that wire
// separately while retaining the original ceiling for actual proposal text.
const WIRE_LIMIT = 8 * 1024 * 1024, TEXT_LIMIT = 256 * 1024;
type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as RecordValue;
}
function invalid(): never { throw new Error("natural_model_response_invalid"); }
function index(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); return Number(value); }
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("natural_model_transport_unavailable"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { if (signal.aborted) disposeLate?.(value); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

export async function readOpenCodexStream(response: Response, model: string, effort: string, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
    void response.body?.cancel().catch(() => undefined); invalid();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, textBytes = 0, pending = "", data: string[] = [], eventName = "", responseId = "", complete = false;
  type Part = { text: string; textDone: boolean; partDone: boolean };
  type Item = { id: string; type: string; done: boolean; parts: Map<number, Part> };
  const items = new Map<number, Item>();
  const itemFor = (e: RecordValue) => {
    const item = items.get(index(e.output_index));
    if (!item || item.id !== e.item_id || item.done) invalid();
    return item;
  };
  const contentMatches = (item: Item, content: unknown) => {
    if (!Array.isArray(content) || content.length !== item.parts.size) invalid();
    content.forEach((raw, i) => {
      const part = object(raw), saved = item.parts.get(i);
      if (part.type !== "output_text" || !saved?.textDone || !saved.partDone || part.text !== saved.text) invalid();
    });
  };
  const dispatch = () => {
    if (data.length === 0) { eventName = ""; return; }
    const payload = data.join("\n"); data = [];
    if (payload === "[DONE]") { if (!complete) invalid(); eventName = ""; return; }
    if (complete) invalid();
    let e: RecordValue; try { e = object(JSON.parse(payload)); } catch { invalid(); }
    if (eventName && eventName !== e.type) invalid(); eventName = "";
    if (e.type === "response.created") {
      if (responseId || typeof e.response?.id !== "string" || !e.response.id) invalid();
      responseId = e.response.id; return;
    }
    if (!responseId) invalid();
    if (e.type === "response.in_progress") {
      if (e.response?.id !== responseId || e.response?.status !== "in_progress") invalid(); return;
    }
    if (e.type === "response.output_item.added") {
      const n = index(e.output_index), item = object(e.item);
      if (items.has(n) || typeof item.id !== "string" || !item.id || [...items.values()].some(x => x.id === item.id) ||
        !["message", "reasoning"].includes(item.type) || (item.type === "message" && item.role !== "assistant")) invalid();
      items.set(n, { id: item.id, type: item.type, done: false, parts: new Map() }); return;
    }
    if (e.type === "response.output_item.done") {
      const item = items.get(index(e.output_index)), raw = object(e.item);
      if (!item || item.done || raw.id !== item.id || raw.type !== item.type) invalid();
      if (item.type === "message") {
        if (raw.role !== "assistant" || raw.status !== "completed") invalid(); contentMatches(item, raw.content);
      }
      item.done = true; return;
    }
    if (e.type === "response.content_part.added") {
      const item = itemFor(e), n = index(e.content_index);
      if (item.type !== "message" || item.parts.has(n) || e.part?.type !== "output_text" || e.part.text !== "") invalid();
      item.parts.set(n, { text: "", textDone: false, partDone: false }); return;
    }
    if (["response.output_text.delta", "response.output_text.done", "response.content_part.done"].includes(e.type)) {
      const item = itemFor(e), part = item.parts.get(index(e.content_index));
      if (item.type !== "message" || !part || part.partDone) invalid();
      if (e.type === "response.output_text.delta") {
        if (part.textDone || typeof e.delta !== "string") invalid();
        textBytes += Buffer.byteLength(e.delta, "utf8");
        if (textBytes > TEXT_LIMIT) throw new Error("natural_model_output_limit");
        part.text += e.delta;
      } else if (e.type === "response.output_text.done") {
        if (part.textDone || typeof e.text !== "string" || e.text !== part.text) invalid(); part.textDone = true;
      } else {
        if (!part.textDone || e.part?.type !== "output_text" || e.part.text !== part.text) invalid(); part.partDone = true;
      }
      return;
    }
    if (/^response\.reasoning_(?:summary_part\.(?:added|done)|summary_text\.(?:delta|done)|text\.(?:delta|done))$/.test(e.type)) {
      if (itemFor(e).type !== "reasoning") invalid(); return;
    }
    if (e.type === "response.completed") {
      const r = object(e.response);
      if (r.id !== responseId || r.model !== model || r.status !== "completed" || r.error || r.reasoning?.effort !== effort || !Array.isArray(r.output) ||
        !items.size || [...items.values()].some(item => !item.done)) invalid();
      // OpenCodex may omit completed.output. If present, it must agree with streamed items.
      if (r.output.length) {
        if (r.output.length !== items.size) invalid();
        r.output.forEach((raw: unknown, n: number) => {
          const value = object(raw), item = items.get(n);
          if (!item || value.id !== item.id || value.type !== item.type) invalid();
          if (item.type === "message") { if (value.role !== "assistant") invalid(); contentMatches(item, value.content); }
        });
      }
      complete = true; return;
    }
    invalid(); // Failed/incomplete/refusal/tool and unknown events cannot authorize a result.
  };
  const line = (value: string) => {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
    const rest = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(rest);
    else if (field === "event") eventName = rest;
    else if (!["id", "retry"].includes(field)) invalid();
  };
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > WIRE_LIMIT) throw new Error("natural_model_output_limit");
      pending += decoder.decode(chunk.value, { stream: true });
      let pos: number;
      while ((pos = pending.indexOf("\n")) >= 0) { line(pending.slice(0, pos)); pending = pending.slice(pos + 1); }
    }
    pending += decoder.decode();
    if (signal.aborted || !complete || pending.trim() || data.length || eventName) invalid();
    const text = [...items.entries()].sort(([a], [b]) => a - b).flatMap(([, item]) => item.type === "message"
      ? [...item.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part.text) : []).join("");
    try { return JSON.parse(text) as unknown; } catch { invalid(); }
  } catch (error) {
    if (error instanceof Error && ["natural_model_response_invalid", "natural_model_output_limit", "natural_model_transport_unavailable"].includes(error.message)) throw error;
    invalid();
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
