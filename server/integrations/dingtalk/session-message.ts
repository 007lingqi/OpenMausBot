type RecordValue = Record<string, unknown>;
export const DINGTALK_CONVERSATION_TEXT_LIMIT = 1_000;

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
  return value.slice(0, maximum).flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [text(entry, "", 256)] : []);
}

function associationCandidates(value: unknown): Array<{ title: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry) => {
    const candidate = record(entry);
    const title = typeof candidate?.title === "string" ? candidate.title.trim() : "";
    return title ? [{ title: text(title, "待确认问题", 120) }] : [];
  });
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

function readySummary(value: unknown): string {
  const summary = userFacingSummary(value, "会按已确认的需求开始修改。");
  const characters = Array.from(summary.replace(/\s+/gu, " "));
  if (characters.length <= 96) return summary;
  // Keep the bounded prefix, not just its first sentence: an introductory
  // sentence (for example, "this is a pilot") may precede the actual request.
  const excerpt = characters.slice(0, 96).join("");
  // This is visibly a topic excerpt, never a replacement Spec or a claim
  // that omitted constraints were removed. The original card is unchanged.
  return `这次处理：“${excerpt}…”，完整要求保持不变。`;
}

const PLAN_HEADLINES: Record<string, string> = {
  planning: "正在整理修改方案",
  ready_for_execution: "准备开始修改",
  planning_failed: "修改方案还没整理完成",
  candidate_ready: "待负责人审批",
  completed: "修改完成",
  verified_result: "修改和回归已核对",
  execution_failed: "执行未完成",
  verification_pending: "正在核对修改结果",
  verification_blocked: "修改结果尚未通过复核",
  owner_accepted: "修改已确认完成",
  owner_rejected: "已退回修改",
  owner_action_denied: "审批操作未执行",
};

function failureGuidance(value: unknown, status: string): string[] {
  const failures = Array.isArray(value) ? value : [];
  const readable = failures
    .filter((item): item is string => typeof item === "string")
    .filter((item) => /[\u3400-\u9fff]/u.test(item) && item !== "未知计划错误")
    .slice(0, 3);
  if (readable.length) return readable;
  if (status === "execution_failed" && failures.includes("provider_source_unavailable")) {
    return ["项目文件未能安全读取，还没有开始修改。请负责人检查文件读取配置后重试。"];
  }
  if (status === "execution_failed" && failures.includes("provider_sandbox_unavailable")) {
    return ["执行环境暂不可用，这次修改没有完成。请负责人检查后再决定是否重试。"];
  }
  // Missing or unfamiliar evidence cannot establish the cause of a failure.
  return [{
    planning_failed: "修改方案还没整理完成，具体原因还需核查；目前没有开始修改。",
    execution_failed: "这次修改没有完成，具体原因还需核查。请负责人检查后再决定是否重试。",
    verification_pending: "正在核对修改结果，还不能确认已完成。",
    verification_blocked: "修改结果尚未通过复核，目前不能标记完成。请负责人核查验证情况。",
  }[status] ?? "暂时无法确认最新进度，请负责人核查。"];
}

