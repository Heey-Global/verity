import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrokeredJwtError } from './brokered-jwt.js';

import {
  createNodeRestrictedHttpJsonTransport,
  createRestrictedHttpJsonConnector,
  RestrictedHttpJsonRejectedError,
  restrictedHttpJsonProfileSchema,
  type RestrictedHttpJsonTransport,
} from './restricted-http-json-connector.js';

interface TransportHooks {
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * The production transport is the one part of this module that cannot be reached
 * with an injected fake: it IS the socket. Both of its outside edges — Node's HTTPS
 * client and the system resolver — are replaced here, and only while a test has
 * installed a hook, so every other test in this file keeps the real ones.
 */
const { transportHooks } = vi.hoisted((): { transportHooks: TransportHooks } => ({
  transportHooks: {},
}));

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return {
    ...actual,
    default: actual,
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) =>
      transportHooks.request
        ? transportHooks.request(options, callback)
        : actual.request(options, callback),
  };
});

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: actual,
    lookup: async (hostname: string, options: { all: true; verbatim: true }) =>
      transportHooks.lookup
        ? transportHooks.lookup(hostname, options)
        : actual.lookup(hostname, options),
  };
});

const profile = restrictedHttpJsonProfileSchema.parse({
  id: 'project-http',
  projectId: 'project-1',
  secretPolicy: {
    mode: 'allowlist',
    aliases: ['STRIPE_API_KEY', 'GITHUB_TOKEN'],
    destinations: [{ hostname: 'api.stripe.com', pathPrefixes: ['/v1'] }],
  },
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: 'https://api.stripe.com/v1/customers?limit=5',
    secretAlias: 'STRIPE_API_KEY',
    auth: { header: 'authorization', scheme: 'Bearer' },
    body: { description: 'Preview customer' },
    ...overrides,
  };
}

