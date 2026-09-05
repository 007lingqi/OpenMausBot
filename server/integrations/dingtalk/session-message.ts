type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function text(value: unknown, fallback: string, maximum = 4_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const selected = normalized || fallback;
  return selected
    .slice(0, maximum)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|-])/gu, "\\$1");
}

function stringList(value: unknown, maximum = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map((entry) => text(entry, "unknown", 256));
}

function associationCandidates(value: unknown): Array<{ title: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry) => {
    const candidate = record(entry);
    const title = typeof candidate?.title === "string" ? candidate.title.trim() : "";
    return title ? [{ title: text(title, "待确认问题", 120) }] : [];
  });
}

function diffPreview(value: unknown, maximum = 3_500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .slice(0, maximum)
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replaceAll("`", "ˋ");
  return normalized || null;
}

function readableStatus(value: unknown): string {
  const status = typeof value === "string" ? value : "unknown";
  return ({
    collecting: "正在整理需求",
    waiting_clarification: "等待补充信息",
    ready_for_execution: "等待执行",
    planning: "正在生成计划",
    active: "进行中",
    paused: "已暂停",
    cancelled: "已取消",
    accepted: "已验收完成",
  } as Record<string, string>)[status] ?? "状态待确认";
}

function userFacingSummary(value: unknown, fallback: string): string {
  const summary = typeof value === "string" ? value.trim() : "";
  if (!summary) return fallback;
  return /[\u3400-\u9fff]/u.test(summary) ? summary : fallback;
}

function failureGuidance(value: unknown): string[] {
  const failures = Array.isArray(value) ? value : [];
  const readable = failures
    .filter((item): item is string => typeof item === "string")
    .filter((item) => /[\u3400-\u9fff]/u.test(item))
    .slice(0, 3);
  return readable.length
    ? readable
    : ["执行环境暂不可用，本次没有产生可验收修改。请由任务负责人检查后使用“重试”命令。"];
}

