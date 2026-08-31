import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { z } from 'zod';
import {
  brokeredHttpRequestAliases,
  brokeredHttpRequestSchema,
  canonicalJson,
  type BrokeredJwtValue,
} from '@verity/secret-contracts';

import { BrokeredJwtError, mintBrokeredJwt } from './brokered-jwt.js';

const dnsNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
const canonicalPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/)
  .refine(
    (path) => !path.split('/').some((segment) => segment === '.' || segment === '..'),
    'path must be canonical',
  );
const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const restrictedHttpJsonProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    secretPolicy: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('per-request-approval') }).strict(),
      z
        .object({
          mode: z.literal('allowlist'),
          aliases: z
            .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
            .min(1)
            .max(64),
          destinations: z
            .array(
              z
                .object({
                  hostname: dnsNameSchema,
                  pathPrefixes: z.array(canonicalPathSchema).min(1).max(64),
                })
                .strict(),
            )
            .min(1)
            .max(64),
        })
        .strict(),
    ]),
    timeoutMs: z.number().int().positive().max(60_000).default(15_000),
    maxRequestBytes: z.number().int().positive().max(262_144).default(65_536),
    maxResponseBytes: z.number().int().positive().max(1_048_576).default(65_536),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (
      profile.secretPolicy.mode === 'allowlist' &&
      new Set(profile.secretPolicy.aliases).size !== profile.secretPolicy.aliases.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['secretPolicy', 'aliases'],
        message: 'secret aliases must be unique',
      });
    }
  });
export type RestrictedHttpJsonProfile = z.infer<typeof restrictedHttpJsonProfileSchema>;

export const restrictedHttpJsonRequestSchema = brokeredHttpRequestSchema;
export type RestrictedHttpJsonRequest = z.infer<typeof restrictedHttpJsonRequestSchema>;

export type RestrictedHttpJsonResult = {
  status: number;
  /**
   * Brokered model tool: the redacted response body (parsed JSON when possible, otherwise the
   * decoded text, null when empty/undecodable). Legacy GET adapter: the parsed JSON object.
   */
  body: unknown;
  /** Set when the upstream body exceeded maxResponseBytes and was cut at the cap. */
  truncated?: boolean;
  note?: 'body withheld (undecodable)' | 'body withheld (truncated)';
};
type RestrictedHttpJsonTransportResult = {
  status: number;
  /** Raw UTF-8 response text up to maxResponseBytes; null when empty or undecodable. */
  body: string | null;
  truncated?: boolean;
  undecodable?: boolean;
};

export class RestrictedHttpJsonRejectedError extends Error {
  constructor() {
    super('restricted HTTP request rejected');
  }
}

export type RestrictedHttpJsonTransport = (request: {
  hostname: string;
  method: z.infer<typeof httpMethodSchema>;
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  authorizeRequest: () => Promise<void>;
}) => Promise<RestrictedHttpJsonTransportResult>;
type RestrictedDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

function isForbiddenIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family !== 6) return true;
  let normalized = address.toLowerCase();
  try {
    // WHATWG URL canonicalization collapses every equivalent IPv6 spelling, including expanded
    // IPv4-mapped forms such as 0:0:0:0:0:ffff:7f00:1.
    normalized = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  // Global unicast is 2000::/3. Deny every special-use, translation, compatible, local, and
  // documentation family by default instead of trying to maintain an incomplete blocklist.
  if (!/^[23][0-9a-f]{0,3}(?::|$)/.test(normalized)) return true;
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  ) {
    return true;
  }
  const mapped = /^::ffff:(.+)$/.exec(normalized);
  if (mapped === null) return false;
  if (mapped[1]!.includes('.')) return isForbiddenIpv4(mapped[1]!);
  const words = mapped[1]!.split(':');
  if (words.length !== 2 || words.some((word) => !/^[a-f0-9]{1,4}$/.test(word))) return true;
  const high = Number.parseInt(words[0]!, 16);
  const low = Number.parseInt(words[1]!, 16);
  return isForbiddenIpv4(
    `${String(high >>> 8)}.${String(high & 0xff)}.${String(low >>> 8)}.${String(low & 0xff)}`,
  );
}

function rejected(): RestrictedHttpJsonRejectedError {
  return new RestrictedHttpJsonRejectedError();
}

