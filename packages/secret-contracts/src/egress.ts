import { z } from 'zod';
import { canonicalJson, secretContractIdSchema, sha256HexSchema } from './common.js';

const forbiddenHeaders = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
]);
const canonicalPathPrefixSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/)
  .refine(
    (value) => !value.split('/').some((part) => part === '.' || part === '..'),
    'path prefix must be canonical',
  );

const dnsNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

export const restrictedHttpEgressPolicySchema = z
  .object({
    id: secretContractIdSchema,
    version: z.number().int().positive(),
    policyHash: sha256HexSchema,
    protocol: z.literal('https-json'),
    destination: z.object({ hostname: dnsNameSchema, port: z.literal(443) }).strict(),
    tls: z
      .object({
        serverName: dnsNameSchema,
        minimumVersion: z.literal('TLSv1.3'),
        spkiSha256: z.array(sha256HexSchema).min(1).max(8),
        allowSystemRoots: z.literal(false),
        trustBundleHash: sha256HexSchema,
        verification: z.literal('pki-hostname-validity-and-spki'),
      })
      .strict(),
    methods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1)
      .max(5),
    pathPrefixes: z.array(canonicalPathPrefixSchema).min(1).max(32),
    allowedQueryKeys: z.array(z.string().min(1).max(128)).max(32),
    allowedRequestHeaders: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(128),
      )
      .max(32),
    immutableBindings: z
      .array(
        z.discriminatedUnion('location', [
          z
            .object({
              location: z.literal('path-segment'),
              segmentIndex: z.number().int().nonnegative().max(63),
              valueHash: sha256HexSchema,
            })
            .strict(),
          z
            .object({
              location: z.literal('query'),
              key: z.string().min(1).max(128),
              valueHash: sha256HexSchema,
            })
            .strict(),
          z
            .object({
              location: z.literal('json-pointer'),
              pointer: z.string().regex(/^(?:\/(?:[^~/]|~0|~1)*)+$/),
              valueHash: sha256HexSchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
    body: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z
        .object({
          kind: z.literal('json-schema'),
          schemaHash: sha256HexSchema,
          maxBytes: z.number().int().positive().max(1_048_576),
        })
        .strict(),
    ]),
    response: z
      .object({
        maxBytes: z.number().int().positive().max(4_194_304),
        schemaHash: sha256HexSchema.optional(),
      })
      .strict(),
    redirects: z.literal('deny'),
    dns: z
      .object({
        searchDomains: z.literal(false),
        pinForRequest: z.literal(true),
        rejectPrivateAndMetadata: z.literal(true),
        allowIpv6: z.boolean(),
      })
      .strict(),
    denyConnect: z.literal(true),
    denyProtocolUpgrade: z.literal(true),
    stripProxyEnvironment: z.literal(true),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.destination.hostname !== policy.tls.serverName) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls', 'serverName'],
        message: 'TLS server name must equal destination',
      });
    }
    for (const values of [
      policy.methods,
      policy.pathPrefixes,
      policy.allowedQueryKeys,
      policy.allowedRequestHeaders,
    ]) {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', message: 'policy lists must be unique' });
    }
    for (const header of policy.allowedRequestHeaders) {
      if (forbiddenHeaders.has(header) || header.startsWith('proxy-'))
        ctx.addIssue({
          code: 'custom',
          path: ['allowedRequestHeaders'],
          message: `forbidden request header: ${header}`,
        });
    }
    if (new Set(policy.tls.spkiSha256).size !== policy.tls.spkiSha256.length)
      ctx.addIssue({
        code: 'custom',
        path: ['tls', 'spkiSha256'],
        message: 'SPKI pins must be unique',
      });
    for (const binding of policy.immutableBindings) {
      if (
        binding.location === 'path-segment' &&
        policy.pathPrefixes.some(
          (prefix) => binding.segmentIndex >= prefix.split('/').filter(Boolean).length,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['immutableBindings'],
          message: 'path binding segment must exist in every prefix',
        });
      if (binding.location === 'query' && !policy.allowedQueryKeys.includes(binding.key))
        ctx.addIssue({
          code: 'custom',
          path: ['immutableBindings'],
          message: 'query binding key must be allowed',
        });
      if (binding.location === 'json-pointer' && policy.body.kind !== 'json-schema')
        ctx.addIssue({
          code: 'custom',
          path: ['immutableBindings'],
          message: 'JSON pointer binding requires JSON body',
        });
    }
  });
export type RestrictedHttpEgressPolicy = z.infer<typeof restrictedHttpEgressPolicySchema>;

export function egressPolicyPreimage(policy: RestrictedHttpEgressPolicy): string {
  const rest = Object.fromEntries(
    Object.entries(policy).filter(([key]) => key !== 'policyHash'),
  ) as Omit<RestrictedHttpEgressPolicy, 'policyHash'>;
  const sorted = (values: readonly string[]) => [...values].sort();
  return (
    'verity.egress-policy.v1\0' +
    canonicalJson({
      ...rest,
      methods: sorted(rest.methods),
      pathPrefixes: sorted(rest.pathPrefixes),
      allowedQueryKeys: sorted(rest.allowedQueryKeys),
      allowedRequestHeaders: sorted(rest.allowedRequestHeaders),
      immutableBindings: [...rest.immutableBindings].sort((a, b) =>
        canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0,
      ),
      tls: { ...rest.tls, spkiSha256: sorted(rest.tls.spkiSha256) },
    })
  );
}

export function validateEgressPolicyIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): RestrictedHttpEgressPolicy {
  const policy = restrictedHttpEgressPolicySchema.parse(input);
  if (sha256(egressPolicyPreimage(policy)) !== policy.policyHash)
    throw new Error('policyHash mismatch');
  return policy;
}

export const egressClassificationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('restricted'), policy: restrictedHttpEgressPolicySchema }).strict(),
  z
    .object({
      mode: z.literal('trusted'),
      reason: z.enum([
        'generic_tcp',
        'arbitrary_payload',
        'uninspectable_tls',
        'unbound_tenant',
        'unsupported_protocol',
      ]),
    })
    .strict(),
]);
export type EgressClassification = z.infer<typeof egressClassificationSchema>;
