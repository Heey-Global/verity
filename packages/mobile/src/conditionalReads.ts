/**
 * Conditional overview reads. The app re-reads `/sessions`, `/projects` and
 * `/projects/:id` after every live hint or invalidation, and most of those
 * reads return what the app already holds. The server tags these responses
 * with an ETag; this wrapper remembers the last body per URL and credential,
 * asks with `If-None-Match`, and turns a `304 Not Modified` back into the
 * remembered `200` so callers keep parsing a normal response.
 */

const CONDITIONAL_PATH = /^\/(?:sessions|projects(?:\/[^/?]+)?)(?:\?envelope=1)?$/u;
const MAX_ENTRIES = 16;

interface Remembered {
  etag: string;
  body: string;
  contentType: string;
}

const remembered = new Map<string, Remembered>();

/** Normalize any HeadersInit to a lower-case record, so the credential is
 * found and forwarded whatever shape the caller passed. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/** Whether a request path takes part in conditional reads. Exported for tests. */
export function isConditionalReadPath(path: string): boolean {
  return CONDITIONAL_PATH.test(path);
}

/** Forget every remembered body. Entries are keyed by credential, so this is
 * hygiene (tests, memory), not a correctness requirement. */
export function clearConditionalReads(): void {
  remembered.clear();
}

/** Wrap `fetch` so eligible GETs are sent conditionally. */
export function withConditionalReads(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let path: string;
    try {
      const parsed = new URL(url);
      path = parsed.pathname + parsed.search;
    } catch {
      return fetchImpl(input, init);
    }
    if (method !== 'GET' || !isConditionalReadPath(path)) return fetchImpl(input, init);
    const headers = headerRecord(init);
    // A different credential may see a different body; never answer one
    // account's request with another account's remembered read.
    const key = `${url}\n${headers.authorization ?? ''}`;
    const known = remembered.get(key);
    if (known !== undefined) headers['if-none-match'] = known.etag;
    const response = await fetchImpl(input, { ...init, headers });
    if (response.status === 304 && known !== undefined) {
      remembered.delete(key);
      remembered.set(key, known);
      return new Response(known.body, {
        status: 200,
        headers: { 'content-type': known.contentType },
      });
    }
    // Test doubles and minimal transports may answer without a Headers object.
    const etag = (response.headers as Headers | undefined)?.get?.('etag') ?? null;
    if (response.status !== 200 || etag === null) {
      remembered.delete(key);
      return response;
    }
    const body = await response.text();
    remembered.delete(key);
    remembered.set(key, {
      etag,
      body,
      contentType: response.headers.get('content-type') ?? 'application/json',
    });
    while (remembered.size > MAX_ENTRIES) remembered.delete(remembered.keys().next().value!);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', etag },
    });
  };
  return wrapped;
}
