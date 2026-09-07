import { describe, expect, it } from "vitest";
import { explainHistoricalProgress } from "./conversation-explanation.ts";

describe("historical status meanings do not echo the phrase or invent current facts", () => {
  it.each([
    ["修改方案已整理好，等待开始执行。", "当时还没开始修改", "等待原因"],
    ["正在整理需求，还没有开始修改。", "弄清要解决什么", "还没开始修改"],
    ["正在整理修改方案，还没有开始修改。", "确定怎么改", "还没开始修改"],
    ["修改方案还没有整理完成，目前没有开始修改。", "还没有可用的修改方案", "原因"],
    ["还需要补充信息，确认后才能开始修改。", "信息还不够", "猜测"],
    ["正在修改或检查，还没有完成。", "处理或检查中", "不能当作完成"],
    ["这次执行没有完成，需要负责人核查后决定下一步。", "没能完成", "原因"],
    ["已有改动结果，正在核对验证和确认条件，还不能标记完成。", "已有改动", "符合要求"],
    ["有结果记录，但目前还不能核对完整验证依据，不能据此确认修改完成。", "证据不完整", "不能据此确认"],
    ["修改完成，相关检查已通过。", "当时那次", "后来新增"],
    ["已暂停，需要负责人决定是否继续。", "暂时停下", "负责人"],
    ["已取消，不会继续修改。", "停止继续处理", "重新执行"],
  ])("explains the exact previously delivered phase: %s", (phase, first, second) => {
    const actual = explainHistoricalProgress(`关于「登录提示」：${phase}`);
    expect(actual).toContain(first); expect(actual).toContain(second);
    expect(actual).not.toContain(phase); expect(actual).not.toMatch(/Work Item|WI-|Spec|Ledger|之前的回复内容是/u);
    expect(actual!.length).toBeLessThan(150);
  });

  it.each([
    "其他同事说修改方案已整理好，等待开始执行。",
    "关于「修改方案已整理好，等待开始执行。登录」：最新进度还需要核查。",
    "关于「登录」：修改方案已整理好，等待开始执行。其实还没确定方案。",
    "关于「登录」：当前是新的未知状态。",
    "",
  ])("does not infer meaning from an unknown or quoted phase: %s", value => {
    expect(explainHistoricalProgress(value)).toBeNull();
  });
});
