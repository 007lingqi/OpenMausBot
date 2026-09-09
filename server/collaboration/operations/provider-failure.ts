/** Trusted adapter classifications only. Never construct these from model text,
 * stderr, caller-supplied codes, or network response bodies. */
const messages = {
  provider_timeout: '模型调用超时，项目尚未修改。',
  provider_interrupted: '模型调用已停止，项目尚未修改。',
  provider_launch_failed: '模型执行程序未能启动，项目尚未修改。',
  provider_input_failed: '需求未能完整交给模型，项目尚未修改。',
  provider_process_failed: '模型执行程序异常结束，项目尚未修改。',
  provider_output_invalid: '模型未返回格式完整的改动建议，项目尚未修改。',
  provider_channel_failed: '模型通道未能正常完成本次调用，项目尚未修改。',
  provider_cleanup_failed: '模型临时状态清理未完成，本次改动建议未采用，项目尚未修改。',
} as const;
export type ProviderFailureCode = keyof typeof messages;
export class ProviderFailure extends Error {
  readonly diagnosticCode: ProviderFailureCode;
  readonly secondaryDiagnosticCode: 'provider_cleanup_failed' | undefined;
  constructor(code: ProviderFailureCode, message: string = code, secondaryDiagnosticCode?: 'provider_cleanup_failed') {
    super(message);
    this.name = 'ProviderFailure';
    this.diagnosticCode = code;
    this.secondaryDiagnosticCode = secondaryDiagnosticCode;
  }
}
export function providerFailureSummary(error: unknown): string | undefined {
  if (!(error instanceof ProviderFailure)) return undefined;
  return messages[error.diagnosticCode] + (error.secondaryDiagnosticCode === 'provider_cleanup_failed'
    ? '模型临时状态清理未完成。' : '');
}
