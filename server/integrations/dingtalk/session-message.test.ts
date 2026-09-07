import { describe, expect, it } from "vitest";
import { renderPlanStatusCard, renderPrimaryStatusCard } from "../../collaboration/message-renderer.ts";
import { renderDingTalkSessionMessage } from "./session-message.ts";

function markdown(payload: unknown): { title: string; text: string } {
  return renderDingTalkSessionMessage(payload).markdown as { title: string; text: string };
}

const internalEvidence = {
  workItemId: "WI-INTERNAL", candidateSha: "private-sha", changedPaths: ["private.ts"],
  testStates: ["target_passed"], candidatePreview: "+private-code",
  actions: [{ actionToken: "private-token" }],
};

function expectBusinessOnly(value: string) {
  expect(value).not.toMatch(/WI|Work Item|任务编号|状态:|Candidate|private|target_passed|```/u);
}

describe("natural DingTalk session replies", () => {
  it("distinguishes receipt of a new request from an associated contribution without claiming execution", () => {
    const created = markdown(renderPrimaryStatusCard({ workItemId: "WI-INTERNAL", status: "collecting", version: 1, association: "created" }));
    const associated = markdown(renderPrimaryStatusCard({ workItemId: "WI-INTERNAL", status: "collecting", version: 2, association: "associated" }));
    expect(created.text).toContain("正在整理你的需求，还没有开始修改");
    expect(associated.title).toBe("补充已收到");
    expect(associated.text).toContain("结合前面的需求一起整理");
    expect(associated.text).not.toContain("新任务");
    for (const reply of [created, associated]) {
      expectBusinessOnly(reply.text);
      expect(reply.text).not.toMatch(/当前进度|修改完成/u);
      expect(reply.text.length).toBeLessThan(100);
    }
  });

  it("does not invent a failure or leak evidence while planning", () => {
    const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "planning" }), ...internalEvidence });
    expect(reply.text).toContain("正在整理修改方案，还没有开始修改");
    expect(reply.text).not.toMatch(/planning|失败|不可用|重试|处理建议/u);
    expectBusinessOnly(reply.text);
  });

  it.each([
    ["planning_failed", "修改方案还没整理完成"],
    ["execution_failed", "这次修改没有完成"],
    ["verification_pending", "正在核对修改结果"],
    ["verification_blocked", "修改结果尚未通过复核"],
  ] as const)("gives a phase-specific %s notice even when no readable reason exists", (status, expected) => {
    for (const failures of [undefined, [], ["unrecognized_internal_code"]]) {
      const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status, failures }), ...internalEvidence });
      expect(reply.text).toContain(expected);
      expectBusinessOnly(reply.text);
      expect(reply.text).not.toMatch(/unrecognized|未知计划错误|执行环境暂不可用/u);
      if (status === "verification_pending") expect(reply.text).not.toMatch(/失败|重试/u);
    }
  });

  it("does not reuse execution failure advice for a denied Owner action", () => {
    const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "owner_action_denied", summary: "只有负责人可以批准本次改动。" }), ...internalEvidence });
    expect(reply.text).toContain("只有负责人可以批准本次改动");
    expect(reply.text).not.toMatch(/环境|重试|处理建议/u);
    expectBusinessOnly(reply.text);
  });

  it("does not infer execution failure, completion or sensitive details from an unknown status", () => {
    const reply = markdown({ type: "plan_status_card", status: "new_internal_state", headline: "private-headline", summary: "private-summary", failures: ["私密原因"], ...internalEvidence });
    expect(reply.text).toContain("暂时无法确认最新进度");
    expect(reply.text).not.toMatch(/new_internal_state|失败|修改完成|私密原因/u);
    expectBusinessOnly(reply.text);
  });

  it("describes the ready scope and next step without repeating the workflow fields", () => {
    const reply = markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "ready_for_execution", summary: "登录失败时保留用户名，密码不保留。" }));
    expect(reply.text).toContain("登录失败时保留用户名，密码不保留");
    expect(reply.text).toContain("完成后会告诉你改动结果和验证情况");
    expect(reply.text).not.toMatch(/任务内容|当前进度|下一步：|修改完成/u);
    expectBusinessOnly(reply.text);
  });

  it("keeps concrete completed results, removes duplicate highlights, and does not invent a generic change", () => {
    const summary = "登录失败后会保留用户名，密码仍会清空。";
    const reply = markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "completed", summary,
      resultHighlights: [summary, "空用户名的情况也已覆盖", "空用户名的情况也已覆盖"] }));
    expect(reply.text.split(summary)).toHaveLength(2);
    expect(reply.text.split("空用户名的情况也已覆盖")).toHaveLength(2);
    expect(reply.text).toContain("相关检查已通过");
    expect(reply.text).not.toMatch(/当前状态|验证情况：|本次变化|接受|批准/u);
    expectBusinessOnly(reply.text);
    const withoutHighlights = markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "completed", summary }));
    expect(withoutHighlights.text).not.toContain("相关功能已按确认要求更新");
    expect(withoutHighlights.text).toContain(summary);
  });

  it("asks about the business topic without a fixed template or unverified ordinal selection", () => {
    const reply = markdown({ type: "association_choice_card", candidateWorkItems: [{ id: "WI-INTERNAL", title: "登录错误提示" }] });
    expect(reply.text).toContain("登录错误提示");
    expect(reply.text).toContain("问题名称");
    expect(reply.text).not.toMatch(/请回复|【|补充：|第二个/u);
    expectBusinessOnly(reply.text);
  });

  it("retains verified ordinal selection and unresolved reply safety", () => {
    const reply = markdown({ type: "association_choice_card", replyContextMissing: true, allowOrdinalSelection: true,
      candidateWorkItems: [{ id: "WI-ONE", title: "登录提示" }, { id: "WI-TWO", title: "支付按钮" }] });
    expect(reply.text).toContain("确认前不会开始修改");
    expect(reply.text).toContain("第二个");
    expect(reply.text).toContain("不用重复刚才的内容");
    expectBusinessOnly(reply.text);
  });

  it("keeps Owner approval commands actionable and does not call a risky candidate completed", () => {
    const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "candidate_ready", summary: "准备调整登录校验规则。",
      approvalReasons: ["会改变身份校验规则，需要负责人确认影响。"] }), ...internalEvidence });
    expect(reply.title).toBe("待负责人审批");
    expect(reply.text).toContain("会改变身份校验规则");
    expect(reply.text).toContain("@研发助手 批准 WI\\-INTERNAL");
    expect(reply.text).toContain("@研发助手 退回 WI\\-INTERNAL 请说明原因");
    expect(reply.text).not.toMatch(/private|target_passed|修改完成/u);
  });

  it("still escapes untrusted business text and preserves recovery instructions", () => {
    const reply = markdown({ type: "clarification_card", questions: [{ question: "<测试> 哪个页面需要调整？", recommendedAnswer: "请负责人使用“继续整理需求”恢复。" }] });
    expect(reply.text).toContain("&lt;测试&gt;");
    expect(reply.text).not.toContain("<测试>");
    expect(reply.text).toContain("请负责人使用“继续整理需求”恢复");
  });
});
