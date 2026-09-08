import { describe, expect, it } from 'vitest';

import { injectCodexEgressCredential, validateCodexEgress } from './codex-egress-policy.js';

describe('Codex egress policy', () => {
  it('maps the exact subscription routes and replaces the placeholder', () => {
    const models = validateCodexEgress({
      method: 'GET',
      url: new URL('https://chatgpt.com/codex/models'),
      headers: { authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });
    expect(models.url.href).toBe('https://chatgpt.com/backend-api/codex/models');

    const responses = injectCodexEgressCredential(
      validateCodexEgress({
        method: 'POST',
        url: new URL('https://chatgpt.com/codex/responses'),
        headers: {
          authorization: 'Bearer verity-codex-gateway-placeholder-v1',
          'content-type': 'application/json',
        },
      }),
      { accessToken: 'server-only-token', accountId: 'account-1' },
    );
    expect(responses.url.href).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(responses.headers.get('authorization')).toBe('Bearer server-only-token');
    expect(responses.headers.get('chatgpt-account-id')).toBe('account-1');

    for (const route of ['generations', 'edits']) {
      const images = injectCodexEgressCredential(
        validateCodexEgress({
          method: 'POST',
          url: new URL(`https://chatgpt.com/codex/images/${route}`),
          headers: {
            authorization: 'Bearer verity-codex-gateway-placeholder-v1',
            'x-openai-actor-authorization': 'verity-codex-gateway-placeholder-v1',
          },
        }),
        { accessToken: 'server-only-token', accountId: 'account-1' },
      );
      expect(images.url.href).toBe(`https://chatgpt.com/backend-api/codex/images/${route}`);
      expect(images.headers.get('x-openai-actor-authorization')).toBeNull();
      expect(images.headers.get('authorization')).toBe('Bearer server-only-token');
    }
  });

  it.each([
    ['wrong path', 'POST', '/v1/responses', {}],
    ['wrong method', 'GET', '/codex/responses', {}],
    ['wrong image method', 'GET', '/codex/images/generations', {}],
    ['unknown image route', 'POST', '/codex/images', {}],
    ['query', 'GET', '/codex/models?admin=true', {}],
    ['client account', 'GET', '/codex/models', { 'chatgpt-account-id': 'attacker' }],
    ['client cookie', 'GET', '/codex/models', { cookie: 'session=attacker' }],
    [
      'client actor credential',
      'POST',
      '/codex/images/generations',
      { 'x-openai-actor-authorization': 'attacker' },
    ],
  ])('rejects %s', (_name, method, path, extraHeaders) => {
    expect(() =>
      validateCodexEgress({
        method,
        url: new URL(path, 'https://chatgpt.com'),
        headers: {
          authorization: 'Bearer verity-codex-gateway-placeholder-v1',
          ...extraHeaders,
        },
      }),
    ).toThrow();
  });

  it('rejects a missing placeholder', () => {
    expect(() =>
      validateCodexEgress({
        method: 'GET',
        url: new URL('https://chatgpt.com/codex/models'),
        headers: {},
      }),
    ).toThrow();
  });

  it.each([
    'Bearer attacker-token',
    'bearer verity-placeholder',
    'Bearer verity-placeholder-extra',
    'Bearer  verity-placeholder',
  ])('rejects a credential other than the exact configured placeholder: %s', (authorization) => {
    expect(() =>
      validateCodexEgress({
        method: 'GET',
        url: new URL('https://chatgpt.com/codex/models'),
        headers: { authorization },
      }),
    ).toThrow();
  });
});
