export class PayRefError extends Error {
  constructor(public code: string, public stage: string, message: string,
    public context: Record<string, string> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PayRefError';
  }
}
export function fail(code: string, stage: string, message: string): never {
  throw new PayRefError(code, stage, message);
}
export function errorText(error: unknown): string {
  if (error instanceof PayRefError) return `${error.stage} · ${error.code}: ${error.message}${Object.keys(error.context).length ? ' · ' + Object.entries(error.context).map(([k,v]) => `${k}=${v}`).join(' ') : ''}`;
  // Never surface arbitrary provider errors: they can contain full calldata or URLs.
  return 'Operation failed. No success was recorded. Retry the read operation or inspect your wallet.';
}
export function rejected(error: unknown): boolean {
  let current: unknown = error;
  for (let n = 0; n < 8 && current && typeof current === 'object'; n++) {
    if ('code' in current && current.code === 4001) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

