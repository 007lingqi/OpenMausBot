import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { DingTalkCredentialProvider, DingTalkCredentials } from "./config.ts";
import type { DingTalkPrivateResourceCapability } from "./types.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const RESOLVE_DOWNLOAD_URL = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
const MAX_JSON_BYTES = 64 * 1024;
export const MAX_DINGTALK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["dingtalk.com", "aliyuncs.com"] as const;

export type DingTalkAttachmentDownloadFailure = {
  ok: false;
  kind: "retryable" | "permanent";
  code: string;
  status?: number;
};

export type DingTalkAttachmentDownloadResult =
  | {
      ok: true;
      bytes: Uint8Array;
      sha256: string;
      mediaType?: string;
    }
  | DingTalkAttachmentDownloadFailure;

type AccessTokenResult =
  | { ok: true; accessToken: string }
  | DingTalkAttachmentDownloadFailure;

type BoundedReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; oversized: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failure(
  kind: "retryable" | "permanent",
  code: string,
  status?: number,
): DingTalkAttachmentDownloadFailure {
  if (status === undefined) return { ok: false, kind, code };
  return { ok: false, kind, code, status };
}

function retryKind(status: number): "retryable" | "permanent" {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "retryable"
    : "permanent";
}

function includesControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function exactOpaque(value: string | undefined, maximum: number): string | null {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value) return null;
  return includesControlCharacter(value) ? null : value;
}

function businessRejected(value: Record<string, unknown>): boolean {
  if (value.success === false) return true;
  if (value.code === undefined || value.code === null) return false;
  return value.code !== 0 && value.code !== "0";
}

async function readBounded(response: Response, maximum: number): Promise<BoundedReadResult> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return { ok: false, oversized: false };
    const announced = Number(contentLength);
    if (!Number.isSafeInteger(announced)) return { ok: false, oversized: false };
    if (announced > maximum) return { ok: false, oversized: true };
  }

  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await reader.read();
    } catch {
      return { ok: false, oversized: false };
    }
    if (chunk.done) break;
    if (!chunk.value) return { ok: false, oversized: false };
    total += chunk.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => {});
      return { ok: false, oversized: true };
    }
    chunks.push(chunk.value);
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

async function responseRecord(response: Response): Promise<Record<string, unknown> | null> {
  const bounded = await readBounded(response, MAX_JSON_BYTES);
  if (!bounded.ok) return null;
  try {
    return record(JSON.parse(Buffer.from(bounded.bytes).toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

function safeDownloadUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value || value.length > 8_192) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) return null;
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || isIP(hostname) !== 0) return null;
  const allowed = ALLOWED_DOWNLOAD_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  return allowed ? url : null;
}

function responseMediaType(response: Response): string | undefined {
  const raw = response.headers.get("content-type");
  if (!raw || raw.length > 255) return undefined;
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mediaType) ? mediaType : undefined;
}

export class FetchDingTalkAttachmentDownloader {
  private readonly credentials: DingTalkCredentialProvider;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private cached: { accessToken: string; expiresAt: number; clientId: string } | null = null;

  constructor(credentials: DingTalkCredentialProvider, fetcher: FetchLike = fetch, now: () => number = Date.now) {
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.now = now;
  }

  async download(capability: DingTalkPrivateResourceCapability): Promise<DingTalkAttachmentDownloadResult> {
    const downloadCode = exactOpaque(capability.downloadCode, 8_192);
    if (!downloadCode) return failure("permanent", "dingtalk_attachment_capability_invalid");

    let credentials: DingTalkCredentials | null;
    try {
      credentials = this.credentials.load();
    } catch {
      return failure("retryable", "dingtalk_attachment_credentials_unavailable");
    }
    if (!credentials) return failure("permanent", "dingtalk_attachment_credentials_missing");
    const robotCode = exactOpaque(capability.robotCode ?? credentials.clientId, 512);
    if (!robotCode) return failure("permanent", "dingtalk_attachment_capability_invalid");

    const token = await this.accessToken(credentials);
    if (!token.ok) return token;

    let resolveResponse: Response;
    try {
      resolveResponse = await this.fetcher(RESOLVE_DOWNLOAD_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": token.accessToken,
        },
        body: JSON.stringify({ downloadCode, robotCode }),
        redirect: "error",
      });
    } catch {
      return failure("retryable", "dingtalk_attachment_resolve_transport");
    }
    if (!resolveResponse.ok) {
      return failure(retryKind(resolveResponse.status), "dingtalk_attachment_resolve_http", resolveResponse.status);
    }
    const resolved = await responseRecord(resolveResponse);
    if (!resolved) return failure("retryable", "dingtalk_attachment_resolve_response_invalid");
    if (businessRejected(resolved)) return failure("permanent", "dingtalk_attachment_resolve_rejected");
    const downloadUrl = safeDownloadUrl(resolved.downloadUrl);
    if (!downloadUrl) return failure("permanent", "dingtalk_attachment_download_url_unsafe");

    let contentResponse: Response;
    try {
      contentResponse = await this.fetcher(downloadUrl, { method: "GET", redirect: "error" });
    } catch {
      return failure("retryable", "dingtalk_attachment_download_transport");
    }
    if (!contentResponse.ok) {
      return failure(retryKind(contentResponse.status), "dingtalk_attachment_download_http", contentResponse.status);
    }
    const announced = contentResponse.headers.get("content-length");
    const content = await readBounded(contentResponse, MAX_DINGTALK_ATTACHMENT_BYTES);
    if (!content.ok) {
      return failure(
        content.oversized ? "permanent" : "retryable",
        content.oversized ? "dingtalk_attachment_too_large" : "dingtalk_attachment_stream_invalid",
      );
    }
    if (announced !== null && Number(announced) !== content.bytes.byteLength) {
      return failure("retryable", "dingtalk_attachment_size_mismatch");
    }
    const mediaType = responseMediaType(contentResponse);
    const result: DingTalkAttachmentDownloadResult = {
      ok: true,
      bytes: content.bytes,
      sha256: createHash("sha256").update(content.bytes).digest("hex"),
    };
    if (mediaType) result.mediaType = mediaType;
    return result;
  }

  private async accessToken(credentials: DingTalkCredentials): Promise<AccessTokenResult> {
    if (
      this.cached &&
      this.cached.clientId === credentials.clientId &&
      this.cached.expiresAt > this.now() + 60_000
    ) return { ok: true, accessToken: this.cached.accessToken };

    let response: Response;
    try {
      response = await this.fetcher(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: credentials.clientId, appSecret: credentials.clientSecret }),
        redirect: "error",
      });
    } catch {
      return failure("retryable", "dingtalk_attachment_token_transport");
    }
    if (!response.ok) {
      return failure(retryKind(response.status), "dingtalk_attachment_token_http", response.status);
    }
    const result = await responseRecord(response);
    if (!result) return failure("retryable", "dingtalk_attachment_token_response_invalid");
    if (businessRejected(result)) return failure("permanent", "dingtalk_attachment_token_rejected");
    const accessToken = exactOpaque(typeof result.accessToken === "string" ? result.accessToken : undefined, 8_192);
    const expireIn = typeof result.expireIn === "number" ? result.expireIn : 0;
    if (!accessToken || !Number.isFinite(expireIn) || expireIn < 60) {
      return failure("retryable", "dingtalk_attachment_token_response_invalid");
    }
    this.cached = {
      accessToken,
      clientId: credentials.clientId,
      expiresAt: this.now() + expireIn * 1_000,
    };
    return { ok: true, accessToken };
  }
}
