import { describe, expect, it } from 'vitest';
import {
  egressClassificationSchema,
  egressPolicyPreimage,
  restrictedHttpEgressPolicySchema,
  validateEgressPolicyIdentity,
} from './index.js';

const hash = 'a'.repeat(64);
const policy = {
  id: 'github-read',
  version: 1,
  policyHash: hash,
  protocol: 'https-json',
  destination: { hostname: 'api.github.com', port: 443 },
  tls: {
    serverName: 'api.github.com',
    minimumVersion: 'TLSv1.3',
    spkiSha256: [hash],
    allowSystemRoots: false,
    trustBundleHash: hash,
    verification: 'pki-hostname-validity-and-spki',
  },
  methods: ['GET'],
  pathPrefixes: ['/repos/heey-global/verity/'],
  allowedQueryKeys: ['page'],
  allowedRequestHeaders: ['accept'],
  immutableBindings: [{ location: 'path-segment', segmentIndex: 2, valueHash: hash }],
  body: { kind: 'none' },
  response: { maxBytes: 1_000_000 },
  redirects: 'deny',
  dns: {
    searchDomains: false,
    pinForRequest: true,
    rejectPrivateAndMetadata: true,
    allowIpv6: false,
  },
  denyConnect: true,
  denyProtocolUpgrade: true,
  stripProxyEnvironment: true,
} as const;

describe('restricted egress policy contracts', () => {
  it('accepts a fully bound HTTPS operation', () =>
    expect(restrictedHttpEgressPolicySchema.parse(policy).protocol).toBe('https-json'));
  it.each([
    { destination: { hostname: '127.0.0.1', port: 443 } },
    { redirects: 'follow' },
    { denyConnect: false },
    { stripProxyEnvironment: false },
    { tls: { ...policy.tls, serverName: 'attacker.example' } },
  ])('rejects fail-open mutation %#', (change) =>
    expect(() => restrictedHttpEgressPolicySchema.parse({ ...policy, ...change })).toThrow(),
  );
  it('classifies generic TCP as trusted', () =>
    expect(egressClassificationSchema.parse({ mode: 'trusted', reason: 'generic_tcp' }).mode).toBe(
      'trusted',
    ));
  it.each(['host', 'connection', 'transfer-encoding', 'proxy-authorization'])(
    'rejects dangerous header %s',
    (header) =>
      expect(() =>
        restrictedHttpEgressPolicySchema.parse({ ...policy, allowedRequestHeaders: [header] }),
      ).toThrow(/forbidden request header/),
  );
  it.each(['/../admin', '//admin', '/%2fadmin', '/ok?x=1'])(
    'rejects noncanonical prefix %s',
    (path) =>
      expect(() =>
        restrictedHttpEgressPolicySchema.parse({ ...policy, pathPrefixes: [path] }),
      ).toThrow(),
  );
  it('binds canonical policy identity', () => {
    const fake = (value: string) => (value.length % 16).toString(16).repeat(64);
    const policyHash = fake(egressPolicyPreimage(restrictedHttpEgressPolicySchema.parse(policy)));
    expect(validateEgressPolicyIdentity({ ...policy, policyHash }, fake).policyHash).toBe(
      policyHash,
    );
    expect(() =>
      validateEgressPolicyIdentity({ ...policy, policyHash: hash }, () => 'b'.repeat(64)),
    ).toThrow(/policyHash mismatch/);
  });
});
