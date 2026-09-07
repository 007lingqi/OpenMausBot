/** Meanings of exact server-authored status phrases, not model-authored facts.
 * The caller must first bind the source to an actual sent read_status reply.
 * Explain what that historical message meant, never assert current state or
 * infer a cause, permission or new operation from its words. */
const meanings: ReadonlyArray<readonly [string, string]> = [
  ["修改方案已整理好，等待开始执行。", "之前的回复表示已经确定怎么改，但当时还没开始修改；后面还要实际修改并检查效果。仅凭这条消息无法确定等待原因。"],
  ["正在整理需求，还没有开始修改。", "之前的回复表示当时还在弄清要解决什么、怎样算解决，还没开始修改功能。"],
  ["正在整理修改方案，还没有开始修改。", "之前的回复表示当时正在确定怎么改，还没开始修改功能；准备方案和实际改动是两个阶段。"],
  ["修改方案还没有整理完成，目前没有开始修改。", "之前的回复表示当时还没有可用的修改方案，也没开始改动；具体原因还需核查，不能据此判断是代码或环境故障。"],
  ["还需要补充信息，确认后才能开始修改。", "之前的回复表示当时的信息还不够，需要先弄清会影响结果的问题，不凭猜测改动；并不是在要求你审批普通修改。"],
  ["正在修改或检查，还没有完成。", "之前的回复表示当时仍在处理或检查中，还不能当作完成；它没有说明具体做到哪一步或何时结束。"],
  ["这次执行没有完成，需要负责人核查后决定下一步。", "之前的回复表示那次处理没能完成，需要先核查原因再决定后续安排；它并没有说明所有代码都没改，也没有自动重试。"],
  ["已有改动结果，正在核对验证和确认条件，还不能标记完成。", "之前的回复表示当时已有改动，但还要确认是否符合要求、检查是否通过，以及是否有必须审批的风险；有改动不等于已完成。"],
  ["有结果记录，但目前还不能核对完整验证依据，不能据此确认修改完成。", "之前的回复表示虽然有结果记录，但当时可核对的证据不完整，不能据此确认问题已经解决；也不等于已经证明测试失败。"],
  ["修改完成，相关检查已通过。", "之前的回复只代表当时那次修改和检查已通过；后来新增的要求不包含在内，这条历史消息也不能证明当前版本仍然通过。"],
  ["已暂停，需要负责人决定是否继续。", "之前的回复表示那件事当时暂时停下了，需要负责人决定是否继续；询问这句话的意思不会恢复执行。"],
  ["已取消，不会继续修改。", "之前的回复表示那件事当时已停止继续处理，不是等待你补充信息；询问含义不会重新执行。"],
];

export function explainHistoricalProgress(summary: string): string | null {
  if (!summary.startsWith("关于「")) return null;
  // Match only the exact terminal phase, not a phrase inside the untrusted
  // topic excerpt or an added claim. No source wording is copied into meaning.
  return meanings.find(([phase]) => summary.endsWith(`」：${phase}`))?.[1] ?? null;
}
