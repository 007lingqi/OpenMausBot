import { describe, expect, it } from "vitest";
import { configuredDocumentExtractor, DockerDocumentExtractor } from "./document-extractor.ts";
import type { DockerCommandPort } from "./docker-containment.ts";
import { NodeDockerCommandPort } from "./docker-containment.ts";

const image = `sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const input = { bytes: new TextEncoder().encode("document"), mediaType: "application/pdf", displayName: "bugs.pdf" };
function harness(output: unknown, failStart = false, failCleanup = false) {
  const calls: Array<{ args: readonly string[]; options: unknown }> = [];
  const docker: DockerCommandPort = { async run(args, options) {
    calls.push({ args, options });
    if (args[0] === "create") return { exitCode: 0, stdout: Buffer.from(id), stderr: Buffer.alloc(0) };
    if (args[0] === "rm") return { exitCode: failCleanup ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (failStart) throw new Error("docker_command_timed_out secret-error-text");
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(output)), stderr: Buffer.alloc(0) };
  } };
  return { calls, extractor: new DockerDocumentExtractor({ docker, image }) };
}
describe("isolated document extraction", () => {
  it("requires explicit enablement, a fixed image and a named Docker context without running commands", () => {
    expect(configuredDocumentExtractor({})).toBeUndefined();
    expect(configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_IMAGE: image })).toBeUndefined();
    expect(configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "0", OMB_DOCUMENT_EXTRACTOR_IMAGE: image })).toBeUndefined();
    expect(() => configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "yes" })).toThrow("attachment_document_enable_invalid");
    expect(() => configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "1" })).toThrow("attachment_document_image_required");
    expect(() => configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "1", OMB_DOCUMENT_EXTRACTOR_IMAGE: "parser:latest", OMB_DOCKER_CONTEXT: "pilot" })).toThrow("attachment_document_image_not_fixed");
    expect(() => configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "1", OMB_DOCUMENT_EXTRACTOR_IMAGE: image })).toThrow("attachment_document_context_required");
    expect(configuredDocumentExtractor({ OMB_DOCUMENT_EXTRACTOR_ENABLED: "1", OMB_DOCUMENT_EXTRACTOR_IMAGE: image, OMB_DOCKER_CONTEXT: "pilot" })).toBeTypeOf("function");
  });
  it("handles an early parser stdin close without an unhandled EPIPE", async () => {
    const port = new NodeDockerCommandPort({ executable: process.execPath });
    await expect(port.run(["-e", "process.exit(0)"], { input: Buffer.alloc(16 * 1024 * 1024), timeoutMs: 5000 })).rejects.toThrow("docker_stdin_write_failed");
  });
  it("cleans up by its unique owned name when creation acknowledgement is lost", async () => {
    const calls: readonly string[][] = [];
    const docker: DockerCommandPort = { async run(args) {
      (calls as string[][]).push([...args]);
      if (args[0] === "create") throw new Error("timeout");
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } };
    await expect(new DockerDocumentExtractor({ docker, image }).extract(input)).rejects.toThrow("attachment_document_extraction_failed");
    const name = calls[0][calls[0].indexOf("--name") + 1];
    expect(name).toMatch(/^omb-document-[a-f0-9-]{36}$/);
    expect(calls.at(-1)).toEqual(["rm", "--force", name]);
  });
  it("has no network, mounts, secrets or host writes and preserves source locations as untrusted text", async () => {
    const h = harness({ version: 1, format: "pdf", records: [{ location: "page:1", text: "access_token=hide-me\n登录失败" }], truncated: false, warnings: [] });
    const result = await h.extractor.extract(input);
    const args = h.calls[0].args;
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--log-driver", "none", "--user", "65534:65534", "--memory", "384m"]));
    expect(args).not.toContain("--mount"); expect(args).not.toContain("--env");
    expect(JSON.stringify(result)).toContain("page:1");
    expect(JSON.stringify(result)).not.toContain("hide-me");
    expect(result.format).toBe("pdf");
    expect(result.chunks[0].untrusted).toBe(true);
    expect(h.calls.at(-1)?.args).toEqual(["rm", "--force", id]);
  });
  it("kills its container after a timeout, suppresses raw errors and refuses unverifiable cleanup", async () => {
    const timed = harness({}, true);
    await expect(timed.extractor.extract(input)).rejects.toThrow("attachment_document_extraction_failed");
    expect(timed.calls.at(-1)?.args).toEqual(["rm", "--force", id]);
    const leaked = harness({ version: 1, format: "pdf", records: [], truncated: false, warnings: [] }, false, true);
    await expect(leaked.extractor.extract(input)).rejects.toThrow("attachment_document_cleanup_failed");
  });
  it("rejects MIME mismatches before Docker, requires a fixed image and preserves partial status", async () => {
    const h = harness({ version: 1, format: "pdf", records: [{ location: "page:1", text: "部分正文" }], truncated: true, warnings: ["unread_images"] });
    expect(() => new DockerDocumentExtractor({ docker: {} as DockerCommandPort, image: "parser:latest" })).toThrow();
    await expect(h.extractor.extract({ ...input, displayName: "bugs.xlsx" })).rejects.toThrow("attachment_extension_media_type_conflict");
    expect(h.calls).toHaveLength(0);
    expect((await h.extractor.extract(input)).truncated).toBe(true);
  });
  it("does not accept wrong formats, unexpected fields or missing content as full extraction", async () => {
    for (const output of [
      { version: 1, format: "docx", records: [], truncated: false, warnings: [] },
      { version: 1, format: "pdf", records: [], truncated: false, warnings: [], command: "delete" },
      { version: 1, format: "pdf", records: [], truncated: false, warnings: [] },
    ]) await expect(harness(output).extractor.extract(input)).rejects.toThrow("attachment_document_extraction_failed");
  });
});
