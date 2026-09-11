import { describe, expect, it } from "vitest";
import { classifyConversationIntent, validateConversationDecision, type ConversationIntentRequest } from "./conversation-intent.ts";
import type { NaturalIntakeModelPort } from "./natural-intake.ts";

const input: ConversationIntentRequest = {
  sourceEventId: "mixed", principalId: "product", text: "登录提示改短，支付进展如何？",
  candidates: [{ id: "WI-LOGIN", title: "登录提示", version: 1, snapshotRevision: 0, state: "open" },
    { id: "WI-PAY", title: "支付提示", version: 2, snapshotRevision: 1, state: "open" }],
  history: [], referencedWorkItemId: null, referencedReplyId: null, pendingQuestion: null, contextTruncated: false,
};
const single = (text: string, intent: string, target: string | null) => ({ version: 1, sourceEventId: input.sourceEventId,
  intent, targetWorkItemId: target, replySourceEventId: null, quote: text, confidence: "high", advice: null, choice: null });
const proposal = () => ({ ...single(input.text, "clarify", null), parts: [
  { ...single("登录提示改短", "contribution", "WI-LOGIN"), text: "登录提示改短" },
  { ...single("支付进展如何", "status_query", "WI-PAY"), text: "支付进展如何" },
] });
const passed = { allIntentsCovered: true, scopesIndependent: true, constraintsPreserved: true };
function model<T>(raw: T, review = passed): NaturalIntakeModelPort {
  let calls = 0;
  return { async complete() { return ++calls === 1 ? raw : review; } };
}

describe("source-bound multi-intent decisions", () => {
  it("does not lose a delivered scheme binding inside an implementation-plus-query turn", async () => {
    const request: ConversationIntentRequest = { ...input, text: "请实现标准版，支付进展如何？",
      history: [{ sourceEventId: "offer", role: "assistant", principalId: null, workItemId: "WI-LOGIN", text: "标准版：保留用户名。" }],
      pendingQuestion: { kind: "read_only", origin: "advice", sourceEventId: "offer", workItemIds: ["WI-LOGIN"], text: "选哪个？" },
      discussionOptions: { sourceEventId: "offer", presentationHash: "a".repeat(64), workItemId: "WI-LOGIN", workItemVersion: 1, snapshotRevision: 0,
        options: [{ title: "标准版", description: "保留用户名。", tradeoff: "涉及登录页面。" }] },
    };
    const raw = { ...single(request.text, "clarify", null), parts: [
      { ...single("请实现标准版", "contribution", "WI-LOGIN"), text: "请实现标准版", choice: { sourceEventId: "offer", optionIndex: 1 } },
      proposal().parts[1],
    ] };
    expect(await classifyConversationIntent(model(raw), request, new AbortController().signal)).toMatchObject({ action: "route_turn", parts: [
      { decision: { action: "contribute", implementationSelection: { option: { title: "标准版" }, presentation: { sourceEventId: "offer" } } } },
      { decision: { action: "read_status", target: { id: "WI-PAY" } } },
    ] });
  });
  it("preserves a reference-conflict clarification instead of rejecting the complete turn", async () => {
    const request = { ...input, referencedWorkItemId: "WI-LOGIN" };
    const result = await classifyConversationIntent(model(proposal()), request, new AbortController().signal);
    expect(result).toMatchObject({ action: "route_turn", parts: [
      { decision: { action: "contribute" } }, { decision: { action: "ask_context", reason: "reference_conflict" } },
    ] });
    expect(validateConversationDecision(request, result)).toEqual(result);
  });
  it("cancels scope review even when the model ignores its signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = classifyConversationIntent({ async complete() {
      if (++calls === 1) return proposal();
      controller.abort();
      return new Promise<never>(() => undefined);
    } }, input, controller.signal);
    await expect(result).rejects.toThrow("conversation_intent_cancelled");
    expect(calls).toBe(2);
  }, 1000);
  it.each(["allIntentsCovered", "scopesIndependent", "constraintsPreserved"] as const)("does not apply a turn rejected for %s", async key => {
    const result = await classifyConversationIntent(model(proposal(), { ...passed, [key]: false }), input, new AbortController().signal);
    expect(result).toMatchObject({ action: "ask_context" });
  });
  it.each(["missing", "overlap", "foreign", "quote"])("rejects an invalid partition: %s", async fault => {
    const raw = proposal();
    if (fault === "missing") raw.parts[0] = { ...raw.parts[0], text: "提示改短", quote: "提示改短" };
    if (fault === "overlap") raw.parts[1] = raw.parts[0];
    if (fault === "foreign") raw.parts[1].sourceEventId = "another-message";
    if (fault === "quote") raw.parts[1].quote = "支付";
    await expect(classifyConversationIntent(model(raw), input, new AbortController().signal)).rejects.toThrow();
  });
  it("rejects altered review evidence and decisions", async () => {
    const result = await classifyConversationIntent(model(proposal()), input, new AbortController().signal);
    expect(validateConversationDecision(input, result)).toEqual(result);
    if (result.action !== "route_turn") throw new Error("expected multi-intent turn");
    expect(() => validateConversationDecision(input, { ...result, scopeReviewHash: "0".repeat(64) })).toThrow();
    expect(() => validateConversationDecision({ ...input, text: input.text + "只讨论" }, result)).toThrow();
    expect(() => validateConversationDecision(input, { ...result, parts: result.parts.toReversed() })).toThrow();
  });
  it("does not expose provider details when review fails", async () => {
    let calls = 0;
    await expect(classifyConversationIntent({ async complete() {
      if (++calls === 1) return proposal();
      throw new Error("private provider details");
    } }, input, new AbortController().signal)).rejects.toThrow("conversation_intent_unavailable");
  });
});
