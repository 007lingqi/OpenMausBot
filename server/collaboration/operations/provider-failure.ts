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
} as const;
export type ProviderFailureCode = keyof typeof messages;
export class ProviderFailure extends Error {
  readonly diagnosticCode: ProviderFailureCode;
  constructor(code: ProviderFailureCode, message = code as string) {
    super(message);
    this.name = 'ProviderFailure';
    this.diagnosticCode = code;
  }
}
export function providerFailureSummary(error: unknown): string | undefined {
  return error instanceof ProviderFailure ? messages[error.diagnosticCode] : undefined;
}
