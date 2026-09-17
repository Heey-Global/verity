import type { ReadableStreamReadResult } from 'node:stream/web';
import {
  injectOpenCodeCredential,
  OPENCODE_EGRESS_ORIGIN,
  OPENCODE_EGRESS_PLACEHOLDER,
  validateOpenCodeEgress,
} from './opencode-egress-policy.js';

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** Discover the provider's catalog without forwarding credentials through redirects. */
export async function fetchOpenCodeModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const request = injectOpenCodeCredential(
    validateOpenCodeEgress({
      method: 'GET',
      url: new URL('/opencode/models', OPENCODE_EGRESS_ORIGIN),
      headers: { authorization: `Bearer ${OPENCODE_EGRESS_PLACEHOLDER}` },
      baseUrl,
    }),
    apiKey,
  );
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error('OpenCode model discovery failed. Check the API base URL and connectivity.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `OpenCode model discovery failed (HTTP ${String(response.status)}). Check the API base URL and API key.`,
    );
  }
  let value: unknown;
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_CATALOG_BYTES) throw new Error('Response too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('OpenCode returned an invalid model catalog. Check its /models endpoint.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('data' in value) ||
    !Array.isArray(value.data)
  ) {
    throw new Error('OpenCode returned an invalid model catalog. Check its /models endpoint.');
  }
  const models = new Set<string>();
  for (const candidate of value.data as unknown[]) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('id' in candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.trim().length === 0 ||
      /[\r\n,]/u.test(candidate.id)
    ) {
      throw new Error('OpenCode returned an invalid model catalog. Check its /models endpoint.');
    }
    models.add(candidate.id);
  }
  return [...models];
}
