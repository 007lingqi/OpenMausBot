import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { ResponsesNaturalIntakeModel, configuredNaturalIntake } from "./natural-intake-model.ts";
import { configuredAcceptanceMapping } from "./acceptance-mapping-model.ts";

const input = () => ({ system: "只整理需求", user: "请解释这个问题", responseSchema: { type: "object", properties: {}, additionalProperties: false }, signal: new AbortController().signal });
const options = { endpoint: "http://127.0.0.1:10100/v1/responses", model: "gpt-6-astra", transport: "opencodex_local" as const };
const snapshot = (status: string) => ({ id: "resp-1", model: "gpt-6-astra", status, reasoning: { effort: "medium" }, output: [] });
function events(text = '{"result":"中文"}') {
  return [
    { type: "response.created", response: snapshot("in_progress") },
    { type: "response.in_progress", response: snapshot("in_progress") },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: "msg-1", output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text } },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: snapshot("completed") },
  ];
}
const wire = (rows: unknown[]) => rows.map(e => `event: ${(e as {type:string}).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("");
function response(rows: unknown[], bytes = 7) {
  const data = Buffer.from(wire(rows));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < data.length; i += bytes) c.enqueue(data.subarray(i, i + bytes)); c.close(); } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
function model(rows = events()) { return new ResponsesNaturalIntakeModel({ ...options, fetch: async () => response(rows) }); }
function env(prefix = "OMB_NATURAL_INTAKE") { return { [`${prefix}_TRANSPORT`]: "opencodex_local", [`${prefix}_MODEL`]: options.model, [`${prefix}_ENDPOINT`]: options.endpoint }; }

describe("explicit local OpenCodex streaming model", () => {
  it("uses real HTTP, no credential or Authorization, medium effort, schema and isolated tool-free input", async () => {
    let requestBody: any, headers: any;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString()); headers = req.headers;
      res.setHeader("Content-Type", "text/event-stream"); res.end(wire(events()));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("address");
      const client = new ResponsesNaturalIntakeModel({ ...options, endpoint: `http://127.0.0.1:${address.port}/v1/responses` });
      expect(await client.complete(input())).toEqual({ result: "中文" });
      expect(headers.authorization).toBeUndefined();
      expect(requestBody).toMatchObject({ model: options.model, reasoning: { effort: "medium" }, stream: true, store: false, tools: [], tool_choice: "none", text: { format: { type: "json_schema", strict: true } } });
      expect(requestBody.input).toBeInstanceOf(Array); expect(requestBody).not.toHaveProperty("previous_response_id");
    } finally { await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }); }
  });
  it("handles split UTF-8/CRLF and an empty completed.output using matching streamed text evidence", async () => {
    expect(await model().complete(input())).toEqual({ result: "中文" });
  });
  it("accepts bounded JSON when small token events exceed the old transport ceiling", async () => {
    const value = { result: "验收依据".repeat(800) }, text = JSON.stringify(value);
    const rows = events(text);
    const delta = rows[4];
    if (typeof delta.delta !== "string") throw new Error("expected delta fixture");
    rows.splice(4, 1, ...Array.from(text).map(char => ({ ...delta, delta: char })));
    expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(wire(rows))).toBeGreaterThan(256 * 1024);
    const client = new ResponsesNaturalIntakeModel({ ...options, fetch: async () => response(rows, 4093) });
    expect(await client.complete(input())).toEqual(value);
  });
  it("bounds decoded text separately from protocol bytes and cancels oversized output", async () => {
    const cancelled = vi.fn();
    const rows = events(JSON.stringify({ result: "中".repeat(90_000) }));
    const data = Buffer.from(wire(rows));
    expect(data.byteLength).toBeLessThan(8 * 1024 * 1024);
    const client = new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(data); }, cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }) });
    await expect(client.complete(input())).rejects.toThrow("natural_model_output_limit");
    expect(cancelled).toHaveBeenCalled();
  });
  it("bounds total wire traffic even when it contains only ignored heartbeat comments", async () => {
    const data = ": heartbeat\n".repeat(700_000), cancelled = vi.fn();
    expect(Buffer.byteLength(data)).toBeGreaterThan(8 * 1024 * 1024);
    const client = new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(Buffer.from(data)); }, cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }) });
    await expect(client.complete(input())).rejects.toThrow("natural_model_output_limit");
    expect(cancelled).toHaveBeenCalled();
  });
  it.each(["http://remote.invalid/v1/responses", "https://remote.invalid/v1/responses", "http://localhost.evil/v1/responses", "http://user:secret@127.0.0.1/v1/responses", "http://127.0.0.1/v1/responses?key=secret", "http://127.0.0.1/other"])("rejects credential-free non-loopback or ambiguous endpoint %s", endpoint => {
    expect(() => new ResponsesNaturalIntakeModel({ ...options, endpoint })).toThrow("natural_model_endpoint_invalid");
  });
  it("rejects credential mixing and invalid effort before doing any I/O", () => {
    expect(() => new ResponsesNaturalIntakeModel({ ...options, credential: () => "not-used" })).toThrow();
    expect(() => new ResponsesNaturalIntakeModel({ ...options, reasoningEffort: "bogus" })).toThrow();
  });
  it.each(["unfinished", "text_mismatch", "wrong_model", "wrong_effort", "wrong_response", "wrong_item", "tool", "refusal", "failed", "late_error", "duplicate_done", "no_text_done", "no_item_done", "completed_conflict"])("rejects %s evidence without returning a proposal", async fault => {
    const rows: any[] = events();
    if (fault === "unfinished") rows.pop();
    if (fault === "text_mismatch") rows[5].text = "{}";
    if (fault === "wrong_model") rows[8].response.model = "other";
    if (fault === "wrong_effort") rows[8].response.reasoning.effort = "low";
    if (fault === "wrong_response") rows[8].response.id = "resp-other";
    if (fault === "wrong_item") rows[4].item_id = "msg-other";
    if (fault === "tool") rows[2].item.type = "function_call";
    if (fault === "refusal") rows[3].part.type = "refusal";
    if (fault === "failed") rows[8] = { type: "response.failed", response: snapshot("failed") };
    if (fault === "late_error") rows.push({ type: "error", error: "secret-provider-error" });
    if (fault === "duplicate_done") rows.splice(6, 0, rows[5]);
    if (fault === "no_text_done") rows.splice(5, 1);
    if (fault === "no_item_done") rows.splice(7, 1);
    if (fault === "completed_conflict") rows[8].response.output = [{ ...rows[7].item, content: [{type:"output_text",text:"{}"}] }];
    await expect(model(rows).complete(input())).rejects.toThrow("natural_model_response_invalid");
  });
  it("rejects malformed frames, content type, oversized streams and raw provider errors safely", async () => {
    for (const r of [new Response("data: nope\n\n", {headers:{"content-type":"text/event-stream"}}), new Response(wire(events()))]) {
      await expect(new ResponsesNaturalIntakeModel({ ...options, fetch: async () => r }).complete(input())).rejects.toThrow("natural_model_response_invalid");
    }
    await expect(new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response("x".repeat(8 * 1024 * 1024 + 1), {headers:{"content-type":"text/event-stream"}}) }).complete(input())).rejects.toThrow("natural_model_output_limit");
    await expect(new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response("secret-provider-error", {status:401}) }).complete(input())).rejects.toThrow(/^natural_model_http_401$/);
  });
  it("cancels a hung body even if a transport ignores the signal", async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: cancelled }), {headers:{"content-type":"text/event-stream"}}));
    const pending = new ResponsesNaturalIntakeModel({ ...options, fetch: fetcher }).complete({...input(),signal:controller.signal});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); controller.abort();
    await expect(pending).rejects.toThrow("natural_model_cancelled"); expect(cancelled).toHaveBeenCalled();
  });
  it("does not send cancelled or oversized input", async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = new ResponsesNaturalIntakeModel({...options,fetch:fetcher});
    await expect(client.complete({...input(),signal:AbortSignal.abort()})).rejects.toThrow("natural_model_cancelled");
    await expect(client.complete({...input(),user:"x".repeat(131073)})).rejects.toThrow("natural_model_input_limit"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("cancels a late response body when a fetch ignores cancellation", async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    let resolveFetch!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { resolveFetch = resolve; }));
    const pending = new ResponsesNaturalIntakeModel({...options,fetch:fetcher}).complete({...input(),signal:controller.signal});
    controller.abort(); await expect(pending).rejects.toThrow("natural_model_cancelled");
    resolveFetch(new Response(new ReadableStream({cancel:cancelled}),{headers:{"content-type":"text/event-stream"}}));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });
  it("cancels rejected content-type bodies instead of leaving a connection open", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({cancel:cancelled})));
    await expect(new ResponsesNaturalIntakeModel({...options,fetch:fetcher}).complete(input())).rejects.toThrow("natural_model_response_invalid");
    expect(cancelled).toHaveBeenCalled();
  });
  it("requires explicit transport selection, rejects typos and mixed credential configuration", () => {
    expect(configuredNaturalIntake({OMB_NATURAL_INTAKE_ENABLED:"1",...env()})).toBeDefined();
    expect(() => configuredNaturalIntake({OMB_NATURAL_INTAKE_ENABLED:"1",...env(),OMB_NATURAL_INTAKE_TRANSPORT:"opencdoex"})).toThrow();
    expect(() => configuredNaturalIntake({OMB_NATURAL_INTAKE_ENABLED:"1",...env(),OMB_NATURAL_INTAKE_CREDENTIAL_FILE:"/unused"})).toThrow();
  });
  it("constructs independent proposer/verifier contexts and binds transport/effort into policy identity", async () => {
    const config = {OMB_ACCEPTANCE_MAPPING_ENABLED:"1",OMB_ACCEPTANCE_MAPPING_POLICY_REVISION:"p1",...env("OMB_ACCEPTANCE_MAPPING_PROPOSER"),...env("OMB_ACCEPTANCE_MAPPING_VERIFIER")};
    const fetcher = vi.fn<typeof fetch>(async () => response(events("{}")));
    const mapping = configuredAcceptanceMapping(config,{fetch:fetcher})!;
    expect(mapping.proposer).not.toBe(mapping.verifier);
    await mapping.proposer.complete(input()); await mapping.verifier.complete(input()); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [,init] of fetcher.mock.calls) {expect(new Headers(init?.headers).has("authorization")).toBe(false);expect(JSON.parse(String(init?.body))).not.toHaveProperty("previous_response_id");}
    expect(configuredAcceptanceMapping({...config,OMB_ACCEPTANCE_MAPPING_VERIFIER_REASONING_EFFORT:"high"})!.policyId).not.toBe(mapping.policyId);
  });
});
