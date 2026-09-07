import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { NaturalIntakeModelPort } from "./natural-intake.ts";
import { runConversationEvaluation, stageReplyDelivered, selectConversationScenarios } from "../../scripts/collaboration-pilot/conversation-eval.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("conversation evaluation uses the real ingress without real delivery or execution", () => {
  it("records actual task, reply and immutable-query evidence from a tool-free model port", async () => {
    const model: NaturalIntakeModelPort = { async complete(request) {
      const input = JSON.parse(request.user);
      if (input.candidates) return { version: 1, sourceEventId: input.sourceEventId,
        intent: input.text.includes("进展") ? "status_query" : "new_request", targetWorkItemId: input.candidates[0]?.id ?? null,
        replySourceEventId: null, quote: input.text, confidence: "high" };
      return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
        goal: { text: input.event.text, quote: input.event.text, confirmed: true },
        acceptance: [{ description: input.event.text, observation: input.event.text, quote: input.event.text }], answers: [], questions: [] };
    } };
    const result = await runConversationEvaluation({ model, scenarios: [{ id: "basic", turns: [
      { speaker: "product", text: "登录失败时保留用户名。", expect: { action: "create_work", items: 1 } },
      { speaker: "tester", text: "登录的进展怎么样？", expect: { action: "read_status", items: 1, unchangedRequirements: true } },
    ] }] });
    directories.push(result.directory);
    expect(result.report.turns.map(turn => turn.checks)).toEqual(expect.arrayContaining([expect.objectContaining({ stageReplyDelivered: true })]));
    expect(result.report.status).toBe("checks_passed");
    expect(result.report.naturalnessReview).toBe("pending");
    expect(result.report.sourceUnchanged).toBe(true);
    expect(result.report.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.turns[0].checks.stageReplyDelivered).toBe(true);
    expect(result.report.modelCalls).toBe(3);
    expect(result.report.turns).toHaveLength(2);
    expect(result.report.turns[1].checks).toMatchObject({ action: true, items: true, unchangedRequirements: true, replayIdempotent: true });
    expect(result.report.turns[1].replies.join(" ")).not.toContain("修改完成");
    expect(result.report.scope).toEqual({ realModel: false, realDingTalk: false, execution: false, isolatedLedger: true });
  });

  it.each(["ready_for_execution", "planning_failed"])("does not count receipt or an old plan as the current %s reply", status => {
    expect(stageReplyDelivered(status, 4, [{ type: "primary_status_card" }])).toBe(false);
    expect(stageReplyDelivered(status, 4, [{ type: "plan_status_card", status, snapshotRevision: 2 }])).toBe(false);
    expect(stageReplyDelivered(status, 4, [{ type: "plan_status_card", status, snapshotRevision: 4 }])).toBe(true);
  });
  it("requires clarification delivery and rejects unsupported stage values", () => {
    expect(stageReplyDelivered("waiting_clarification", 2, [{ type: "primary_status_card" }])).toBe(false);
    expect(stageReplyDelivered("waiting_clarification", 2, [{ type: "clarification_card", snapshotRevision: 2 }])).toBe(true);
    expect(stageReplyDelivered("unknown", 2, [])).toBe(false);
  });
  it("selects only the explicitly requested known scenario before any model call", () => {
    expect(selectConversationScenarios(["--live", "--scenario", "clarification-and-answer"]).map(s => s.id)).toEqual(["clarification-and-answer"]);
    expect(() => selectConversationScenarios(["--live", "--scenario", "unknown"])).toThrow();
    expect(() => selectConversationScenarios([])).toThrow();
    expect(() => selectConversationScenarios(["--live", "--endpoint", "elsewhere"])).toThrow();
  });

  it("includes a multi-topic short-answer regression, not just fully specified follow-ups", () => {
    const [scenario] = selectConversationScenarios(["--live", "--scenario", "unanswered-topics-and-short-answer"]);
    expect(scenario.turns[2]).toMatchObject({ text: "对，就这样。", expect: { action: "ask_context", items: 2, unchangedRequirements: true, pendingTasks: 2 } });
    expect(scenario.turns[3].expect).toMatchObject({ action: "contribute", targetTurn: 0 });
    const [status] = selectConversationScenarios(["--live", "--scenario", "clear-request-and-status"]);
    expect(status.turns[1].expect.maxReplyLength).toBe(90);
  });

  it("checks named hints and the preserved read-only purpose in a continuous multi-question scenario", async () => {
    const [scenario] = selectConversationScenarios(["--live", "--scenario", "progress-amid-unanswered-requirements"]);
    expect(scenario.turns.every(turn => turn.speaker === "product")).toBe(true);
    expect(scenario.turns[3]).toMatchObject({ text: "登录那个。", expect: { action: "read_status", unchangedRequirements: true, pendingKind: "read_only" } });
    const model: NaturalIntakeModelPort = { async complete(envelope) {
      const input = JSON.parse(envelope.user);
      if (input.candidates) {
        const turn = Number(input.sourceEventId.split(":").at(-1));
        return { version: 1, sourceEventId: input.sourceEventId, intent: turn < 2 ? "new_request" : "status_query",
          targetWorkItemId: turn === 3 ? input.candidates.find((candidate: { title: string }) => candidate.title.includes("登录")).id : null,
          replySourceEventId: null, quote: input.text, confidence: "high" };
      }
      return { version: 1, sourceEventId: input.event.sourceEventId, baseRevision: input.snapshot.revision,
        goal: null, acceptance: [], answers: [], questions: [] };
    } };
    const result = await runConversationEvaluation({ model, scenarios: [scenario] }); directories.push(result.directory);
    expect(result.report.status).toBe("checks_passed");
    expect(result.report.turns[2].checks.topicHints).toBe(true);
    expect(result.report.turns[3].checks.pendingKind).toBe(true);
  });

  it("stops after three model failures instead of retrying or inventing a successful result", async () => {
    let calls = 0;
    const result = await runConversationEvaluation({ model: { async complete() { calls++; throw new Error("private upstream body"); } },
      scenarios: Array.from({ length: 5 }, (_, i) => ({ id: `failed-${i}`, turns: [{ speaker: "product", text: "谢谢。", expect: { action: "acknowledge", items: 0 } }] })) });
    directories.push(result.directory);
    expect(calls).toBe(3);
    expect(result.report.status).toBe("stopped");
    expect(result.report.turns.every(turn => !turn.passed)).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain("private upstream body");
    expect(result.report.stopReason).toBe("three_consecutive_model_failures");
  });
});