function canonicalRequestUrl(value: string): URL {
  const rawPath = value.slice(value.indexOf('/', 'https://'.length)).split(/[?#]/, 1)[0] ?? '';
  try {
    if (
      rawPath
        .split('/')
        .some(
          (segment) => decodeURIComponent(segment) === '.' || decodeURIComponent(segment) === '..',
        )
    ) {
      throw rejected();
    }
  } catch {
    throw rejected();
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    isIP(url.hostname) !== 0 ||
    !dnsNameSchema.safeParse(url.hostname).success ||
    !canonicalPathSchema.safeParse(url.pathname).success ||
    [...url.searchParams].length > 32
  ) {
    throw rejected();
  }
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  return url;
}

function requestHash(request: RestrictedHttpJsonRequest, url: URL): string {
  return createHash('sha256')
    .update(
      `verity.restricted-http-request.v1\0${canonicalJson({
        method: request.method,
        url: url.toString(),
        secretAlias: request.secretAlias,
        auth: request.auth,
        bodyPresent: request.body !== undefined,
        ...(request.body === undefined ? {} : { body: request.body }),
      })}`,
    )
    .digest('hex');
}

/**
 * Production HTTPS transport using Node's normal CA and hostname verification. The socket lookup
 * itself rejects the entire answer set unless every address is public, so a second DNS resolution
 * cannot bypass the SSRF check. No DNS result or certificate pin survives this request.
 */
export function createNodeRestrictedHttpJsonTransport(options?: {
  lookup?: RestrictedDnsLookup;
}): RestrictedHttpJsonTransport {
  const lookup: RestrictedDnsLookup =
    options?.lookup ??
    (async (hostname, lookupOptions) => {
      const resolved = await dnsLookup(hostname, lookupOptions);
      return resolved.map((entry) => {
        if (entry.family !== 4 && entry.family !== 6) throw rejected();
        return { address: entry.address, family: entry.family };
      });
    });
  return async (request) => {
    return new Promise<RestrictedHttpJsonTransportResult>((resolve, reject) => {
      const fail = (): void => reject(rejected());
      const outgoing = httpsRequest(
        {
          protocol: 'https:',
          hostname: request.hostname,
          port: 443,
          method: request.method,
          path: request.path,
          headers: request.headers,
          servername: request.hostname,
          signal: AbortSignal.timeout(request.timeoutMs),
          // A reused keep-alive socket would skip lookup and therefore the at-most-once approval
          // fence inside it. A fresh connection binds every approved call to one guarded lookup.
          agent: false,
          lookup: (_hostname, lookupOptions, callback) => {
            void (async () => {
              try {
                const addresses = await lookup(request.hostname, { all: true, verbatim: true });
                if (
                  addresses.length === 0 ||
                  addresses.some((entry) => isForbiddenAddress(entry.address))
                ) {
                  throw rejected();
                }
                await request.authorizeRequest();
                const selected = addresses[0]!;
                if (lookupOptions.all === true) {
                  callback(null, addresses);
                } else {
                  callback(null, selected.address, selected.family);
                }
              } catch {
                callback(rejected(), '', 4);
              }
            })();
          },
        },
        (response) => {
          const status = response.statusCode;
          if (status === undefined) {
            response.destroy();
            fail();
            return;
          }
          // Any status is a RESULT, not an error (ADR 0011 D1): the agent needs to see a 401
          // as `{status: 401}` instead of a masked rejection. Bodies are capped, never fatal:
          // overflow truncates at the cap and is flagged, it does not reject the call.
          const chunks: Buffer[] = [];
          let total = 0;
          let done = false;
          const finish = (truncated: boolean): void => {
            if (done) return;
            done = true;
            const combined = Buffer.concat(chunks, total);
            try {
              if (total === 0) {
                resolve({ status, body: null });
                return;
              }
              let raw: string | null;
              let undecodable = false;
              try {
                // A cut at the cap may split a UTF-8 sequence; decode truncated bodies leniently.
                raw = new TextDecoder('utf-8', { fatal: !truncated }).decode(combined);
              } catch {
                raw = null;
                undecodable = true;
              }
              resolve({
                status,
                body: raw,
                ...(truncated ? { truncated: true } : {}),
                ...(undecodable ? { undecodable: true } : {}),
              });
            } finally {
              combined.fill(0);
              for (const chunk of chunks) chunk.fill(0);
            }
          };
          response.on('data', (chunk: Buffer) => {
            if (done) return;
            if (total + chunk.byteLength > request.maxResponseBytes) {
              chunks.push(Buffer.from(chunk.subarray(0, request.maxResponseBytes - total)));
              total = request.maxResponseBytes;
              response.destroy();
              finish(true);
              return;
            }
            total += chunk.byteLength;
            chunks.push(Buffer.from(chunk));
          });
          response.once('error', () => {
            if (!done) fail();
          });
          response.once('end', () => finish(false));
        },
      );
      outgoing.once('error', fail);
      if (request.body !== undefined) outgoing.write(request.body);
      outgoing.end();
    });
  };
}

/**
 * One credential one request put on the wire.
 *
 * A JWT request resolves more than one alias — the signing key plus whatever
 * claims came from Doppler — and mints a bearer token on top of them. All of it
 * is credential material that an upstream could echo, so all of it is redacted.
 */
export type RedactedCredential = { value: string; alias: string };

/** One searchable form of one credential, and the marker that replaces it. */
type RedactionNeedle = { needle: string; marker: string; caseInsensitive: boolean };

/**
 * Every form of every credential — raw, JSON-escaped, Base64, URL-encoded —
 * sorted longest first ACROSS all of them.
 *
 * The global sort is the load-bearing part. Longest-first exists so a short
 * value that occurs inside a longer one cannot replace the prefix and leave the
 * remainder readable, and that property only holds if every variant competes in
 * the same ordering: ranking credentials by their raw length and then expanding
 * each one's variants in turn lets a short raw value cut through the middle of
 * another credential's Base64 form, stranding the rest of it in the body.
 *
 * A colluding upstream can still echo a transformed credential; that residual
 * risk is accepted (ADR 0011) in exchange for a usable response channel.
 */
function redactionOrder(credentials: readonly RedactedCredential[]): RedactionNeedle[] {
  const needles: RedactionNeedle[] = [];
  for (const { value, alias } of credentials) {
    if (value.length === 0) continue;
    const marker = `[REDACTED:${alias}]`;
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    const exact = new Set([
      value,
      JSON.stringify(value).slice(1, -1),
      base64,
      base64.replace(/=+$/u, ''),
      Buffer.from(value, 'utf8').toString('base64url'),
    ]);
    for (const needle of exact) {
      if (needle.length > 0) needles.push({ needle, marker, caseInsensitive: false });
    }
    // Hex digits in percent escapes are case-insensitive and can be mixed within
    // one credential. A case-insensitive match is deliberately conservative: it
    // may also redact an ASCII case variant rather than risk leaking the secret.
    const insensitive = new Set([
      encodeURIComponent(value),
      new URLSearchParams({ value }).toString().slice('value='.length),
    ]);
    for (const needle of insensitive) {
      if (needle.length > 0) needles.push({ needle, marker, caseInsensitive: true });
    }
  }
  return needles.sort((left, right) => right.needle.length - left.needle.length);
}

function redactAllSecretForms(
  text: string,
  credentials: readonly RedactedCredential[],
  needles: readonly RedactionNeedle[],
): string {
  let redacted = text;
  for (const { needle, marker, caseInsensitive } of needles) {
    redacted = caseInsensitive
      ? redacted.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), marker)
      : redacted.split(needle).join(marker);
  }
  // Percent encoding is not canonical: reserved and even unreserved bytes may
  // be escaped independently (for example `a%21b` or `%61!b`). Decode valid
  // percent-byte runs tolerantly, then fail closed for the whole visible field
  // if the decoded representation reconstructs any credential.
  let decoded = redacted;
  // Decode repeatedly: `%2520` is a valid double-encoding of `%20`. A single pass leaves the
  // credential encoded and visible. Eight rounds cover realistic nested encodings while keeping
  // hostile response work strictly bounded.
  for (let round = 0; round < 8; round++) {
    const next = decoded.replace(/\+/gu, ' ').replace(/(?:%[0-9a-f]{2})+/giu, (encodedRun) => {
      try {
        return decodeURIComponent(encodedRun);
      } catch {
        return encodedRun;
      }
    });
    for (const { value, alias } of credentials) {
      if (value.length > 0 && next.includes(value)) return `[REDACTED:${alias}]`;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return redacted;
}

function redactJsonValue(
  value: unknown,
  credentials: readonly RedactedCredential[],
  needles: readonly RedactionNeedle[],
): unknown {
  if (typeof value === 'string') return redactAllSecretForms(value, credentials, needles);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, credentials, needles));
  if (typeof value !== 'object' || value === null) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return value;
    const redacted = redactAllSecretForms(serialized, credentials, needles);
    return redacted === serialized ? value : redacted;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactAllSecretForms(key, credentials, needles),
      redactJsonValue(item, credentials, needles),
    ]),
  );
}

