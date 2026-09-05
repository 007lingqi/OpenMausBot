/** Veto only: a clear status is not proof of delivery without the endpoint's receipt. */
export function inspectDingTalkBusinessStatus(
  result: Record<string, unknown>,
  hasReceipt = false,
): "clear" | "rejected" | "unconfirmed" {
  let positive = hasReceipt;
  let rejected = false;
  for (const field of ["success", "errcode", "code"] as const) {
    if (!(field in result)) continue;
    const value = result[field];
    if (field === "success") {
      if (typeof value !== "boolean") return "unconfirmed";
      if (value) positive = true;
      else rejected = true;
      continue;
    }
    const validNumber = typeof value === "number" && Number.isSafeInteger(value);
    const validString = field === "code" && typeof value === "string" && value.length > 0 && value.trim() === value;
    if (!validNumber && !validString) return "unconfirmed";
    if (value === 0 || value === "0") positive = true;
    else rejected = true;
  }
  if (positive && rejected) return "unconfirmed";
  return rejected ? "rejected" : "clear";
}
