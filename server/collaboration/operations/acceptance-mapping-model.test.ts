import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { configuredAcceptanceMapping } from "./acceptance-mapping-model.ts";
import { openCollaborationLedger } from "../db.ts";
import { AcceptanceMappingCoordinator, readApprovedAcceptanceMapping, type MappingRequest } from "../acceptance-mapping.ts";
import { acceptanceConditionHash } from "../acceptance-assertions.ts";
import { ResponsesNaturalIntakeModel } from "./natural-intake-model.ts";
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, {recursive:true,force:true})));
function environment(file = "/not-read-at-startup") {
  return { OMB_ACCEPTANCE_MAPPING_ENABLED: "1", OMB_ACCEPTANCE_MAPPING_POLICY_REVISION: "policy-1",
    ...Object.fromEntries(["PROPOSER", "VERIFIER"].flatMap(role => [
      [`OMB_ACCEPTANCE_MAPPING_${role}_MODEL`, "explicit-model"],
      [`OMB_ACCEPTANCE_MAPPING_${role}_ENDPOINT`, "https://model.example.invalid/v1/responses"],
      [`OMB_ACCEPTANCE_MAPPING_${role}_CREDENTIAL_FILE`, file],
    ])) };
}
const input = { system: "核对验收条件", user: "不可信业务材料", responseSchema: {type:"object",properties:{},additionalProperties:false}, signal:new AbortController().signal };
it("stays disabled by default and never borrows another feature's credentials", () => {
  expect(configuredAcceptanceMapping({OPENAI_API_KEY:"unrelated",OMB_NATURAL_INTAKE_CREDENTIAL_FILE:"/other"})).toBeUndefined();
  expect(() => configuredAcceptanceMapping({OMB_ACCEPTANCE_MAPPING_ENABLED:"1",OMB_NATURAL_INTAKE_MODEL:"other"})).toThrow("acceptance_mapping_configuration_required");
});
it("constructs independent stateless contexts without reading credentials", () => {
  const config = configuredAcceptanceMapping(environment())!;
  expect(config.proposer).not.toBe(config.verifier);
  expect(config.policyId).toMatch(/^mapping-v1:[a-f0-9]{64}$/);
  expect(config.policyId).toBe("mapping-v1:d6e222e468315e519c88a028491e4cf2eac5cfaf2187f32ba17e2e4182356f21");
});
it.each(["responses", "opencodex_local"] as const)("gives only the configured %s mapping contexts 300-second calls and a 600-second total", async transport => {
  const root = mkdtempSync(join(tmpdir(), "omb-mapping-timeout-")); scratch.push(root);
  const file = join(root, "credential"); writeFileSync(file, "fixture-key", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = environment(file);
  if (transport === "opencodex_local") for (const role of ["PROPOSER", "VERIFIER"]) {
    env[`OMB_ACCEPTANCE_MAPPING_${role}_TRANSPORT`] = transport;
    env[`OMB_ACCEPTANCE_MAPPING_${role}_ENDPOINT`] = "http://127.0.0.1:10100/v1/responses";
    env[`OMB_ACCEPTANCE_MAPPING_${role}_CREDENTIAL_FILE`] = "";
  }
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(delay => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), delay); return controller.signal;
  });
  const controller = new AbortController(), fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  try {
    const config = configuredAcceptanceMapping(env, { fetch: fetcher })!;
    const pending = Promise.all([config.proposer, config.verifier].map(model => model.complete({ ...input, signal: controller.signal })
      .then(value => ({ value }), error => ({ error }))));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ error: new Error("natural_model_transport_unavailable") }, { error: new Error("natural_model_transport_unavailable") }]);
    expect(timeout.mock.calls).toEqual([[300_000], [300_000]]);
    expect(config.timeoutMs).toBe(600_000);
  } finally { controller.abort(); timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each([55_000, 250_000])("completes two %i ms phases through the configured mapping adapter without local budget conflicts", async stageMs => {
  const root = mkdtempSync(join(tmpdir(), "omb-mapping-two-phase-budget-")); scratch.push(root);
  const file = join(root, "credential"); writeFileSync(file, "fixture-key", { mode: 0o600 });
  const store = openCollaborationLedger(root); store.close(); const db = new DatabaseSync(store.filePath);
  const condition = { description: "保存成功", observation: "保存后显示 after" };
  const request: MappingRequest = { candidateSha: "a".repeat(40), specHash: "b".repeat(64), conditions: [condition],
    sources: [{ commandId: "cases", file: "case.test.mjs", blobSha: "c".repeat(40), text: "test('保存',()=>{assert.equal(save(),'after');});" }] };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), supplied = JSON.parse(body.input[0].content[0].text);
    await new Promise(resolve => setTimeout(resolve, stageMs));
    const output = supplied.proposal
      ? { version: 1, requestHash: supplied.requestHash, proposalHash: supplied.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "合成复核仅验证预算与原文传递" }] }
      : { version: 2, requestHash: supplied.requestHash, bindings: [{ conditionHash: acceptanceConditionHash(condition),
        commandId: "cases", file: "case.test.mjs", testName: "保存", startLine: 1, endLine: 1, rationale: "核对保存后的实际值" }] };
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(delay => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), delay); return controller.signal;
  });
  try {
    const config = configuredAcceptanceMapping(environment(file), { fetch: fetcher })!;
    const pending = new AcceptanceMappingCoordinator(db, config).map(request, 1000);
    await vi.advanceTimersByTimeAsync(stageMs * 2);
    const result = await pending;
    expect(result.status).toBe("approved");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[300_000], [300_000]]);
    expect(config.timeoutMs).toBe(600_000);
    expect(readApprovedAcceptanceMapping(db, { requestHash: result.requestHash, policyId: config.policyId,
      candidateSha: request.candidateSha, specHash: request.specHash, conditions: request.conditions })).toEqual(result.contracts);
  } finally { timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
});
it("invalidates policy identity when either model endpoint, name, credential reference or revision changes", () => {
  const env = environment(); const base = configuredAcceptanceMapping(env)!.policyId;
  for (const change of [{OMB_ACCEPTANCE_MAPPING_PROPOSER_MODEL:"changed"}, {OMB_ACCEPTANCE_MAPPING_VERIFIER_ENDPOINT:"https://other.example.invalid/responses"},
    {OMB_ACCEPTANCE_MAPPING_VERIFIER_CREDENTIAL_FILE:"/new-reference"}, {OMB_ACCEPTANCE_MAPPING_POLICY_REVISION:"policy-2"}]) {
    expect(configuredAcceptanceMapping({...env,...change})!.policyId).not.toBe(base);
  }
});
it("rejects incomplete configuration, unsafe endpoints and relative credential paths", () => {
  for (const change of [{OMB_ACCEPTANCE_MAPPING_VERIFIER_MODEL:""}, {OMB_ACCEPTANCE_MAPPING_PROPOSER_ENDPOINT:"http://remote.invalid/responses"},
    {OMB_ACCEPTANCE_MAPPING_VERIFIER_ENDPOINT:"https://host.invalid/?token=private"}, {OMB_ACCEPTANCE_MAPPING_VERIFIER_CREDENTIAL_FILE:"relative"}]) {
    expect(() => configuredAcceptanceMapping({...environment(),...change})).toThrow();
  }
});
it("uses only each explicit credential and never enables tools or conversation reuse", async () => {
  const root=mkdtempSync(join(tmpdir(),"omb-mapping-model-")); scratch.push(root);
  const file=join(root,"credential"); writeFileSync(file,"fixture-key",{mode:0o600});
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"{}"}]}]})));
  const config=configuredAcceptanceMapping(environment(file),{fetch:fetcher})!;
  await config.proposer.complete(input); await config.verifier.complete(input);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for(const [,init] of fetcher.mock.calls) {
    expect(init).toMatchObject({redirect:"error",headers:{Authorization:"Bearer fixture-key"}});
    const body=JSON.parse(String(init?.body));
    expect(body).toMatchObject({store:false,tools:[],tool_choice:"none"});
    expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(body)).not.toContain("fixture-key");
  }
  chmodSync(file,0o644);
  await expect(config.proposer.complete(input)).rejects.toThrow("credentials_unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("carries selector-v2 schema and host numbering through the configured wire before reviewing canonical quoted source", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-mapping-selector-wire-")); scratch.push(root);
  const file = join(root, "credential"); writeFileSync(file, "fixture-key", { mode: 0o600 });
  const store = openCollaborationLedger(root); store.close();
  const db = new DatabaseSync(store.filePath);
  const condition = { description: "保存成功", observation: "保存后显示 after" };
  const source = "test('保存', () => {\n  assert.equal(save(), 'after');\n});";
  const request: MappingRequest = { candidateSha: "a".repeat(40), specHash: "b".repeat(64), conditions: [condition],
    sources: [{ commandId: "cases", file: "case.test.mjs", blobSha: "c".repeat(40), text: source }] };
  const roles: string[] = [];
  const reviewedSources: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const supplied = JSON.parse(body.input[0].content[0].text);
    const schema = body.text.format.schema;
    expect(body).toMatchObject({ store: false, tools: [], tool_choice: "none", text: { format: { strict: true } } });
    expect(body).not.toHaveProperty("previous_response_id");
    let output;
    if (roles.length === 0) {
      roles.push("proposer");
      expect(schema.properties.version.const).toBe(2);
      expect(schema.properties.bindings.items.additionalProperties).toBe(false);
      expect(schema.properties.bindings.items.properties).not.toHaveProperty("quote");
      expect(supplied.sources[0]).not.toHaveProperty("text");
      expect(supplied.sources[0].numberedLines).toEqual([
        [1, "test('保存', () => {"], [2, "  assert.equal(save(), 'after');"], [3, "});"],
      ]);
      output = { version: 2, requestHash: supplied.requestHash, bindings: [{ conditionHash: supplied.conditions[0].conditionHash,
        commandId: "cases", file: "case.test.mjs", testName: "保存", startLine: 1, endLine: 3, rationale: "核对保存后的实际值" }] };
    } else {
      roles.push("verifier");
      expect(schema.properties.version.const).toBe(1);
      reviewedSources.push(supplied.request.sources[0]);
      expect(supplied.request.conditions[0].conditionHash).toBe(acceptanceConditionHash(condition));
      expect(supplied.proposal).toMatchObject({ version: 1, bindings: [{ startLine: 1, endLine: 3, quote: source }] });
      output = { version: 1, requestHash: supplied.requestHash, proposalHash: supplied.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "合成服务仅核对协议与源码传递" }] };
    }
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  const model = configuredAcceptanceMapping(environment(file), { fetch: fetcher })!;
  try {
    const result = await new AcceptanceMappingCoordinator(db, model).map(request, 1000);
    expect(result.status).toBe("approved");
    expect(roles).toEqual(["proposer", "verifier"]);
    expect(reviewedSources).toEqual(request.sources);
    expect(readApprovedAcceptanceMapping(db, { requestHash: result.requestHash, policyId: model.policyId,
      candidateSha: request.candidateSha, specHash: request.specHash, conditions: request.conditions })).toEqual(result.contracts);
  } finally { db.close(); }
});