describe('restricted HTTP JSON connector', () => {
  it.each([
    'https://evil.example/v1/customers',
    'https://api.stripe.com/v2/customers',
    'https://api.stripe.com/v10/customers',
  ])('rejects an allowlisted secret outside its destination boundary: %s', async (url) => {
    const resolveSecret = vi.fn();
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret,
      transport: vi.fn(),
    });
    await expect(connector.execute(request({ url }))).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('validates allowlist uniqueness and supports approval-only secret selection', async () => {
    expect(() =>
      restrictedHttpJsonProfileSchema.parse({
        id: 'duplicate-aliases',
        projectId: 'project-1',
        secretPolicy: {
          mode: 'allowlist',
          aliases: ['API_TOKEN', 'API_TOKEN'],
          destinations: [{ hostname: 'api.example.com', pathPrefixes: ['/'] }],
        },
      }),
    ).toThrow(/secret aliases must be unique/);

    const connector = createRestrictedHttpJsonConnector({
      profile: {
        id: 'approval-only',
        projectId: 'project-1',
        secretPolicy: { mode: 'per-request-approval' },
        timeoutMs: 15_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      resolveSecret: async () => Buffer.from('marker'),
      consumeApproval: () => true,
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ ok: true }) };
      },
    });
    const candidate = request({ secretAlias: 'PROJECT_SPECIFIC_TOKEN' });
    await expect(connector.execute(candidate)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it('rejects per-request approval profiles without an approval consumer', () => {
    expect(() =>
      createRestrictedHttpJsonConnector({
        profile: {
          id: 'approval-only',
          projectId: 'project-1',
          secretPolicy: { mode: 'per-request-approval' },
          timeoutMs: 15_000,
          maxRequestBytes: 65_536,
          maxResponseBytes: 65_536,
        },
        resolveSecret: async () => Buffer.from('marker'),
        transport: async () => ({ status: 200, body: null }),
      }),
    ).toThrow(RestrictedHttpJsonRejectedError);
  });

  it('executes exactly one approved request without exposing the secret', async () => {
    const secret = Buffer.from('sk_test_marker');
    let observedBody = '';
    let transportCalls = 0;
    const transport: RestrictedHttpJsonTransport = async (input) => {
      await input.authorizeRequest();
      transportCalls += 1;
      observedBody = input.body?.toString('utf8') ?? '';
      expect(input).toMatchObject({
        hostname: 'api.stripe.com',
        method: 'POST',
        path: '/v1/customers?limit=5',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer sk_test_marker',
          'content-type': 'application/json',
        },
      });
      return { status: 201, body: JSON.stringify({ id: 'cus_123' }) };
    };
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async (alias) => {
        expect(alias).toBe('STRIPE_API_KEY');
        return secret;
      },
      transport,
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 201,
      body: { id: 'cus_123' },
    });
    await expect(connector.execute(request())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
    expect(transportCalls).toBe(1);
    expect(observedBody).toBe('{"description":"Preview customer"}');
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('redacts the injected secret in every returned body form (ADR 0011 D1)', async () => {
    const secretValue = 'secret-marker';
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        return {
          status: 200,
          body: JSON.stringify({
            reflected: 'Bearer secret-marker',
            base64: Buffer.from(secretValue, 'utf8').toString('base64'),
            base64Unpadded: Buffer.from(secretValue, 'utf8').toString('base64').replace(/=+$/u, ''),
            base64Url: Buffer.from(secretValue, 'utf8').toString('base64url'),
            urlencoded: encodeURIComponent(`${secretValue}?`),
          }),
        };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: {
        reflected: 'Bearer [REDACTED:STRIPE_API_KEY]',
        base64: '[REDACTED:STRIPE_API_KEY]',
        base64Unpadded: '[REDACTED:STRIPE_API_KEY]',
        base64Url: '[REDACTED:STRIPE_API_KEY]',
        urlencoded: expect.stringContaining('[REDACTED:STRIPE_API_KEY]'),
      },
    });
  });

  it('redacts secrets reconstructed from JSON escapes in keys and values', async () => {
    const secretValue = 'secret-"quoted\\value';
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        return {
          status: 200,
          body: JSON.stringify({
            [secretValue]: `Bearer ${secretValue}`,
          }),
        };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: {
        '[REDACTED:STRIPE_API_KEY]': 'Bearer [REDACTED:STRIPE_API_KEY]',
      },
    });
  });

  it('redacts JSON-escaped secrets embedded in non-JSON text', async () => {
    const secretValue = 'secret-"quoted\\value';
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        const escapedSecret = JSON.stringify(secretValue).slice(1, -1);
        return { status: 200, body: `upstream error: Bearer ${escapedSecret}` };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: 'upstream error: Bearer [REDACTED:STRIPE_API_KEY]',
    });
  });

  it('redacts reflected secrets shorter than four characters', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('abc'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ reflected: 'Bearer abc' }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: { reflected: 'Bearer [REDACTED:STRIPE_API_KEY]' },
    });
  });

  it('redacts a secret reflected as a JSON number', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('123456'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: '{"token":123456}' };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: { token: '[REDACTED:STRIPE_API_KEY]' },
    });
  });

  it('redacts mixed-case percent escapes and form-encoded spaces', async () => {
    const secretValue = 'secret value?';
    const mixEscapeCase = (encoded: string): string =>
      encoded.replace(/%([0-9A-F])([0-9A-F])/g, (_match, first: string, second: string) => {
        return `%${first.toLowerCase()}${second.toUpperCase()}`;
      });
    const encoded = mixEscapeCase(encodeURIComponent(secretValue));
    const formEncoded = mixEscapeCase(
      new URLSearchParams({ value: secretValue }).toString().slice('value='.length),
    );
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ encoded, formEncoded }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: {
        encoded: '[REDACTED:STRIPE_API_KEY]',
        formEncoded: '[REDACTED:STRIPE_API_KEY]',
      },
    });
  });

  it('redacts equivalent non-canonical percent encodings', async () => {
    const secretValue = 'a!b';
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        return {
          status: 200,
          body: JSON.stringify({
            encodedReserved: 'a%21b',
            encodedUnreserved: '%61!b',
          }),
        };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: {
        encodedReserved: '[REDACTED:STRIPE_API_KEY]',
        encodedUnreserved: '[REDACTED:STRIPE_API_KEY]',
      },
    });
  });

  it('redacts repeatedly percent-encoded credentials', async () => {
    const secretValue = 'secret value?';
    const twice = encodeURIComponent(encodeURIComponent(secretValue));
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from(secretValue),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ twice }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: { twice: '[REDACTED:STRIPE_API_KEY]' },
    });
  });

  it('returns non-2xx statuses as results with the redacted body, not errors', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });

  it('withholds truncated bodies whose trailing fragment cannot be proven safe', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: '{"partial":tru', truncated: true };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: null,
      truncated: true,
      note: 'body withheld (truncated)',
    });
  });

  it('returns upstream JSON only for the explicit trusted compatibility adapter', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      returnTrustedResponseBody: true,
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ id: 'trusted-result' }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: { id: 'trusted-result' },
    });
  });

  it('delegates atomic approval consumption after secret preflight but before transport', async () => {
    const consumeApproval = vi.fn().mockResolvedValue(false);
    const resolveSecret = vi.fn(async () => Buffer.from('secret-marker'));
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret,
      consumeApproval,
      transport: vi.fn(async (input: Parameters<RestrictedHttpJsonTransport>[0]) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }),
    });
    await expect(connector.execute(request())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
    expect(consumeApproval).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(resolveSecret).toHaveBeenCalledOnce();
  });

  it.each(['POST', 'PUT', 'PATCH'] as const)('supports bounded JSON for %s', async (method) => {
    const transport = vi.fn(async (input: Parameters<RestrictedHttpJsonTransport>[0]) => {
      await input.authorizeRequest();
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('marker'),
      transport,
    });
    const candidate = request({ method });
    await expect(connector.execute(candidate)).resolves.toMatchObject({
      status: 200,
    });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method }));
  });

  it('supports body-free GET and DELETE', async () => {
    const transport = vi.fn(async (input: Parameters<RestrictedHttpJsonTransport>[0]) => {
      await input.authorizeRequest();
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('marker'),
      transport,
    });
    for (const method of ['GET', 'DELETE'] as const) {
      const candidate = request({ method, body: undefined });
      await expect(connector.execute(candidate)).resolves.toMatchObject({
        status: 200,
      });
    }
  });

  it.each([
    request({ url: 'http://api.stripe.com/v1/customers' }),
    request({ url: 'https://user@api.stripe.com/v1/customers' }),
    request({ url: 'https://api.stripe.com:8443/v1/customers' }),
    request({ url: 'https://127.0.0.1/v1/customers' }),
    request({ url: 'https://api.stripe.com/v1/../admin' }),
    request({ url: 'https://api.stripe.com/v1/customers#fragment' }),
    request({ secretAlias: 'UNCONFIGURED_SECRET' }),
    request({ method: 'GET' }),
  ])('rejects unsafe or unavailable requests before secret resolution', async (candidate) => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: vi.fn(),
      transport: vi.fn(),
    });
    await expect(connector.execute(candidate)).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
  });

  it('rejects oversized JSON before secret resolution', async () => {
    const resolveSecret = vi.fn();
    const connector = createRestrictedHttpJsonConnector({
      profile: { ...profile, maxRequestBytes: 8 },
      resolveSecret,
      transport: vi.fn(),
    });
    await expect(
      connector.execute(request({ body: { value: 'too large' } })),
    ).rejects.toBeInstanceOf(RestrictedHttpJsonRejectedError);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('zeroizes buffers and sanitizes resolver and transport failures', async () => {
    const secret = Buffer.from('secret-marker');
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => secret,
      transport: async (input) => {
        await input.authorizeRequest();
        throw new Error('socket contained secret-marker');
      },
    });
    await expect(connector.execute(request())).rejects.toEqual(
      new RestrictedHttpJsonRejectedError(),
    );
    expect(secret.every((byte) => byte === 0)).toBe(true);

    const resolverFailure = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => {
        throw new Error('Doppler project and token details');
      },
      transport: vi.fn(),
    });
    await expect(resolverFailure.execute(request())).rejects.toEqual(
      new RestrictedHttpJsonRejectedError(),
    );
  });

  it.each([Buffer.alloc(0), Buffer.from('line-one\nline-two'), Buffer.from([0xff])])(
    'rejects secrets that cannot form one safe header value',
    async (secret) => {
      const connector = createRestrictedHttpJsonConnector({
        profile,
        resolveSecret: async () => secret,
        transport: vi.fn(),
      });
      await expect(connector.execute(request())).rejects.toBeInstanceOf(
        RestrictedHttpJsonRejectedError,
      );
      expect(secret.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    { status: 99, body: JSON.stringify({ ok: true }) },
    { status: 600, body: JSON.stringify({ ok: true }) },
    { status: 200.5, body: JSON.stringify({ ok: true }) },
  ])('rejects an invalid transport result: %j', async (result) => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return result;
      },
    });
    await expect(connector.execute(request())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
  });

  it.each([
    { raw: null, expected: null },
    { raw: 'null', expected: null },
    { raw: '"scalar"', expected: 'scalar' },
    { raw: '42', expected: 42 },
    { raw: 'plain text, not JSON', expected: 'plain text, not JSON' },
  ])('returns scalar, null, and non-JSON bodies as values: %j', async ({ raw, expected }) => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 201, body: raw };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 201,
      body: expected,
    });
  });

  it.each([
    '127.0.0.1',
    '10.0.0.8',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fec0::1',
    '64:ff9b::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a00:8',
  ])('rejects private and metadata DNS answers before opening a socket: %s', async (address) => {
    const family = address.includes(':') ? 6 : 4;
    const transport = createNodeRestrictedHttpJsonTransport({
      lookup: vi.fn().mockResolvedValue([{ address, family }]),
    });
    const authorizeRequest = vi.fn();
    await expect(
      transport({
        hostname: 'api.example.com',
        method: 'GET',
        path: '/v1/read',
        headers: {},
        timeoutMs: 100,
        maxResponseBytes: 1024,
        authorizeRequest,
      }),
    ).rejects.toBeInstanceOf(RestrictedHttpJsonRejectedError);
    expect(authorizeRequest).not.toHaveBeenCalled();
  });

  // The fence lives inside the transport's `authorizeRequest` because that is the
  // last moment before bytes leave the process. A transport that never calls it has
  // put a credential on the wire outside the fence, so its answer is refused.
  it('refuses a result from a transport that skipped the approval fence', async () => {
    const consumeApproval = vi.fn(() => true);
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      consumeApproval,
      transport: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
    });
    await expect(connector.execute(request())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it('reports an undecodable body as withheld rather than as an empty one', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: null, undecodable: true };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: null,
      note: 'body withheld (undecodable)',
    });
  });

  it('redacts a secret reflected inside a JSON array', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: '[{"echo":"secret-marker"},["secret-marker"],1]' };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: [{ echo: '[REDACTED:STRIPE_API_KEY]' }, ['[REDACTED:STRIPE_API_KEY]'], 1],
    });
  });

  // The tolerant decode pass exists to catch a credential hidden behind non-canonical
  // escapes. A percent run that is not valid UTF-8 is not one of those, and must be
  // handed back as written instead of throwing the whole response away.
  it('leaves a percent run it cannot decode untouched', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ blob: 'raw%c3%28bytes' }) };
      },
    });
    await expect(connector.execute(request())).resolves.toEqual({
      status: 200,
      body: { blob: 'raw%c3%28bytes' },
    });
  });

  // `x-api-key` takes the credential verbatim: a scheme prefix would be sent as part
  // of the key and the call would fail for a reason the agent cannot see.
  it('sends a scheme-less credential verbatim in the header the request named', async () => {
    let headers: Readonly<Record<string, string>> = {};
    const connector = createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('sk_test_marker'),
      transport: async (input) => {
        await input.authorizeRequest();
        headers = input.headers;
        return { status: 200, body: null };
      },
    });
    await expect(
      connector.execute(request({ auth: { header: 'x-api-key', scheme: null } })),
    ).resolves.toEqual({ status: 200, body: null });
    expect(headers['x-api-key']).toBe('sk_test_marker');
    expect(headers['authorization']).toBeUndefined();
  });

  it('keeps the merged GET module path as a compatibility implementation', async () => {
    const compatibility = await import('./restricted-http-get-connector.js');
    expect(compatibility.createRestrictedHttpGetConnector).toBeTypeOf('function');
  });
});

