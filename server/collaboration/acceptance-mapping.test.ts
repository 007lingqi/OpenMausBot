import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("instructs both roles to explain assertions without repeating credential examples", async () => {
    const model = models();
    expect((await new AcceptanceMappingCoordinator(ledger().database, model).map(request, 1000)).status).toBe("approved");
    for (const call of model.calls) {
      expect(call.system).toContain("说明文字仅描述输入类别、断言关系和业务结果");
      expect(call.system).toContain("不要复述密码、密钥或令牌的具体示例值");
      expect(call.system).toContain("不能还原脱敏内容");
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

  it.each(["proposer", "verifier"] as const)("cancels a waiting %s without writing a late receipt or starting another model", async stage => {
    const store = ledger(); const model = models(); const controller = new AbortController();
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
