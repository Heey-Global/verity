import { expect, it } from 'vitest';

import { VerityClient } from './api.js';

type Call = { url: string; init: RequestInit | undefined };
function fakeFetchSequence(...responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    const response = responses.shift();
    if (!response) throw new Error('fakeFetchSequence exhausted');
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

it('reads a project QA, sends a decision and its mode, bound to the project and issue', async () => {
  const state = {
    enabled: true,
    coding: true,
    mode: 'automatic',
    sessionId: 'qa',
    brakeAt: null,
    checkedAt: null,
    sources: { pullRequests: { readable: true, failing: 1 }, ci: { readable: false, failing: 0 } },
    issues: [],
    repairSessions: [],
  };
  const { fetch, calls } = fakeFetchSequence(
    json(state),
    json({ state }),
    new Response(null, { status: 204 }),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  expect((await client.projectQA.state('p')).sources.pullRequests.failing).toBe(1);
  await client.projectQA.decide('p', 'issue 1', 'another_round');
  await client.projectQA.setMode('p', 'paused');
  expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
    ['GET', 'http://host/projects/p/qa'],
    ['POST', 'http://host/projects/p/qa/issues/issue%201/decision'],
    ['PUT', 'http://host/projects/p/repairs'],
  ]);
  expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ decision: 'another_round' });
  expect(JSON.parse(calls[2]!.init?.body as string)).toEqual({ mode: 'paused' });
});
