import { describe, expect, it } from "vitest";
import { reviewSharedFactRewrite, validateSemanticReview, type SharedRewriteContext } from "./fact-rewrite.ts";

const before = { description: "内部员工下载逗号分隔的订单文件", observation: "只能下载自己负责的订单" };
const after = { ...before, description: "内部员工下载Excel订单文件" };
const context: SharedRewriteContext = { workItemId: "WI-A", baseRevision: 3, sourceEventId: "correction",
  clarification: { principalId: "a", text: "更正为Excel，其他不变" }, acceptance: [{ before, facts: [
  { key: "format", principalId: "a", before: "CSV", after: "Excel" },
  { key: "audience", principalId: "a", before: "内部员工", after: "内部员工" },
] }], goal: { before: "给内部员工导出CSV订单", facts: [
  { key: "format", principalId: "a", before: "CSV", after: "Excel" },
  { key: "audience", principalId: "a", before: "内部员工", after: "内部员工" },
] } };
const candidate = { acceptance: [{ before, after }], goal: { before: context.goal!.before, after: "给内部员工导出Excel订单" } };
const verdict = { appliesRequestedChanges: true, preservesOtherRequirements: true, uncertain: false, question: null };

describe("tool-free scoped semantic fact rewriting", () => {
  it("requires a separate preservation review before returning a scoped rewrite", async () => {
    const calls: Array<{ system: string; user: string; responseSchema: unknown }> = [];
    const result = await reviewSharedFactRewrite({ async complete(input) {
      calls.push(input); return calls.length === 1 ? candidate : verdict;
    } }, context, new AbortController().signal);
    if (!result || !("rewrites" in result)) throw new Error("Expected a reviewed rewrite");
    expect(result?.rewrites).toEqual(candidate);
    expect(calls).toHaveLength(2);
    expect(calls[0].system).not.toBe(calls[1].system);
    expect(JSON.parse(calls[1].user)).toEqual({ context, candidate });
    expect(calls[1].system).toContain("不可信");
    expect(result?.contextHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => validateSemanticReview({ ...context, workItemId: "WI-OTHER" }, result)).toThrow();
    expect(() => validateSemanticReview({ ...context, baseRevision: 4 }, result)).toThrow();
    expect(() => validateSemanticReview(context, { ...result, candidateHash: "0".repeat(64) })).toThrow();
    expect(() => validateSemanticReview(context, { ...result, verdict: { ...verdict, uncertain: true } })).toThrow();
  });

  it("turns uncertainty into one concrete business question without approving a rewrite", async () => {
    let calls = 0;
    const question = "需要改的是下载文件的格式，还是导出插件？";
    expect(await reviewSharedFactRewrite({ async complete() { return ++calls === 1 ? candidate : { ...verdict, uncertain: true, question }; } }, context,
      new AbortController().signal)).toEqual({ clarificationQuestion: question });
  });

  it.each([
    { ...verdict, preservesOtherRequirements: false },
    { ...verdict, appliesRequestedChanges: false },
    { ...verdict, uncertain: true },
    { ...verdict, deploy: true },
  ])("does not apply a rewrite on a negative, uncertain or malformed independent review: %j", async review => {
    let calls = 0;
    const result = await reviewSharedFactRewrite({ async complete() { return ++calls === 1 ? candidate : review; } }, context, new AbortController().signal);
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  it.each([
    { ...candidate, acceptance: [] },
    { ...candidate, acceptance: [...candidate.acceptance, ...candidate.acceptance] },
    { ...candidate, goal: null },
    { ...candidate, acceptance: [{ before: { ...before, description: "其他事项" }, after }] },
    { ...candidate, permission: "deploy" },
  ])("rejects changed scope or injected control fields before semantic review: %j", async invalid => {
    let calls = 0;
    expect(await reviewSharedFactRewrite({ async complete() { calls++; return invalid; } }, context, new AbortController().signal)).toBeNull();
    expect(calls).toBe(1);
  });
});
