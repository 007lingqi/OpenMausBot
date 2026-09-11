import { describe, expect, it } from "vitest";

import { validateSequentialPlan } from "../graph.ts";
import { parsePlannerProposal } from "../planner.ts";
import type { WorkItemSnapshot } from "../snapshot.ts";
import { ConfiguredSequentialPlanner, configuredPlanningPolicy } from "./configured-planner.ts";

describe("configured sequential planner", () => {
  it("turns a confirmed pilot definition into the fixed four-node plan", () => {
    const options = {
      repository: "/pilot/repository",
      writeScopes: ["pilot-output.txt"],
      targetCommandIds: ["pilot:target"],
    };
    const snapshot: WorkItemSnapshot = {
      workItemId: "WI-1",
      revision: 1,
      sourceWorkItemVersion: 1,
      goal: "output hello pilot",
      goalConfirmed: true,
      repository: options.repository,
      facts: ["requested in DingTalk"],
      assumptions: [],
      acceptanceConditions: [{ description: "output exists", observation: "pilot target passes" }],
      blockingAmbiguities: [],
      createdAt: 1,
    };
    const proposal = new ConfiguredSequentialPlanner(options).propose(snapshot);
    expect(validateSequentialPlan(proposal, configuredPlanningPolicy(options)).nodes.map((node) => node.type)).toEqual([
      "analyze", "modify", "validate", "report",
    ]);
    expect(proposal.nodes[1].writeScope).toEqual(["pilot-output.txt"]);
    expect(proposal.nodes[2].commands).toEqual(["pilot:target"]);
    expect(proposal.nodes.map((node) => node.agentId)).toEqual([
      "meta-coordinator",
      "codex-patch",
      "codex-verifier",
      "meta-coordinator",
    ]);
    expect(proposal.summary).toBe("output hello pilot");
    expect(proposal.summary).not.toContain(options.repository);
  });

  it("references the fixed current Spec without reintroducing old chat as execution evidence", () => {
    const options = { repository: "/pilot/repository", writeScopes: ["src/**"], targetCommandIds: ["target"] };
    const snapshot: WorkItemSnapshot = { workItemId: "WI-1", revision: 7, sourceWorkItemVersion: 4,
      goal: "订单导出为Excel", goalConfirmed: true, repository: options.repository,
      facts: ["订单导出为CSV", "更正：订单导出为Excel"], assumptions: [], blockingAmbiguities: [], createdAt: 1,
      acceptanceConditions: [{ description: "导出为Excel", observation: "导出文件为Excel" }] };
    const plan = new ConfiguredSequentialPlanner(options).propose(snapshot);
    expect(plan.nodes.every(node => !JSON.stringify(node).includes("CSV"))).toBe(true);
    expect(plan.nodes.every(node => node.inputEvidence.some(evidence => evidence.includes("WI-1") && evidence.includes("7")))).toBe(true);
    expect(snapshot.facts).toContain("订单导出为CSV");
  });

  it("does not flatten a complete many-condition Spec into an oversized node label", () => {
    const options = { repository: "/pilot/repository", writeScopes: ["src/**"], targetCommandIds: ["target"] };
    const snapshot: WorkItemSnapshot = { workItemId: "WI-1", revision: 7, sourceWorkItemVersion: 4,
      goal: "完整实现订单查询", goalConfirmed: true, repository: options.repository, facts: [], assumptions: [],
      blockingAmbiguities: [], createdAt: 1, acceptanceConditions: Array.from({ length: 12 }, (_, i) =>
        ({ description: `${i}：${"业务条件".repeat(80)}`, observation: `${i}：${"测试结果".repeat(80)}` })) };
    expect(() => validateSequentialPlan(parsePlannerProposal(new ConfiguredSequentialPlanner(options).propose(snapshot)), configuredPlanningPolicy(options))).not.toThrow();
  });
});
