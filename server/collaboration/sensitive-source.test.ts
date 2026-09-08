import { describe, expect, it } from "vitest";
import ts from "typescript";
import { redactSensitiveSource } from "./sensitive-source.ts";

const marker = "[敏感信息已隐藏]";
function parses(source: string) {
  const parsed = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  expect((parsed as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
}

describe("syntax-preserving source redaction", () => {
  it("keeps the default bound but permits a trusted larger bounded source view", () => {
    const source = `const description = "${"readable ".repeat(40_000)}";\nconst password = "large-fixture-value";`;
    expect(() => redactSensitiveSource(source)).toThrow("sensitive_source_unavailable");
    const result = redactSensitiveSource(source, "source.ts", { maxBytes: 512 * 1024 });
    expect(result).toContain('const description = "readable ');
    expect(result).not.toContain("large-fixture-value");
    expect(result).toContain(marker);
    parses(result);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 512 * 1024 + 129])("rejects an invalid trusted source bound %s", maxBytes => {
    expect(() => redactSensitiveSource("const value = 1;", "source.ts", { maxBytes })).toThrow("sensitive_source_unavailable");
  });

  it("applies an explicit source bound to UTF-8 bytes, not character count", () => {
    const source = `const label = "${"中".repeat(12_000)}";`;
    expect(() => redactSensitiveSource(source, "source.ts", { maxBytes: 32_000 })).toThrow("sensitive_source_unavailable");
    expect(redactSensitiveSource(source, "source.ts", { maxBytes: Buffer.byteLength(source) })).toBe(source);
  });

  it.each(["tsx", "jsx"])("redacts JSX credentials while preserving ordinary UI evidence in %s", extension => {
    const source = 'const ui = <Panel password="fixture-value" apiToken={"fixture-value"} label="保存">\n' +
      '<p>password: fixture-value</p><button aria-label="保存">保存成功</button>\n</Panel>;';
    const file = `panel.${extension}`, result = redactSensitiveSource(source, file);
    expect(result).not.toContain("fixture-value");
    expect(result).toContain('label="保存"');
    expect(result).toContain('<button aria-label="保存">保存成功</button>');
    expect(result.split("\n")).toHaveLength(source.split("\n").length);
    expect((ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true) as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
    expect(redactSensitiveSource(result, file)).toBe(result);
  });
  it("keeps namespaced JSX attributes and multiline redaction parseable", () => {
    const source = 'const view = <Panel auth:token="fixture-value" password={123456}><p>password: fixture-value\r\nnext line</p></Panel>;';
    const result = redactSensitiveSource(source, "view.tsx");
    expect(result).not.toContain("fixture-value"); expect(result).not.toContain("123456");
    expect(result.match(/\r\n|[\r\n]/g)).toEqual(source.match(/\r\n|[\r\n]/g));
    expect(redactSensitiveSource(result, "view.tsx")).toBe(result);
  });
  it.each([
    'function compare(password: string, input: string) { return password === input; }',
    'const ok = token !== expectedToken && password === "";',
    'const config = { title: "登录提示", enabled: true };',
    'const token = process.env.TOKEN; const password = suppliedValue;',
    'const regex = /label: [a-z]+/; const ratio = left / right;',
    'const text = "not a /* comment */"; // ordinary comment',
  ])("preserves credential references and operators without inventing missing syntax: %s", source => {
    expect(redactSensitiveSource(source)).toBe(source);
  });

  it.each([
    'const password = "fixture-value";',
    'const config = { clientSecret: "fixture-value" };',
    'config["apiKey"] = "fixture-value";',
    'config["pass" + "word"] = "fixture-value";',
    'const config = { [unknownField]: "fixture-value" };',
    'const config = { ["field" + (unknownField)]: "fixture-value" };',
    'const { password: alias = "fixture-value" } = input;',
    'type Config = { password: "fixture-value" };',
    'const ok = password === "fixture-value";',
    'const ok = "fixture-value" !== token;',
    'function f(password = "fixture-value") { return password; }',
    'const { password = "fixture-value" } = input;',
    'const apiKey = "fixture-" + "value";',
    'const config = { "pass\\u0077ord": "fixture-value" };',
    'setPassword("fixture-value");',
    'const text = "password: fixture-value";',
    'const text = "sk-fixture-value";',
    'const regex = /password: fixture-value/;',
    'const text = `password: fixture-value`;',
    'const text = tag`password: fixture-value`;',
    'const password = tag`fixture-value${input}`;',
    '// password: fixture-value\nconst answer = 42;',
    'const answer = 42; /* password: fixture-value */',
  ])("hides synthetic credential material while remaining parseable: %s", source => {
    const result = redactSensitiveSource(source);
    expect(result).not.toContain("fixture-value");
    expect(result).not.toContain('"fixture-"');
    expect(result).toContain(marker);
    expect(result.split("\n")).toHaveLength(source.split("\n").length);
    parses(result);
    expect(redactSensitiveSource(result)).toBe(result);
  });

  it("retains exact test source and line numbers while masking an adjacent comparison value", () => {
    const source = ['function login(password) { return password === "fixture-value"; }',
      'test("登录", () => {', '  assert.equal(login(input), false);', '});'].join("\n");
    const result = redactSensitiveSource(source, "login.test.mjs");
    expect(result.split("\n").slice(1)).toEqual(source.split("\n").slice(1));
    expect(result).toContain('password === "' + marker + '"');
    parses(result);
  });

  it("preserves multiline template line positions without evaluating any candidate code", () => {
    const source = 'const password = `fixture-value\nsecond-line`;\nthrow new Error("must not execute");';
    const result = redactSensitiveSource(source);
    expect(result).not.toContain("fixture-value");
    expect(result).not.toContain("second-line");
    expect(result.split("\n")).toHaveLength(3);
    parses(result);
  });

  it.each(['const password = "unterminated', 'const x = ;', 'x'.repeat(32001)])("fails closed for unparseable or oversized source", source => {
    expect(() => redactSensitiveSource(source)).toThrow(/sensitive_source_/);
  });

  it("handles token trivia without treating regex contents as real comments", () => {
    const source = 'const regex = /a\\/\\/b/; const value = 1 /* password: fixture-value */ + 2;';
    const result = redactSensitiveSource(source);
    expect(result).toContain('/a\\/\\/b/');
    expect(result).not.toContain('fixture-value');
    parses(result);
  });

  it("preserves CRLF and Unicode line breaks in masked multiline values", () => {
    const source = 'const password = `fixture-value\r\nsecond\u2028third`;\r\nconst x = 1;';
    const result = redactSensitiveSource(source);
    expect(result.match(/\r\n|[\r\n\u2028\u2029]/gu)).toEqual(source.match(/\r\n|[\r\n\u2028\u2029]/gu));
    expect(result).not.toContain('second');
    expect(result).not.toContain('third');
    expect(redactSensitiveSource(result)).toBe(result);
  });
});
