/** The hosted service owns the durable, shared attempt budget. */
export type PinBudgetResult =
  | { state: 'allowed' }
  | { state: 'cooldown'; retryAfterSeconds: number }
  | { state: 'locked' }
  | { state: 'unavailable' };

export interface PreviewPinBudget {
  begin(): Promise<PinBudgetResult | { state: 'allowed'; attemptId: string }>;
  finish(attemptId: string, valid: boolean): Promise<PinBudgetResult>;
}

export function createPreviewPinBudget(
  url: string,
  token: string,
  shareId: string,
): PreviewPinBudget {
  const base = new URL(url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid preview PIN budget URL');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid preview PIN budget token');
  const endpoint = `${base.href.replace(/\/$/, '')}/internal/preview-pin/${encodeURIComponent(shareId)}`;

  async function request(
    action: 'begin' | 'finish',
    body: object,
  ): Promise<PinBudgetResult | { state: 'allowed'; attemptId: string }> {
    try {
      const response = await fetch(`${endpoint}/${action}`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok || !response.body) return { state: 'unavailable' };
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8_192) return { state: 'unavailable' };
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object') return { state: 'unavailable' };
      const record = result as Record<string, unknown>;
      if (record.state === 'allowed') {
        if (action === 'finish') return { state: 'allowed' };
        if (
          typeof record.attemptId === 'string' &&
          record.attemptId.length > 0 &&
          record.attemptId.length <= 256
        )
          return { state: 'allowed', attemptId: record.attemptId };
      }
      if (record.state === 'locked') return { state: 'locked' };
      if (
        record.state === 'cooldown' &&
        Number.isSafeInteger(record.retryAfterSeconds) &&
        typeof record.retryAfterSeconds === 'number' &&
        record.retryAfterSeconds > 0 &&
        record.retryAfterSeconds <= 3600
      )
        return { state: 'cooldown', retryAfterSeconds: record.retryAfterSeconds };
      return { state: 'unavailable' };
    } catch {
      return { state: 'unavailable' };
    }
  }
  return {
    begin: () => request('begin', {}),
    finish: (attemptId, valid) => request('finish', { attemptId, valid }),
  };
}
