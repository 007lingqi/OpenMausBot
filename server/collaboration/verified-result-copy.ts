import { redactSensitiveText } from "./sensitive-text.ts";

/** A bounded display excerpt, never a replacement for the complete acceptance conditions. */
export function verifiedResultSummary(descriptions: readonly string[]): string {
  const clauses = descriptions.map(description => description.replace(/`+/gu, "").replace(/\s+/gu, " ").trim())
    .map(description => (redactSensitiveText(description) !== description || description.includes("[敏感信息已隐藏]")
    ? "涉及敏感信息的改动细节已省略" : description)
    .replace(/修改(?:已)?完成/gu, "修改结果")
    .replace(/任务(?:已)?完成/gu, "任务结果")
    .replace(/已验收/gu, "验收结果")
    .replace(/WI-[A-Z0-9-]+|\b(?:SHA|diff|execution_failed|candidate_ready)\b/giu, "内部标识")
    .replace(/[。！？!?]+/gu, "；")
    .replace(/\s+/gu, " ").trim().replace(/[；;]+$/u, "")).filter(Boolean);
  if (!clauses.length) throw new Error("candidate_result_feature_description_missing");
  const full = clauses.join("；");
  // UTF-16 length is the serializer's limit; do not split a surrogate pair at the boundary.
  let excerpt = "";
  for (const character of full) {
    if (excerpt.length + character.length > 480) break;
    excerpt += character;
  }
  const shortened = excerpt.length < full.length;
  return `本次已核对的改动${shortened ? "要点摘录" : "要点"}：${excerpt}${shortened ? "…" : ""}。自动回归和独立复核均已通过。`;
}
