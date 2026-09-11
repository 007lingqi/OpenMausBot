import { z } from "zod";

export const discussionOptionSchema = z.object({ title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(180), tradeoff: z.string().trim().min(1).max(120) }).strict();
export const discussionOptionsSchema = z.object({ sourceEventId: z.string().min(1).max(256),
  kind: z.enum(["offer", "selection"]).optional(),
  presentationHash: z.string().regex(/^[a-f0-9]{64}$/u),
  workItemId: z.string().nullable(), workItemVersion: z.number().int().nonnegative(), snapshotRevision: z.number().int().nonnegative(),
  options: z.array(discussionOptionSchema).min(1).max(3) }).strict();
export type DiscussionOption = z.infer<typeof discussionOptionSchema>;
export type DiscussionOptions = z.infer<typeof discussionOptionsSchema>;
export interface DiscussionSelection {
  presentation: DiscussionOptions;
  optionIndex: number;
  option: DiscussionOption;
}

export function renderAdviceDiscussion(advice: { summary: string; options: DiscussionOption[]; question: string | null }): string {
  return [advice.summary, ...advice.options.map((option, index) => `${index + 1}. ${option.title}：${option.description} 取舍：${option.tradeoff}`),
    ...(advice.question ? [advice.question] : [])].join("\n\n");
}

export function renderDiscussionSelection(selection: DiscussionSelection): string {
  if (selection.presentation.kind === "selection") return `好，继续按「${selection.option.title}」细化。`;
  const description = /[。！？!?]$/u.test(selection.option.description) ? selection.option.description : `${selection.option.description}。`;
  return `已选「${selection.option.title}」：${description}后续按这个方案继续细化。`;
}

/** A recognizable ordinal must match the chosen position. Do not treat ordering
 * in a Work Item list as an offered choice, or silently accept an invalid index. */
export function selectionMatchesUtterance(text: string, offer: DiscussionOptions, index: number): boolean {
  const option = offer.options[index - 1];
  if (!option) return false;
  const normalized = text.normalize("NFKC");
  if (/(?:不选|别选|不按|不是第|不要第|放弃第)/u.test(normalized) ||
    ["不要", "不是", "放弃"].some(prefix => normalized.includes(prefix + option.title))) return false;
  const ordinals = [...normalized.matchAll(/(?:第([一二三四五六七八九十]|\d+)(?:个|项|版)|(?:选择|选)\s*([123]))/gu)];
  if (ordinals.length > 1 || offer.options.filter(candidate => text.includes(candidate.title)).length > 1) return false;
  const ordinal = ordinals[0];
  if (ordinal) {
    const digits = "一二三四五六七八九十";
    const raw = ordinal[1] ?? ordinal[2];
    return (digits.includes(raw) ? digits.indexOf(raw) + 1 : Number(raw)) === index;
  }
  if (text.includes(option.title)) return true;
  return offer.options.length === 1 && /^(?:就)?(?:按这个来|这个|好|好的|可以|就这样)[。！!\s]*$/u.test(text);
}
