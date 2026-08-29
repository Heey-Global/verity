import { describe, expect, it } from 'vitest';
import {
  authorizeClaudeEgress,
  CLAUDE_EGRESS_PLACEHOLDER,
  ClaudeEgressPolicyError,
} from './claude-egress-policy.js';

const identity = {
  authenticatedProjectId: 'project-1',
  credentialProjectId: 'project-1',
};

const request = (
  url: string,
  headers: Headers | Record<string, string>,
  transportAuthority = 'api.anthropic.com:443',
  method = 'POST',
) => ({ url, method, headers, transportAuthority });

describe('Claude credential-injection egress policy', () => {
  it('replaces only the placeholder bearer on the exact Anthropic API origin', () => {
    const input = new Headers({
      authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      'anthropic-version': '2023-06-01',
    });

    const authorized = authorizeClaudeEgress(
      request('https://api.anthropic.com/v1/messages', input),
      identity,
      'server-only-access-token',
    );

    expect(authorized.url.href).toBe('https://api.anthropic.com/v1/messages');
    expect(authorized.headers.get('authorization')).toBe('Bearer server-only-access-token');
    expect(authorized.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(authorized.redirect).toBe('manual');
    expect(input.get('authorization')).toBe(`Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`);
  });

  it.each([
    'https://api.anthropic.com.evil.example/v1/messages',
    'https://evil.example/v1/messages?next=https://api.anthropic.com',
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com:444/v1/messages',
    'https://user@api.anthropic.com/v1/messages',
  ])('rejects a non-canonical destination: %s', (url) => {
    expect(() =>
      authorizeClaudeEgress(
        request(url, { authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` }),
        identity,
        'server-only-access-token',
      ),
    ).toThrow(ClaudeEgressPolicyError);
  });

  it.each(['/v1/messages', '/v1/messages/count_tokens'])(
    'allows the exact POST inference endpoint: %s',
    (path) => {
      expect(
        authorizeClaudeEgress(
          request(`https://api.anthropic.com${path}`, {
            authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          }),
          identity,
          'server-only-access-token',
        ).url.pathname,
      ).toBe(path);
    },
  );

  it.each(['/v1/messages?beta=true', '/v1/messages/count_tokens?beta=true'])(
    'allows the CLI beta query parameter and forwards it verbatim: %s',
    (path) => {
      expect(
        authorizeClaudeEgress(
          request(`https://api.anthropic.com${path}`, {
            authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          }),
          identity,
          'server-only-access-token',
        ).url.href,
      ).toBe(`https://api.anthropic.com${path}`);
    },
  );

  it.each([
    ['GET', '/v1/messages'],
    ['PUT', '/v1/messages'],
    ['post', '/v1/messages'],
    ['POST', '/v1/messages/'],
    ['POST', '/v1/messages/count_tokens/'],
    ['POST', '/v1/messages/batches'],
    ['POST', '/v1/models'],
    ['GET', '/api/oauth/usage'],
    ['POST', '/v1/organizations'],
    ['POST', '/v1/%6dessages'],
    ['POST', '/v1/messages%2fcount_tokens'],
    ['POST', '/v1/messages/../organizations'],
    ['POST', '//v1/messages'],
    ['POST', '/v1/messages?admin=true'],
    ['POST', '/v1/messages?beta=false'],
    ['POST', '/v1/messages?beta=true&admin=true'],
    ['POST', '/v1/messages?beta=true&beta=true'],
    ['POST', '/v1/messages?beta'],
    ['POST', '/v1/messages?BETA=true'],
    ['POST', '/v1/messages?b%65ta=true'],
    ['GET', '/v1/messages?beta=true'],
    ['POST', '/v1/models?beta=true'],
    ['POST', '/v1/messages#fragment'],
    ['POST', '/v1/messages?beta=true#fragment'],
  ])('rejects non-inference endpoint %s %s', (method, path) => {
    expect(() =>
      authorizeClaudeEgress(
        request(
          `https://api.anthropic.com${path}`,
          { authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
          'api.anthropic.com:443',
          method,
        ),
        identity,
        'server-only-access-token',
      ),
    ).toThrow('Claude egress inference endpoint is not allowed');
  });

  it.each([
    undefined,
    'Bearer real-token-from-sandbox',
    `Basic ${CLAUDE_EGRESS_PLACEHOLDER}`,
    `Bearer  ${CLAUDE_EGRESS_PLACEHOLDER}`,
  ])('rejects a missing or altered placeholder: %s', (authorization) => {
    const headers = authorization === undefined ? {} : { authorization };
    expect(() =>
      authorizeClaudeEgress(
        request('https://api.anthropic.com/v1/messages', headers),
        identity,
        'server-only-access-token',
      ),
    ).toThrow('Claude egress placeholder is missing');
  });

  it('rejects client-provided API keys', () => {
    expect(() =>
      authorizeClaudeEgress(
        {
          ...request('https://api.anthropic.com/v1/messages', {
            authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
            'x-api-key': 'sandbox-secret',
          }),
        },
        identity,
        'server-only-access-token',
      ),
    ).toThrow('Claude egress does not accept client API keys');
  });

  it.each([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'trailer',
    'proxy-authorization',
    'cookie',
    'anthropic-user-profile-id',
    'x-forwarded-host',
  ])('rejects client-controlled routing or framing header: %s', (name) => {
    expect(() =>
      authorizeClaudeEgress(
        request('https://api.anthropic.com/v1/messages', {
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          [name]: 'attacker-controlled',
        }),
        identity,
        'server-only-access-token',
      ),
    ).toThrow(`Claude egress header is not allowed: ${name}`);
  });

  it.each(['', 'token\r\ninjected: header'])('rejects an invalid server token', (token) => {
    expect(() =>
      authorizeClaudeEgress(
        request('https://api.anthropic.com/v1/messages', {
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        }),
        identity,
        token,
      ),
    ).toThrow('Claude access token is invalid');
  });

  it('rejects cross-project credential use', () => {
    expect(() =>
      authorizeClaudeEgress(
        request('https://api.anthropic.com/v1/messages', {
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        }),
        { authenticatedProjectId: 'project-evil', credentialProjectId: 'project-1' },
        'server-only-access-token',
      ),
    ).toThrow('Claude egress project identity does not match credential');
  });

  it('rejects disagreement between CONNECT/SNI and the decrypted URL', () => {
    expect(() =>
      authorizeClaudeEgress(
        request(
          'https://api.anthropic.com/v1/messages',
          { authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
          'evil.example:443',
        ),
        identity,
        'server-only-access-token',
      ),
    ).toThrow('Claude egress transport authority does not match URL');
  });

  it('rejects a non-canonical CONNECT port for the allowed host', () => {
    expect(() =>
      authorizeClaudeEgress(
        request(
          'https://api.anthropic.com/v1/messages',
          { authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
          'api.anthropic.com:444',
        ),
        identity,
        'server-only-access-token',
      ),
    ).toThrow('Claude egress transport authority does not match URL');
  });
});