/** Converts internal status-card data to the documented DingTalk session-webhook message shape. */
export function renderDingTalkSessionMessage(payload: unknown): Record<string, unknown> {
  const card = record(payload);
  const type = typeof card?.type === "string" ? card.type : "unknown";
  const status = typeof card?.status === "string" ? card.status : "";
  const headline = type === "primary_status_card"
    ? "需求已收到"
    : status === "ready_for_execution"
    ? "方案已确认，准备执行"
    : status === "candidate_ready"
      ? "修改完成，需要负责人确认"
    : status === "completed"
      ? "修改已完成"
    : status === "owner_accepted"
      ? "修改已确认完成"
    : status === "owner_rejected"
      ? "已退回修改"
    : status === "owner_action_denied"
      ? "验收操作未执行"
    : type === "command_status_card"
      ? text(card?.headline, "任务状态", 120)
    : text(card?.headline, "协作状态更新", 120);
  const lines = [`### ${headline}`];

  if (type === "primary_status_card") {
    const resourceCount = typeof card?.resourceCount === "number" && card.resourceCount > 0
      ? Math.min(Math.floor(card.resourceCount), 5)
      : 0;
    lines.push(
      "",
      resourceCount
        ? `已收到你的需求和 ${resourceCount} 个附件，正在安全读取附件内容。`
        : "已收到你的需求，正在整理。当前尚未开始执行。",
      "",
      resourceCount ? "- 当前进度：读取附件" : "- 当前进度：正在整理需求",
      ...(resourceCount ? ["- 读取完成前不会开始修改"] : []),
      `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
    );
  } else if (type === "association_choice_card") {
    lines.push(
      "",
      "我还不能确定这条消息是继续已有问题，还是一个新问题。",
      "",
      "**可能相关的问题**",
    );
    const candidates = associationCandidates(card?.candidateWorkItems);
    if (candidates.length) {
      candidates.forEach((candidate, index) => lines.push(`${index + 1}. ${candidate.title}`));
    } else {
      lines.push("- 当前问题标题暂不可用");
    }
    lines.push("", "请回复“继续【问题标题】，补充：具体内容”，或者回复“这是新问题：具体内容”。");
  } else if (type === "invalid_reference_card") {
    lines.push("", "引用的问题不可用。", "", `- 引用: \`${text(card?.reference, "unknown", 128)}\``);
  } else if (type === "clarification_card") {
    const perQuestionRecipients = Array.isArray(card?.questions) && card.questions.some(question => record(question)?.requestedResponder);
    const responders = Array.isArray(card?.requestedResponders)
      ? card.requestedResponders.slice(0, 3).flatMap((entry) => {
          const responder = record(entry);
          const displayName = typeof responder?.displayName === "string" ? responder.displayName.trim() : "";
          return displayName ? [text(displayName, "相关人员", 128)] : [];
        })
      : [];
    if (Array.isArray(card?.questions) && card.questions.length > 0) lines.push(
      "",
      responders.length && !perQuestionRecipients
        ? `为了避免返工，建议由 ${responders.map((name) => `@${name}`).join("、")} 补充以下信息：`
        : "为了避免返工，请补充以下关键信息：",
    );
    if (typeof card?.contextSummary === "string" && card.contextSummary.trim()) {
      lines.splice(1, 0, text(card.contextSummary, "附件内容已读取。", 500), "");
    }
    if (Array.isArray(card?.questions)) {
      for (const question of card.questions.slice(0, 3)) {
        const item = record(question);
        const recipient = record(item?.requestedResponder);
        const name = typeof recipient?.displayName === "string" && recipient.displayName.trim()
          ? `@${text(recipient.displayName, "相关同事", 128)}，` : "";
        lines.push(`- ${name}${text(item?.question, "需要补充信息")}`);
        if (typeof item?.recommendedAnswer === "string" && item.recommendedAnswer.trim()) {
          lines.push(`  - 建议回答：${text(item.recommendedAnswer, "请给出明确答案", 500)}`);
        }
      }
    }
  } else if (type === "command_status_card") {
    lines.push(
      "",
      text(card?.summary, "命令已处理。", 1_000),
      "",
      `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
    );
    if (card?.workItemStatus) lines.push(`- 业务状态：${readableStatus(card.workItemStatus)}`);
    if (card?.definitionStatus) lines.push(`- 计划状态：${readableStatus(card.definitionStatus)}`);
    if (card?.controlState) lines.push(`- 控制状态：${readableStatus(card.controlState)}`);
  } else if (type === "plan_status_card") {
    if (status === "ready_for_execution") {
      lines.push(
        "",
        "**任务内容**",
        "",
        text(userFacingSummary(card?.summary, "已确认任务范围，系统将按受控计划执行。"), "按已确认的需求执行。", 1_000),
        "",
        "- 当前进度：准备开始",
        "- 下一步：系统将自动执行，完成后直接通知结果",
        `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
      );
    } else if (status === "candidate_ready") {
      lines.push(
        "",
        text(card?.summary, "本次改动已完成并通过基础验证，但存在需要负责人确认的风险。", 1_000),
        "",
        "**需要确认的原因**",
      );
      const approvalReasons = stringList(card?.approvalReasons, 3);
      for (const reason of approvalReasons.length ? approvalReasons : ["本次改动需要负责人确认后才能完成。"]) {
        lines.push(`- ${reason}`);
      }
      const workItemId = text(card?.workItemId, "WI-...", 128);
      lines.push(
        "",
        `- 任务编号：${workItemId}`,
        `- 确认继续：@研发助手 批准 ${workItemId}`,
        `- 需要调整：@研发助手 退回 ${workItemId} 请说明原因`,
      );
    } else if (status === "completed") {
      lines.push(
        "",
        `**已完成：${text(card?.summary, "已按确认的需求完成修改。", 1_000)}**`,
        "",
        "**本次变化**",
      );
      const highlights = stringList(card?.resultHighlights, 3);
      for (const highlight of highlights.length ? highlights : ["相关功能已按确认要求更新"]) {
        lines.push(`- ${highlight}`);
      }
      lines.push(
        "",
        "- 验证情况：相关检查已通过",
        "- 当前状态：已完成，无需再次确认",
        `- 任务编号：${text(card?.workItemId, "unavailable", 128)}`,
      );
    } else if (status === "owner_accepted") {
      lines.push(
        "",
        "负责人已批准本次风险改动，任务已完成。",
        `- 任务编号：${text(card?.workItemId, "unavailable", 128)}`,
      );
    } else if (status === "owner_rejected") {
      lines.push(
        "",
        "负责人已退回本次结果，系统将按反馈重新整理并执行。",
        `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
      );
    } else if (status === "owner_action_denied") {
      lines.push(
        "",
        text(card?.summary, "该验收操作未通过身份或候选状态校验，请使用最新消息中的验收指令。", 1_000),
      );
    } else lines.push(
      "",
      `- Work Item: \`${text(card?.workItemId, "unavailable", 128)}\``,
      `- 状态: ${text(card?.status, "planning", 80)}`,
    );
    if (!["ready_for_execution", "candidate_ready", "completed", "owner_accepted", "owner_rejected"].includes(status)) {
      if (typeof card?.summary === "string" && card.summary.trim()) lines.push(`- 摘要: ${text(card.summary, "", 1_000)}`);
      if (typeof card?.candidateSha === "string" && card.candidateSha.trim()) {
        lines.push(`- Candidate: \`${text(card.candidateSha, "unavailable", 128)}\``);
      }
      for (const path of stringList(card?.changedPaths)) lines.push(`- 变更: \`${path}\``);
      for (const state of stringList(card?.testStates)) lines.push(`- 测试: ${state}`);
      const preview = diffPreview(card?.candidatePreview);
      if (preview) lines.push("", "**候选内容预览**", "", "```diff", preview, "```");
      for (const failure of failureGuidance(card?.failures)) lines.push(`- 处理建议：${text(failure, "请联系维护人员检查。", 1_000)}`);
    }
  } else {
    lines.push("", "协作状态已更新，请查看受控审计记录。");
  }

  const atUserIds = type === "clarification_card" && Array.isArray(card?.requestedResponders)
    ? card.requestedResponders.slice(0, 3).flatMap((entry) => {
        const responder = record(entry);
        const targetId = typeof responder?.targetId === "string" ? responder.targetId.trim() : "";
        return targetId ? [targetId.slice(0, 256)] : [];
      })
    : [];
  return {
    msgtype: "markdown",
    markdown: { title: headline, text: lines.join("\n") },
    ...(atUserIds.length ? { at: { atUserIds, isAtAll: false } } : {}),
  };
}
