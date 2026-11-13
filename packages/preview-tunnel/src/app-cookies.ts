/**
 * Application cookies on online preview shares.
 *
 * Every online share is a sibling host under one parent domain, and SameSite
 * does not separate siblings: script on one share can write a
 * `Domain=<parent>` cookie that the browser then sends to every other share.
 * Browsers refuse to store a `__Host-` cookie that names a Domain, whoever
 * sets it, so the edge stores each application cookie as
 * `__Host-app-<name>` and forwards only cookies with that exact prefix.
 * Cookies tossed in by a sibling, and the edge's own credentials, never
 * reach the application. Because every rewritten name starts with the
 * prefix, the application can't overwrite them either.
 */

export const APP_COOKIE_PREFIX = '__Host-app-';

/** Browsers drop a cookie whose name and value together exceed this. */
export const MAX_COOKIE_PAIR_BYTES = 4096;

/** Browsers ignore an attribute whose value exceeds this. */
export const MAX_COOKIE_ATTRIBUTE_VALUE_BYTES = 1024;

/** The tunnel refuses any header value longer than this (see `framing.ts`). */
export const MAX_RELAYED_SET_COOKIE_CHARACTERS = 8192;

/**
 * Upper bounds on what the connector relays per response. The caller further
 * limits them to the room the target's other headers leave inside the tunnel's
 * header count and size limits: one response over those limits would fault its
 * whole stream.
 */
export const MAX_RELAYED_SET_COOKIE_BYTES = 16 * 1024;
export const MAX_RELAYED_SET_COOKIES = 40;

/** Header name (`x-verity-local-set-cookie-NN`) plus the tunnel's per-header
 * framing, counted against the byte budget for every relayed line. */
export const RELAYED_SET_COOKIE_OVERHEAD_BYTES = 32;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 cookie-octet, optionally wrapped in double quotes.
const COOKIE_VALUE =
  /^(?:"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"|[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*)$/;
const MAX_AGE = /^-?\d{1,20}$/;
const HTTP_DATE = /^[A-Za-z0-9 ,:-]+$/;
const SAME_SITE: Record<string, string> = { strict: 'Strict', lax: 'Lax', none: 'None' };
const PRIORITY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * Rewrites one application `Set-Cookie` line for an online share, or returns
 * `undefined` when the browser must not receive it at all. The output is
 * assembled only from validated parts. `Domain` and unknown attributes are
 * dropped, and `Path=/; Secure` is forced because `__Host-` requires it. Apps
 * that scope same-named cookies to different paths therefore share one cookie.
 */
export function namespaceSetCookie(line: string): string | undefined {
  const [pair = '', ...attributes] = line.split(';');
  const separator = pair.indexOf('=');
  if (separator <= 0) return undefined;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!TOKEN.test(name) || !COOKIE_VALUE.test(value)) return undefined;
  if (APP_COOKIE_PREFIX.length + name.length + value.length > MAX_COOKIE_PAIR_BYTES)
    return undefined;

  let maxAge: string | undefined;
  let expires: string | undefined;
  let httpOnly = false;
  let sameSite: string | undefined;
  let partitioned = false;
  let priority: string | undefined;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const raw = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (raw.length > MAX_COOKIE_ATTRIBUTE_VALUE_BYTES) continue;
    // As in browsers, a later occurrence of an attribute replaces an earlier one.
    if (key === 'max-age') {
      if (MAX_AGE.test(raw)) maxAge = raw;
    } else if (key === 'expires') {
      const time = HTTP_DATE.test(raw) ? Date.parse(raw) : Number.NaN;
      if (Number.isFinite(time)) expires = new Date(time).toUTCString();
    } else if (key === 'httponly') httpOnly = true;
    else if (key === 'samesite') sameSite = SAME_SITE[raw.toLowerCase()] ?? sameSite;
    else if (key === 'partitioned') partitioned = true;
    else if (key === 'priority') priority = PRIORITY[raw.toLowerCase()] ?? priority;
  }

  return [
    `${APP_COOKIE_PREFIX}${name}=${value}`,
    'Path=/',
    'Secure',
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
    ...(expires === undefined ? [] : [`Expires=${expires}`]),
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(sameSite === undefined ? [] : [`SameSite=${sameSite}`]),
    ...(partitioned ? ['Partitioned'] : []),
    ...(priority === undefined ? [] : [`Priority=${priority}`]),
  ].join('; ');
}

/**
 * Selects the application's cookies from a browser `Cookie` header on an online
 * share and restores their original names. Order and duplicates are kept. The
 * prefix match is deliberately case-sensitive: older browsers enforce the
 * `__Host-` rules only for that exact spelling, so a sibling share could still
 * plant a `__host-app-` cookie there.
 */
export function appRequestCookies(header: string): string {
  const cookies: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name.startsWith(APP_COOKIE_PREFIX)) continue;
    const original = name.slice(APP_COOKIE_PREFIX.length);
    if (!TOKEN.test(original)) continue;
    cookies.push(`${original}=${part.slice(separator + 1).trim()}`);
  }
  return cookies.join('; ');
}

/**
 * The `Set-Cookie` lines the connector may relay, in the order the target sent
 * them. A line the tunnel would reject is skipped. Relaying stops at the count
 * or byte budget, whichever of the fixed bound and the given `room` is smaller,
 * so an application with too many cookies loses the rest instead of faulting
 * the response. The connector doesn't apply the edge's validation, so a cookie
 * the edge will drop still uses up budget.
 */
export function boundedSetCookies(
  lines: readonly string[],
  room: { headers: number; bytes: number } = { headers: Infinity, bytes: Infinity },
): string[] {
  const maxCount = Math.min(MAX_RELAYED_SET_COOKIES, room.headers);
  const maxBytes = Math.min(MAX_RELAYED_SET_COOKIE_BYTES, room.bytes);
  const relayed: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (line.length > MAX_RELAYED_SET_COOKIE_CHARACTERS) continue;
    const cost = line.length + RELAYED_SET_COOKIE_OVERHEAD_BYTES;
    if (relayed.length >= maxCount || bytes + cost > maxBytes) break;
    relayed.push(line);
    bytes += cost;
  }
  return relayed;
}
