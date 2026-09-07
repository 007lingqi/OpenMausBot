import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { readSecureCredentialFile } from "./credentials.ts";
import { DwsOnlineDocumentReader, NodeDwsReadCommandPort, onlineReadGrantSchema, type OnlineDocumentReader } from "./dws-online-reader.ts";
import { DockerRelayOnlineDocumentReader, PrivateSocketOnlineDocumentReader } from "./online-document-channel.ts";

const path = z.string().min(1).max(1024).refine(value => isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/u.test(value));
const config = z.object({ version: z.literal(1), grants: z.array(onlineReadGrantSchema).min(1).max(32), transport: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host_dws"), executable: path, configDirectory: path, home: path, cwd: path,
    path: z.string().min(1).max(4096).refine(value => value.split(":").every(part => path.safeParse(part).success)) }).strict(),
  z.object({ kind: z.literal("private_socket"), socketPath: path }).strict(),
  z.object({ kind: z.literal("docker_relay"), port: z.number().int().min(1024).max(65535) }).strict(),
]) }).strict();

/** Only a private operator-owned file enables reads. A message can neither select
 * this file nor expand its identities, targets, groups, argv or environment. */
export function configuredOnlineDocuments(environment: NodeJS.ProcessEnv, allowedGroups: ReadonlySet<string>, options: { hostOnly?: boolean } = {}): OnlineDocumentReader | undefined {
  const file = environment.OMB_ONLINE_DOCUMENTS_CONFIG_FILE;
  if (file === undefined) return undefined;
  try {
    if (environment.OMB_DINGTALK_ENABLED !== "1" || !file.trim()) throw new Error();
    const bytes = readSecureCredentialFile(file.trim());
    let parsed: z.infer<typeof config>;
    try { parsed = config.parse(JSON.parse(bytes.toString("utf8"))); } finally { bytes.fill(0); }
    if (parsed.grants.some(grant => !allowedGroups.has(grant.conversationId))) throw new Error();
    if (options.hostOnly && parsed.transport.kind !== "host_dws") throw new Error();
    if (parsed.transport.kind === "docker_relay") {
      if (environment.OMB_DOCUMENT_RELAY_ENABLED !== "1" || environment.OMB_DOCUMENT_RELAY_PORT !== String(parsed.transport.port)) throw new Error();
      return new DockerRelayOnlineDocumentReader(parsed.grants, parsed.transport.port);
    }
    return parsed.transport.kind === "private_socket"
      ? new PrivateSocketOnlineDocumentReader(parsed.grants, parsed.transport.socketPath)
      : new DwsOnlineDocumentReader(parsed.grants, new NodeDwsReadCommandPort(parsed.transport));
  } catch { throw new Error("online_document_configuration_invalid"); }
}
