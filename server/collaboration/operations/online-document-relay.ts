import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { forwardOnlineDocumentSource, probeOnlineDocumentSocket, startOnlineDocumentGateway, validateOnlineDocumentSocketPath } from "./online-document-channel.ts";

/** Runs under the socket owner's existing nonroot UID. It has no DWS login,
 * grant config, shell or child process. Host and controller each enforce grants. */
export async function startOnlineDocumentRelay(options: { socketPath: string; port: number }) {
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error("online_document_relay_configuration_invalid");
  await probeOnlineDocumentSocket(options.socketPath);
  return startOnlineDocumentGateway({ port: options.port, forward: (source, signal) => forwardOnlineDocumentSource(options.socketPath, source, signal) });
}
export function parseOnlineDocumentRelayArgs(args: readonly string[]) {
  if (args.length !== 6 || args[0] !== "--port" || !/^[1-9]\d*$/u.test(args[1]) || args[2] !== "--socket" ||
    args[4] !== "--parent-stdin" || args[5] !== "1") throw new Error("online_document_relay_configuration_invalid");
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("online_document_relay_configuration_invalid");
  validateOnlineDocumentSocketPath(args[3]); return { port, socketPath: args[3] };
}
export async function runOnlineDocumentRelay(args = process.argv.slice(2)) {
  const config = parseOnlineDocumentRelayArgs(args), stop = new AbortController(), terminate = () => stop.abort();
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  process.stdin.once("end", terminate); process.stdin.once("error", terminate); process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) terminate();
  let relay: Awaited<ReturnType<typeof startOnlineDocumentRelay>> | undefined;
  try {
    relay = await startOnlineDocumentRelay(config);
    if (!stop.signal.aborted) {
      process.stdout.write(JSON.stringify({ event: "online_document_channel_ready", mode: "relay", url: relay.url }) + "\n");
      await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally { await relay?.close(); process.stdin.off("end", terminate); process.stdin.off("error", terminate); process.stdin.pause();
    process.off("SIGTERM", terminate); process.off("SIGINT", terminate); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runOnlineDocumentRelay().catch(() => { process.stderr.write("online_document_relay_failed\n"); process.exitCode = 1; });
}
