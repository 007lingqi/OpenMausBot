export interface DingTalkCredentials {
  clientId: string;
  clientSecret: string;
}

function parseConversationAllowlist(raw: string, field: string): Set<string> {
  let values: unknown[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch { values = raw.split(","); }
  if (values.length < 1 || values.length > 32) throw new Error(`${field}_invalid`);
  const normalized = values.map(value => {
    if (typeof value !== "string") throw new Error(`${field}_invalid`);
    const id = value.trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error(`${field}_invalid`);
    return id;
  });
  const result = new Set(normalized);
  if (result.size !== normalized.length) throw new Error(`${field}_contains_duplicates`);
  return result;
}

/** Shared configuration only: importing this module never starts a service. */
export function readDingTalkAllowedConversationIds(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const preferred = environment.OMB_DINGTALK_ALLOWED_CONVERSATION_IDS?.trim();
  const legacy = environment.DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS?.trim();
  if (!preferred && !legacy) throw new Error("dingtalk_allowed_conversation_ids_required");
  const preferredIds = preferred ? parseConversationAllowlist(preferred, "OMB_DINGTALK_ALLOWED_CONVERSATION_IDS") : undefined;
  const legacyIds = legacy ? parseConversationAllowlist(legacy, "DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS") : undefined;
  if (preferredIds && legacyIds && !(preferredIds.size === legacyIds.size && [...preferredIds].every(value => legacyIds.has(value)))) {
    throw new Error("dingtalk_allowed_conversation_ids_conflict");
  }
  return preferredIds ?? legacyIds!;
}

export interface DingTalkCredentialProvider {
  load(): DingTalkCredentials | null;
}

export type DingTalkConfigurationState =
  | { enabled: false; configured: false; state: "disabled" }
  | { enabled: true; configured: false; state: "needs_configuration"; missing: string[] }
  | {
      enabled: true;
      configured: true;
      state: "ready";
      proactiveOpenConversationId?: string;
      cardTemplateId?: string;
    };

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export class EnvironmentDingTalkCredentialProvider implements DingTalkCredentialProvider {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
  }

  load(): DingTalkCredentials | null {
    const clientId = trimmed(this.environment.OMB_DINGTALK_CLIENT_ID);
    const clientSecret = trimmed(this.environment.OMB_DINGTALK_CLIENT_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
}

export function readDingTalkConfiguration(environment: NodeJS.ProcessEnv = process.env): DingTalkConfigurationState {
  if (environment.OMB_DINGTALK_ENABLED !== "1") return { enabled: false, configured: false, state: "disabled" };
  const missing: string[] = [];
  if (!trimmed(environment.OMB_DINGTALK_CLIENT_ID)) missing.push("OMB_DINGTALK_CLIENT_ID");
  if (!trimmed(environment.OMB_DINGTALK_CLIENT_SECRET)) missing.push("OMB_DINGTALK_CLIENT_SECRET");
  if (missing.length) return { enabled: true, configured: false, state: "needs_configuration", missing };
  return {
    enabled: true,
    configured: true,
    state: "ready",
    ...(trimmed(environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID)
      ? { proactiveOpenConversationId: trimmed(environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID) }
      : {}),
    ...(trimmed(environment.OMB_DINGTALK_CARD_TEMPLATE_ID)
      ? { cardTemplateId: trimmed(environment.OMB_DINGTALK_CARD_TEMPLATE_ID) }
      : {}),
  };
}