// The legacy GET adapter feeds server code that trusts what it gets back, so it
// keeps the narrow contract the brokered model tool deliberately does not: 2xx, a
// complete body, and a JSON object. Everything else is a rejection, not a result.
describe('restricted HTTP JSON connector trusted compatibility adapter', () => {
  const trusted = (result: {
    status: number;
    body: string | null;
    truncated?: boolean;
  }): ReturnType<typeof createRestrictedHttpJsonConnector> =>
    createRestrictedHttpJsonConnector({
      profile,
      resolveSecret: async () => Buffer.from('secret-marker'),
      returnTrustedResponseBody: true,
      transport: async (input) => {
        await input.authorizeRequest();
        return result;
      },
    });

  it.each([
    { name: 'a non-2xx status', result: { status: 404, body: '{"error":"missing"}' } },
    { name: 'a redirect', result: { status: 302, body: '{}' } },
    { name: 'a truncated body', result: { status: 200, body: '{"a":1}', truncated: true } },
    { name: 'a 204 that carries a body', result: { status: 204, body: '{"a":1}' } },
    { name: 'a body that is not JSON', result: { status: 200, body: 'plain text' } },
    { name: 'an empty body', result: { status: 200, body: null } },
    { name: 'a JSON scalar', result: { status: 200, body: '42' } },
    { name: 'JSON null', result: { status: 200, body: 'null' } },
  ])('refuses $name', async ({ result }) => {
    await expect(trusted(result).execute(request())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
  });

  it('maps an empty 204 to a null body', async () => {
    await expect(trusted({ status: 204, body: null }).execute(request())).resolves.toEqual({
      status: 204,
      body: null,
    });
  });

  // The adapter's own comment says "parsed JSON object", but the check it runs is
  // `typeof parsed !== 'object'`, which a top-level JSON array satisfies — so an array
  // crosses. Redaction is not what separates the two: this adapter returns the parsed
  // body as-is for an object too (`return { status, body: parsed }`), so an array is not
  // a distinct exposure path, only a shape the comment did not anticipate. This pins what
  // the adapter DOES rather than what the comment claims, so a change in either direction
  // is deliberate instead of silent drift. Whether a top-level array should be admitted at
  // all is a production question this tests-only change does not decide.
  it('admits a top-level JSON array, which its object check does not exclude', async () => {
    await expect(
      trusted({ status: 200, body: '[{"id":"item-1"}]' }).execute(request()),
    ).resolves.toEqual({ status: 200, body: [{ id: 'item-1' }] });
  });
});

// The alternative to this path is injecting the private key into the Sandbox so
// some CLI can sign there — which hands the agent the one credential brokerage
// exists to keep on the server.
describe('restricted HTTP JSON connector JWT auth', () => {
  const ec = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const ascProfile = restrictedHttpJsonProfileSchema.parse({
    id: 'asc',
    projectId: 'project-1',
    secretPolicy: {
      mode: 'allowlist',
      aliases: ['ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID'],
      destinations: [{ hostname: 'api.appstoreconnect.apple.com', pathPrefixes: ['/v1/apps'] }],
    },
  });
  const ascRequest = (auth: Record<string, unknown> = {}) => ({
    method: 'GET',
    url: 'https://api.appstoreconnect.apple.com/v1/apps',
    secretAlias: 'ASC_API_KEY_P8',
    auth: {
      kind: 'jwt',
      algorithm: 'ES256',
      keyId: { alias: 'ASC_API_KEY_ID' },
      issuer: { alias: 'ASC_API_ISSUER_ID' },
      audience: 'appstoreconnect-v1',
      ...auth,
    },
  });
  const ascSecrets: Record<string, string> = {
    ASC_API_KEY_P8: ec.privateKey,
    ASC_API_KEY_ID: 'ABCD1234',
    ASC_API_ISSUER_ID: '69a6de70-issuer',
  };

  it('signs the assertion server-side and sends only the bearer token', async () => {
    let authorization = '';
    const resolved: string[] = [];
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) => {
        resolved.push(alias);
        return Buffer.from(ascSecrets[alias]!);
      },
      transport: async (input) => {
        await input.authorizeRequest();
        authorization = input.headers['authorization'] ?? '';
        return { status: 200, body: JSON.stringify({ data: [] }) };
      },
    });
    await expect(connector.execute(ascRequest())).resolves.toEqual({
      status: 200,
      body: { data: [] },
    });
    // Every claim source is resolved server-side, signing key first.
    expect(resolved).toEqual(['ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID']);
    expect(authorization.startsWith('Bearer ')).toBe(true);
    const [header, payload, signature] = authorization.slice('Bearer '.length).split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'ABCD1234',
    });
    expect(
      JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { iss: string },
    ).toMatchObject({ iss: '69a6de70-issuer', aud: 'appstoreconnect-v1' });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header!}.${payload!}`, 'utf8'),
        { key: ec.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    // The private key never crosses back to the agent, and neither does the
    // assertion minted from it.
    expect(authorization).not.toContain('PRIVATE KEY');
  });

  it('redacts the minted assertion and every claim source from the response', async () => {
    let minted = '';
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) => Buffer.from(ascSecrets[alias]!),
      transport: async (input) => {
        await input.authorizeRequest();
        minted = (input.headers['authorization'] ?? '').slice('Bearer '.length);
        return {
          status: 401,
          body: JSON.stringify({
            echoedToken: minted,
            echoedKeyId: 'ABCD1234',
            echoedIssuer: '69a6de70-issuer',
          }),
        };
      },
    });
    // A non-2xx still comes back as a result so the agent can react (ADR 0011 D1).
    const result = await connector.execute(ascRequest());
    expect(result).toEqual({
      status: 401,
      body: {
        echoedToken: '[REDACTED:ASC_API_KEY_P8]',
        echoedKeyId: '[REDACTED:ASC_API_KEY_ID]',
        echoedIssuer: '[REDACTED:ASC_API_ISSUER_ID]',
      },
    });
    expect(JSON.stringify(result)).not.toContain(minted);
  });

  // Longest-first only protects a credential if every variant of every
  // credential competes in ONE ordering. Rank by raw length and expand each
  // credential's variants in turn, and a second credential's raw value can cut
  // through the middle of the first one's Base64 form, stranding the rest of it
  // in a body the agent then reads.
  it('orders redaction across the variants of all credentials, not per credential', async () => {
    // The issuer is short raw but long once Base64-encoded; the key id is longer
    // raw than the issuer and is deliberately a prefix of that Base64 form.
    const issuerValue = 'issuer-69a6de70-0000-1111-2222-3333444455556666777788';
    const issuerBase64 = Buffer.from(issuerValue, 'utf8').toString('base64');
    const keyIdValue = issuerBase64.slice(0, issuerValue.length + 10);
    expect(keyIdValue.length).toBeGreaterThan(issuerValue.length);
    expect(issuerBase64.length).toBeGreaterThan(keyIdValue.length);
    const secrets: Record<string, string> = {
      ASC_API_KEY_P8: ec.privateKey,
      ASC_API_KEY_ID: keyIdValue,
      ASC_API_ISSUER_ID: issuerValue,
    };
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) => Buffer.from(secrets[alias]!),
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify({ echoed: issuerBase64 }) };
      },
    });
    const result = await connector.execute(ascRequest());
    expect(result).toEqual({ status: 200, body: { echoed: '[REDACTED:ASC_API_ISSUER_ID]' } });
    // The tail is what a per-credential pass leaves behind.
    expect(JSON.stringify(result)).not.toContain(issuerBase64.slice(keyIdValue.length));
  });

  it('refuses claim aliases the profile never allowed', async () => {
    const resolveSecret = vi.fn();
    const connector = createRestrictedHttpJsonConnector({
      profile: restrictedHttpJsonProfileSchema.parse({
        id: 'asc-key-only',
        projectId: 'project-1',
        // The signing key is allowed; the issuer alias is not.
        secretPolicy: {
          mode: 'allowlist',
          aliases: ['ASC_API_KEY_P8'],
          destinations: [{ hostname: 'api.appstoreconnect.apple.com', pathPrefixes: ['/v1/apps'] }],
        },
      }),
      resolveSecret,
      transport: vi.fn(),
    });
    await expect(connector.execute(ascRequest())).rejects.toBeInstanceOf(
      RestrictedHttpJsonRejectedError,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  // Two requests differing only in their claims are different credentials. If the
  // fence hashed the signing alias alone, an approval for one would spend on the
  // other.
  it('binds the approval fence to the claims, not just the signing key', async () => {
    const hashes: string[] = [];
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) => Buffer.from(ascSecrets[alias]!),
      consumeApproval: (hash) => {
        hashes.push(hash);
        return true;
      },
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: null };
      },
    });
    await connector.execute(ascRequest());
    await connector.execute(ascRequest({ audience: 'other-audience' }));
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('names a key that cannot produce the requested algorithm instead of masking it', async () => {
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) =>
        Buffer.from(alias === 'ASC_API_KEY_P8' ? 'sk_live_not_a_key' : ascSecrets[alias]!),
      transport: vi.fn(),
    });
    // ADR 0011 D5: a configuration fact the agent can act on must not come back
    // as a generic rejection.
    await expect(connector.execute(ascRequest())).rejects.toThrow(BrokeredJwtError);
  });

  // `sub` and `scope` are optional and a claim may be spelled out as a literal
  // instead of resolved from Doppler. A literal is not a credential, so it stays
  // readable in the response; an alias-resolved claim does not.
  it('signs literal claims, an optional subject and a scope without a key id', async () => {
    let authorization = '';
    const connector = createRestrictedHttpJsonConnector({
      profile: ascProfile,
      resolveSecret: async (alias) => Buffer.from(ascSecrets[alias]!),
      transport: async (input) => {
        await input.authorizeRequest();
        authorization = input.headers['authorization'] ?? '';
        return { status: 200, body: JSON.stringify({ echoedIssuer: 'issuer.example' }) };
      },
    });
    const result = await connector.execute({
      method: 'GET',
      url: 'https://api.appstoreconnect.apple.com/v1/apps',
      secretAlias: 'ASC_API_KEY_P8',
      auth: {
        kind: 'jwt',
        algorithm: 'ES256',
        issuer: { literal: 'issuer.example' },
        subject: { literal: 'subject-42' },
        audience: 'appstoreconnect-v1',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
      },
    });

    const [header, payload] = authorization.slice('Bearer '.length).split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      typ: 'JWT',
    });
    expect(
      JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>,
    ).toMatchObject({
      iss: 'issuer.example',
      sub: 'subject-42',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    expect(result).toEqual({ status: 200, body: { echoedIssuer: 'issuer.example' } });
  });

  it('refuses claim values that would not survive a JWT payload', async () => {
    const connector = (issuer: string) =>
      createRestrictedHttpJsonConnector({
        profile: ascProfile,
        resolveSecret: async (alias) =>
          Buffer.from(alias === 'ASC_API_ISSUER_ID' ? issuer : ascSecrets[alias]!),
        transport: vi.fn(),
      });
    for (const issuer of ['issuer\nx', 'i'.repeat(257)]) {
      await expect(connector(issuer).execute(ascRequest())).rejects.toBeInstanceOf(
        RestrictedHttpJsonRejectedError,
      );
    }
    // A PEM as a header value would be header injection under static auth; under
    // JWT auth it is the expected shape and must not be refused for its newlines.
    await expect(
      createRestrictedHttpJsonConnector({
        profile: ascProfile,
        resolveSecret: async (alias) => Buffer.from(ascSecrets[alias]!),
        transport: async (input) => {
          await input.authorizeRequest();
          return { status: 200, body: null };
        },
      }).execute(ascRequest()),
    ).resolves.toEqual({ status: 200, body: null });
  });
});

/**
 * The production HTTPS transport. Its refusals are the SSRF fence: no DNS answer,
 * no oversized body and no header-less response gets past it, and the at-most-once
 * approval is spent inside the socket's own lookup so a reused connection cannot
 * skip it.
 */
describe('node restricted HTTP JSON transport', () => {
  afterEach(() => {
    delete transportHooks.request;
    delete transportHooks.lookup;
  });

  class FakeClientRequest extends EventEmitter {
    written: Buffer[] = [];
    ended = false;
    write(chunk: Buffer): boolean {
      this.written.push(Buffer.from(chunk));
      return true;
    }
    end(): this {
      this.ended = true;
      return this;
    }
  }

  class FakeIncoming extends EventEmitter {
    destroyed = false;
    constructor(readonly statusCode: number | undefined) {
      super();
    }
    destroy(): void {
      this.destroyed = true;
    }
  }

  interface Exchange {
    options: RequestOptions;
    outgoing: FakeClientRequest;
    respond(status: number | undefined): FakeIncoming;
  }

  /** Installs the HTTPS hook and resolves with the exchange the transport opens. */
  function captureExchange(): Promise<Exchange> {
    return new Promise<Exchange>((resolve) => {
      transportHooks.request = (options, callback) => {
        const outgoing = new FakeClientRequest();
        resolve({
          options,
          outgoing,
          respond(status) {
            const incoming = new FakeIncoming(status);
            callback(incoming as unknown as IncomingMessage);
            return incoming;
          },
        });
        return outgoing as unknown as ClientRequest;
      };
    });
  }

  type LookupResult = { error: Error | null; addresses: unknown; family?: number };

  /** Drives the socket-level lookup the transport installs, exactly as Node would. */
  function runSocketLookup(exchange: Exchange, all: boolean): Promise<LookupResult> {
    const lookup = exchange.options.lookup as unknown as (
      hostname: string,
      options: { all: boolean },
      callback: (error: Error | null, addresses: unknown, family?: number) => void,
    ) => void;
    return new Promise<LookupResult>((resolve) => {
      lookup('resolved-by-the-socket.invalid', { all }, (error, addresses, family) =>
        resolve({ error, addresses, ...(family === undefined ? {} : { family }) }),
      );
    });
  }

  function start(
    transport: ReturnType<typeof createNodeRestrictedHttpJsonTransport>,
    overrides: Partial<Parameters<RestrictedHttpJsonTransport>[0]> = {},
  ) {
    const authorizeRequest = vi.fn(async () => undefined);
    const result = transport({
      hostname: 'api.example.com',
      method: 'GET',
      path: '/v1/read',
      headers: { accept: 'application/json' },
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
      authorizeRequest,
      ...overrides,
    });
    // Nothing here may reject before a test attaches its own expectation.
    result.catch(() => undefined);
    return { result, authorizeRequest };
  }

  it.each([
    { name: 'is not an address at all', address: 'api.example.com', family: 4 },
    { name: 'carries an IPv6 zone id', address: 'fe80::1%25eth0', family: 6 },
    { name: 'is an empty string', address: '', family: 4 },
  ])(
    'refuses a DNS answer that $name without spending the approval',
    async ({ address, family }) => {
      const transport = createNodeRestrictedHttpJsonTransport({
        lookup: vi.fn().mockResolvedValue([{ address, family }]),
      });
      const exchange = captureExchange();
      const { authorizeRequest } = start(transport);

      const outcome = await runSocketLookup(await exchange, true);
      expect(outcome.error).toBeInstanceOf(RestrictedHttpJsonRejectedError);
      expect(outcome.addresses).toBe('');
      expect(authorizeRequest).not.toHaveBeenCalled();
    },
  );

  // An empty answer set must not be read as "nothing forbidden was found".
  it('refuses an empty DNS answer set', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({
      lookup: vi.fn().mockResolvedValue([]),
    });
    const exchange = captureExchange();
    const { authorizeRequest } = start(transport);

    const outcome = await runSocketLookup(await exchange, true);
    expect(outcome.error).toBeInstanceOf(RestrictedHttpJsonRejectedError);
    expect(authorizeRequest).not.toHaveBeenCalled();
  });

  // The approval is spent between the answer being judged public and the socket
  // being handed an address — the narrowest window there is.
  it('hands the whole public answer set to the socket after spending the approval', async () => {
    const addresses = [
      { address: '2606:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ];
    const transport = createNodeRestrictedHttpJsonTransport({
      lookup: vi.fn().mockResolvedValue(addresses),
    });
    const exchange = captureExchange();
    const { authorizeRequest } = start(transport);

    const outcome = await runSocketLookup(await exchange, true);
    expect(outcome.error).toBeNull();
    expect(outcome.addresses).toEqual(addresses);
    expect(authorizeRequest).toHaveBeenCalledOnce();
  });

  it('selects the first answer when the socket asks for a single address', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({
      lookup: vi.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ]),
    });
    const exchange = captureExchange();
    start(transport);

    const outcome = await runSocketLookup(await exchange, false);
    expect(outcome).toEqual({ error: null, addresses: '93.184.216.34', family: 4 });
  });

  it('refuses to resolve an address when the approval fence declines', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({
      lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
    });
    const exchange = captureExchange();
    const authorizeRequest = vi.fn(() => Promise.reject(new Error('approval already spent')));
    const result = transport({
      hostname: 'api.example.com',
      method: 'GET',
      path: '/v1/read',
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
      authorizeRequest,
    });
    result.catch(() => undefined);

    const outcome = await runSocketLookup(await exchange, true);
    expect(outcome.error).toBeInstanceOf(RestrictedHttpJsonRejectedError);
    expect(outcome.addresses).toBe('');
  });

  // Without an injected resolver the transport uses the system one, and it must
  // narrow that answer to the two families it knows how to judge.
  it.each([
    { name: 'refuses', family: 0, expected: 'rejected' },
    { name: 'accepts', family: 4, expected: 'resolved' },
  ])('$name a system resolver answer of family $family', async ({ family, expected }) => {
    transportHooks.lookup = vi.fn(async () => [{ address: '93.184.216.34', family }]);
    const transport = createNodeRestrictedHttpJsonTransport();
    const exchange = captureExchange();
    start(transport);

    const outcome = await runSocketLookup(await exchange, true);
    if (expected === 'rejected') {
      expect(outcome.error).toBeInstanceOf(RestrictedHttpJsonRejectedError);
    } else {
      expect(outcome.error).toBeNull();
      expect(outcome.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    }
    expect(transportHooks.lookup).toHaveBeenCalledWith('api.example.com', {
      all: true,
      verbatim: true,
    });
  });

  it('refuses a response that arrived without a status', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    const incoming = (await exchange).respond(undefined);
    await expect(result).rejects.toBeInstanceOf(RestrictedHttpJsonRejectedError);
    expect(incoming.destroyed).toBe(true);
  });

  it('returns a null body for a response that carries none', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    (await exchange).respond(204).emit('end');
    await expect(result).resolves.toEqual({ status: 204, body: null });
  });

  it('returns the decoded body with the status the upstream sent', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    const incoming = (await exchange).respond(401);
    incoming.emit('data', Buffer.from('{"error":"un'));
    incoming.emit('data', Buffer.from('authorized"}'));
    incoming.emit('end');
    await expect(result).resolves.toEqual({ status: 401, body: '{"error":"unauthorized"}' });
  });

  // A body that is not UTF-8 is flagged, not guessed at: a lossy decode would put
  // replacement characters where an unreadable credential echo used to be.
  it('flags a body that is not valid UTF-8 instead of decoding it lossily', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    const incoming = (await exchange).respond(200);
    incoming.emit('data', Buffer.from([0xff, 0xfe, 0xfd]));
    incoming.emit('end');
    await expect(result).resolves.toEqual({ status: 200, body: null, undecodable: true });
  });

  // The cap is what bounds what the agent can be handed. It cuts at exactly the cap,
  // says so, and stops reading — a body that keeps arriving cannot push past it.
  it('cuts an oversized body at the cap, flags it, and stops reading', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport, { maxResponseBytes: 8 });

    const incoming = (await exchange).respond(200);
    incoming.emit('data', Buffer.from('12345'));
    incoming.emit('data', Buffer.from('6789abcdef'));
    incoming.emit('data', Buffer.from('never read'));
    incoming.emit('end');
    await expect(result).resolves.toEqual({ status: 200, body: '12345678', truncated: true });
    expect(incoming.destroyed).toBe(true);
  });

  it('refuses a response whose stream fails before it ends', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    const incoming = (await exchange).respond(200);
    incoming.emit('data', Buffer.from('{"partial":'));
    incoming.emit('error', new Error('socket hang up with secret in it'));
    await expect(result).rejects.toBeInstanceOf(RestrictedHttpJsonRejectedError);
  });

  it('refuses a request whose socket fails, without leaking the socket error', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const { result } = start(transport);

    (await exchange).outgoing.emit('error', new Error('ECONNREFUSED sk_live_marker'));
    await expect(result).rejects.toEqual(new RestrictedHttpJsonRejectedError());
  });

  // Pinned so a keep-alive socket cannot skip the guarded lookup, and therefore the
  // approval fence inside it.
  it('sends the body on a fresh, non-pooled connection to port 443', async () => {
    const transport = createNodeRestrictedHttpJsonTransport({ lookup: vi.fn() });
    const exchange = captureExchange();
    const body = Buffer.from('{"description":"Preview customer"}', 'utf8');
    const { result } = start(transport, { method: 'POST', path: '/v1/customers', body });

    const opened = await exchange;
    expect(opened.options).toMatchObject({
      protocol: 'https:',
      hostname: 'api.example.com',
      port: 443,
      method: 'POST',
      path: '/v1/customers',
      servername: 'api.example.com',
      agent: false,
    });
    expect(Buffer.concat(opened.outgoing.written).toString('utf8')).toBe(body.toString('utf8'));
    expect(opened.outgoing.ended).toBe(true);
    opened.respond(200).emit('end');
    await expect(result).resolves.toEqual({ status: 200, body: null });
  });
});
