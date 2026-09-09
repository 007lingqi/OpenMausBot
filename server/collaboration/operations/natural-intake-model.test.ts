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
  it.each([
    { timeoutMs: undefined, deadline: 60_000 },
    { timeoutMs: 1, deadline: 1 },
    { timeoutMs: 300_000, deadline: 300_000 },
  ])("bounds a hanging transport at the trusted constructor deadline $deadline, not message fields", async ({ timeoutMs, deadline }) => {
    vi.useFakeTimers();
    // Native AbortSignal.timeout uses an internal clock; replace only that clock for deterministic boundary checks.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(delay => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const options = { endpoint: "https://model.example.invalid/v1/responses", model: "fixed",
      credential: () => "fixture-key", fetch: fetcher, timeoutMs };
    try {
      const model = new ResponsesNaturalIntakeModel(options);
      const supplied = { ...input(), signal: controller.signal, timeoutMs: 9_000_000,
        user: JSON.stringify({ text: "等待结果", timeoutMs: 9_000_000 }) };
      const pending = model.complete(supplied);
      const settled = vi.fn();
      void pending.then(settled, settled);
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).not.toHaveBeenCalled();
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(await outcome).toEqual({ error: new Error("natural_model_transport_unavailable") });
      expect(timeout).toHaveBeenCalledWith(deadline);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("timeoutMs");
    } finally { controller.abort(); timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 300_001, Number.MAX_SAFE_INTEGER + 1, "300000", null])(
    "rejects an invalid trusted transport timeout before credentials or I/O: %s", timeoutMs => {
      const credential = vi.fn(() => "fixture-key"), fetcher = vi.fn<typeof fetch>();
      // SAFETY: These malformed test-only options bypass TypeScript to prove rejection before credentials or I/O.
      const options = { endpoint: "https://model.example.invalid/v1/responses", model: "fixed", credential, fetch: fetcher,
        timeoutMs: timeoutMs as number };
      expect(() => new ResponsesNaturalIntakeModel(options)).toThrow("natural_model_timeout_invalid");
      expect(credential).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

  it("keeps configured ordinary chat at 60 seconds despite timeout-like environment and message data", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(delay => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), delay); return controller.signal;
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    try {
      const interpreter = configuredNaturalIntake({ OMB_NATURAL_INTAKE_ENABLED: "1", OMB_NATURAL_INTAKE_MODEL: "fixed",
        OMB_NATURAL_INTAKE_ENDPOINT: "http://127.0.0.1:10100/v1/responses", OMB_NATURAL_INTAKE_TRANSPORT: "opencodex_local",
        OMB_NATURAL_INTAKE_TIMEOUT_MS: "300000", OMB_ACCEPTANCE_MAPPING_TIMEOUT_MS: "600000" })!;
      const pending = interpreter.interpret({
        event: { sourceEventId: "fixture-event", principalId: "fixture-person", text: "请把 timeoutMs 改为 9000000" },
        snapshot: { workItemId: "WI-fixture", revision: 1, sourceWorkItemVersion: 1, goal: null, goalConfirmed: false,
          repository: null, assumptions: [], acceptanceConditions: [], blockingAmbiguities: [], createdAt: 1000 },
        history: [], questions: [], contextTruncated: false,
      }, controller.signal).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ error: new Error("natural_model_transport_unavailable") });
      expect(timeout.mock.calls).toEqual([[60_000]]);
    } finally { controller.abort(); fetcher.mockRestore(); timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

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
