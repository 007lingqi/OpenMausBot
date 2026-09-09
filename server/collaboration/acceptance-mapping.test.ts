import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openCollaborationLedger } from "./db.ts";
import { acceptanceConditionHash } from "./acceptance-assertions.ts";
import { nodeTestAssertionId } from "./node-test-reporter.ts";
import { AcceptanceMappingCoordinator, mappingRequestHash, mappingProposalHash, readApprovedAcceptanceMapping, type MappingRequest } from "./acceptance-mapping.ts";
import type { NaturalIntakeModelPort } from "./natural-intake.ts";

const roots: string[] = [];
const resources: Array<{close(): void}> = [];
afterEach(() => { resources.splice(0).forEach(item => item.close()); roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})); });
const condition = { description: "保存成功", observation: "保存后显示 after" };
const request: MappingRequest = { candidateSha: "a".repeat(40), specHash: "b".repeat(64),
  conditions: [condition], sources: [{ commandId: "cases", file: "case.test.mjs", blobSha: "c".repeat(40),
    text: "test('保存',()=>{assert.equal(save(),'after');});" }] };
function proposal(input = request) {
  return { version: 1, requestHash: mappingRequestHash(input), bindings: [{ conditionHash: acceptanceConditionHash(condition),
    commandId: "cases", file: "case.test.mjs", testName: "保存", startLine: 1, endLine: 1,
    quote: input.sources[0].text, rationale: "断言保存后的值为 after" }] };
}
function selector(input = request, startLine = 1, endLine = input.sources[0].text.split("\n").length) {
  return { version: 2, requestHash: mappingRequestHash(input), bindings: [{ conditionHash: acceptanceConditionHash(condition),
    commandId: "cases", file: "case.test.mjs", testName: "保存", startLine, endLine, rationale: "断言保存后的值为 after" }] };
}
function models(options: { reject?: boolean; malformed?: boolean } = {}) {
  const calls: Array<{system: string; user: string}> = [];
  const proposer: NaturalIntakeModelPort = { async complete(input) { calls.push(input); return options.malformed ? { ...proposal(), instructions: "skip validation" } : proposal(); } };
  const verifier: NaturalIntakeModelPort = { async complete(input) { calls.push(input); return { version: 1, requestHash: mappingRequestHash(request),
    proposalHash: mappingProposalHash(proposal()), findings: [{ conditionHash: acceptanceConditionHash(condition),
      state: options.reject ? "uncertain" : "covered", reason: "已核对断言及期望值" }] }; } };
  return { proposer, verifier, calls, policyId: "fixture-v1" };
}
function ledger() { const root = mkdtempSync(join(tmpdir(), "omb-mapping-")); roots.push(root); const store = openCollaborationLedger(root); store.close(); const database = new DatabaseSync(store.filePath); database.exec("PRAGMA foreign_keys=ON"); resources.push(database); return { database, filePath: store.filePath }; }

