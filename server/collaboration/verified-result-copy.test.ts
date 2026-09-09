import { describe, expect, it } from "vitest";
import { verifiedResultSummary } from "./verified-result-copy.ts";
import { candidateResultDeliveryProof } from "./candidate-result-evidence.ts";

describe("bounded verified result copy", () => {
  it.each([
    ["支持全部、P0、P1、P2筛选。", "优先级与搜索共同生效。"],
    Array.from({ length: 50 }, (_, index) => `第${index + 1}项：${"筛选结果符合预期".repeat(50)}。`),
    ["修改完成后能筛选！任务完成后有空态？SHA 和 diff 可供研发核对，WI-ABCD 是内部编号。"],
    ["界面不显示 ``` 或 access_token=abcdef1234567890abcdef1234567890。"],
    ["支持 S`HA 字段；修改完`成后能筛选；支持 sec`ret=example-value 文本。"],
    ["😀".repeat(400)],
  ])("keeps real serialization and delivery-proof validation usable for legal descriptions", (...clauses: string[]) => {
    const descriptions = clauses.flat();
    const summary = verifiedResultSummary(descriptions);
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.match(/[。！？!?]/gu)).toHaveLength(2);
    expect(summary).toContain("自动回归和独立复核均已通过。");
    expect(summary).not.toMatch(/修改完成|任务完成|\bSHA\b|\bdiff\b|WI-ABCD|```|abcdef1234567890|example-value/iu);
    const proof = candidateResultDeliveryProof({ type: "plan_status_card", status: "verified_result", headline: "修改和回归已核对",
      workItemId: "work", workItemVersion: 3, planRevision: 2, snapshotRevision: 4, candidateSha: "a".repeat(40), summary }, "source", {
      outboxId: "outbox", idempotencyKey: "key", channel: "session", destination: "source", confirmationKind: "business_response",
    });
    expect(proof).toBeDefined();
  });
  it("labels a shortened excerpt and does not mutate complete acceptance descriptions", () => {
    const descriptions = ["筛选".repeat(400)];
    const before = [...descriptions];
    expect(verifiedResultSummary(descriptions)).toContain("要点摘录");
    expect(descriptions).toEqual(before);
  });
  it("refuses absent feature evidence instead of inventing a feature", () => {
    expect(() => verifiedResultSummary([])).toThrow("candidate_result_feature_description_missing");
  });
});
