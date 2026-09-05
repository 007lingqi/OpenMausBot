type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

// A session attempt followed by token exchange and proactive send must fit
// inside the runtime's default 30-second outbox claim, including body reads.
const REQUEST_TIMEOUT_MS = 8_000;

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Bound even a transport that ignores AbortSignal, disposing of late responses. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      reject(new Error("dingtalk_reply_deadline"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(value => {
      signal.removeEventListener("abort", abort);
      if (settled) { discard?.(value); return; }
      settled = true;
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}

async function readRecord(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumBytes)) {
    cancelBody(response);
    throw new Error("dingtalk_reply_size_invalid");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new Error("dingtalk_reply_size_invalid");
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
  } finally {
    // Cancellation itself may hang; never let it hold the queue open.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** No raw provider error or body escapes into a persisted delivery result. */
export async function boundedReplyRequest(fetcher: FetchLike, url: string | URL, init: RequestInit, maximumBytes: number): Promise<{
  ok: boolean;
  status: number;
  record: Record<string, unknown> | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await abortable(fetcher(url, { ...init, signal: controller.signal }), controller.signal, cancelBody);
    if (!response.ok) {
      cancelBody(response);
      return { ok: false, status: response.status, record: null };
    }
    return { ok: true, status: response.status, record: await readRecord(response, maximumBytes, controller.signal) };
  } finally {
    clearTimeout(timer);
  }
}
