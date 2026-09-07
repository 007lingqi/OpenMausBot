import { describe, expect, it } from "vitest";
import { evaluateDefinitionReadiness } from "./readiness.ts";
import type { WorkItemSnapshot } from "./snapshot.ts";
import { validateNaturalIntakeProposal } from "./natural-intake.ts";

const snapshot: WorkItemSnapshot = { workItemId: "WI-FIXTURE", revision: 2, sourceWorkItemVersion: 1,
  goal: "登录提示友好一点", goalConfirmed: false, repository: "/tmp/project", facts: [], assumptions: [], acceptanceConditions: [], createdAt: 1000,
  blockingAmbiguities: [{ id: "natural-login-message", question: "哪个登录场景，想显示什么提示？", recommendedAnswer: "需要明确场景与提示", dependsOn: [], role: "requester" }] };
describe("concrete natural clarification frontier", () => {
  it("asks the concrete question without also asking the generic goal template, while retaining every gate", () => {
    const result = evaluateDefinitionReadiness(snapshot, ["/tmp/project"]);
    expect(result.frontier.map(q => q.id)).toEqual(["natural-login-message"]);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(["goal", "acceptance", "blocking_ambiguity"]);
  });
  it("restores the goal question when no concrete business question remains and keeps configuration gates", () => {
    expect(evaluateDefinitionReadiness({ ...snapshot, blockingAmbiguities: [] }, ["/tmp/project"]).frontier.map(q => q.id)).toEqual(["goal"]);
    expect(evaluateDefinitionReadiness({ ...snapshot, repository: null }, []).frontier.map(q => q.id)).toEqual(["natural-login-message", "repository"]);
  });
  it.each(["natural-input-pending", "natural-context-incomplete"])("does not let system state %s hide goal confirmation", id => {
    const result = evaluateDefinitionReadiness({ ...snapshot, blockingAmbiguities: [{ ...snapshot.blockingAmbiguities[0]!, id }] }, ["/tmp/project"]);
    expect(result.frontier.some(q => q.id === "goal")).toBe(true);
    expect(result.frontier.find(q => q.id === id)?.showRecommendedAnswer).not.toBe(false);
  });
  it("preserves repository configuration among three concrete questions", () => {
    const result = evaluateDefinitionReadiness({ ...snapshot, repository: null,
      blockingAmbiguities: [1, 2, 3].map(n => ({ ...snapshot.blockingAmbiguities[0]!, id: `natural-${n}` })) }, []);
    expect(result.frontier.map(q => q.id)).toEqual(["natural-1", "natural-2", "repository"]);
    expect(result.blockers).toContain("repository");
  });
  it("cannot confirm an unasked generic goal from a short answer to a concrete question", () => {
    const request = { event: { sourceEventId: "short-answer", principalId: "product", text: "对" }, snapshot,
      history: [], contextTruncated: false, questions: evaluateDefinitionReadiness(snapshot, ["/tmp/project"]).frontier };
    expect(() => validateNaturalIntakeProposal({ version: 1, sourceEventId: "short-answer", baseRevision: snapshot.revision,
      goal: { text: snapshot.goal, confirmed: true, quote: "对" }, answers: [], questions: [], acceptance: [] }, request))
      .toThrow("natural_intake_confirmation_not_grounded");
  });
});
