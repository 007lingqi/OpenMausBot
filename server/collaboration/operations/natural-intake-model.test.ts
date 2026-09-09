import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { ResponsesNaturalIntakeModel, configuredNaturalIntake } from "./natural-intake-model.ts";

function input() { return { system: "只解释需求", user: JSON.stringify({ text: "就是这个意思" }),
  responseSchema: { type: "object", properties: {}, additionalProperties: false }, signal: new AbortController().signal }; }
function completed(value: unknown) { return new Response(JSON.stringify({ status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] },
] }), { status: 200 }); }

describe("tool-free Responses natural intake adapter", () => {
  it("preflights the exact serialized 128 KiB envelope without credentials or I/O and shares that boundary with complete", async () => {
    const credential = vi.fn(() => "fixture-key");
    const wire: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { wire.push(String(init?.body)); return completed({ result: "ok" }); });
    const model = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "fixed",
      credential, fetch: fetcher });
    const sample = { ...input(), system: '只解释\n不要复述"内容"\\标记', user: JSON.stringify({ text: '原文\n"引用"\\转义' }),
      responseSchema: { type: "object", properties: { result: { type: "string", description: '说明"字段"\n换行' } }, additionalProperties: false } };
    expect(() => model.validateInput(sample)).not.toThrow();
    expect(credential).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await model.complete(sample)).toEqual({ result: "ok" });
    const remaining = 128 * 1024 - Buffer.byteLength(wire[0]);
    const exact = { ...sample, user: sample.user + "x".repeat(remaining) };
    expect(() => model.validateInput(exact)).not.toThrow();
    expect(credential).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await model.complete(exact)).toEqual({ result: "ok" });
    expect(Buffer.byteLength(wire[1])).toBe(128 * 1024);
    const oversized = { ...exact, user: exact.user + "x" };
    expect(() => model.validateInput(oversized)).toThrow("natural_model_input_limit");
    await expect(model.complete(oversized)).rejects.toThrow("natural_model_input_limit");
    expect(() => model.validateInput({ ...oversized, signal: AbortSignal.abort() })).toThrow("natural_model_cancelled");
    expect(credential).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the actual fetch HTTP transport against a non-production loopback endpoint", async () => {
    let received: unknown;
    let authorization: string | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      authorization = request.headers.authorization;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"result":"ok"}' }] }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const model = new ResponsesNaturalIntakeModel({ endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
        allowInsecureLoopback: true, model: "configured-model", credential: () => "local-test-key" });
      expect(await model.complete(input())).toEqual({ result: "ok" });
      expect(received).toMatchObject({ tools: [], tool_choice: "none", model: "configured-model" });
      expect(authorization).toBe("Bearer local-test-key");
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
  it("sends a real HTTP-shaped request with no tools, no storage and a fixed trusted model/endpoint", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => completed({ goal: "更清晰的反馈" }));
    const model = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "configured-model",
      credential: () => "test-key-never-log", fetch: fetcher });
    expect(await model.complete(input())).toEqual({ goal: "更清晰的反馈" });
    expect(fetcher).toHaveBeenCalledWith("https://model.example.invalid/v1/responses", expect.objectContaining({ redirect: "error", method: "POST" }));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "configured-model", instructions: "只解释需求", store: false, tools: [], tool_choice: "none",
      text: { format: { type: "json_schema", strict: true } } });
    expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(body)).not.toContain("test-key-never-log");
  });

  it.each([
    { status: "incomplete", output: [] },
    { status: "completed", output: [{ type: "function_call", name: "delete" }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "secret" }] }] },
  ])("rejects incomplete, tool-call or refused responses without echoing provider text", async (body) => {
    const model = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "fixed",
      credential: () => "test-key", fetch: async () => new Response(JSON.stringify(body)) });
    await expect(model.complete(input())).rejects.toThrow("natural_model_response_invalid");
  });

  it("bounds output and does not expose HTTP error bodies or credentials", async () => {
    const options = { endpoint: "https://model.example.invalid/v1/responses", model: "fixed", credential: () => "test-key" };
    await expect(new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response("private-provider-error", { status: 401 }) })
      .complete(input())).rejects.toThrow(/^natural_model_http_401$/);
    await expect(new ResponsesNaturalIntakeModel({ ...options, fetch: async () => new Response("x".repeat(262_145)) })
      .complete(input())).rejects.toThrow("natural_model_output_limit");
  });

  it("requires explicit configuration and never falls back to unrelated credentials", () => {
    expect(configuredNaturalIntake({ OPENAI_API_KEY: "unrelated" })).toBeUndefined();
    expect(() => configuredNaturalIntake({ OMB_NATURAL_INTAKE_ENABLED: "1" })).toThrow("natural_model_configuration_required");
    expect(() => new ResponsesNaturalIntakeModel({ endpoint: "https://user:secret@host.invalid/responses", model: "fixed", credential: () => "key" }))
      .toThrow("natural_model_endpoint_invalid");
    expect(() => new ResponsesNaturalIntakeModel({ endpoint: "http://remote.invalid/responses", model: "fixed", credential: () => "key" }))
      .toThrow("natural_model_endpoint_invalid");
  });

  it("constructs the configured interpreter without reading its credential or calling the provider", () => {
    const interpreter = configuredNaturalIntake({ OMB_NATURAL_INTAKE_ENABLED: "1", OMB_NATURAL_INTAKE_MODEL: "chosen-model",
      OMB_NATURAL_INTAKE_ENDPOINT: "https://model.example.invalid/v1/responses", OMB_NATURAL_INTAKE_CREDENTIAL_FILE: "/not-read-during-construction" });
    expect(interpreter?.interpret).toBeTypeOf("function");
    expect(interpreter?.associate).toBeTypeOf("function");
  });

  it("honors cancellation before loading credentials or sending a request", async () => {
    const credential = vi.fn(() => "key");
    const fetcher = vi.fn(async () => completed({}));
    const signal = AbortSignal.abort();
    const model = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "fixed", credential, fetch: fetcher });
    await expect(model.complete({ ...input(), signal })).rejects.toThrow("natural_model_cancelled");
    expect(credential).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
