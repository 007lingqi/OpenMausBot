import { describe, expect, it } from "vitest";

import { FetchDingTalkSessionSender } from "./sender.ts";

const primaryStatus = {
  type: "primary_status_card",
  headline: "已接收",
  acknowledgement: "消息已接收并写入协作账本。",
  workItemId: "WI-TEST",
  workItemStatus: "collecting",
};

describe("DingTalk session sender", () => {
  it("puts each question next to its actual recipient and sends only those notification IDs", async () => {
    let body: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "clarification_card", headline: "需要澄清", workItemId: "WI-INTERNAL", snapshotRevision: 1,
      requestedResponders: [{ targetId: "qa", displayName: "小王" }, { targetId: "product", displayName: "小李" }],
      questions: [
        { id: "systems", question: "哪些手机系统能复现？", recommendedAnswer: "请测试同事补充",
          requestedResponder: { targetId: "qa", displayName: "小王" } },
        { id: "scope", question: "是否只调整登录页面？", recommendedAnswer: "请产品同事补充",
          requestedResponder: { targetId: "product", displayName: "小李" } },
      ],
    });
    const payload = body as { markdown: { text: string }; at: unknown };
    expect(payload.markdown.text).toContain("@小王，哪些手机系统能复现？");
    expect(payload.markdown.text).toContain("@小李，是否只调整登录页面？");
    expect(payload.markdown.text).not.toContain("WI");
    expect(payload.at).toEqual({ atUserIds: ["qa", "product"], isAtAll: false });
  });

  it("does not ask users to supply missing information when a notice contains no questions", async () => {
    let body: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "clarification_card", headline: "需要澄清", questions: [], contextSummary: "原消息已保存，后续整理中断，无需重复发送。",
    });
    const payload = body as { markdown: { text: string } };
    expect(payload.markdown.text).toContain("无需重复发送");
    expect(payload.markdown.text).not.toContain("请补充以下关键信息");
  });
  it("presents a ready plan in language product and project users can understand", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "计划已发布",
      workItemId: "WI-35CFBA362138",
      status: "ready_for_execution",
      summary: "把 pilot-output.txt 的内容修改为 hello pilot，并运行 pilot 验证。",
    });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("方案已确认，准备执行");
    expect(markdown.text).toContain("任务内容");
    expect(markdown.text).toContain("当前进度：准备开始");
    expect(markdown.text).toContain("下一步：系统将自动执行，完成后直接通知结果");
    expect(markdown.text).toContain("任务编号");
    expect(markdown.text).not.toContain("ready_for_execution");
    expect(markdown.text).not.toContain("Work Item");
  });

  it("explains a risky change in plain language without exposing implementation evidence or tokens", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "候选已就绪",
      workItemId: "WI-D183F9E734FE",
      status: "candidate_ready",
      summary: "修改已完成并通过验证，请确认结果是否符合需求。",
      candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
      changedPaths: ["pilot-output.txt"],
      testStates: ["pilot: target_passed"],
      candidatePreview: "@@ -1 +1 @@\n-pending\n+hello pilot",
      approvalReasons: ["涉及部署或运行环境，可能影响服务可用性。"],
      actions: [
        { label: "接受候选", actionToken: "accept_code_12345678901234567890123456789012" },
        { label: "拒绝候选", actionToken: "reject_code_12345678901234567890123456789012" },
      ],
    });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("修改完成，需要负责人确认");
    expect(markdown.text).toContain("涉及部署或运行环境");
    expect(markdown.text).toContain("@研发助手 批准 WI\\-D183F9E734FE");
    expect(markdown.text).toContain("@研发助手 退回 WI\\-D183F9E734FE 请说明原因");
    expect(markdown.text).not.toContain("pending");
    expect(markdown.text).not.toContain("hello pilot");
    expect(markdown.text).not.toContain("pilot-output.txt");
    expect(markdown.text).not.toContain("accept_code_");
    expect(markdown.text).not.toContain("reject_code_");
    expect(markdown.text).not.toContain("刷新验收码");
    expect(markdown.text).not.toContain("candidate_ready");
    expect(markdown.text).not.toContain("target_passed");
    expect(markdown.text).not.toContain("2570cfb4692ad7775e261f403964d5585a95de7e");
  });

  it("reports a verified low-risk change as completed without asking for acceptance", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "修改已完成",
      workItemId: "WI-D183F9E734FE",
      status: "completed",
      summary: "发布看板现在会显示清晰的完成结果。",
      resultHighlights: ["产品和测试人员可以直接看到本次变化", "普通修改不再需要重复确认"],
    });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("修改已完成");
    expect(markdown.text).toContain("发布看板现在会显示清晰的完成结果");
    expect(markdown.text).toContain("产品和测试人员可以直接看到本次变化");
    expect(markdown.text).toContain("验证情况：相关检查已通过");
    expect(markdown.text).toContain("当前状态：已完成，无需再次确认");
    expect(markdown.text).not.toContain("接受");
    expect(markdown.text).not.toContain("candidate");
    expect(markdown.text).not.toContain("SHA");
  });

  it("renders command outcomes and hides internal failure codes from group users", async () => {
    const requests: unknown[] = [];
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "command_status_card",
      headline: "控制操作已执行",
      command: "pause",
      workItemId: "WI-D183F9E734FE",
      outcome: "allowed",
      summary: "任务已暂停；正在运行的执行会收到中断请求。",
      workItemStatus: "collecting",
      definitionStatus: "ready_for_execution",
      controlState: "paused",
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "执行未完成",
      workItemId: "WI-D183F9E734FE",
      status: "execution_failed",
      failures: ["provider_sandbox_unavailable"],
    });
    const commandText = (requests[0] as { markdown: { text: string } }).markdown.text;
    expect(commandText).toContain("任务已暂停");
    expect(commandText).toContain("控制状态：已暂停");
    expect(commandText).not.toContain("ready_for_execution");
    const failureText = (requests[1] as { markdown: { text: string } }).markdown.text;
    expect(failureText).toContain("执行环境暂不可用");
    expect(failureText).not.toContain("provider_sandbox_unavailable");
  });

  it("asks users to choose by business title instead of exposing only Work Item IDs", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "association_choice_card",
      headline: "请选择问题归属",
      allowOrdinalSelection: true,
      acknowledgement: "internal acknowledgement",
      candidateWorkItemIds: ["WI-SECRET-1", "WI-SECRET-2"],
      candidateWorkItems: [
        { id: "WI-SECRET-1", title: "登录失败时给出清晰提示" },
        { id: "WI-SECRET-2", title: "支付页按钮样式调整" },
      ],
    });
    const markdown = (requestBody as { markdown: { text: string } }).markdown.text;
    expect(markdown).toContain("登录失败时给出清晰提示");
    expect(markdown).toContain("支付页按钮样式调整");
    expect(markdown).toContain("这是新问题");
    expect(markdown).toContain("第二个");
    expect(markdown).toContain("不用重复刚才的内容");
    expect(markdown).not.toContain("补充：具体内容");
    expect(markdown).not.toContain("WI\\-SECRET");
    expect(markdown).not.toContain("internal acknowledgement");
  });

  it("renders at most three clarification questions and targets stable mentioned people", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "clarification_card",
      headline: "需要澄清",
      workItemId: "WI-HIDDEN",
      snapshotRevision: 1,
      contextSummary: "已安全读取附件“缺陷清单.csv”，内容已按来源保存。",
      requestedResponders: [{ targetId: "staff-tester", displayName: "测试负责人" }],
      questions: [
        { id: "goal", title: "目标", question: "最终要解决什么问题？", recommendedAnswer: "用一句话说明结果。" },
        { id: "scope", title: "范围", question: "哪些页面受影响？", recommendedAnswer: "列出页面名称。" },
        { id: "acceptance", title: "验收", question: "如何确认完成？", recommendedAnswer: "说明可观察结果。" },
        { id: "ignored", title: "忽略", question: "第四个问题不应出现", recommendedAnswer: "忽略" },
      ],
    });
    const payload = requestBody as { markdown: { text: string }; at?: { atUserIds: string[]; isAtAll: boolean } };
    expect(payload.markdown.text).toContain("@测试负责人");
    expect(payload.markdown.text).toContain("已安全读取附件“缺陷清单\\.csv”");
    expect(payload.markdown.text).toContain("最终要解决什么问题");
    expect(payload.markdown.text).toContain("建议回答：用一句话说明结果");
    expect(payload.markdown.text).not.toContain("第四个问题不应出现");
    expect(payload.markdown.text).not.toContain("WI\\-HIDDEN");
    expect(payload.at).toEqual({ atUserIds: ["staff-tester"], isAtAll: false });
  });

  it("renders a documented Markdown webhook payload and requires business success", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: true, status: 200 });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("需求已收到");
    expect(markdown.text).toContain("已收到你的需求，正在整理。当前尚未开始执行");
    expect(markdown.text).toContain("当前进度：正在整理需求");
    expect(markdown.text).toContain("任务编号");
    expect(markdown.text).not.toContain("collecting");
    expect(markdown.text).not.toContain("Work Item");
    expect(markdown.text).not.toContain("协作账本");
  });

  it("reports attachment intake without claiming that the content was already read", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      ...primaryStatus,
      resourceCount: 2,
    });
    const markdown = (requestBody as { markdown: { text: string } }).markdown.text;
    expect(markdown).toContain("已收到你的需求和 2 个附件");
    expect(markdown).toContain("当前进度：读取附件");
    expect(markdown).toContain("读取完成前不会开始修改");
    expect(markdown).not.toContain("已读取");
    expect(markdown).not.toContain("修改完成");
  });

  it("does not treat an HTTP 200 DingTalk business error as sent", async () => {
    const sender = new FetchDingTalkSessionSender(async () =>
      new Response(JSON.stringify({ errcode: 310000, errmsg: "invalid payload" }), { status: 200 }));
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: false, status: 200, code: "dingtalk_310000" });
  });

  it("fails closed when a successful HTTP response has no verifiable business result", async () => {
    const sender = new FetchDingTalkSessionSender(async () => new Response("not-json", { status: 200 }));
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: false, status: 200, code: "dingtalk_response_invalid" });
  });
});