/** Converts internal status-card data to the documented DingTalk session-webhook message shape. */
export function renderDingTalkSessionMessage(payload: unknown): Record<string, unknown> {
  const card = record(payload);
  const type = typeof card?.type === "string" ? card.type : "unknown";
  const status = typeof card?.status === "string" ? card.status : "";
  // Only ordinary business questions whose explanatory boilerplate was
  // explicitly hidden use this layout. Operational and mixed notices retain
  // their context; presentation is not a new provenance or permission gate.
  const plainQuestions = type === "clarification_card" && card?.headline === "需要澄清" &&
    Array.isArray(card.questions) && card.questions.length > 0 && card.questions.length <= 3 &&
    card.questions.every(question => {
      const item = record(question);
      return typeof item?.id === "string" && ((item.id.startsWith("natural-") &&
        !["natural-input-pending", "natural-context-incomplete"].includes(item.id)) || /^fact-(?:conflict|assumption)-[a-z][a-z0-9-]{0,39}$/u.test(item.id)) && item.showRecommendedAnswer === false &&
        typeof item.question === "string" && item.question.trim().length > 0;
    });
  const headline = type === "primary_status_card"
    ? card?.association === "associated" ? "补充已收到" : "需求已收到"
    : type === "plan_status_card"
      ? (Object.hasOwn(PLAN_HEADLINES, status) ? PLAN_HEADLINES[status] : "进度待核查")
    : type === "command_status_card"
      ? text(card?.headline, "任务状态", 120)
    : plainQuestions ? "想确认一下"
    : text(card?.headline, "协作状态更新", 120);
  const lines = plainQuestions ? [] : [`### ${headline}`];

  if (type === "primary_status_card") {
    const resourceCount = typeof card?.resourceCount === "number" && card.resourceCount > 0
      ? Math.min(Math.floor(card.resourceCount), 5)
      : 0;
    lines.push(
      "",
      resourceCount
        ? `已收到你的需求和 ${resourceCount} 个附件，正在安全读取附件内容。`
        : card?.association === "associated"
        ? "会结合前面的需求一起整理。"
        : "正在整理你的需求，还没有开始修改。",
      ...(resourceCount ? ["读取完成前不会开始修改。"] : []),
    );
  } else if (type === "association_choice_card") {
    lines.push(
      "",
      card?.replyContextMissing === true
        ? "你的补充已保存，但还没能确认你回复的那条消息属于哪个问题。确认前不会开始修改。"
        : "我还不能确定这条消息是继续已有问题，还是一个新问题。",
      "",
      "**可能相关的问题**",
    );
    const candidates = associationCandidates(card?.candidateWorkItems);
    if (candidates.length) {
      candidates.forEach((candidate, index) => lines.push(`${index + 1}. ${candidate.title}`));
    } else {
      lines.push("- 当前问题标题暂不可用");
    }
    lines.push("", !candidates.length && card?.replyContextMissing === true
      ? "请补充问题名称或原需求内容，我再确认归属。"
      : card?.allowOrdinalSelection === true
      ? "直接说“第二个”就可以选择，不用重复刚才的内容。也可以继续补充；如果这是新问题，请直接描述。"
      : "请说明要继续的问题名称，或告诉我这是新问题。");
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
    if (plainQuestions) {
      if (typeof card?.contextSummary === "string" && card.contextSummary.trim()) {
        lines.push(text(card.contextSummary, "", 500), "");
      }
      if (responders.length && !perQuestionRecipients) lines.push(`${responders.map(name => `@${name}`).join("、")}，想确认一下：`, "");
    } else if (Array.isArray(card?.questions) && card.questions.length > 0) lines.push(
      "",
      responders.length && !perQuestionRecipients
        ? `为了避免返工，建议由 ${responders.map((name) => `@${name}`).join("、")} 补充以下信息：`
        : "为了避免返工，请补充以下关键信息：",
    );
    if (!plainQuestions && typeof card?.contextSummary === "string" && card.contextSummary.trim()) {
      lines.splice(1, 0, text(card.contextSummary, "附件内容已读取。", 500), "");
    }
    if (Array.isArray(card?.questions)) {
      for (const question of card.questions.slice(0, 3)) {
        const item = record(question);
        const recipient = record(item?.requestedResponder);
        const name = typeof recipient?.displayName === "string" && recipient.displayName.trim()
          ? `@${text(recipient.displayName, "相关同事", 128)}，` : "";
        lines.push(`${plainQuestions && card.questions.length === 1 ? "" : "- "}${name}${text(item?.question, "需要补充信息")}`);
        if (item?.showRecommendedAnswer !== false && typeof item?.recommendedAnswer === "string" && item.recommendedAnswer.trim()) {
          lines.push(`  - 建议回答：${text(item.recommendedAnswer, "请给出明确答案", 500)}`);
        }
      }
    }
  } else if (type === "command_status_card") {
    if (card?.presentation === "business") {
      lines.push("", text(card?.summary, "任务状态已更新。", 1_000));
    } else {
    lines.push(
      "",
      text(card?.summary, "命令已处理。", 1_000),
      "",
      `- 任务编号：\`${text(card?.workItemId, "unavailable", 128)}\``,
    );
    if (card?.workItemStatus) lines.push(`- 业务状态：${readableStatus(card.workItemStatus)}`);
    if (card?.definitionStatus) lines.push(`- 计划状态：${readableStatus(card.definitionStatus)}`);
    if (card?.controlState) lines.push(`- 控制状态：${readableStatus(card.controlState)}`);
    }
  } else if (type === "plan_status_card") {
    if (status === "planning") {
      lines.push("", "正在整理修改方案，还没有开始修改。");
    } else if (status === "ready_for_execution") {
      lines.push(
        "",
        text(readySummary(card?.summary), "按已确认的需求执行。", 1_000),
        "",
        "完成后会告诉你改动结果和验证情况。",
      );
    } else if (status === "candidate_ready") {
      if (typeof card?.approvalTopic === "string" && card.approvalTopic.trim()) lines.push("", `事项：${text(card.approvalTopic, "本次需求", 100)}`);
      lines.push(
        "",
        text(card?.summary, "改动已准备好，但存在需要负责人确认的风险，任务尚未完成。", 1_000),
        "",
        "**需要确认的原因**",
      );
      const approvalReasons = stringList(card?.approvalReasons, 3);
      for (const reason of approvalReasons.length ? approvalReasons : ["本次改动需要负责人确认后才能完成。"]) {
        lines.push(`- ${reason}`);
      }
      if (card?.approvalRequired === true && card.cardTemplateId === undefined && card.actions === undefined) {
        lines.push("", "负责人是否批准这次改动？@研发助手 直接回复即可；如不同意，请说一下需要调整的地方。");
      } else {
        // Preserve legacy presentation behavior: token/template cards do not
        // establish the fixed Markdown provenance used by natural approval.
        const workItemId = text(card?.workItemId, "WI-...", 128);
        lines.push("", `- 任务编号：${workItemId}`,
          `- 确认继续：@研发助手 批准 ${workItemId}`,
          `- 需要调整：@研发助手 退回 ${workItemId} 请说明原因`);
      }
    } else if (status === "verified_result") {
      lines.push("",text(card?.summary,"修改结果正在核对。",600));
    } else if (status === "completed") {
      const summary = text(userFacingSummary(card?.summary, "已按确认的需求完成修改。"), "已按确认的需求完成修改。", 1_000);
      lines.push("", summary);
      const highlights = [...new Set(stringList(card?.resultHighlights, 3))]
        .filter(highlight => highlight !== summary && highlight !== "相关功能已按确认要求更新");
      if (highlights.length) lines.push("", ...highlights.map(highlight => `- ${highlight}`));
      lines.push("", "相关检查已通过。");
    } else if (["planning_failed", "execution_failed", "verification_pending", "verification_blocked"].includes(status)) {
      lines.push("", ...failureGuidance(card?.failures, status).map(message => text(message, "本次修改尚未通过验证。", 1_000)));
    } else if (status === "owner_accepted") {
      lines.push(
        "",
        "负责人已批准本次风险改动，任务已完成。",
      );
    } else if (status === "owner_rejected") {
      lines.push(
        "",
        "负责人已退回本次结果，系统将按反馈重新整理并执行。",
      );
    } else if (status === "owner_action_denied") {
      lines.push(
        "",
        text(card?.summary, "该验收操作未通过身份或候选状态校验，请使用最新消息中的验收指令。", 1_000),
      );
    } else lines.push("", "暂时无法确认最新进度，请负责人核查。");
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
    markdown: { title: headline, text: type === "plan_status_card" && status === "verified_result" ? text(card?.summary,"修改结果正在核对。",600) : type === "command_status_card" && card?.command === "conversation" && card?.presentation === "business"
      ? text(card.summary, "任务状态已更新。", DINGTALK_CONVERSATION_TEXT_LIMIT) : lines.join("\n") },
    ...(atUserIds.length ? { at: { atUserIds, isAtAll: false } } : {}),
  };
}
