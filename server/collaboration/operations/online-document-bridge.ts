import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { readDingTalkAllowedConversationIds } from "../../integrations/dingtalk/config.ts";
import { configuredOnlineDocuments } from "./configured-online-documents.ts";
import { startOnlineDocumentGateway } from "./online-document-channel.ts";
import { createPilotSshOperations } from "./opencodex-pilot-ssh.ts";
import { createChannelCheckpoint } from "./opencodex-channel-checkpoint.ts";
import { createPrivateSshChannel, type PrivateSshOperations, type SshChannelState } from "./opencodex-ssh-channel.ts";
import type { OnlineDocumentReader } from "./dws-online-reader.ts";

export async function startOnlineDocumentBridge(options: { reader: OnlineDocumentReader; port: number; sshConfig: string;
  stateFile: string; intervalMs?: number; operations?: PrivateSshOperations; onState?(state: SshChannelState): void }) {
  const interval = options.intervalMs ?? 10000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60000 || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("online_document_bridge_configuration_invalid");
  }
  const operations = options.operations ?? createPilotSshOperations({ sshConfig: options.sshConfig, port: options.port, channel: "documents" });
  // Fixed loopback port ownership precedes both checkpoint access and any SSH mutation.
  const gateway = await startOnlineDocumentGateway({ reader: options.reader, port: options.port });
  let channel: ReturnType<typeof createPrivateSshChannel>;
  try { channel = createPrivateSshChannel(operations, { checkpoint: createChannelCheckpoint({ path: options.stateFile, port: options.port }) }); }
  catch (error) { await gateway.close(); throw error; }
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, closing: Promise<void> | undefined, previous = "";
  const pump = async () => {
    try { const state = await channel.tick(), encoded = JSON.stringify(state);
      if (!stopped && encoded !== previous) { previous = encoded; try { options.onState?.(state); } catch { /* Observer has no control authority. */ } }
    } finally { if (!stopped) timer = setTimeout(() => { void pump(); }, interval); }
  };
  void pump();
  return { url: gateway.url, socketPath: `/tmp/omb-documents-channel-${options.port}/documents.sock`, snapshot: channel.snapshot, close() {
    stopped = true; clearTimeout(timer);
    closing ??= (async () => { try { await channel.close(); } finally { await gateway.close(); } })(); return closing;
  } };
}

type Arguments = { mode: "host"; configFile: string; port: number } | { mode: "bridge"; configFile: string; port: number; sshConfig: string; stateFile: string };
export function parseOnlineDocumentChannelArgs(args: readonly string[]): Arguments {
  const invalid = (): never => { throw new Error("online_document_bridge_configuration_invalid"); };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--mode", "--config", "--port", "--ssh-config", "--state-file"].includes(key) || values.has(key) || !value) invalid();
    values.set(key, value);
  }
  const mode = values.get("--mode"), configFile = values.get("--config") ?? "", portText = values.get("--port") ?? "", port = Number(portText);
  const path = (value: string) => isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/u.test(value) && Buffer.byteLength(value) <= 1024;
  if (!path(configFile) || !/^\d+$/u.test(portText) || !Number.isSafeInteger(port) || port < 0 || port > 65535) invalid();
  if (mode === "host" && values.size === 3) return { mode, configFile, port };
  const sshConfig = values.get("--ssh-config") ?? "", stateFile = values.get("--state-file") ?? "";
  if (mode !== "bridge" || values.size !== 5 || !port || !path(sshConfig) || !sshConfig.endsWith("/colima-openmausbot-pilot/ssh.config") || !path(stateFile)) return invalid();
  return { mode, configFile, port, sshConfig, stateFile };
}
export async function runOnlineDocumentChannel(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseOnlineDocumentChannelArgs(args);
  const reader = configuredOnlineDocuments({ ...environment, OMB_ONLINE_DOCUMENTS_CONFIG_FILE: config.configFile }, readDingTalkAllowedConversationIds(environment), { hostOnly: true });
  if (!reader) throw new Error("online_document_configuration_invalid");
  const stop = new AbortController(), terminate = () => stop.abort();
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  let channel: Awaited<ReturnType<typeof startOnlineDocumentGateway>> | undefined;
  try {
    channel = config.mode === "host" ? await startOnlineDocumentGateway({ reader, port: config.port }) : await startOnlineDocumentBridge({ ...config, reader,
      onState: state => process.stdout.write(JSON.stringify({ event: "online_document_channel_state", ...state }) + "\n") });
    if (!stop.signal.aborted) {
      process.stdout.write(JSON.stringify({ event: "online_document_channel_ready", mode: config.mode, url: channel.url }) + "\n");
      await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally { await channel?.close(); process.off("SIGTERM", terminate); process.off("SIGINT", terminate); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runOnlineDocumentChannel(process.argv.slice(2)).catch(() => { process.stderr.write("online_document_channel_failed\n"); process.exitCode = 1; });
}
