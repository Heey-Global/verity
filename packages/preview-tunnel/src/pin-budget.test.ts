import { scrypt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewPinBudget } from './pin-budget.js';
import { PreviewEdge, hashPreviewPin, hashPreviewSecret } from './index.js';
import type { PreviewEdgeOptions } from './index.js';
import type { PreviewPinBudget, PinBudgetResult } from './pin-budget.js';

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(scrypt).mockClear();
  for (const close of cleanup.splice(0)) await close();
});

async function edgeWith(budget: PreviewPinBudget, options: Partial<PreviewEdgeOptions> = {}) {
  const edge = new PreviewEdge({
    shareId: 'share-budget',
    pinHash: hashPreviewPin('123456'),
    connectorTokenHash: hashPreviewSecret('connector-secret'),
    sessionSecretHash: hashPreviewSecret('session-secret'),
    publicOrigin: 'https://budget.preview.test',
    pinBudget: budget,
    ...options,
  });
  const port = await edge.listen();
  cleanup.push(() => edge.close());
  return `http://127.0.0.1:${port}`;
}

function login(origin: string, get: boolean, pin = '123456', headers: Record<string, string> = {}) {
  return fetch(get ? `${origin}/?pin=${pin}` : `${origin}/__verity/login`, {
    method: get ? 'GET' : 'POST',
    redirect: 'manual',
    headers,
    ...(get
      ? {}
      : {
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body: new URLSearchParams({ pin }),
        }),
  });
}

it.each([false, true])('requires durable finish before issuing a cookie (GET=%s)', async (get) => {
  const begin = vi.fn(async () => ({ state: 'allowed' as const, attemptId: 'reservation' }));
  const finish = vi.fn(async (): Promise<PinBudgetResult> => ({ state: 'unavailable' }));
  const origin = await edgeWith({ begin, finish });
  const refused = await login(origin, get);
  expect(refused.status).toBe(503);
  expect(refused.headers.get('set-cookie')).toBeNull();
  expect(finish).toHaveBeenCalledWith('reservation', true);
  finish.mockResolvedValue({ state: 'allowed' });
  const accepted = await login(origin, get);
  expect(accepted.status).toBe(303);
  expect(accepted.headers.get('set-cookie')).toBeTruthy();
});

it.each([false, true])('books failed PINs durably (GET=%s)', async (get) => {
  const finish = vi.fn(async (): Promise<PinBudgetResult> => ({ state: 'allowed' }));
  const origin = await edgeWith({
    begin: async () => ({ state: 'allowed', attemptId: 'wrong' }),
    finish,
  });
  expect((await login(origin, get, '000000')).status).toBe(401);
  expect(finish).toHaveBeenCalledWith('wrong', false);
});

it.each([
  [{ state: 'locked' }, 403],
  [{ state: 'cooldown', retryAfterSeconds: 120 }, 429],
  [{ state: 'unavailable' }, 503],
] as const)('blocks PIN checks when budget is %s', async (result, status) => {
  const finish = vi.fn(async (): Promise<PinBudgetResult> => ({ state: 'allowed' }));
  const origin = await edgeWith({ begin: async () => result, finish });
  const response = await login(origin, true);
  expect(response.status).toBe(status);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(finish).not.toHaveBeenCalled();
  if (result.state === 'cooldown') {
    expect(response.headers.get('retry-after')).toBe('120');
    expect(await response.text()).toContain('120 seconds');
  }
});

it('does not apply a new PIN lock to existing authenticated visitors', async () => {
  const begin = vi.fn(
    async (): Promise<PinBudgetResult | { state: 'allowed'; attemptId: string }> => ({
      state: 'allowed',
      attemptId: 'ok',
    }),
  );
  const origin = await edgeWith({ begin, finish: async () => ({ state: 'allowed' }) });
  const response = await login(origin, false);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  begin.mockResolvedValue({ state: 'locked' });
  const existing = await fetch(`${origin}/?pin=000000`, {
    redirect: 'manual',
    headers: { cookie },
  });
  // Without a connector this reaches the unavailable-preview page, not PIN lockout.
  expect(existing.status).toBe(503);
  expect(begin).toHaveBeenCalledTimes(1);
});

