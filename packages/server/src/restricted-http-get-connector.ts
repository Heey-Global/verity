import { isIP } from 'node:net';

import { z } from 'zod';

import {
  createNodeRestrictedHttpJsonTransport,
  createRestrictedHttpJsonConnector,
  RestrictedHttpJsonRejectedError,
  type RestrictedHttpJsonTransport,
} from './restricted-http-json-connector.js';

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

export const restrictedHttpGetProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === '' &&
        isIP(url.hostname) === 0 &&
        dnsNameSchema.safeParse(url.hostname).success
      );
    }),
    pathPrefixes: z.array(canonicalPathSchema).min(1).max(16),
    allowedQueryKeys: z.array(z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/)).max(16),
    auth: z
      .object({
        secretAlias: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        header: z.enum(['authorization', 'x-api-key']),
        scheme: z.enum(['Bearer', 'Basic']).nullable(),
      })
      .strict(),
    timeoutMs: z.number().int().positive().max(60_000).default(15_000),
    maxResponseBytes: z.number().int().positive().max(1_048_576).default(262_144),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (new Set(profile.pathPrefixes).size !== profile.pathPrefixes.length) {
      ctx.addIssue({ code: 'custom', path: ['pathPrefixes'], message: 'paths must be unique' });
    }
    if (new Set(profile.allowedQueryKeys).size !== profile.allowedQueryKeys.length) {
      ctx.addIssue({ code: 'custom', path: ['allowedQueryKeys'], message: 'keys must be unique' });
    }
    if (profile.auth.header === 'authorization' && profile.auth.scheme === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'scheme'],
        message: 'authorization requires a fixed scheme',
      });
    }
    if (profile.auth.header === 'x-api-key' && profile.auth.scheme !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'scheme'],
        message: 'x-api-key forbids a scheme',
      });
    }
  });
export type RestrictedHttpGetProfile = z.infer<typeof restrictedHttpGetProfileSchema>;

export const restrictedHttpGetRequestSchema = z
  .object({
    path: canonicalPathSchema,
    query: z.record(z.string(), z.string().max(2048)).default({}),
  })
  .strict();
export type RestrictedHttpGetRequest = z.infer<typeof restrictedHttpGetRequestSchema>;
export type RestrictedHttpGetResult = { status: number; body: unknown };
export class RestrictedHttpGetRejectedError extends Error {
  constructor() {
    super('restricted HTTP request rejected');
  }
}
export type RestrictedHttpTransport = (request: {
  hostname: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxResponseBytes: number;
}) => Promise<{ status: number; body: unknown }>;

function legacyRejected(): RestrictedHttpGetRejectedError {
  return new RestrictedHttpGetRejectedError();
}

function pathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}

/** Source-compatible wrapper around the original, already-merged GET-only policy. */
export function createRestrictedHttpGetConnector(options: {
  profile: RestrictedHttpGetProfile;
  resolveSecret: (alias: string) => Promise<Uint8Array>;
  transport: RestrictedHttpTransport;
}) {
  const profile = restrictedHttpGetProfileSchema.parse(options.profile);
  const connector = createRestrictedHttpJsonConnector({
    profile: {
      id: profile.id,
      projectId: profile.projectId,
      secretPolicy: { mode: 'allowlist', aliases: [profile.auth.secretAlias] },
      timeoutMs: profile.timeoutMs,
      maxRequestBytes: 65_536,
      maxResponseBytes: profile.maxResponseBytes,
    },
    resolveSecret: options.resolveSecret,
    consumeApproval: () => true,
    returnTrustedResponseBody: true,
    transport: async (request) => {
      await request.authorizeRequest();
      const result = await options.transport({
        hostname: request.hostname,
        path: request.path,
        headers: { ...request.headers, 'user-agent': 'verity-secret-http-get/1' },
        timeoutMs: request.timeoutMs,
        maxResponseBytes: request.maxResponseBytes,
      });
      // The legacy transport contract carries a parsed JSON body; the JSON connector's
      // transport contract carries raw text — re-encode at the seam.
      return {
        status: result.status,
        body:
          result.body === null || result.body === undefined ? null : JSON.stringify(result.body),
      };
    },
  });
  return {
    profile,
    async execute(unparsed: unknown): Promise<RestrictedHttpGetResult> {
      const parsed = restrictedHttpGetRequestSchema.safeParse(unparsed);
      if (!parsed.success || !pathAllowed(parsed.data.path, profile.pathPrefixes)) {
        throw legacyRejected();
      }
      const keys = Object.keys(parsed.data.query);
      if (keys.some((key) => !profile.allowedQueryKeys.includes(key))) throw legacyRejected();
      const url = new URL(profile.origin);
      url.pathname = parsed.data.path;
      for (const key of keys.sort()) url.searchParams.set(key, parsed.data.query[key]!);
      const candidate = {
        method: 'GET' as const,
        url: url.toString(),
        secretAlias: profile.auth.secretAlias,
        auth: { header: profile.auth.header, scheme: profile.auth.scheme },
      };
      try {
        const result = await connector.execute(candidate);
        if (!Object.hasOwn(result, 'body')) throw legacyRejected();
        return { status: result.status, body: result.body };
      } catch {
        throw legacyRejected();
      }
    },
  };
}

type LegacyDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export function createNodeRestrictedHttpTransport(options?: {
  lookup?: LegacyDnsLookup;
}): RestrictedHttpTransport {
  const transport: RestrictedHttpJsonTransport = createNodeRestrictedHttpJsonTransport(options);
  return async (request) => {
    try {
      const result = await transport({
        ...request,
        method: 'GET',
        authorizeRequest: () => Promise.resolve(),
      });
      // Preserve the legacy contract: 2xx, complete JSON body, parsed.
      if (
        typeof result.body !== 'string' ||
        result.truncated === true ||
        result.status < 200 ||
        result.status >= 300
      ) {
        throw legacyRejected();
      }
      return { status: result.status, body: JSON.parse(result.body) as unknown };
    } catch {
      throw legacyRejected();
    }
  };
}

export { RestrictedHttpJsonRejectedError };
