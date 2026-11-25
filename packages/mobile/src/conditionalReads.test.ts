import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConditionalReads,
  isConditionalReadPath,
  withConditionalReads,
} from './conditionalReads.js';

type Call = { url: string; headers: Record<string, string> };

/** A server that tags its body and answers 304 to a matching validator. */
function server(body: () => string) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    calls.push({ url: typeof input === 'string' ? input : '', headers });
    const current = body();
    const etag = `W/"${current.length}-${current}"`;
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(current, {
      status: 200,
      headers: { 'content-type': 'application/json', etag },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

beforeEach(() => clearConditionalReads());

describe('withConditionalReads', () => {
  it('revalidates overview reads and turns 304 back into the remembered body', async () => {
    let body = '[1]';
    const { calls, fetchImpl } = server(() => body);
    const read = withConditionalReads(fetchImpl);
    const url = 'https://verity.test/sessions?envelope=1';
    const init = { method: 'GET', headers: { authorization: 'Bearer a' } };

    expect(await (await read(url, init)).json()).toEqual([1]);
    const second = await read(url, init);
    // The caller must never see the bodiless 304: it parses a normal answer.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual([1]);
    expect(calls[1]?.headers['if-none-match']).toBe('W/"3-[1]"');

    body = '[1,2]';
    expect(await (await read(url, init)).json()).toEqual([1, 2]);
  });

  it('never answers one credential with a body remembered for another', async () => {
    const { calls, fetchImpl } = server(() => '[]');
    const read = withConditionalReads(fetchImpl);
    await read('https://verity.test/projects', { headers: { authorization: 'Bearer a' } });
    await read('https://verity.test/projects', { headers: { authorization: 'Bearer b' } });
    expect(calls[1]?.headers['if-none-match']).toBeUndefined();
  });

  it("keeps the caller's header shape and the server's response headers", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(init?.headers);
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json', etag: 'W/"x"', 'x-verity-version': '4' },
      });
    }) as typeof fetch;
    const read = withConditionalReads(fetchImpl);
    const headers = new Headers({ Authorization: 'Bearer a' });
    const first = await read('https://verity.test/projects', { headers });
    expect(first.headers.get('x-verity-version')).toBe('4');
    await read('https://verity.test/projects', { headers });
    expect(seen[1]).toBeInstanceOf(Headers);
    expect((seen[1] as Headers).get('authorization')).toBe('Bearer a');
    expect((seen[1] as Headers).get('if-none-match')).toBe('W/"x"');
  });

  it('leaves writes and other reads untouched', async () => {
    const { calls, fetchImpl } = server(() => '{}');
    const read = withConditionalReads(fetchImpl);
    await read('https://verity.test/projects/p1', { method: 'GET' });
    await read('https://verity.test/projects/p1', { method: 'PATCH' });
    await read('https://verity.test/sessions/s1/events', { method: 'GET' });
    await read('https://verity.test/sessions/s1/events', { method: 'GET' });
    expect(calls[1]?.headers['if-none-match']).toBeUndefined();
    expect(calls[3]?.headers['if-none-match']).toBeUndefined();
  });

  it('matches exactly the overview routes the server tags', () => {
    expect(isConditionalReadPath('/sessions')).toBe(true);
    expect(isConditionalReadPath('/sessions?envelope=1')).toBe(true);
    expect(isConditionalReadPath('/projects')).toBe(true);
    expect(isConditionalReadPath('/projects/p1')).toBe(true);
    expect(isConditionalReadPath('/projects/p1/pull-requests')).toBe(false);
    expect(isConditionalReadPath('/sessions/s1')).toBe(false);
    expect(isConditionalReadPath('/verity/sessions?envelope=1')).toBe(true);
  });
});
