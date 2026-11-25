/**
 * Conditional overview reads. The app re-reads `/sessions`, `/projects` and
 * `/projects/:id` after every live hint or invalidation, and most of those
 * reads return what the app already holds. The server tags these responses
 * with an ETag; this wrapper remembers the last response per URL and
 * credential, asks with `If-None-Match`, and turns a `304 Not Modified` back
 * into the remembered `200` so callers keep parsing a normal response.
 *
 * Only a response the server tagged is remembered, so matching a path that is
 * not an overview read costs nothing beyond the lookup. The match allows a
 * path prefix, for servers reached below a base path.
 */

const CONDITIONAL_PATH = /(?:^|\/)(?:sessions|projects(?:\/[^/?]+)?)(?:\?envelope=1)?$/u;
const MAX_ENTRIES = 16;

interface Remembered {
  etag: string;
  body: string;
  headers: [string, string][];
}

const remembered = new Map<string, Remembered>();

/** Whether a request path takes part in conditional reads. Exported for tests. */
export function isConditionalReadPath(path: string): boolean {
  return CONDITIONAL_PATH.test(path);
}

/** Forget every remembered body. Entries are keyed by credential, so this is
 * hygiene (tests, memory), not a correctness requirement. */
export function clearConditionalReads(): void {
  remembered.clear();
}

/** Add one header while keeping the caller's own HeadersInit shape, which a
 * custom transport may depend on. */
function withHeader(init: RequestInit | undefined, name: string, value: string): RequestInit {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set(name, value);
    return { ...init, headers: copy };
  }
  if (Array.isArray(headers)) return { ...init, headers: [...headers, [name, value]] };
  return { ...init, headers: { ...headers, [name]: value } };
}

/** Response headers worth keeping with a remembered body. The transport has
 * already decoded the body, so its encoding and length no longer describe the
 * text handed to callers. */
function responseHeaders(response: Response): [string, string][] {
  const headers = response.headers as Headers | undefined;
  if (headers?.entries === undefined) return [];
  return [...headers.entries()].filter(
    ([name]) => name !== 'content-encoding' && name !== 'content-length',
  );
}

/** Wrap `fetch` so eligible GETs are sent conditionally. */
export function withConditionalReads(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    // A Request carries its own headers, which a replacement `init` would
    // override; only plain URLs (what VerityClient sends) take part.
    if (typeof input !== 'string' && !(input instanceof URL)) return fetchImpl(input, init);
    const url = typeof input === 'string' ? input : input.href;
    const method = (init?.method ?? 'GET').toUpperCase();
    let path: string;
    try {
      const parsed = new URL(url);
      path = parsed.pathname + parsed.search;
    } catch {
      return fetchImpl(input, init);
    }
    if (method !== 'GET' || !isConditionalReadPath(path)) return fetchImpl(input, init);
    // Keyed per credential so one account's bodies are not kept under another's
    // key. Correctness does not depend on it: the tag hashes the exact body, so
    // a 304 only ever confirms a byte-identical answer.
    const key = `${url}\n${new Headers(init?.headers).get('authorization') ?? ''}`;
    const known = remembered.get(key);
    const response = await fetchImpl(
      input,
      known === undefined ? init : withHeader(init, 'if-none-match', known.etag),
    );
    if (response.status === 304 && known !== undefined) {
      // A 304 updates the stored metadata (RFC 9111 §4.3.4): the body is the
      // same, but e.g. a server upgrade may have changed version headers.
      const merged = new Map(known.headers);
      for (const [name, value] of responseHeaders(response)) merged.set(name, value);
      const refreshed = { ...known, headers: [...merged] };
      remembered.delete(key);
      remembered.set(key, refreshed);
      return new Response(known.body, { status: 200, headers: refreshed.headers });
    }
    // Test doubles and minimal transports may answer without a Headers object.
    const headers = response.headers as Headers | undefined;
    const etag = headers?.get?.('etag') ?? null;
    if (response.status !== 200 || etag === null || headers === undefined) {
      remembered.delete(key);
      return response;
    }
    const body = await response.text();
    const kept = responseHeaders(response);
    remembered.delete(key);
    remembered.set(key, { etag, body, headers: kept });
    while (remembered.size > MAX_ENTRIES) remembered.delete(remembered.keys().next().value!);
    return new Response(body, { status: 200, headers: kept });
  };
  return wrapped;
}
