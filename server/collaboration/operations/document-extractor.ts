import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractAttachmentText, MAX_ATTACHMENT_BYTES, type AttachmentTextExtractionInput, type AttachmentTextExtraction, type AttachmentExtractionContext } from "../attachment-text-extractor.ts";
import { NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";

const formats = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as const;
const outputSchema = z.object({ version: z.literal(1), format: z.enum(["pdf", "docx", "xlsx"]),
  records: z.array(z.object({ location: z.string().min(1).max(1024), text: z.string().max(250_000) }).strict()).min(1).max(5000),
  truncated: z.boolean(), warnings: z.array(z.string().regex(/^[a-z_]{1,100}$/)).max(20),
}).strict();

export class DockerDocumentExtractor {
  private readonly docker: DockerCommandPort;
  private readonly image: string;
  constructor(input: { docker: DockerCommandPort; image: string }) {
    if (!/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(input.image)) throw new Error("attachment_document_image_not_fixed");
    this.docker = input.docker; this.image = input.image;
  }
  async extract(input: AttachmentTextExtractionInput, context: AttachmentExtractionContext = {}): Promise<AttachmentTextExtraction> {
    const assertActive = () => {
      try {
        if (context.signal?.aborted) throw new Error();
        context.assertActive?.();
      } catch { throw new Error("attachment_document_inactive"); }
    };
    assertActive();
    const extension = extname(input.displayName).toLowerCase() as keyof typeof formats;
    if (!(extension in formats)) return extractAttachmentText(input);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("attachment_file_too_large");
    const media = input.mediaType.split(";", 1)[0].trim().toLowerCase();
    if (media !== formats[extension] && media !== "application/octet-stream") throw new Error("attachment_extension_media_type_conflict");
    let id: string | undefined;
    const ownedName = `omb-document-${randomUUID()}`;
    try {
      const created = await this.docker.run(["create", "--name", ownedName, "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--log-driver", "none", "--user", "65534:65534", "--memory", "384m",
        "--memory-swap", "384m", "--cpus", "1", "--pids-limit", "32", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
        "--entrypoint", "python", this.image, "-I", "/app/extractor.py", extension.slice(1)], { timeoutMs: 30_000, maxOutputBytes: 4096 });
      const candidate = created.stdout.toString("utf8").trim();
      if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(candidate)) throw new Error("create_failed");
      id = candidate;
      // Let create settle before cleanup so a normal stop cannot lose its receipt.
      assertActive();
      const result = await this.docker.run(["start", "--attach", "--interactive", id], { input: Buffer.from(input.bytes), timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, signal: context.signal });
      assertActive();
      if (result.exitCode !== 0) throw new Error("parse_failed");
      const parsed = outputSchema.parse(JSON.parse(result.stdout.toString("utf8")));
      if (parsed.format !== extension.slice(1) || (!parsed.truncated && parsed.warnings.length)) throw new Error("invalid_result");
      // Reuse trusted redaction, output bounds and chunk hashing after the isolated parser.
      const extraction = extractAttachmentText({ bytes: Buffer.from(parsed.records.map(record => JSON.stringify(record)).join("\n")), mediaType: "text/plain", displayName: "extracted.txt" });
      const truncated = parsed.truncated || extraction.truncated;
      const warnings = [...new Set([...parsed.warnings, ...extraction.warnings])];
      return { ...extraction, format: parsed.format, truncated, warnings,
        extractor: { name: "docker-document", version: `1:${this.image}` },
        chunks: extraction.chunks.map(chunk => ({ ...chunk, truncated, warnings })) };
    } catch { assertActive(); throw new Error("attachment_document_extraction_failed"); }
    finally {
      {
        let removed = false;
        try { removed = (await this.docker.run(["rm", "--force", id ?? ownedName], { timeoutMs: 10_000, maxOutputBytes: 4096 })).exitCode === 0; } catch { /* fail closed below */ }
        if (!removed) throw new Error("attachment_document_cleanup_failed");
        assertActive();
      }
    }
  }
}

export function configuredDocumentExtractor(environment: NodeJS.ProcessEnv): ((input: AttachmentTextExtractionInput, context?: AttachmentExtractionContext) => Promise<AttachmentTextExtraction>) | undefined {
  const enabled = environment.OMB_DOCUMENT_EXTRACTOR_ENABLED?.trim();
  if (!enabled || enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("attachment_document_enable_invalid");
  const image = environment.OMB_DOCUMENT_EXTRACTOR_IMAGE?.trim();
  if (!image) throw new Error("attachment_document_image_required");
  const context = environment.OMB_DOCKER_CONTEXT?.trim();
  if (!context) throw new Error("attachment_document_context_required");
  const extractor = new DockerDocumentExtractor({ image, docker: new NodeDockerCommandPort({
    executable: environment.OMB_DOCKER_EXECUTABLE, context,
  }) });
  return (input, context) => extractor.extract(input, context);
}