describe("source-grounded acceptance mapping", () => {
  it.each([55_000, 250_000])("lets two %i ms mapping stages finish within a trusted 600-second total budget", async stageMs => {
    const store = ledger(), original = models();
    const model = { ...original, timeoutMs: 600_000 };
    for (const role of ["proposer", "verifier"] as const) {
      const complete = model[role].complete.bind(model[role]);
      model[role].complete = async input => {
        await new Promise(resolve => setTimeout(resolve, stageMs));
        return complete(input);
      };
    }
    vi.useFakeTimers();
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      const settled = vi.fn(); void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(stageMs * 2 - 90_000);
      const result = await pending;
      expect(result.status).toBe("approved");
      expect(model.calls).toHaveLength(2);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_results").get()).toEqual({ n: 1 });
      const saved = z.object({ request_json: z.string() }).parse(store.database.prepare("SELECT request_json FROM collaboration_mapping_all_attempts").get());
      expect(JSON.parse(saved.request_json)).toEqual({ policyId: model.policyId, request });
      expect(result.requestHash).toBe(mappingRequestHash(request));
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(["proposer", "verifier"] as const)("aborts a hanging %s exactly at the trusted 600-second total deadline", async role => {
    const store = ledger(), model = { ...models(), timeoutMs: 600_000 };
    let captured: AbortSignal | undefined;
    model[role].complete = input => { captured = input.signal; return new Promise(() => {}); };
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      const settled = vi.fn(); void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(settled).not.toHaveBeenCalled();
      expect(captured?.aborted).toBe(false);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_results").get()).toEqual({ n: 0 });
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ status: "failed", failureReason: "timeout",
        failureStage: role === "proposer" ? "proposal_call" : "review_call" });
      expect(captured?.aborted).toBe(true);
      expect(store.database.prepare("SELECT attempt,created_at FROM collaboration_mapping_all_results").all()).toEqual([{ attempt: 1, created_at: 601_000 }]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps the claim pending through 629999 ms and fences the old result after a claim at 630000 ms", async () => {
    const store = ledger(), old = { ...models(), timeoutMs: 600_000 }, fresh = { ...models(), timeoutMs: 600_000 };
    let release!: () => void;
    old.proposer.complete = () => new Promise(resolve => { release = () => resolve(proposal()); });
    const controller = new AbortController();
    const first = new AcceptanceMappingCoordinator(store.database, old).map(request, 1000, controller.signal);
    const outcome = first.catch(() => undefined);
    try {
      expect((await new AcceptanceMappingCoordinator(store.database, fresh).map(request, 630_999)).status).toBe("pending");
      expect(fresh.calls).toHaveLength(0);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 1 });
      expect((await new AcceptanceMappingCoordinator(store.database, fresh).map(request, 631_000)).status).toBe("approved");
      release();
      expect((await first).status).toBe("pending");
      expect(store.database.prepare("SELECT attempt FROM collaboration_mapping_all_attempts ORDER BY attempt").all()).toEqual([{ attempt: 1 }, { attempt: 2 }]);
      expect(store.database.prepare("SELECT attempt FROM collaboration_mapping_all_results").all()).toEqual([{ attempt: 2 }]);
    } finally { controller.abort(); release(); await outcome; }
  });

  it.each([
    { timeoutMs: undefined, elapsed: 119_999, status: "approved" },
    { timeoutMs: undefined, elapsed: 120_000, status: "pending" },
    { timeoutMs: undefined, elapsed: 120_001, status: "pending" },
    { timeoutMs: 600_000, elapsed: 629_999, status: "approved" },
    { timeoutMs: 600_000, elapsed: 630_000, status: "pending" },
    { timeoutMs: 600_000, elapsed: 630_001, status: "pending" },
  ])("fences a delayed event-loop result at elapsed $elapsed with trusted timeout $timeoutMs", async ({ timeoutMs, elapsed, status }) => {
    const store = ledger(), model = { ...models(), timeoutMs };
    const complete = model.verifier.complete.bind(model.verifier);
    let release!: () => void;
    model.verifier.complete = async input => {
      const reviewed = await complete(input);
      return new Promise(resolve => { release = () => resolve(reviewed); });
    };
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf("function");
      // Simulate suspension: wall time advances before either queued result/timeout callback runs.
      vi.setSystemTime(1000 + elapsed);
      release();
      expect((await pending).status).toBe(status);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_results").get()).toEqual({ n: status === "approved" ? 1 : 0 });
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 1 });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 600_001, Number.MAX_SAFE_INTEGER + 1, "600000", null])(
    "rejects an invalid trusted mapping budget before reserving an attempt: %s", timeoutMs => {
      // SAFETY: Malformed test-only budgets bypass TypeScript to exercise runtime rejection before durable writes.
      const store = ledger(), model = { ...models(), timeoutMs: timeoutMs as number };
      expect(() => new AcceptanceMappingCoordinator(store.database, model)).toThrow("acceptance_mapping_timeout_invalid");
      expect(model.calls).toHaveLength(0);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 0 });
    });

  it("accepts the minimum 1 ms trusted budget but never a timeout field inside request data", async () => {
    const store = ledger(), model = { ...models(), timeoutMs: 1 };
    const coordinator = new AcceptanceMappingCoordinator(store.database, model);
    const untrusted = { ...request, timeoutMs: 600_000 };
    await expect(coordinator.map(untrusted, 1000)).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
    model.proposer.complete = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = coordinator.map(request, 1000);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ status: "failed", failureReason: "timeout", failureStage: "proposal_call" });
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 1 });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("constructs exact multiline quotes from an explicit selector and trusted numbered sanitized sources before independent review", async () => {
    const sourceLines = ['const password = "fixture-value";', "test('保存', () => {", "  const actual = save();", "", "  assert.equal(actual, 'after');", "});", ""];
    const input = { ...request, sources: [{ ...request.sources[0], text: sourceLines.join("\n") }] };
    const sanitizedLines = ['const password = "[敏感信息已隐藏]";', ...sourceLines.slice(1)];
    const selected = selector(input, 2, 6);
    const canonical = { ...proposal(input), bindings: [{ ...proposal(input).bindings[0], startLine: 2, endLine: 6,
      quote: "test('保存', () => {\n  const actual = save();\n\n  assert.equal(actual, 'after');\n});" }] };
    const store = ledger();
    const calls: Array<Parameters<NaturalIntakeModelPort["complete"]>[0]> = [];
    const model = { policyId: "selector-v2", proposer: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
      calls.push(call);
      return selected;
    } }, verifier: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
      calls.push(call);
      const data = JSON.parse(call.user);
      expect(data.proposal).toEqual(canonical);
      expect(data.proposalHash).toBe(mappingProposalHash(canonical));
      return { version: 1, requestHash: data.requestHash, proposalHash: data.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "合成复核端口确认原文及业务断言传递" }] };
    } } };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(input, 1000);
    expect(result.status).toBe("approved");
    expect(calls).toHaveLength(2);
    const modelInput = JSON.parse(calls[0].user);
    expect(modelInput.sources[0]).not.toHaveProperty("text");
    expect(modelInput.sources[0].numberedLines).toEqual(sanitizedLines.map((text, index) => [index + 1, text]));
    expect(modelInput.requestHash).toBe(mappingRequestHash(input));
    expect(calls[0].responseSchema).toMatchObject({ properties: { version: { const: 2 } } });
    expect(JSON.stringify(calls[0].responseSchema)).not.toContain('"quote"');
    const saved = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    expect(JSON.parse(saved.receipt_json)).toMatchObject({ selector: selected, proposal: canonical });
    expect(JSON.stringify(calls)).not.toContain("fixture-value");
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(input, 2000)).toEqual(result);
    expect(calls).toHaveLength(2);
    expect(readApprovedAcceptanceMapping(store.database, { requestHash: result.requestHash, policyId: model.policyId,
      candidateSha: input.candidateSha, specHash: input.specHash, conditions: input.conditions })).toEqual(result.contracts);
  });

  it.each([
    ["mixed_quote", "proposal_schema"], ["legacy_without_quote", "proposal_schema"], ["legacy_wrong_quote", "quote_invalid"],
    ["zero_line", "proposal_schema"], ["fractional_line", "proposal_schema"], ["reversed_range", "quote_invalid"],
    ["outside_range", "quote_invalid"], ["absent_test_name", "quote_invalid"], ["wrong_file", "binding_invalid"],
    ["wrong_command", "binding_invalid"], ["wrong_condition", "binding_invalid"], ["duplicate", "binding_invalid"],
    ["implementation", "binding_invalid"], ["stale", "proposal_stale"], ["missing_condition", "coverage_missing"],
  ] as const)("fails closed for selector %s without correcting model intent or calling the Verifier", async (fault, failureReason) => {
    const input: MappingRequest = fault === "implementation" ? { ...request, sources: [{ ...request.sources[0], role: "implementation" }] }
      : fault === "missing_condition" ? { ...request, conditions: [...request.conditions, { description: "失败提示", observation: "保存失败显示原因" }] } : request;
    const selected = selector(input);
    if (fault === "zero_line") selected.bindings[0].startLine = 0;
    if (fault === "fractional_line") selected.bindings[0].startLine = 1.5;
    if (fault === "reversed_range") selected.bindings[0].startLine = 2;
    if (fault === "outside_range") selected.bindings[0].endLine = 2;
    if (fault === "absent_test_name") selected.bindings[0].testName = "不在选中源码里的测试";
    if (fault === "wrong_file") selected.bindings[0].file = "../not-provided.test.mjs";
    if (fault === "wrong_command") selected.bindings[0].commandId = "unconfigured";
    if (fault === "wrong_condition") selected.bindings[0].conditionHash = "0".repeat(64);
    if (fault === "duplicate") selected.bindings.push({ ...selected.bindings[0] });
    if (fault === "stale") selected.requestHash = "0".repeat(64);
    const returned = fault === "mixed_quote" ? { ...selected, bindings: [{ ...selected.bindings[0], quote: "model must not supply this" }] }
      : fault === "legacy_without_quote" ? { ...selected, version: 1 }
      : fault === "legacy_wrong_quote" ? { ...proposal(input), bindings: [{ ...proposal(input).bindings[0], quote: "wrong original proposal" }] } : selected;
    const verifier = vi.fn<NaturalIntakeModelPort["complete"]>();
    const store = ledger();
    const result = await new AcceptanceMappingCoordinator(store.database, {
      policyId: "selector-invalid-v2", proposer: { async complete() { return returned; } }, verifier: { complete: verifier },
    }).map(input, 1000);
    expect(result).toMatchObject({ status: "failed", failureReason, failureStage: "proposal_validation" });
    expect(result.contracts).toBeUndefined();
    expect(verifier).not.toHaveBeenCalled();
    const saved = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    expect(JSON.parse(saved.receipt_json)).toEqual({ error: "acceptance_mapping_unavailable", failureReason, failureStage: "proposal_validation" });
  });

  it.each(["missing", "uncertain", "wrong_hash", "timeout"] as const)("requires independent semantic review after selector materialization: %s", async fault => {
    const store = ledger();
    const model = models();
    model.proposer.complete = async () => selector();
    const verifier = vi.fn<NaturalIntakeModelPort["complete"]>(async call => {
      const data = JSON.parse(call.user);
      expect(data.proposal).toEqual(proposal());
      if (fault === "timeout") return new Promise(() => {});
      return { version: 1, requestHash: data.requestHash, proposalHash: fault === "wrong_hash" ? "0".repeat(64) : data.proposalHash,
        findings: [{ conditionHash: acceptanceConditionHash(condition), state: fault === "wrong_hash" ? "covered" : fault, reason: "独立复核未能确认覆盖" }] };
    });
    model.verifier.complete = verifier;
    if (fault === "timeout") vi.useFakeTimers();
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      if (fault === "timeout") await vi.advanceTimersByTimeAsync(90001);
      expect(await pending).toMatchObject({ status: fault === "missing" || fault === "uncertain" ? "rejected" : "failed",
        failureReason: fault === "wrong_hash" ? "review_invalid" : fault === "timeout" ? "timeout" : `review_${fault}`,
        failureStage: fault === "timeout" ? "review_call" : "review_validation" });
      expect(verifier).toHaveBeenCalledTimes(1);
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ n: 1 });
      expect(readApprovedAcceptanceMapping(store.database, { requestHash: mappingRequestHash(request), policyId: model.policyId,
        candidateSha: request.candidateSha, specHash: request.specHash, conditions: request.conditions })).toBeUndefined();
    } finally { if (fault === "timeout") vi.useRealTimers(); }
  });

  it.each(["quote", "selector", "selector_quote"] as const)("revalidates stored canonical source and selector consistency: %s", async fault => {
    const store = ledger(), model = models();
    model.proposer.complete = async () => selector();
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    expect(result.status).toBe("approved");
    const row = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    const saved = JSON.parse(row.receipt_json);
    if (fault === "quote") saved.proposal.bindings[0].quote = "altered source";
    if (fault === "selector") saved.selector.bindings[0].rationale = "另一份语义不同但格式有效的提议";
    if (fault === "selector_quote") saved.selector.bindings[0].quote = saved.proposal.bindings[0].quote;
    store.database.exec("DROP TRIGGER collaboration_mapping_result_no_update");
    store.database.prepare("UPDATE collaboration_acceptance_mapping_results SET receipt_json=?").run(JSON.stringify(saved));
    expect(readApprovedAcceptanceMapping(store.database, { requestHash: result.requestHash, policyId: model.policyId,
      candidateSha: request.candidateSha, specHash: request.specHash, conditions: request.conditions })).toBeUndefined();
    await expect(new AcceptanceMappingCoordinator(store.database, model).map(request, 2000)).rejects.toThrow("acceptance_mapping_");
    expect(model.calls).toHaveLength(1);
  });

  it("does not reset the three-attempt budget when a legacy proposer switches to selector v2", async () => {
    const store = ledger(), model = models({ malformed: true });
    for (let attempt = 0; attempt < 3; attempt++) await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000 + attempt * 200000);
    const proposed = vi.fn<NaturalIntakeModelPort["complete"]>(async () => selector());
    model.proposer.complete = proposed;
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(request, 700000)).toMatchObject({ status: "limit", failureReason: "proposal_schema" });
    expect(proposed).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ n: 3 });
  });

  it("returns a valid legacy approved receipt before consulting current transport preflight", async () => {
    const store = ledger(), original = models();
    const result = await new AcceptanceMappingCoordinator(store.database, original).map(request, 1000);
    expect(result.status).toBe("approved");
    const history = () => store.database.prepare("SELECT a.*,r.receipt_json FROM collaboration_mapping_all_attempts a LEFT JOIN collaboration_mapping_all_results r USING(request_key,attempt)").all();
    const before = history();
    const complete = vi.fn<NaturalIntakeModelPort["complete"]>(async () => { throw new Error("must_not_call_model"); });
    const validateInput = vi.fn(() => { throw new Error("natural_model_input_limit"); });
    const current = { ...original, timeoutMs: 600_000, proposer: { complete, validateInput } };
    expect(await new AcceptanceMappingCoordinator(store.database, current).map(request, 2000)).toEqual(result);
    expect(validateInput).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 1 });
    expect(history()).toEqual(before);
    expect(readApprovedAcceptanceMapping(store.database, { requestHash: result.requestHash, policyId: current.policyId,
      candidateSha: request.candidateSha, specHash: request.specHash, conditions: request.conditions })).toEqual(result.contracts);
  });

  it("does not call preflight or reserve an attempt after cancellation", async () => {
    const store = ledger(), original = models();
    const validateInput = vi.fn(() => { throw new Error("must_not_preflight"); });
    const current = { ...original, proposer: { ...original.proposer, validateInput } };
    await expect(new AcceptanceMappingCoordinator(store.database, current).map(request, 1000, AbortSignal.abort())).rejects.toThrow("acceptance_mapping_cancelled");
    expect(validateInput).not.toHaveBeenCalled();
    expect(original.calls).toHaveLength(0);
    expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_mapping_all_attempts").get()).toEqual({ n: 0 });
  });

  it.each([
    ["schema", "proposal_schema"], ["stale", "proposal_stale"], ["binding", "binding_invalid"],
    ["coverage", "coverage_missing"], ["quote", "quote_invalid"], ["sensitive", "sensitive_output"],
  ] as const)("records only a bounded reason for proposal %s failures", async (fault, failureReason) => {
    const store = ledger(), model = models();
    const input = fault === "coverage" ? { ...request, conditions: [...request.conditions, { description: "保存失败", observation: "显示失败原因" }] } : request;
    const proposed = proposal(input);
    if (fault === "stale") proposed.requestHash = "0".repeat(64);
    if (fault === "binding") proposed.bindings[0].file = "not-provided.mjs";
    if (fault === "quote") proposed.bindings[0].quote = "invented-private-model-output";
    if (fault === "sensitive") proposed.bindings[0].rationale = "密码 synthetic-private-value";
    model.proposer.complete = async () => fault === "schema" ? { ...proposed, extra: "private-invalid-output" } : proposed;
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(input, 1000);
    expect(result).toMatchObject({ status: "failed", failureReason, failureStage: "proposal_validation" });
    expect(result.contracts).toBeUndefined();
    const saved = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    expect(JSON.parse(saved.receipt_json)).toEqual({ error: "acceptance_mapping_unavailable", failureReason, failureStage: "proposal_validation" });
    expect(model.calls).toHaveLength(0);
  });

  it.each(["schema", "binding", "missing", "uncertain"] as const)("separates independent review %s from upstream failures", async fault => {
    const store = ledger(), model = models();
    const failureReason = { schema: "review_schema", binding: "review_invalid", missing: "review_missing", uncertain: "review_uncertain" }[fault];
    model.verifier.complete = async () => {
      const reviewed = { version: 1, requestHash: mappingRequestHash(request),
      proposalHash: fault === "binding" ? "0".repeat(64) : mappingProposalHash(proposal()),
      findings: [{ conditionHash: acceptanceConditionHash(condition), state: fault === "missing" || fault === "uncertain" ? fault : "covered", reason: "核对结果" }],
      };
      return fault === "schema" ? { ...reviewed, extra: "private-invalid-review" } : reviewed;
    };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    expect(result).toMatchObject({ status: fault === "missing" || fault === "uncertain" ? "rejected" : "failed", failureReason, failureStage: "review_validation" });
    expect(result.contracts).toBeUndefined();
    const saved = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    expect(JSON.parse(saved.receipt_json)).toMatchObject({ failureReason, failureStage: "review_validation" });
    expect(saved.receipt_json).not.toContain("private-invalid-review");
  });

  it.each(["proposer", "verifier"] as const)("does not classify or persist arbitrary %s exception text as validation evidence", async role => {
    const store = ledger(), model = models();
    model[role].complete = async () => { throw new Error("acceptance_mapping_incomplete secret=private-upstream-value"); };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    const failureStage = role === "proposer" ? "proposal_call" : "review_call";
    expect(result).toMatchObject({ status: "failed", failureReason: "upstream_call", failureStage });
    const saved = z.object({ receipt_json: z.string() }).parse(store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").get());
    expect(JSON.parse(saved.receipt_json)).toEqual({ error: "acceptance_mapping_unavailable", failureReason: "upstream_call", failureStage });
    expect(saved.receipt_json).not.toContain("private-upstream-value");
  });

  it.each(["proposer", "verifier"] as const)("retains the bounded %s timeout stage without extending its deadline", async role => {
    const store = ledger(), model = models();
    model[role].complete = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      await vi.advanceTimersByTimeAsync(90001);
      expect(await pending).toMatchObject({ status: "failed", failureReason: "timeout", failureStage: role === "proposer" ? "proposal_call" : "review_call" });
      expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ n: 1 });
    } finally { vi.useRealTimers(); }
  });

  it("preserves safe latest failure details at the three-attempt limit without another model call", async () => {
    const store = ledger(), model = models({ malformed: true });
    for (let attempt = 0; attempt < 3; attempt++) await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000 + attempt * 200000);
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(request, 700000)).toMatchObject({ status: "limit", failureReason: "proposal_schema", failureStage: "proposal_validation" });
    expect(model.calls).toHaveLength(3);
  });

  it.each([
    { error: "acceptance_mapping_unavailable" },
    { error: "acceptance_mapping_unavailable", failureReason: "private-persisted-value", failureStage: "proposal_call" },
    { error: "acceptance_mapping_unavailable", failureReason: "upstream_call", failureStage: "private-persisted-stage" },
  ])("does not invent or echo diagnostic details from legacy or invalid receipts: %j", async receipt => {
    const store = ledger(), model = models({ malformed: true });
    for (let attempt = 0; attempt < 3; attempt++) await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000 + attempt * 200000);
    store.database.exec("DROP TRIGGER collaboration_mapping_result_no_update");
    store.database.prepare("UPDATE collaboration_acceptance_mapping_results SET receipt_json=? WHERE attempt=3").run(JSON.stringify(receipt));
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 700000);
    expect(result).toEqual({ status: "limit", requestHash: mappingRequestHash(request) });
    expect(model.calls).toHaveLength(3);
  });

  it.each(["mjs", "tsx", "jsx"])("cannot bind %s implementation context as a reported test", async extension => {
    const input: MappingRequest = { ...request, sources: [...request.sources, { ...request.sources[0],
      file: `src/save.${extension}`, role: "implementation", text: extension === "mjs" ? 'export const save = () => "after";' : 'export const save = () => <button>after</button>;' }] };
    const model = models();
    model.proposer.complete = async () => ({ ...proposal(input), bindings: [{ ...proposal(input).bindings[0],
      file: `src/save.${extension}`, testName: "save", quote: input.sources[1].text }] });
    const result = await new AcceptanceMappingCoordinator(ledger().database, model).map(input, 1000);
    expect(result.status).toBe("failed");
    expect(result.contracts).toBeUndefined();
    expect(model.calls).toHaveLength(0); // The independent role must not run after an invalid binding.
  });
  it("preserves sanitized source and exact quotes through both models, replay and receipt revalidation", async () => {
    const input: MappingRequest = { ...request, sources: [{ ...request.sources[0],
      text: 'const password = "fixture-value";\n' + request.sources[0].text }] };
    const expectedText = 'const password = "[敏感信息已隐藏]";\n' + request.sources[0].text;
    const store = ledger();
    const calls: string[] = [];
    const model = {
      policyId: "source-syntax-v1",
      proposer: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
        calls.push(call.user);
        const data = JSON.parse(call.user);
        expect(data.sources[0].numberedLines).toEqual(expectedText.split("\n").map((text, index) => [index + 1, text]));
        return { ...proposal(input), bindings: [{ ...proposal(input).bindings[0], startLine: 2, endLine: 2,
          quote: request.sources[0].text }] };
      } },
      verifier: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
        calls.push(call.user);
        const data = JSON.parse(call.user);
        expect(data.request.sources[0].text).toBe(expectedText);
        return { version: 1, requestHash: data.requestHash, proposalHash: data.proposalHash,
          findings: [{ conditionHash: acceptanceConditionHash(condition), state: "covered", reason: "合成端口仅测试源码传递" }] };
      } },
    };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(input, 1000);
    expect(result.status).toBe("approved");
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(input, 2000)).toEqual(result);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("fixture-value");
    expect(readApprovedAcceptanceMapping(store.database, { requestHash: result.requestHash, policyId: model.policyId,
      candidateSha: input.candidateSha, specHash: input.specHash, conditions: input.conditions })).toEqual(result.contracts);
    expect(JSON.stringify(store.database.prepare("SELECT request_json FROM collaboration_acceptance_mapping_attempts").all()))
      .not.toContain("fixture-value");
  });

  it("instructs both roles to explain assertions without repeating credential examples", async () => {
    const model = models();
    expect((await new AcceptanceMappingCoordinator(ledger().database, model).map(request, 1000)).status).toBe("approved");
    for (const call of model.calls) {
      expect(call.system).toContain("说明文字仅描述输入类别、断言关系和业务结果");
      expect(call.system).toContain("不要复述密码、密钥或令牌的具体示例值");
      expect(call.system).toContain("不能还原脱敏内容");
      expect(call.system).toContain("role=implementation");
    }
  });

  it.each(["proposer", "verifier"] as const)("rejects credential-like %s explanations without retaining their values", async role => {
    const store = ledger(); const model = models();
    const original = model[role].complete.bind(model[role]);
    const synthetic = "synthetic-sensitive-fixture-value";
    model[role].complete = async input => {
      const output = await original(input) as ReturnType<typeof proposal> & { findings?: Array<{ reason: string }> };
      if (role === "proposer") output.bindings[0].rationale = `密码 ${synthetic}`;
      else output.findings![0].reason = `密码 ${synthetic}`;
      return output;
    };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    expect(result.status).toBe("failed");
    expect(result.contracts).toBeUndefined();
    const receipts = store.database.prepare("SELECT receipt_json FROM collaboration_acceptance_mapping_results").all();
    expect(JSON.stringify(receipts)).not.toContain(synthetic);
  });

  it("supplies computed condition identities to both models instead of requiring them to invent hashes", async () => {
    const store = ledger();
    const input = { ...request, conditions: [condition, { description: "保存失败", observation: "失败时显示原因" }] };
    const observed: unknown[] = [];
    const model = {
      policyId: "provided-identities-v1",
      proposer: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
        const data = JSON.parse(call.user); observed.push(data.conditions);
        return { version: 1, requestHash: data.requestHash, bindings: data.conditions.map((c: { conditionHash: string }) => ({
          ...proposal().bindings[0], conditionHash: c.conditionHash,
        })) };
      } },
      verifier: { async complete(call: Parameters<NaturalIntakeModelPort["complete"]>[0]) {
        const data = JSON.parse(call.user); observed.push(data.request.conditions);
        return { version: 1, requestHash: data.requestHash, proposalHash: data.proposalHash,
          findings: data.request.conditions.map((c: { conditionHash: string }) => ({ conditionHash: c.conditionHash, state: "covered", reason: "合成端口仅验证身份传递" })) };
      } },
    };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(input, 1000);
    expect(result.status).toBe("approved");
    const enriched = input.conditions.map(c => ({ ...c, conditionHash: acceptanceConditionHash(c) }));
    expect(observed).toEqual([enriched, enriched]);
    expect(input.conditions[0]).not.toHaveProperty("conditionHash");
    expect(readApprovedAcceptanceMapping(store.database, { requestHash: result.requestHash, policyId: model.policyId,
      candidateSha: input.candidateSha, specHash: input.specHash, conditions: input.conditions })).toEqual(result.contracts);
  });

  it.each([
    ["proposer", undefined], ["verifier", undefined], ["proposer", 600_000], ["verifier", 600_000],
  ] as const)("cancels a waiting %s with trusted budget %s without writing a late receipt or starting another model", async (stage, timeoutMs) => {
    const store = ledger(); const model = { ...models(), timeoutMs }; const controller = new AbortController();
    let release!: (value: unknown) => void;
    let captured: AbortSignal | undefined;
    const original = model[stage].complete.bind(model[stage]);
    let value: unknown;
    model[stage].complete = async input => {
      captured = input.signal;
      value = await original(input);
      return new Promise(resolve => { release = resolve; });
    };
    const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000, controller.signal);
    const settled = expect(pending).rejects.toThrow("acceptance_mapping_cancelled");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort();
    await settled;
    expect(captured?.aborted).toBe(true);
    const calls = model.calls.length;
    release(value);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.calls).toHaveLength(calls);
    expect(store.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ count: 1 });
    expect(store.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_results").get()).toEqual({ count: 0 });
  });
  it("does not reserve an attempt or call a model when already cancelled", async () => {
    const store = ledger(); const model = models();
    await expect(new AcceptanceMappingCoordinator(store.database, model).map(request, 1000, AbortSignal.abort()))
      .rejects.toThrow("acceptance_mapping_cancelled");
    expect(model.calls).toHaveLength(0);
    expect(store.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ count: 0 });
  });
  it("never starts the independent model after a timed-out proposer eventually returns", async () => {
    const store = ledger(); const model = models();
    let release!: (value: unknown) => void;
    model.proposer.complete = () => new Promise(resolve => { release = resolve; });
    vi.useFakeTimers();
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      await vi.advanceTimersByTimeAsync(90001);
      expect((await pending).status).toBe("failed");
      release(proposal());
      await vi.advanceTimersByTimeAsync(1);
      expect(model.calls).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it("requires independent review and persists a reproducible binding without user hashes", async () => {
    const store = ledger(); const model = models();
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    expect(result.status).toBe("approved");
    expect(result.contracts?.cases.bindings).toEqual([{ conditionHash: acceptanceConditionHash(condition), assertionIds: [nodeTestAssertionId("case.test.mjs", "保存")] }]);
    expect(model.calls).toHaveLength(2);
    const expected={requestHash:result.requestHash,policyId:model.policyId,candidateSha:request.candidateSha,specHash:request.specHash,conditions:request.conditions};
    expect(readApprovedAcceptanceMapping(store.database,expected)).toEqual(result.contracts);
    for(const change of [{candidateSha:"d".repeat(40)},{specHash:"e".repeat(64)},{policyId:"changed"},{conditions:[{description:"别的需求",observation:"另一结果"}]}]) {
      expect(readApprovedAcceptanceMapping(store.database,{...expected,...change})).toBeUndefined();
    }
    expect(model.calls[0].system).not.toBe(model.calls[1].system);
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(request, 2000)).toEqual(result);
    expect(model.calls).toHaveLength(2);
  });
  it("does not make uncertain or instruction-bearing output into a contract", async () => {
    for (const option of [{ reject: true }, { malformed: true }]) {
      const result = await new AcceptanceMappingCoordinator(ledger().database, models(option)).map(request, 1000);
      expect(result.status).not.toBe("approved");
      expect(result.contracts).toBeUndefined();
    }
  });
  it("rejects invented source quotes and refuses a shared model context", async () => {
    const model = models();
    model.proposer.complete = async () => ({ ...proposal(), bindings: [{ ...proposal().bindings[0], quote: "not in source" }] });
    expect((await new AcceptanceMappingCoordinator(ledger().database, model).map(request, 1000)).status).toBe("failed");
    expect(() => new AcceptanceMappingCoordinator(ledger().database, { proposer: model.proposer, verifier: model.proposer, policyId: "fixture-v1" })).toThrow("independent");
  });
  it("keeps three failed attempts across coordinator restarts and does not retry forever", async () => {
    const store = ledger(); const model = models({ malformed: true });
    for (let i=0;i<4;i++) await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000+i*200000);
    expect(model.calls).toHaveLength(3);
    expect(() => store.database.exec("DELETE FROM collaboration_acceptance_mapping_attempts")).toThrow("immutable");
  });
  const recovery = () => ({ requestHash: mappingRequestHash(request), policyId: "fixture-v1",
    afterAttempt: 3 as const, referenceHash: "f".repeat(64) });
  async function exhausted() {
    const store = ledger();
    for (let i = 0; i < 3; i++) await new AcceptanceMappingCoordinator(store.database, models({ malformed: true })).map(request, 1000 + i * 200000);
    return store;
  }
  it("does not refund exhausted legacy attempts or change their receipts when only the trusted budget grows", async () => {
    const store = await exhausted(), model = { ...models(), timeoutMs: 600_000 };
    const history = () => store.database.prepare("SELECT a.*,r.receipt_json FROM collaboration_mapping_all_attempts a LEFT JOIN collaboration_mapping_all_results r USING(request_key,attempt) ORDER BY a.attempt").all();
    const before = history();
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(request, 700_000)).toMatchObject({ status: "limit", failureReason: "proposal_schema" });
    expect(model.calls).toHaveLength(0);
    expect(history()).toEqual(before);
    expect(before).toHaveLength(3);
  });
  it("records a trusted one-time fourth-attempt authorization before I/O without changing historical receipts", async () => {
    const store = await exhausted(), model = models();
    const history = () => store.database.prepare("SELECT a.*,r.receipt_json FROM collaboration_acceptance_mapping_attempts a LEFT JOIN collaboration_acceptance_mapping_results r USING(request_key,attempt) WHERE a.attempt<=3 ORDER BY a.attempt").all();
    const before = history(), complete = model.proposer.complete.bind(model.proposer);
    model.proposer.complete = async input => {
      const row = store.database.prepare("SELECT request_json FROM collaboration_mapping_recovery_attempts WHERE attempt=4").get() as { request_json: string };
      expect(JSON.parse(row.request_json).ownerAuthorizedRecovery).toEqual(recovery());
      return complete(input);
    };
    const result = await new AcceptanceMappingCoordinator(store.database, model).map(request, 700000, undefined, recovery());
    expect(result.status).toBe("approved"); expect(history()).toEqual(before);
    expect(readApprovedAcceptanceMapping(store.database, { ...recovery(), candidateSha: request.candidateSha,
      specHash: request.specHash, conditions: request.conditions })).toEqual(result.contracts);
    expect(await new AcceptanceMappingCoordinator(store.database, model).map(request, 800000)).toEqual(result);
    expect(model.calls).toHaveLength(2);
  });
  it("never grants a fifth attempt, including with a new authorization reference after restart", async () => {
    const store = await exhausted(), model = models({ malformed: true });
    expect((await new AcceptanceMappingCoordinator(store.database, model).map(request, 700000, undefined, recovery())).status).toBe("failed");
    expect((await new AcceptanceMappingCoordinator(store.database, model).map(request, 900000, undefined,
      { ...recovery(), referenceHash: "e".repeat(64) })).status).toBe("limit");
    expect((await new AcceptanceMappingCoordinator(store.database, model).map(request, 900001)).status).toBe("limit");
    expect(model.calls).toHaveLength(1);
  });
  it.each([ { policyId: "other" }, { requestHash: "0".repeat(64) }, { referenceHash: "not-a-digest" },
    { afterAttempt: 4 }, { extra: "untrusted" } ])("rejects mismatched or malformed recovery before any model call: %j", async change => {
    const store = await exhausted(), model = models();
    await expect(new AcceptanceMappingCoordinator(store.database, model).map(request, 700000, undefined,
      { ...recovery(), ...change } as ReturnType<typeof recovery>)).rejects.toThrow("acceptance_mapping_recovery_invalid");
    expect(model.calls).toHaveLength(0);
    expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_attempts").get()).toEqual({ n: 3 });
  });
  it("does not accept recovery inside untrusted request data or before the three attempts are spent", async () => {
    const store = ledger(), model = models(), coordinator = new AcceptanceMappingCoordinator(store.database, model);
    await expect(coordinator.map(request, 1000, undefined, recovery())).rejects.toThrow("acceptance_mapping_recovery_invalid");
    await expect(coordinator.map({ ...request, ownerAuthorizedRecovery: recovery() } as MappingRequest, 1000)).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
  });
  it("consumes a cancelled fourth reservation and cannot refund it after lease expiry", async () => {
    const store = await exhausted(), model = models(), controller = new AbortController();
    let release!: () => void;
    model.proposer.complete = () => new Promise(resolve => { release = () => resolve(proposal()); });
    const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 700000, controller.signal, recovery());
    expect((await new AcceptanceMappingCoordinator(store.database, models()).map(request, 700001, undefined, recovery())).status).toBe("pending");
    controller.abort(); await expect(pending).rejects.toThrow("acceptance_mapping_cancelled"); release();
    expect((await new AcceptanceMappingCoordinator(store.database, models()).map(request, 900000, undefined, recovery())).status).toBe("limit");
    expect(store.database.prepare("SELECT count(*) AS n FROM collaboration_acceptance_mapping_results").get()).toEqual({ n: 3 });
  });
  it("does not reuse a mapping after the Spec or candidate changes", async () => {
    const store = ledger(); const model = models();
    await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    const next = await new AcceptanceMappingCoordinator(store.database, model).map({ ...request, candidateSha: "d".repeat(40) }, 2000);
    expect(next.status).toBe("failed");
    expect(model.calls).toHaveLength(3);
  });
  it("does not duplicate a live mapping and ignores a late result after a newer claim", async () => {
    const store = ledger(); const model = models();
    let release!: (value: unknown) => void;
    model.proposer.complete = () => new Promise(resolve => { release = resolve; });
    const first = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    expect((await new AcceptanceMappingCoordinator(store.database, models()).map(request, 1001)).status).toBe("pending");
    const fresh = await new AcceptanceMappingCoordinator(store.database, models()).map(request, 122000);
    expect(fresh.status).toBe("approved");
    release(proposal());
    expect((await first).status).toBe("pending");
    expect(store.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_results").get()).toEqual({count: 1});
  });
  it("times out even when a model ignores cancellation and consumes the durable attempt", async () => {
    const store = ledger(); const model = models();
    model.proposer.complete = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
      await vi.advanceTimersByTimeAsync(90001);
      expect((await pending).status).toBe("failed");
      expect(store.database.prepare("SELECT count(*) AS count FROM collaboration_acceptance_mapping_attempts").get()).toEqual({count: 1});
    } finally { vi.useRealTimers(); }
  });
  it("cannot use a stale independent review or reuse approval under a new verification policy", async () => {
    const store = ledger(); const model = models();
    await new AcceptanceMappingCoordinator(store.database, model).map(request, 1000);
    const changed = models(); changed.policyId = "new-policy";
    changed.verifier.complete = async () => ({version: 1, requestHash: mappingRequestHash(request), proposalHash: "0".repeat(64), findings: []});
    expect((await new AcceptanceMappingCoordinator(store.database, changed).map(request, 2000)).status).toBe("failed");
  });
});
