import { describe, expect, it } from "vitest";
import { renderDiscussionSelection } from "./discussion-options.ts";

describe("readable selected discussion text", () => {
  it.each(["只改提示文字。", "显示“请稍后重试。”", "显示「请稍后重试！」"])("does not double punctuation after %s", description => {
    const option = { title: "简洁版", description, tradeoff: "文字较少。" };
    expect(renderDiscussionSelection({ optionIndex: 1, option, presentation: { kind: "offer",
      sourceEventId: "offer", presentationHash: "a".repeat(64), workItemId: null, workItemVersion: 0, snapshotRevision: 0, options: [option] } }))
      .toBe(`已选「简洁版」：${description}后续按这个方案继续细化。`);
  });
});