it("maps an 8372-byte fixed request with 4000 blank lines through the bounded production adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-mapping-compact-wire-")); scratch.push(root);
  const store = openCollaborationLedger(root); store.close();
  const db = new DatabaseSync(store.filePath);
  const condition = { description: "结果正确", observation: "断言正确" };
  const testSource = 'test("case",()=>{assert.equal(1,1);});';
  const request: MappingRequest = { candidateSha: "a".repeat(40), specHash: "b".repeat(64), conditions: [condition],
    sources: [{ commandId: "cases", file: "case.test.mjs", blobSha: "c".repeat(40), text: "\n".repeat(4000) + testSource }] };
  expect(Buffer.byteLength(JSON.stringify(request))).toBe(8372);
  const wire: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    wire.push(String(init?.body));
    const body = JSON.parse(String(init?.body));
    const supplied = JSON.parse(body.input[0].content[0].text);
    const output = { version: 2, requestHash: supplied.requestHash, bindings: [{ conditionHash: supplied.conditions[0].conditionHash,
      commandId: "cases", file: "case.test.mjs", testName: "case", startLine: 4001, endLine: 4001, rationale: "核对真实断言" }] };
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  const proposer = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "fixed",
    credential: () => "fixture-key", fetch: fetcher });
  const reviewed: unknown[] = [];
  const verifier = { async complete(call: Parameters<ResponsesNaturalIntakeModel["complete"]>[0]) {
    const supplied = JSON.parse(call.user); reviewed.push(supplied.proposal.bindings[0].quote);
    return { version: 1, requestHash: supplied.requestHash, proposalHash: supplied.proposalHash,
      findings: [{ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "合成复核仅证明传输与原文提取" }] };
  } };
  try {
    const result = await new AcceptanceMappingCoordinator(db, { policyId: "compact-v2", proposer, verifier }).map(request, 1000);
    expect(result.status).toBe("approved");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(wire[0])).toBeLessThanOrEqual(128 * 1024);
    const supplied = JSON.parse(JSON.parse(wire[0]).input[0].content[0].text);
    expect(supplied.sources[0]).not.toHaveProperty("text");
    expect(supplied.sources[0].numberedLines).toHaveLength(4001);
    expect(supplied.sources[0].numberedLines[4000]).toEqual([4001, testSource]);
    expect(reviewed).toEqual([testSource]);
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it("rejects truly oversized selector envelopes before any credential read, network call or durable attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-mapping-preflight-")); scratch.push(root);
  const store = openCollaborationLedger(root); store.close();
  const db = new DatabaseSync(store.filePath);
  const request: MappingRequest = { candidateSha: "a".repeat(40), specHash: "b".repeat(64),
    conditions: [{ description: "结果正确", observation: "断言正确" }], sources: [{ commandId: "cases", file: "case.test.mjs",
      blobSha: "c".repeat(40), text: "\n".repeat(20000) + 'test("case",()=>{assert.equal(1,1);});' }] };
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(80000);
  const fetcher = vi.fn<typeof fetch>();
  const credential = vi.fn(() => "fixture-key");
  const verifier = vi.fn<ResponsesNaturalIntakeModel["complete"]>(async () => ({}));
  const proposer = new ResponsesNaturalIntakeModel({ endpoint: "https://model.example.invalid/v1/responses", model: "fixed", credential, fetch: fetcher });
  try {
    const model = { policyId: "preflight-v2", proposer, verifier: { complete: verifier } };
    for (const now of [1000, 201000, 401000]) {
      await expect(new AcceptanceMappingCoordinator(db, model).map(request, now)).rejects.toThrow("natural_model_input_limit");
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_results").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
