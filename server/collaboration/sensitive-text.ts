const HIDDEN = "[敏感信息已隐藏]";

const CREDENTIAL_ASSIGNMENT =
  /\b(client[ _-]?secret|app[ _-]?secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|credential|secret|token)\b(\s*(?::|=)?\s+|\s*[:=]\s*)([^\s,;]+)/giu;
const CHINESE_CREDENTIAL_ASSIGNMENT =
  /((?:钉钉|应用|访问|刷新|登录|接口)?(?:密钥|令牌|密码|凭证))(?:\s*[:=：]\s*|\s+)([^\s，；]+)/gu;
const QUERY_CREDENTIAL =
  /([?&](?:client_secret|app_secret|api_key|access_token|refresh_token|password|secret|token)=)[^&#\s]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;

/** Quoted legacy commands are data, but their bearer values must not enter the Ledger. */
export function redactOwnerActionTokens(value: string): string {
  return value.replace(/((?:接受|拒绝)\s+)[A-Za-z0-9_-]{32,}/gu, `$1${HIDDEN}`);
}

/** Redacts common credential representations before user-controlled text leaves the Ledger boundary. */
export function redactSensitiveText(value: string): string {
  return redactOwnerActionTokens(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, HIDDEN)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${HIDDEN}`)
    .replace(/\b(?:sk|pk|rk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/giu, HIDDEN)
    .replace(JWT, HIDDEN)
    .replace(QUERY_CREDENTIAL, `$1${HIDDEN}`)
    .replace(CREDENTIAL_ASSIGNMENT, (match, label: string, separator: string, value: string) =>
      !separator.trim() && /^(?:时|为空|失效|过期|错误|不正确)(?:显示|提示|反馈|应|会|时|后)/u.test(value)
        ? match : `${label}${separator}${HIDDEN}`)
    .replace(CHINESE_CREDENTIAL_ASSIGNMENT, (_match, label: string) => `${label} ${HIDDEN}`);
}
