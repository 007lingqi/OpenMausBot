import { describe, expect, it } from "vitest";
import { renderPlanStatusCard, renderPrimaryStatusCard, renderConversationReplyCard, renderClarificationCard } from "../../collaboration/message-renderer.ts";
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
  const businessQuestion = (id: string, question: string) => ({ id: `natural-${id}`, title: "待确认", question,
    recommendedAnswer: "内部解释不应重复播报", showRecommendedAnswer: false });

  it("asks a single business question directly, keeping the exact question and its actual recipient", () => {
    const question = "账号或密码错误时，希望显示什么提示？";
    const card = renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      questions: [{ ...businessQuestion("copy", question), requestedResponder: { targetId: "staff-product", displayName: "小李" } }],
      requestedResponders: [{ targetId: "staff-product", displayName: "小李" }] });
    const before = structuredClone(card), reply = renderDingTalkSessionMessage(card);
    expect(reply.markdown).toEqual({ title: "想确认一下", text: `@小李，${question}` });
    expect(reply.at).toEqual({ atUserIds: ["staff-product"], isAtAll: false });
    expect(card).toEqual(before);
  });

  it("keeps distinct questions with their own people and does not assign an unowned question", () => {
    const card = renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      questions: [
        { ...businessQuestion("where", "在哪个页面会出现？"), requestedResponder: { displayName: "小王" } },
        { ...businessQuestion("result", "希望改成什么提示？"), requestedResponder: { displayName: "小李" } },
        businessQuestion("empty", "没有返回原因时显示什么？"),
      ] });
    expect(markdown(card).text).toBe("- @小王，在哪个页面会出现？\n- @小李，希望改成什么提示？\n- 没有返回原因时显示什么？");
  });

  it("preserves an existing group recipient and context without the procedural preamble", () => {
    const reply = markdown(renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      contextSummary: "原消息已保存，不必重复发送。", requestedResponders: [{ displayName: "小李" }],
      questions: [businessQuestion("copy", "希望显示什么提示？")] }));
    expect(reply.text).toContain("原消息已保存，不必重复发送。");
    expect(reply.text).toContain("@小李，想确认一下：");
    expect(reply.text).toContain("希望显示什么提示？");
    expect(reply.text).not.toMatch(/###|为了避免返工|关键信息|建议回答/u);
  });

  it("does not truncate or rewrite a long business question to make it look concise", () => {
    const question = `在${"特殊登录条件、".repeat(25)}情况下，是否保留用户名但不保留密码？<原文> *提示*`;
    const reply = markdown(renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      questions: [businessQuestion("long", question)] }));
    expect(reply.text).toBe(question.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("*", "\\*"));
  });

  it.each(["natural-input-pending", "natural-context-incomplete", "repository"])("retains operational context for %s instead of treating it as a concise business question", id => {
    const reply = markdown(renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      questions: [businessQuestion("copy", "希望显示什么提示？"), { id, title: "需处理", question: "当前还有信息待核对。",
        recommendedAnswer: "请负责人检查后再继续。" }] }));
    expect(reply.text).toContain("### 需要澄清");
    expect(reply.text).toContain("当前还有信息待核对。");
    expect(reply.text).toContain("请负责人检查后再继续。");
  });

  it("does not compact a recovery notice even if it includes a business question", () => {
    const reply = markdown({ ...renderClarificationCard({ workItemId: "WI-INTERNAL", snapshotRevision: 3,
      questions: [businessQuestion("copy", "希望显示什么提示？")] }), headline: "需求整理未完成",
      contextSummary: "请负责人检查后回复“继续整理需求”。" });
    expect(reply.text).toContain("### 需求整理未完成");
    expect(reply.text).toContain("请负责人检查后回复“继续整理需求”。");
  });

  it("answers ordinary conversation directly without a workflow heading", () => {
    expect(markdown(renderConversationReplyCard("不客气，有需要继续说。")).text).toBe("不客气，有需要继续说。");
  });
  it("omits explicitly hidden explanatory boilerplate but retains the actual question and person", () => {
    const reply = markdown({ type: "clarification_card", questions: [{ id: "natural-login", question: "希望显示什么提示？",
      requestedResponder: { displayName: "产品同事" }, recommendedAnswer: "为了形成可观察业务结果，需要明确提示。", showRecommendedAnswer: false }] });
    expect(reply.text).toContain("@产品同事，希望显示什么提示？");
    expect(reply.text).not.toContain("建议回答");
    expect(reply.text).not.toContain("为了形成可观察");
  });
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

  it("uses an explicitly shortened topic for a long ready message, without changing the full requirement", () => {
    const summary = "发布验收室增加优先级筛选。" + "与状态和搜索组合，空结果保持原提示。".repeat(12) + "不得修改账号权限。";
    const card = renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "ready_for_execution", summary });
    const before = structuredClone(card), reply = markdown(card);
    expect(reply.text).toContain("发布验收室增加优先级筛选");
    expect(reply.text).toContain("…");
    expect(reply.text).toContain("完整要求保持不变");
    expect(reply.text.length).toBeLessThan(200);
    expect(reply.text).not.toContain(summary);
    expect(reply.text).not.toMatch(/修改完成|批准|接受/u);
    expect(card).toEqual(before);
    expectBusinessOnly(reply.text);
  });

  it("explains a proven source-read failure without calling it an isolation failure or exposing details", () => {
    const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "execution_failed", failures: ["provider_source_unavailable"] }), ...internalEvidence });
    expect(reply.text).toContain("项目文件未能安全读取");
    expect(reply.text).toContain("还没有开始修改");
    expect(reply.text).toContain("负责人");
    expect(reply.text).not.toMatch(/provider_|执行环境|已完成/u);
    expectBusinessOnly(reply.text);
    expect(markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "verification_blocked", failures: ["provider_source_unavailable"] })).text)
      .not.toContain("还没有开始修改");
  });

  it("keeps the business request after an introductory sentence in a long ready excerpt", () => {
    const summary = "这是一次非生产自动化试点。请给“发布验收室”的检查项列表增加优先级筛选，可以选全部、P0、P1、P2，并与现有状态筛选、搜索一起生效。没有匹配项时继续显示空结果提示。只改这个测试页面，完成后自动回归，用两三句话告诉我改了什么、验证是否通过。";
    const card = renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "ready_for_execution", summary });
    const before = structuredClone(card), reply = markdown(card);
    expect(reply.text).toContain("发布验收室");
    expect(reply.text).toContain("增加优先级筛选");
    expect(reply.text).toContain("状态筛选、搜索一起生效");
    expect(reply.text.length).toBeLessThan(200);
    expect(reply.text).not.toContain("修改完成");
    expect(card).toEqual(before);
    expectBusinessOnly(reply.text);
  });

  it("keeps a shortened ready excerpt escaped and does not split Unicode characters", () => {
    const summary = "界面" + "🧪".repeat(130) + "<script>不得执行</script>";
    const reply = markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "ready_for_execution", summary }));
    expect(reply.text).toContain("…");
    expect(reply.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    const markup = markdown(renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "ready_for_execution", summary: "<测试>*筛选*" + "普通内容".repeat(40) }));
    expect(markup.text).toContain("&lt;测试&gt;\\*筛选\\*");
    expect(markup.text).not.toContain("<测试>");
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

  it("invites natural Owner approval without an ID and does not call a risky candidate completed", () => {
    const reply = markdown({ ...renderPlanStatusCard({ workItemId: "WI-INTERNAL", status: "candidate_ready", summary: "准备调整登录校验规则。",
      approvalReasons: ["会改变身份校验规则，需要负责人确认影响。"] }), ...internalEvidence, actions: undefined });
    expect(reply.title).toBe("待负责人审批");
    expect(reply.text).toContain("会改变身份校验规则");
    expect(reply.text).toContain("负责人是否批准这次改动");
    expect(reply.text).toContain("直接回复即可");
    expect(reply.text).toContain("需要调整的地方");
    expectBusinessOnly(reply.text);
    expect(reply.text).not.toMatch(/private|target_passed|修改完成/u);
  });

  it("shows the current requirement topic even when the approval summary is generic", () => {
    const reply = markdown({ type: "plan_status_card", status: "candidate_ready", approvalRequired: true,
      approvalTopic: "登录错误提示", summary: "存在需要负责人确认的风险。", workItemId: "WI-INTERNAL" });
    expect(reply.text).toContain("登录错误提示");
    expectBusinessOnly(reply.text);
  });

  it("still escapes untrusted business text and preserves recovery instructions", () => {
    const reply = markdown({ type: "clarification_card", questions: [{ question: "<测试> 哪个页面需要调整？", recommendedAnswer: "请负责人使用“继续整理需求”恢复。" }] });
    expect(reply.text).toContain("&lt;测试&gt;");
    expect(reply.text).not.toContain("<测试>");
    expect(reply.text).toContain("请负责人使用“继续整理需求”恢复");
  });
});
