import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./sensitive-text.ts";

describe("sensitive requirement text redaction", () => {
  it.each([
    "clientSecret abc123",
    "钉钉密钥 abc123",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
    "https://example.invalid/callback?access_token=abc123&mode=test",
    "Authorization: Bearer abc123",
  ])("removes credential value from %s", (input) => {
    const output = redactSensitiveText(input);
    expect(output).toContain("[敏感信息已隐藏]");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("signature123");
  });

  it("keeps ordinary product requirements readable", () => {
    expect(redactSensitiveText("筛选条件与搜索可以同时生效")).toBe("筛选条件与搜索可以同时生效");
  });
  it("does not mistake a password error requirement for an actual password", () => {
    const input = "密码错了就明确提示密码错误，空 token 时显示反馈";
    expect(redactSensitiveText(input)).toBe(input);
  });
});
