import { describe, expect, it } from "vitest";
import { executionSpec, parseExecutionSpec } from "./execution-spec.ts";
import type { WorkItemSnapshot } from "./snapshot.ts";

const snapshot: WorkItemSnapshot = { workItemId: "WI-1", revision: 7, sourceWorkItemVersion: 3,
  goal: "订单导出为Excel", goalConfirmed: true, repository: "/repo", facts: ["旧要求CSV"], assumptions: [],
  acceptanceConditions: [{ description: "导出Excel", observation: "文件为Excel" }], blockingAmbiguities: [], createdAt: 1 };

describe("current execution Spec", () => {
  it("keeps all current conditions and source versions without raw historical utterances", () => {
    const conditions = Array.from({ length: 50 }, (_, i) => ({ description: `${i}${"条".repeat(1900)}`, observation: `${i}${"证".repeat(1900)}` }));
    const spec = executionSpec({ ...snapshot, acceptanceConditions: conditions });
    expect(spec).toMatchObject({ version: 1, workItemId: "WI-1", snapshotRevision: 7, sourceWorkItemVersion: 3, acceptanceConditions: conditions });
    expect(JSON.stringify(spec)).not.toContain("CSV");
    expect(spec.acceptanceConditions).not.toBe(conditions);
  });
  it("rejects unsettled, foreign, oversized and permission-bearing data", () => {
    expect(() => executionSpec({ ...snapshot, goalConfirmed: false })).toThrow("execution_spec_unsettled");
    expect(() => executionSpec({ ...snapshot, blockingAmbiguities: [{ id: "gap", question: "什么结果", dependsOn: [], recommendedAnswer: "说明结果" }] })).toThrow("execution_spec_unsettled");
    expect(() => executionSpec({ ...snapshot, acceptanceConditions: [] })).toThrow();
    const spec = executionSpec(snapshot);
    expect(() => parseExecutionSpec(spec, "WI-OTHER")).toThrow("execution_spec_work_item_mismatch");
    expect(() => parseExecutionSpec({ ...spec, permissions: { network: true } }, "WI-1")).toThrow();
    expect(() => parseExecutionSpec({ ...spec, goal: "x".repeat(2001) }, "WI-1")).toThrow();
    expect(() => parseExecutionSpec({ ...spec, acceptanceConditions: Array(51).fill(spec.acceptanceConditions[0]) }, "WI-1")).toThrow();
  });
  it("refuses secret-bearing requirements instead of sending or silently truncating them", () => {
    expect(() => executionSpec({ ...snapshot, goal: `API key sk-${"a".repeat(48)}` })).toThrow("execution_spec_sensitive_content");
  });
});
