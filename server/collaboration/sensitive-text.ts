const HIDDEN = "[敏感信息已隐藏]";

const CREDENTIAL_ASSIGNMENT =
  /\b(client[ _-]?secret|app[ _-]?secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|credential|secret|token)\b(\s*(?::|=)?\s+|\s*[:=]\s*)([^\s,;]+)/giu;
const CHINESE_CREDENTIAL_ASSIGNMENT =
  /((?:钉钉|应用|访问|刷新|登录|接口)?(?:密钥|令牌|密码|凭证))\s*(?::|=)?\s*([^\s，；]+)/gu;
const QUERY_CREDENTIAL =
  /([?&](?:client_secret|app_secret|api_key|access_token|refresh_token|password|secret|token)=)[^&#\s]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;

/** Redacts common credential representations before user-controlled text leaves the Ledger boundary. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, HIDDEN)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${HIDDEN}`)
    .replace(/\b(?:sk|pk|rk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/giu, HIDDEN)
    .replace(JWT, HIDDEN)
    .replace(QUERY_CREDENTIAL, `$1${HIDDEN}`)
    .replace(CREDENTIAL_ASSIGNMENT, (_match, label: string, separator: string) => `${label}${separator}${HIDDEN}`)
    .replace(CHINESE_CREDENTIAL_ASSIGNMENT, (_match, label: string) => `${label} ${HIDDEN}`);
}
