import { createHash } from 'node:crypto';

export function fingerprint(data) {
  return { length: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') };
}

export class HindsightError extends Error {
  constructor(code, kind, status, details) {
    super(code);
    Object.assign(this, { code, kind, status, ...details });
  }
}

export function errorDiagnostic(code, error) {
  if (error instanceof HindsightError) {
    const { code, status, length, sha256 } = error;
    return { code, status, length, sha256 };
  }
  return { code, ...fingerprint(String(error?.message ?? error)) };
}

export function recordError(stage, code, error) {
  const { kind, status } = error ?? {};
  return {
    stage,
    ...(['unreachable', 'unknown', 'failed', 'rejected'].includes(kind) ? { kind } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...errorDiagnostic(code, error),
  };
}

export function redactLegacyError(error) {
  if (!error || !Object.hasOwn(error, 'message')) return error;
  const stage = ['mail', 'lookup', 'retain'].includes(error.stage) ? error.stage : 'legacy';
  return recordError(stage, 'LEGACY_ERROR', error);
}