it('authenticates budget requests and never sends the PIN', async () => {
  const mock = vi.fn(
    async () => new Response(JSON.stringify({ state: 'allowed', attemptId: 'a' })),
  );
  vi.stubGlobal('fetch', mock);
  const budget = createPreviewPinBudget('http://uplink:8080', 'a'.repeat(43), 'share/id');
  expect(await budget.begin()).toEqual({ state: 'allowed', attemptId: 'a' });
  expect(await budget.finish('a', true)).toEqual({ state: 'allowed' });
  expect(mock.mock.calls[0]).toEqual([
    'http://uplink:8080/internal/preview-pin/share%2Fid/begin',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${'a'.repeat(43)}` }),
      body: '{}',
      redirect: 'error',
    }),
  ]);
  expect(mock.mock.calls[1]).toEqual([
    expect.stringContaining('/finish'),
    expect.objectContaining({ body: JSON.stringify({ attemptId: 'a', valid: true }) }),
  ]);
});

it.each([
  { state: 'allowed' },
  { state: 'cooldown', retryAfterSeconds: -1 },
  { state: 'unexpected' },
])('fails closed for malformed budget responses %s', async (body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
  expect(await createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id').begin()).toEqual({
    state: 'unavailable',
  });
});

it('cancels unread error bodies before releasing the PIN verification slot', async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 })),
  );
  const budget = createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect(await budget.begin()).toEqual({ state: 'unavailable' });
    expect(cancel).toHaveBeenCalledTimes(attempt + 1);
  }
});

it('fails closed on transport failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  expect(await createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id').begin()).toEqual({
    state: 'unavailable',
  });
});

it('fails closed on HTTP errors and oversized replies', async () => {
  const mock = vi.fn(
    async () => new Response('{"state":"allowed","attemptId":"a"}', { status: 500 }),
  );
  vi.stubGlobal('fetch', mock);
  const budget = createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id');
  expect(await budget.begin()).toEqual({ state: 'unavailable' });
  mock.mockResolvedValue(new Response(' '.repeat(8193)));
  expect(await budget.begin()).toEqual({ state: 'unavailable' });
});

it('fails closed when the response body cannot finish before the request deadline', async () => {
  const abort = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      options.signal?.throwIfAborted();
      return new Response('{}');
    }),
  );
  try {
    expect(await createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id').begin()).toEqual({
      state: 'unavailable',
    });
    expect(abort).toHaveBeenCalledWith(5000);
  } finally {
    abort.mockRestore();
  }
});

it.each(['begin', 'finish'] as const)('fails closed when %s throws', async (operation) => {
  const origin = await edgeWith({
    begin: async () => {
      if (operation === 'begin') throw new Error('unavailable');
      return { state: 'allowed', attemptId: 'a' };
    },
    finish: async () => {
      throw new Error('unavailable');
    },
  });
  const response = await login(origin, false);
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
});

it.each([201, 202, 204, 206, 301, 400, 401, 403, 429, 500, 503])(
  'refuses HTTP %s even with an allowed payload',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            status === 204 ? null : JSON.stringify({ state: 'allowed', attemptId: 'a' }),
            { status },
          ),
      ),
    );
    const budget = createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id');
    expect(await budget.begin()).toEqual({ state: 'unavailable' });
    expect(await budget.finish('a', true)).toEqual({ state: 'unavailable' });
  },
);

it.each([
  'not a URL',
  'ftp://uplink',
  'http://user@uplink',
  'http://uplink/path',
  'http://uplink?x=1',
  'http://uplink/#x',
])('rejects malformed budget origin %s', (url) => {
  expect(() => createPreviewPinBudget(url, 'a'.repeat(43), 'id')).toThrow();
});
it.each(['', 'a'.repeat(42), 'a'.repeat(44), '+'.repeat(43)])(
  'rejects malformed token %s',
  (token) => {
    expect(() => createPreviewPinBudget('http://uplink', token, 'id')).toThrow();
  },
);

it.each([false, true])(
  'waits for begin before scrypt and finishes after it (GET=%s)',
  async (get) => {
    let allow!: (value: { state: 'allowed'; attemptId: string }) => void;
    let begun!: () => void;
    const reached = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const begin = vi.fn(() => {
      begun();
      return new Promise<{ state: 'allowed'; attemptId: string }>((resolve) => {
        allow = resolve;
      });
    });
    const finish = vi.fn(async (): Promise<PinBudgetResult> => ({ state: 'allowed' }));
    const origin = await edgeWith({ begin, finish });
    const pending = login(origin, get);
    await reached;
    try {
      expect(scrypt).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
    } finally {
      allow({ state: 'allowed', attemptId: 'ordered' });
      await pending;
    }
    expect((await pending).status).toBe(303);
    expect(vi.mocked(scrypt).mock.invocationCallOrder[0]).toBeGreaterThan(
      begin.mock.invocationCallOrder[0]!,
    );
    expect(finish.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(scrypt).mock.invocationCallOrder[0]!,
    );
  },
);

it.each([false, true])(
  'enforces escalating pauses before begin and resets after an idle hour (GET=%s)',
  async (get) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const begin = vi.fn(async () => ({ state: 'allowed' as const, attemptId: 'a' }));
    const origin = await edgeWith({ begin, finish: async () => ({ state: 'allowed' }) });
    let checks = 0;
    for (const seconds of [60, 120, 240, 480, 960, 1920, 3600]) {
      for (let i = 0; i < 3; i++) {
        expect((await login(origin, get, '000000')).status).toBe(401);
        checks++;
      }
      const refused = await login(origin, get);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('set-cookie')).toBeNull();
      expect(refused.headers.get('retry-after')).toBe(String(seconds));
      expect(await refused.text()).toContain(`${seconds} seconds`);
      expect(begin).toHaveBeenCalledTimes(checks);
      now += seconds * 1000 - 1;
      expect((await login(origin, get)).headers.get('retry-after')).toBe('1');
      now += 1;
    }
    now += 3_600_000;
    for (let i = 0; i < 3; i++) expect((await login(origin, get, '000000')).status).toBe(401);
    expect((await login(origin, get)).headers.get('retry-after')).toBe('60');
  },
);

it('counts wrong PINs when finish fails and does not erase failures on success', async () => {
  const finish = vi.fn(async (): Promise<PinBudgetResult> => ({ state: 'unavailable' }));
  const begin = vi.fn(async () => ({ state: 'allowed' as const, attemptId: 'a' }));
  const origin = await edgeWith({ begin, finish });
  expect((await login(origin, true, '000000')).status).toBe(503);
  finish.mockResolvedValue({ state: 'allowed' });
  expect((await login(origin, true)).status).toBe(303);
  for (let i = 0; i < 2; i++) expect((await login(origin, true, '000000')).status).toBe(401);
  expect((await login(origin, true)).status).toBe(429);
  expect(begin).toHaveBeenCalledTimes(4);
});

it('does not count budget denials as incorrect PINs', async () => {
  const begin = vi.fn(async (): ReturnType<PreviewPinBudget['begin']> => ({
    state: 'unavailable',
  }));
  const origin = await edgeWith({ begin, finish: async () => ({ state: 'allowed' }) });
  for (let i = 0; i < 5; i++) expect((await login(origin, true)).status).toBe(503);
  begin.mockResolvedValue({ state: 'allowed', attemptId: 'a' });
  expect((await login(origin, true)).status).toBe(303);
});

it('serializes one client while allowing a different trusted client to check', async () => {
  let release!: (result: PinBudgetResult) => void;
  let finishing!: () => void;
  const reached = new Promise<void>((resolve) => {
    finishing = resolve;
  });
  const begin = vi.fn(async () => ({ state: 'allowed' as const, attemptId: 'a' }));
  const finish = vi.fn(() => {
    finishing();
    return new Promise<PinBudgetResult>((resolve) => {
      release = resolve;
    });
  });
  const origin = await edgeWith({ begin, finish }, { trustedProxyHops: 1 });
  const first = login(origin, true, '000000', { 'x-forwarded-for': '203.0.113.1' });
  await reached;
  const same = await login(origin, true, '000000', { 'x-forwarded-for': '203.0.113.1' });
  expect(same.status).toBe(429);
  expect(begin).toHaveBeenCalledTimes(1);
  finish.mockResolvedValue({ state: 'allowed' });
  expect((await login(origin, true, '000000', { 'x-forwarded-for': '203.0.113.2' })).status).toBe(
    401,
  );
  release({ state: 'allowed' });
  expect((await first).status).toBe(401);
});

it.each([0, 1, 2])(
  'cannot evade an IP pause with untrusted forwarding prefixes (hops=%s)',
  async (hops) => {
    const begin = vi.fn(async () => ({ state: 'allowed' as const, attemptId: 'a' }));
    const origin = await edgeWith(
      { begin, finish: async () => ({ state: 'allowed' }) },
      { trustedProxyHops: hops },
    );
    const suffix = hops === 2 ? ', 10.0.0.1' : '';
    for (let i = 1; i <= 3; i++) {
      expect(
        (
          await login(origin, true, '000000', {
            'x-forwarded-for': `198.51.100.${i}, 203.0.113.1${suffix}`,
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await login(origin, true, '123456', {
          'x-forwarded-for': `198.51.100.99, 203.0.113.1${suffix}`,
        })
      ).status,
    ).toBe(429);
    expect(begin).toHaveBeenCalledTimes(3);
    if (hops > 0) {
      expect((await login(origin, true, '000000', { 'x-forwarded-for': 'spoofed' })).status).toBe(
        400,
      );
      expect((await login(origin, true, '000000')).status).toBe(400);
      expect(begin).toHaveBeenCalledTimes(3);
    }
  },
);

it.each(
  [false, true].flatMap((get) =>
    ['begin', 'finish'].flatMap((operation) =>
      [
        { state: 'cooldown' as const, retryAfterSeconds: 90 },
        { state: 'locked' as const },
        { state: 'unavailable' as const },
      ].map((result) => ({ get, operation, result })),
    ),
  ),
)('denies $operation $result.state for GET=$get', async ({ get, operation, result }) => {
  const begin = vi.fn(async () =>
    operation === 'begin' ? result : { state: 'allowed' as const, attemptId: 'a' },
  );
  const finish = vi.fn(async () => result);
  const origin = await edgeWith({ begin, finish });
  const response = await login(origin, get);
  expect(response.status).toBe(
    result.state === 'cooldown' ? 429 : result.state === 'locked' ? 403 : 503,
  );
  expect(response.headers.get('set-cookie')).toBeNull();
  if (operation === 'begin') {
    expect(scrypt).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  } else expect(finish).toHaveBeenCalledWith('a', true);
  const message = await response.text();
  if (result.state === 'cooldown') {
    expect(response.headers.get('retry-after')).toBe('90');
    expect(message).toContain('90 seconds');
  }
  if (result.state === 'locked') expect(message).toContain('new link');
});

it.each([
  '{',
  'null',
  '[]',
  '"allowed"',
  '{"state":"cooldown","retryAfterSeconds":3601}',
  '{"state":"cooldown","retryAfterSeconds":1.5}',
])('fails closed on invalid JSON or response shape %s', async (body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );
  const budget = createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id');
  expect(await budget.begin()).toEqual({ state: 'unavailable' });
  expect(await budget.finish('a', false)).toEqual({ state: 'unavailable' });
});

it('fails closed when a response stream errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('disconnected'));
            },
          }),
        ),
    ),
  );
  const budget = createPreviewPinBudget('http://uplink', 'a'.repeat(43), 'id');
  expect(await budget.begin()).toEqual({ state: 'unavailable' });
  expect(await budget.finish('a', false)).toEqual({ state: 'unavailable' });
});