/**
 * Server-owned JSON connector. Project settings expose only eligible secret aliases. The model
 * proposes a complete public HTTPS request. The durable at-most-once consumption fence binds and
 * authorizes the canonical request immediately before network I/O.
 */
export function createRestrictedHttpJsonConnector(options: {
  profile: RestrictedHttpJsonProfile;
  resolveSecret: (alias: string) => Promise<Uint8Array>;
  /**
   * Durable at-most-once fence required for per-request approval profiles. The user-facing
   * permission/grant flow runs upstream before invoking this connector; this hook prevents an
   * approved, attested tool call from reaching the network more than once.
   */
  consumeApproval?: (requestHash: string) => boolean | Promise<boolean>;
  /** Legacy GET compatibility adapter only: enforces 2xx + parsed JSON object, no redaction. */
  returnTrustedResponseBody?: boolean;
  transport: RestrictedHttpJsonTransport;
}) {
  const profile = restrictedHttpJsonProfileSchema.parse(options.profile);
  const parse = (unparsed: unknown) => {
    const parsed = restrictedHttpJsonRequestSchema.safeParse(unparsed);
    if (!parsed.success) throw rejected();
    const policy = profile.secretPolicy;
    // An allowlist covers EVERY alias the request resolves, not just the signing
    // key: a JWT can pull its claims from aliases the profile never allowed.
    if (
      policy.mode === 'allowlist' &&
      !brokeredHttpRequestAliases(parsed.data).every((alias) => policy.aliases.includes(alias))
    ) {
      throw rejected();
    }
    const url = canonicalRequestUrl(parsed.data.url);
    if (
      policy.mode === 'allowlist' &&
      !policy.destinations.some(
        ({ hostname, pathPrefixes }) =>
          hostname.toLowerCase() === url.hostname &&
          pathPrefixes.some(
            (prefix) =>
              url.pathname === prefix ||
              url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
          ),
      )
    ) {
      throw rejected();
    }
    let body: Buffer | undefined;
    if (parsed.data.body !== undefined) {
      body = Buffer.from(JSON.stringify(parsed.data.body), 'utf8');
      if (body.byteLength > profile.maxRequestBytes) {
        body.fill(0);
        throw rejected();
      }
    }
    return { request: parsed.data, url, body };
  };
  const consumedApprovals = new Set<string>();
  if (
    profile.secretPolicy.mode === 'per-request-approval' &&
    options.consumeApproval === undefined
  ) {
    throw rejected();
  }
  const consumeApproval =
    options.consumeApproval ??
    ((hash: string) => {
      if (consumedApprovals.has(hash)) return false;
      consumedApprovals.add(hash);
      return true;
    });
  return {
    profile,
    async execute(unparsed: unknown): Promise<RestrictedHttpJsonResult> {
      const { request, url, body: requestBody } = parse(unparsed);
      const canonicalHash = requestHash(request, url);
      const resolved: Uint8Array[] = [];
      try {
        // Resolve every alias the request names — one for static auth, up to four
        // when a JWT takes its `kid`, `iss` or `sub` from the secret store too.
        const values = new Map<string, string>();
        for (const alias of brokeredHttpRequestAliases(request)) {
          const raw = await options.resolveSecret(alias);
          resolved.push(raw);
          let value: string;
          try {
            value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
          } catch {
            throw rejected();
          }
          if (value.length === 0 || value.includes('\0')) throw rejected();
          values.set(alias, value);
        }
        const signingValue = values.get(request.secretAlias)!;
        const credentials: RedactedCredential[] = [...values].map(([alias, value]) => ({
          alias,
          value,
        }));
        let headerName: string;
        let headerValue: string;
        if (request.auth.kind === 'jwt') {
          const auth = request.auth;
          const claim = (source: BrokeredJwtValue | undefined): string | undefined => {
            if (source === undefined) return undefined;
            const value = 'alias' in source ? values.get(source.alias) : source.literal;
            // A claim crosses into a JWT header/payload as a JSON string. Control
            // characters and line breaks have no place there, and an over-long
            // value is a sign the alias holds something other than an id.
            if (value === undefined || value.length > 256 || /[\p{Cc}]/u.test(value)) {
              throw rejected();
            }
            return value;
          };
          const issuer = claim(auth.issuer);
          if (issuer === undefined) throw rejected();
          const keyId = claim(auth.keyId);
          const subject = claim(auth.subject);
          const jwt = mintBrokeredJwt({
            algorithm: auth.algorithm,
            privateKeyPem: signingValue,
            ...(keyId === undefined ? {} : { keyId }),
            issuer,
            audience: auth.audience,
            ...(subject === undefined ? {} : { subject }),
            ...(auth.scope === undefined ? {} : { scope: auth.scope }),
            expiresInSeconds: auth.expiresInSeconds,
          });
          // The assertion is a bearer credential in its own right, so it is
          // redacted like the key that produced it, under the key's alias.
          credentials.push({ alias: request.secretAlias, value: jwt });
          headerName = 'authorization';
          headerValue = `Bearer ${jwt}`;
        } else {
          // A static credential goes into a header verbatim, so a line break in it
          // would be header injection. A PEM never reaches this branch.
          if (/[\r\n]/.test(signingValue)) throw rejected();
          headerName = request.auth.header;
          headerValue =
            request.auth.scheme === null ? signingValue : `${request.auth.scheme} ${signingValue}`;
        }
        // Commit the durable at-most-once fence after every preflight step but immediately before
        // network I/O. Doppler failures remain safely retryable; ambiguous network failures do not.
        let requestAuthorized = false;
        const result = await options.transport({
          hostname: url.hostname,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: {
            accept: 'application/json',
            [headerName]: headerValue,
            ...(requestBody === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': String(requestBody.byteLength),
                }),
            'user-agent': 'verity-secret-http-json/1',
          },
          ...(requestBody === undefined ? {} : { body: requestBody }),
          timeoutMs: profile.timeoutMs,
          maxResponseBytes: profile.maxResponseBytes,
          authorizeRequest: async () => {
            if (requestAuthorized || !(await consumeApproval(canonicalHash))) throw rejected();
            requestAuthorized = true;
          },
        });
        if (!requestAuthorized) throw rejected();
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
          throw rejected();
        }
        const rawBody =
          typeof result.body === 'string' && result.body.length > 0 ? result.body : null;
        if (options.returnTrustedResponseBody === true) {
          // Legacy GET compatibility adapter keeps its strict contract: 2xx, complete body,
          // parsed JSON object (204 -> null).
          if (result.status < 200 || result.status >= 300 || result.truncated === true) {
            throw rejected();
          }
          if (result.status === 204) {
            if (rawBody !== null) throw rejected();
            return { status: result.status, body: null };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody ?? '') as unknown;
          } catch {
            throw rejected();
          }
          // UNRESOLVED, recorded rather than quietly changed: "JSON object" above and
          // this check disagree — a top-level JSON array satisfies `typeof === 'object'`
          // and crosses. That may be intended (REST endpoints do answer with arrays, and
          // this is the compatibility path), and it is NOT a redaction gap: an object is
          // returned as-is on the next line too, so an array is a shape the comment did
          // not anticipate, not a distinct exposure path. Whichever way it is settled,
          // fix the comment or add `|| Array.isArray(parsed)` — the current behaviour is
          // pinned by "admits a top-level JSON array, which its object check does not
          // exclude" in the co-located test, so either resolution is a visible change.
          if (typeof parsed !== 'object' || parsed === null) throw rejected();
          return { status: result.status, body: parsed };
        }
        // Brokered model tool (ADR 0011 D1): the status and the redacted body ALWAYS cross back
        // to the agent — non-2xx included — so it can react instead of failing blind.
        const truncatedFlag = result.truncated === true ? { truncated: true as const } : {};
        if (rawBody === null) {
          return {
            status: result.status,
            body: null,
            ...truncatedFlag,
            ...(result.undecodable === true
              ? { note: 'body withheld (undecodable)' as const }
              : {}),
          };
        }
        // A cut response can end in any prefix of a raw, encoded, or JSON-escaped
        // credential. Withhold that incomplete body because no finite replacement
        // pass can prove the trailing fragment safe.
        if (result.truncated === true) {
          return {
            status: result.status,
            body: null,
            ...truncatedFlag,
            note: 'body withheld (truncated)' as const,
          };
        }
        const needles = redactionOrder(credentials);
        let bodyValue: unknown;
        try {
          // Parse first so JSON escaping cannot hide a reflected credential from
          // the redactor. Keys and string values are both model-visible.
          bodyValue = redactJsonValue(JSON.parse(rawBody) as unknown, credentials, needles);
        } catch {
          bodyValue = redactAllSecretForms(rawBody, credentials, needles);
        }
        return { status: result.status, body: bodyValue, ...truncatedFlag };
      } catch (error) {
        if (error instanceof RestrictedHttpJsonRejectedError) throw error;
        // A key that does not match the requested algorithm is a configuration
        // fact the agent can act on, and masking it as a generic rejection sends
        // it hunting for a second, wrong cause (ADR 0011 D5).
        if (error instanceof BrokeredJwtError) throw error;
        throw rejected();
      } finally {
        for (const secret of resolved) secret.fill(0);
        requestBody?.fill(0);
      }
    },
  };
}
