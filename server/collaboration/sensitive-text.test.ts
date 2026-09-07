import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./sensitive-text.ts";

describe("sensitive requirement text redaction", () => {
  it("hides legacy Owner tokens even in quoted, conditional or multiline discussion", () => {
    const token = "fixture_" + "a".repeat(36);
    for (const text of [`示例： 接受 ${token}`, `接受 ${token} 如果测试通过`, `> 拒绝 ${token} 提示不清楚`, `拒绝\n${token}`]) {
      expect(redactSensitiveText(text)).not.toContain(token);
      expect(redactSensitiveText(text)).toContain("[敏感信息已隐藏]");
    }
    expect(redactSensitiveText("可以接受这项需求，拒绝空密码登录")).toBe("可以接受这项需求，拒绝空密码登录");
  });
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
