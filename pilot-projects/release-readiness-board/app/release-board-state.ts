export type CheckStatus = "ready" | "review" | "blocked";
export type Filter = "all" | CheckStatus;
export interface ReleaseCheck {
  id: string; title: string; detail: string; owner: string; area: string; due: string;
  priority: "P0" | "P1" | "P2"; status: CheckStatus;
}

export function checkCounts(checks: readonly ReleaseCheck[]) {
  return {
    ready: checks.filter(item => item.status === "ready").length,
    review: checks.filter(item => item.status === "review").length,
    blocked: checks.filter(item => item.status === "blocked").length,
  };
}

export function visibleChecks(checks: readonly ReleaseCheck[], filter: Filter, query: string) {
  const needle = query.trim().toLowerCase();
  return checks.filter(item => (filter === "all" || item.status === filter) &&
    (!needle || [item.title, item.detail, item.owner, item.area].some(value => value.toLowerCase().includes(needle))));
}

export function toggleCheckReady(checks: readonly ReleaseCheck[], id: string): ReleaseCheck[] {
  return checks.map(item => item.id === id ? { ...item, status: item.status === "ready" ? "review" : "ready" } : item);
}

export function appendCheck(checks: ReleaseCheck[], rawTitle: string): ReleaseCheck[] {
  const title = rawTitle.trim();
  if (!title) return checks;
  return [...checks, { id: `check-${checks.length + 1}`, title, detail: "新检查项，等待补充验收证据",
    owner: "待指派", area: "未分类", due: "未设置", priority: "P1", status: "review" }];
}
