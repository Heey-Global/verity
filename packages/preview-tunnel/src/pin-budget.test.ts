import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewPinBudget } from './pin-budget.js';
import { PreviewEdge, hashPreviewPin, hashPreviewSecret } from './index.js';
import type { PreviewPinBudget, PinBudgetResult } from './pin-budget.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) await close();
});

async function edgeWith(budget: PreviewPinBudget) {
  const edge = new PreviewEdge({
    shareId: 'share-budget',
    pinHash: hashPreviewPin('123456'),
    connectorTokenHash: hashPreviewSecret('connector-secret'),
    sessionSecretHash: hashPreviewSecret('session-secret'),
    publicOrigin: 'https://budget.preview.test',
    pinBudget: budget,
  });
  const port = await edge.listen();
  cleanup.push(() => edge.close());
  return `http://127.0.0.1:${port}`;
}

function login(origin: string, get: boolean, pin = '123456') {
  return fetch(get ? `${origin}/?pin=${pin}` : `${origin}/__verity/login`, {
    method: get ? 'GET' : 'POST',
    redirect: 'manual',
    ...(get
      ? {}
      : {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
  if (result.state === 'cooldown') expect(response.headers.get('retry-after')).toBe('120');
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
