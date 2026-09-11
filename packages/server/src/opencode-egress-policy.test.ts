import { describe, expect, it } from 'vitest';

import {
  injectOpenCodeCredential,
  OPENCODE_EGRESS_ORIGIN,
  OpenCodeEgressPolicyError,
  validateOpenCodeEgress,
} from './opencode-egress-policy.js';

describe('OpenCode egress policy', () => {
  it('replaces the sandbox placeholder without exposing the provider key', () => {
    const request = validateOpenCodeEgress({
      method: 'POST',
      url: new URL('/opencode/chat/completions', OPENCODE_EGRESS_ORIGIN),
      baseUrl: 'https://provider.example/v1',
      headers: { authorization: 'Bearer verity-opencode-gateway-placeholder-v1' },
    });
    const authorized = injectOpenCodeCredential(request, 'real-provider-key');
    expect(authorized.url.href).toBe('https://provider.example/v1/chat/completions');
    expect(authorized.headers.get('authorization')).toBe('Bearer real-provider-key');
  });

  it.each([
    { authorization: 'Bearer attacker-key' },
    {
      authorization: 'Bearer verity-opencode-gateway-placeholder-v1',
      'x-api-key': 'attacker-key',
    },
  ])('rejects sandbox-controlled credentials', (headers) => {
    expect(() =>
      validateOpenCodeEgress({
        method: 'POST',
        url: new URL('/opencode/chat/completions', OPENCODE_EGRESS_ORIGIN),
        baseUrl: 'https://provider.example/v1',
        headers,
      }),
    ).toThrow(OpenCodeEgressPolicyError);
  });

  it('rejects cleartext upstreams', () => {
    expect(() =>
      validateOpenCodeEgress({
        method: 'GET',
        url: new URL('/opencode/models', OPENCODE_EGRESS_ORIGIN),
        baseUrl: 'http://provider.example/v1',
        headers: { authorization: 'Bearer verity-opencode-gateway-placeholder-v1' },
      }),
    ).toThrow('OpenCode upstream URL is invalid');
  });

  it.each(['/opencode/files', '/opencode/chat/completions?api-version=other'])(
    'rejects provider operations outside the inference allowlist',
    (path) => {
      expect(() =>
        validateOpenCodeEgress({
          method: 'POST',
          url: new URL(path, OPENCODE_EGRESS_ORIGIN),
          baseUrl: 'https://provider.example/v1',
          headers: { authorization: 'Bearer verity-opencode-gateway-placeholder-v1' },
        }),
      ).toThrow('OpenCode egress route is not allowed');
    },
  );
});
