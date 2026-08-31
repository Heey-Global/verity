import type {
  ProviderBindingRecord,
  RunGrantClaims,
  SecretAliasRecord,
} from '@verity/secret-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createDopplerSecretNameLister,
  createDopplerSecretResolver,
  DopplerSecretResolutionError,
  listDopplerProjectSecretNames,
  resolveDopplerProjectSecret,
} from './doppler-secret-resolver.js';
import type { HttpFetch, HttpResponse } from './github.js';

const HASH = 'a'.repeat(64);
const TOKEN = 'dp.st.test.token-fixture';
const SECRET = 'provider-secret-fixture';
const claims: RunGrantClaims = {
  protocolVersion: 1,
  grantId: 'grant-1',
  requestHash: HASH,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  profile: { id: 'profile-1', version: 1, policyHash: HASH },
  aliases: [{ id: 'api-token', version: 1 }],
  providerBindings: [{ id: 'doppler-binding', version: 1, provider: 'doppler' }],
  audience: 'verity-secret-job-executor',
  issuedAt: '2026-07-23T00:00:00.000Z',
  expiresAt: '2026-07-23T00:10:00.000Z',
  nonce: 'bm9uY2UtZml4dHVyZS0xMjM0NTY3ODkw',
};
const alias: SecretAliasRecord = {
  id: 'api-token',
  projectId: claims.projectId,
  version: 1,
  name: 'api-token',
  description: 'Restricted API token.',
  binding: claims.providerBindings[0]!,
  providerKey: 'UPSTREAM_API_TOKEN',
  injection: { kind: 'env', target: 'API_TOKEN' },
  profile: claims.profile,
  state: 'active',
};
const binding: ProviderBindingRecord = {
  id: 'doppler-binding',
  projectId: claims.projectId,
  version: 1,
  provider: 'doppler',
  credentialRef: 'secretref:projects/project-1/doppler',
  dopplerProject: 'upstream-project',
  dopplerConfig: 'production',
  state: 'active',
};

function response(body: unknown, status = 200): HttpResponse {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(raw),
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' ? String(raw.length) : null),
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(raw));
        controller.close();
      },
    }),
  };
}

function setup(overrides?: {
  alias?: SecretAliasRecord | undefined;
  binding?: ProviderBindingRecord | undefined;
  credential?: Uint8Array | undefined;
  fetch?: HttpFetch;
}) {
  const credential =
    overrides && 'credential' in overrides ? overrides.credential : Buffer.from(TOKEN, 'utf8');
  const fetch =
    overrides?.fetch ??
    vi.fn<HttpFetch>(() =>
      Promise.resolve(response({ UPSTREAM_API_TOKEN: SECRET, UNRELATED: 'must-not-return' })),
    );
  const resolver = createDopplerSecretResolver({
    catalog: {
      resolveAlias: () =>
        Promise.resolve(overrides && 'alias' in overrides ? overrides.alias : alias),
      resolveBinding: () =>
        Promise.resolve(overrides && 'binding' in overrides ? overrides.binding : binding),
    },
    readCredential: () => Promise.resolve(credential),
    fetch,
  });
  return { resolver, fetch, credential };
}

