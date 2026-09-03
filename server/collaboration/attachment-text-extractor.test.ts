import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  extractAttachmentText,
  MAX_ATTACHMENT_BYTES,
} from "./attachment-text-extractor.ts";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("bounded attachment text extraction", () => {
  it("extracts UTF-8 text into hash-verifiable untrusted chunks with line ranges", () => {
    const result = extractAttachmentText({
      bytes: utf8("第一行\n第二行\n第三行"),
      mediaType: "text/plain; charset=utf-8",
      displayName: "复现步骤.txt",
    });

    expect(result).toMatchObject({
      format: "text",
      characterCount: 11,
      lineCount: 3,
      truncated: false,
      warnings: [],
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toEqual({
      ordinal: 0,
      lineStart: 1,
      lineEnd: 3,
      text: "第一行\n第二行\n第三行",
      textHash: createHash("sha256").update("第一行\n第二行\n第三行").digest("hex"),
      untrusted: true,
      truncated: false,
      warnings: [],
    });
  });

  it("parses RFC4180 CSV records without losing commas, escaped quotes, or embedded newlines", () => {
    const result = extractAttachmentText({
      bytes: utf8('id,summary,detail\r\n1,"登录,失败","第一行\r\n第二行"\r\n2,"a ""quote""",ok\r\n'),
      mediaType: "text/csv",
      displayName: "bugs.csv",
    });

    expect(result.format).toBe("csv");
    expect(result.lineCount).toBe(3);
    expect(result.chunks.map((chunk) => chunk.text).join("\n")).toBe(
      '["id","summary","detail"]\n["1","登录,失败","第一行\\r\\n第二行"]\n["2","a \\"quote\\"","ok"]',
    );
  });

  it("redacts credential values before chunks and hashes are produced", () => {
    const result = extractAttachmentText({
      bytes: utf8("复现信息\naccess_token=never-store-this\n可以结束"),
      mediaType: "text/markdown",
      displayName: "bug.md",
    });
    const output = result.chunks.map((chunk) => chunk.text).join("\n");

    expect(output).toContain("access_token=[敏感信息已隐藏]");
    expect(output).not.toContain("never-store-this");
    expect(result.chunks[0]?.textHash).toBe(createHash("sha256").update(output).digest("hex"));
  });

  it("keeps formula-looking CSV cells as quoted plain text and adds a warning", () => {
    const result = extractAttachmentText({
      bytes: utf8("name,value\nAlice,=1+1\nBob,+cmd\nCarol,-2\nDave,@SUM(A1)"),
      mediaType: "text/csv",
      displayName: "report.csv",
    });
    const output = result.chunks.map((chunk) => chunk.text).join("\n");

    expect(output).toContain('["Alice","=1+1"]');
    expect(result.warnings).toEqual(["csv_formula_like_cells_present:4"]);
    expect(result.chunks.every((chunk) => chunk.warnings.includes("csv_formula_like_cells_present:4"))).toBe(true);
  });

  it("rejects file, CSV row, column, and cell-count limits", () => {
    expect(() => extractAttachmentText({
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      mediaType: "text/plain",
      displayName: "huge.txt",
    })).toThrow("attachment_file_too_large");

    expect(() => extractAttachmentText({
      bytes: utf8(`${"row\n".repeat(20_000)}overflow`),
      mediaType: "text/csv",
      displayName: "too-many-rows.csv",
    })).toThrow("attachment_csv_too_many_rows");

    expect(() => extractAttachmentText({
      bytes: utf8(Array.from({ length: 101 }, (_, index) => `c${index}`).join(",")),
      mediaType: "text/csv",
      displayName: "too-many-columns.csv",
    })).toThrow("attachment_csv_too_many_columns");

    const oneHundredCells = Array.from({ length: 100 }, () => "x").join(",");
    expect(() => extractAttachmentText({
      bytes: utf8(Array.from({ length: 2_001 }, () => oneHundredCells).join("\n")),
      mediaType: "text/csv",
      displayName: "too-many-cells.csv",
    })).toThrow("attachment_csv_too_many_cells");
  });

  it("rejects NUL and malformed UTF-8", () => {
    expect(() => extractAttachmentText({
      bytes: utf8("before\u0000after"),
      mediaType: "text/plain",
      displayName: "nul.txt",
    })).toThrow("attachment_text_contains_nul");
    expect(() => extractAttachmentText({
      bytes: Uint8Array.of(0xc3, 0x28),
      mediaType: "text/plain",
      displayName: "invalid.txt",
    })).toThrow("attachment_text_not_utf8");
  });

  it("rejects unsupported files and obvious extension/MIME conflicts", () => {
    expect(() => extractAttachmentText({
      bytes: utf8("not really a pdf"),
      mediaType: "application/pdf",
      displayName: "report.pdf",
    })).toThrow("attachment_extension_unsupported");
    expect(() => extractAttachmentText({
      bytes: utf8("a,b"),
      mediaType: "text/csv",
      displayName: "notes.md",
    })).toThrow("attachment_extension_media_type_conflict");
    expect(() => extractAttachmentText({
      bytes: utf8("hello"),
      mediaType: "text/plain; charset=iso-8859-1",
      displayName: "notes.txt",
    })).toThrow("attachment_charset_unsupported");
  });

  it("truncates redacted output at 250,000 characters and marks every chunk", () => {
    const result = extractAttachmentText({
      bytes: utf8("x".repeat(250_100)),
      mediaType: "text/plain",
      displayName: "long.txt",
    });
    expect(result.characterCount).toBe(250_000);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain("output_truncated");
    expect(result.chunks.every((chunk) => chunk.truncated && chunk.warnings.includes("output_truncated"))).toBe(true);
  });
});