describe('Doppler Secret Resolver', () => {
  // `names` is the field the provider actually sends. Asserting it here is the
  // whole point of this test: the previous fixture used `secrets`, so the parser
  // and the mock agreed with each other and disagreed with Doppler, and the
  // resulting empty list is indistinguishable from "this project has no secrets".
  it('lists only dynamic secret names through Doppler names endpoint', async () => {
    const credential = Buffer.from(TOKEN);
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve(response({ names: ['GITHUB_TOKEN', 'DATABASE_URL', 'GITHUB_TOKEN'] })),
    );
    const listNames = createDopplerSecretNameLister({
      readCredential: () => Promise.resolve(credential),
      fetch,
    });
    await expect(listNames(binding)).resolves.toEqual(['DATABASE_URL', 'GITHUB_TOKEN']);
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain('/v3/configs/config/secrets/names?');
    expect(url).toContain('include_dynamic_secrets=false');
    expect([...credential]).toEqual(new Array(credential.length).fill(0));
  });

  // The lister the live feature calls (project-settings `DOPPLER_TOKEN` → the alias
  // names in the turn prompt, ADR 0011 D3). It had no test at all, which is how a
  // parser that never matched a real response reached production.
  describe('listDopplerProjectSecretNames', () => {
    const projectBinding = { dopplerProject: 'pulseci', dopplerConfig: 'dev' };

    it('reads the `names` field Doppler sends, deduped and sorted', async () => {
      const token = Buffer.from(TOKEN);
      const fetch = vi.fn<HttpFetch>(() =>
        Promise.resolve(response({ names: ['TS_AUTHKEY', 'ASC_API_KEY', 'TS_AUTHKEY'] })),
      );
      await expect(
        listDopplerProjectSecretNames({ ...projectBinding, token, fetch }),
      ).resolves.toEqual(['ASC_API_KEY', 'TS_AUTHKEY']);
      const [url] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toContain('/v3/configs/config/secrets/names?');
      expect(url).toContain('project=pulseci');
      expect(url).toContain('config=dev');
      // The credential is zeroed even on the success path.
      expect([...token]).toEqual(new Array(token.length).fill(0));
    });

    // Every one of these bodies must FAIL rather than resolve to `[]`: the caller
    // degrades a rejection to "no list", so a parser that quietly accepts an
    // unrecognized shape reproduces the original bug in a new spelling. `secrets`
    // is here because it is the shape the parser used to expect — the one that
    // agreed with the old fixture and with nothing Doppler sends.
    it.each([
      ['an unrecognized object', { success: true }],
      ['the shape the parser used to expect', { secrets: ['ASC_API_KEY'] }],
      ['a bare array', ['ASC_API_KEY']],
      ['a name that is not a valid Doppler key', { names: ['ASC_API_KEY', 'not a key'] }],
    ])('rejects %s rather than reporting an empty project', async (_label, body) => {
      const token = Buffer.from(TOKEN);
      const fetch = vi.fn<HttpFetch>(() => Promise.resolve(response(body)));
      await expect(
        listDopplerProjectSecretNames({ ...projectBinding, token, fetch }),
      ).rejects.toBeInstanceOf(DopplerSecretResolutionError);
      // Zeroing on the failure path is the harder half to get right, and a token
      // left in a Buffer after a rejected request is the exposure that matters.
      expect([...token]).toEqual(new Array(token.length).fill(0));
    });
  });

  it('rejects invalid provider configuration at startup', () => {
    const common = {
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
    };
    expect(() => createDopplerSecretResolver({ ...common, timeoutMs: 0 })).toThrow(
      /integer from 1/,
    );
    expect(() => createDopplerSecretResolver({ ...common, timeoutMs: 2 ** 32 })).toThrow(
      /integer from 1/,
    );
    expect(() =>
      createDopplerSecretResolver({ ...common, apiOrigin: 'https://doppler.example.test' }),
    ).toThrow(/must be https:\/\/api\.doppler\.com/);
    expect(() =>
      createDopplerSecretNameLister({
        readCredential: common.readCredential,
        apiOrigin: 'https://doppler.example.test',
      }),
    ).toThrow(/must be https:\/\/api\.doppler\.com/);
    expect(() =>
      createDopplerSecretNameLister({ readCredential: common.readCredential, timeoutMs: 0 }),
    ).toThrow(/integer from 1/);
    expect(() =>
      createDopplerSecretNameLister({
        readCredential: common.readCredential,
        maxResponseBytes: 0,
      }),
    ).toThrow(/positive integer/);
  });

  it('downloads only approved provider keys and maps them to injection targets', async () => {
    const { resolver, fetch, credential } = setup();
    const values = await resolver(claims);

    expect(Buffer.from(values.get('API_TOKEN')!).toString('utf8')).toBe(SECRET);
    expect(values.has('UNRELATED')).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe('https://api.doppler.com');
    expect(url).toContain('/v3/configs/config/secrets/download?');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('project')).toBe(binding.dopplerProject);
    expect(parsed.searchParams.get('config')).toBe(binding.dopplerConfig);
    expect(parsed.searchParams.get('secrets')).toBe(alias.providerKey);
    expect(init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect([...credential!]).toEqual(new Array(credential!.length).fill(0));
    expect(JSON.stringify(values)).not.toContain(TOKEN);
  });

  it('downloads multiple distinct secrets in one request', async () => {
    const secondAlias: SecretAliasRecord = {
      ...alias,
      id: 'second-token',
      providerKey: 'SECOND_API_TOKEN',
      injection: { kind: 'env', target: 'SECOND_API_TOKEN' },
    };
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve(response({ UPSTREAM_API_TOKEN: SECRET, SECOND_API_TOKEN: 'second-value' })),
    );
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: (ref) => Promise.resolve(ref.id === alias.id ? alias : secondAlias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
    });
    const values = await resolver({
      ...claims,
      aliases: [...claims.aliases, { id: secondAlias.id, version: 1 }],
    });
    expect(Buffer.from(values.get('API_TOKEN')!).toString()).toBe(SECRET);
    expect(Buffer.from(values.get('SECOND_API_TOKEN')!).toString()).toBe('second-value');
    expect(new URL(vi.mocked(fetch).mock.calls[0]![0]).searchParams.get('secrets')).toBe(
      'SECOND_API_TOKEN,UPSTREAM_API_TOKEN',
    );
    values.dispose?.();
  });

  it('retries only network, 429, and 5xx failures', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = vi
      .fn<HttpFetch>()
      .mockRejectedValueOnce(new Error(`network ${TOKEN}`))
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response({ UPSTREAM_API_TOKEN: SECRET }));
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      sleep,
    });
    await expect(resolver(claims)).resolves.toBeInstanceOf(Map);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    for (const status of [400, 401, 403, 404]) {
      const noRetryFetch = vi.fn<HttpFetch>(() => Promise.resolve(response({}, status)));
      const noRetry = createDopplerSecretResolver({
        catalog: {
          resolveAlias: () => Promise.resolve(alias),
          resolveBinding: () => Promise.resolve(binding),
        },
        readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
        fetch: noRetryFetch,
        sleep,
      });
      await expect(noRetry(claims)).rejects.toBeInstanceOf(DopplerSecretResolutionError);
      expect(noRetryFetch).toHaveBeenCalledOnce();
    }
  });

  it('isolates parallel requests and their owned credentials', async () => {
    const credentials = [Buffer.from(TOKEN), Buffer.from(TOKEN)];
    let read = 0;
    const fetch = vi.fn<HttpFetch>(async () => {
      await Promise.resolve();
      return response({ UPSTREAM_API_TOKEN: SECRET });
    });
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(credentials[read++]!),
      fetch,
    });
    const [first, second] = await Promise.all([resolver(claims), resolver(claims)]);
    expect(first.get('API_TOKEN')).not.toBe(second.get('API_TOKEN'));
    expect(credentials.every((credential) => credential.every((byte) => byte === 0))).toBe(true);
    first.dispose?.();
    second.dispose?.();
  });

  it('retries connection timeouts before returning the timeout phase', async () => {
    const fetch = vi.fn<HttpFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          });
        }),
    );
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      timeoutMs: 1,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    await expect(resolver(claims)).rejects.toMatchObject({
      phase: 'Doppler request timeout',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('enforces its deadline when the HTTP adapter ignores AbortSignal', async () => {
    const fetch = vi.fn<HttpFetch>(() => new Promise(() => undefined));
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      timeoutMs: 1,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    await expect(resolver(claims)).rejects.toMatchObject({
      phase: 'Doppler request timeout',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('enforces its deadline when a response body never produces bytes', async () => {
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ...response({}),
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }),
      }),
    );
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      timeoutMs: 1,
      maxAttempts: 1,
    });
    await expect(resolver(claims)).rejects.toMatchObject({
      phase: 'Doppler request timeout',
    });
  });

  it('retries a transient response-body failure after headers', async () => {
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"UPSTREAM_API_TOKEN":"partial'));
        controller.error(new Error('connection reset'));
      },
    });
    const fetch = vi
      .fn<HttpFetch>()
      .mockResolvedValueOnce({
        ...response({}),
        headers: { get: () => null },
        body: brokenBody,
      })
      .mockResolvedValueOnce(response({ UPSTREAM_API_TOKEN: SECRET }));
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      retryDelayMs: 0,
    });
    const values = await resolver(claims);
    expect(Buffer.from(values.get('API_TOKEN')!).toString()).toBe(SECRET);
    expect(fetch).toHaveBeenCalledTimes(2);
    values.dispose?.();
  });

  it.each([
    ['missing alias', { alias: undefined }],
    ['disabled alias', { alias: { ...alias, state: 'disabled' as const } }],
    ['cross-project alias', { alias: { ...alias, projectId: 'other-project' } }],
    ['wrong profile', { alias: { ...alias, profile: { ...alias.profile, version: 2 } } }],
    ['unapproved binding', { alias: { ...alias, binding: { ...alias.binding, version: 2 } } }],
    ['ambiguous provider key', { alias: { ...alias, providerKey: 'TOKEN,UNAPPROVED' } }],
    ['lowercase provider key', { alias: { ...alias, providerKey: 'upstream_token' } }],
    ['non-env injection', { alias: { ...alias, injection: { kind: 'stdin' as const } } }],
    ['missing binding', { binding: undefined }],
    ['disabled binding', { binding: { ...binding, state: 'disabled' as const } }],
    ['cross-project binding', { binding: { ...binding, projectId: 'other-project' } }],
    ['missing credential', { credential: undefined }],
  ])('fails closed with one redacted error for %s', async (_name, overrides) => {
    const { resolver } = setup(overrides);
    await expect(resolver(claims)).rejects.toMatchObject({
      phase: expect.stringMatching(/project configuration|secret alias|Doppler authentication/u),
    });
  });

  it.each([
    [
      'authentication failure',
      () => Promise.resolve(response({ token: TOKEN }, 401)),
      'Doppler authentication',
      401,
    ],
    [
      'provider failure',
      () => Promise.resolve(response({ secret: SECRET }, 500)),
      'Doppler response status',
      500,
    ],
    [
      'transport failure',
      () => Promise.reject(new Error(`network ${TOKEN} ${SECRET}`)),
      'Doppler request start',
      undefined,
    ],
    [
      'malformed body',
      () => Promise.resolve(response({ UPSTREAM_API_TOKEN: 42 })),
      'Doppler response format',
      undefined,
    ],
  ])('does not leak provider context on %s', async (_name, fetchImpl, phase, httpStatus) => {
    const { resolver } = setup({ fetch: vi.fn(fetchImpl) });
    let thrown: unknown;
    try {
      await resolver(claims);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DopplerSecretResolutionError);
    expect(thrown).toMatchObject({ phase, httpStatus });
    expect(String(thrown)).toContain('No secret value was exposed.');
    expect(String(thrown)).not.toContain(TOKEN);
    expect(String(thrown)).not.toContain(SECRET);
    expect(String(thrown)).not.toContain(alias.providerKey);
  });

  it('rejects duplicate injection targets before contacting Doppler', async () => {
    const duplicateClaims: RunGrantClaims = {
      ...claims,
      aliases: [...claims.aliases, { id: 'second-token', version: 1 }],
    };
    const { resolver, fetch } = setup();
    const custom = createDopplerSecretResolver({
      catalog: {
        resolveAlias: (ref) =>
          Promise.resolve(ref.id === alias.id ? alias : { ...alias, id: ref.id }),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
    });
    await expect(custom(duplicateClaims)).rejects.toThrow(/Secret resolution failed during/u);
    expect(fetch).not.toHaveBeenCalled();
    void resolver;
  });

  it('downloads a shared provider key once and maps it to both approved targets', async () => {
    const secondAlias: SecretAliasRecord = {
      ...alias,
      id: 'second-token',
      injection: { kind: 'env', target: 'SECOND_API_TOKEN' },
    };
    const sharedClaims: RunGrantClaims = {
      ...claims,
      aliases: [claims.aliases[0]!, { id: secondAlias.id, version: 1 }],
    };
    const fetch = vi.fn<HttpFetch>(() => Promise.resolve(response({ UPSTREAM_API_TOKEN: SECRET })));
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: (ref) => Promise.resolve(ref.id === alias.id ? alias : secondAlias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
    });

    const values = await resolver(sharedClaims);
    expect(Buffer.from(values.get('API_TOKEN')!).toString()).toBe(SECRET);
    expect(Buffer.from(values.get('SECOND_API_TOKEN')!).toString()).toBe(SECRET);
    expect(values.get('API_TOKEN')).toBe(values.get('SECOND_API_TOKEN'));
    const requested = new URL(vi.mocked(fetch).mock.calls[0]![0]).searchParams.get('secrets');
    expect(requested).toBe('UPSTREAM_API_TOKEN');
    for (const value of values.values()) value.fill(0);
  });

  it('rejects oversized responses without parsing provider values', async () => {
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ...response({ UPSTREAM_API_TOKEN: SECRET }),
        headers: { get: () => String(2_000_000) },
      }),
    );
    const { resolver } = setup({ fetch });
    await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
  });

  it.each(['-1', '1.5', 'not-a-number', '9007199254740992'])(
    'rejects malformed Content-Length %s',
    async (declared) => {
      const fetch = vi.fn<HttpFetch>(() =>
        Promise.resolve({
          ...response({ UPSTREAM_API_TOKEN: SECRET }),
          headers: {
            get: (name) => (name.toLowerCase() === 'content-length' ? declared : null),
          },
        }),
      );
      const { resolver } = setup({ fetch });
      await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
    },
  );

  it('rejects malformed UTF-8 in the provider response', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]));
        controller.close();
      },
    });
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        headers: { get: () => null },
        body,
      }),
    );
    const { resolver } = setup({ fetch });
    await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
  });

  it('stops an oversized streamed body without relying on Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(8, 0x61));
        controller.enqueue(Buffer.alloc(8, 0x62));
        controller.close();
      },
    });
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        headers: { get: () => null },
        body,
      }),
    );
    const limited = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      maxResponseBytes: 10,
    });
    await expect(limited(claims)).rejects.toThrow(/Secret resolution failed during/u);
  });

  it('times out a provider stream that never closes', async () => {
    const fetch = vi.fn<HttpFetch>((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('{"UPSTREAM_API_TOKEN":"partial'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new Error('request aborted')),
            { once: true },
          );
        },
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        headers: { get: () => null },
        body,
      });
    });
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: () => Promise.resolve(alias),
        resolveBinding: () => Promise.resolve(binding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
      timeoutMs: 10,
    });
    await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
  });

  it('rejects a non-streaming adapter without a declared body size before reading', async () => {
    const text = vi.fn(() => Promise.resolve(JSON.stringify({ UPSTREAM_API_TOKEN: SECRET })));
    const fetch = vi.fn<HttpFetch>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text,
        headers: { get: () => null },
      }),
    );
    const { resolver } = setup({ fetch });
    await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
    expect(text).not.toHaveBeenCalled();
  });

  it('zeroizes an invalid credential before any provider request', async () => {
    const credential = Buffer.from('   ', 'utf8');
    const { resolver, fetch } = setup({ credential });
    await expect(resolver(claims)).rejects.toThrow(/Secret resolution failed during/u);
    expect([...credential]).toEqual(new Array(credential.length).fill(0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('zeroizes secrets accumulated before a later binding fails', async () => {
    const secondBinding: ProviderBindingRecord = {
      ...binding,
      id: 'doppler-binding-2',
      credentialRef: 'secretref:projects/project-1/doppler-2',
    };
    const secondAlias: SecretAliasRecord = {
      ...alias,
      id: 'second-token',
      binding: { id: secondBinding.id, version: 1, provider: 'doppler' },
      providerKey: 'SECOND_TOKEN',
      injection: { kind: 'env', target: 'SECOND_TOKEN' },
    };
    const multiClaims: RunGrantClaims = {
      ...claims,
      aliases: [claims.aliases[0]!, { id: secondAlias.id, version: 1 }],
      providerBindings: [claims.providerBindings[0]!, secondAlias.binding],
    };
    const firstSecret = 'first-binding-secret';
    const originalFrom = Buffer.from.bind(Buffer);
    let captured: Buffer | undefined;
    const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((
      value: Parameters<typeof Buffer.from>[0],
      ...args: unknown[]
    ) => {
      const result = Reflect.apply(originalFrom, Buffer, [value, ...args]) as Buffer;
      if (value === firstSecret) captured = result;
      return result;
    }) as typeof Buffer.from);
    const fetch = vi
      .fn<HttpFetch>()
      .mockResolvedValueOnce(response({ UPSTREAM_API_TOKEN: firstSecret }))
      .mockResolvedValueOnce(response({}, 503));
    const resolver = createDopplerSecretResolver({
      catalog: {
        resolveAlias: (ref) => Promise.resolve(ref.id === alias.id ? alias : secondAlias),
        resolveBinding: (ref) => Promise.resolve(ref.id === binding.id ? binding : secondBinding),
      },
      readCredential: () => Promise.resolve(Buffer.from(TOKEN)),
      fetch,
    });
    try {
      await expect(resolver(multiClaims)).rejects.toThrow(/Secret resolution failed during/u);
      expect(captured).toBeDefined();
      expect([...captured!]).toEqual(new Array(captured!.length).fill(0));
    } finally {
      fromSpy.mockRestore();
    }
  });
});

describe('resolveDopplerProjectSecret', () => {
  const options = (fetch: HttpFetch, secretName: string) => ({
    projectId: 'project-1',
    dopplerProject: 'heey-cluster',
    dopplerConfig: 'prd',
    token: Buffer.from('dp.st.token'),
    secretName,
    fetch,
  });

  it('returns the value when the config holds the name', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ KUBECONFIG: 'value' })));
    await expect(
      resolveDopplerProjectSecret(options(fetch as unknown as HttpFetch, 'KUBECONFIG')),
    ).resolves.toEqual(Buffer.from('value'));
  });

  // Telling a typo apart from a revoked token used to be impossible: both came
  // back as the same opaque sentence. The name came from the caller, so naming
  // it back leaks nothing.
  it('names the missing secret instead of failing opaquely', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ KUBECONFIG: 'value' })));
    await expect(
      resolveDopplerProjectSecret(options(fetch as unknown as HttpFetch, 'KUBECONFIG_B64')),
    ).rejects.toThrow(/no secret named KUBECONFIG_B64 is available/u);
  });

  it('still fails opaquely when the provider itself refuses', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ error: 'nope' }, 401)));
    await expect(
      resolveDopplerProjectSecret(options(fetch as unknown as HttpFetch, 'KUBECONFIG')),
    ).rejects.toThrow(/Doppler authentication \(HTTP 401\).*No secret value was exposed/u);
  });
});
