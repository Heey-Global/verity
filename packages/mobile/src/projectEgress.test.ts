import { describe, expect, it, vi } from 'vitest';
import { VerityClient, VerityApiError } from './api.js';
import { projectEgressPolicySchema } from './projectEgress.js';

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 7,
  target: { host: 'example.com', protocol: 'tcp' as const, port: 443 },
  requestedBy: ['sandbox'],
  createdAt: 1,
  expiresAt: 1000,
  status: 'pending',
};
const policy = { revision: 7, requests: { example: request }, grants: [] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it('sends exact project-scoped revisioned decisions and revocations', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json({ policy, enforcement: 'unavailable' }))
    .mockResolvedValueOnce(json({ request }))
    .mockResolvedValueOnce(json({ request: { ...request, status: 'denied' } }))
    .mockResolvedValueOnce(json({ enforcement: 'unavailable' }));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  expect(await client.getProjectEgress('p/id')).toEqual(policy);
  await client.decideProjectEgress('p/id', { requestId: request.id, revision: 7, allow: true });
  await client.decideProjectEgress('p/id', { requestId: request.id, revision: 8, allow: false });
  await client.revokeProjectEgress('p/id', { grantId: request.id, revision: 9 });
  expect(fetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    ['http://host/projects/p%2Fid/egress', 'GET', undefined],
    [
      'http://host/projects/p%2Fid/egress/decisions',
      'POST',
      JSON.stringify({ requestId: request.id, revision: 7, allow: true }),
    ],
    [
      'http://host/projects/p%2Fid/egress/decisions',
      'POST',
      JSON.stringify({ requestId: request.id, revision: 8, allow: false }),
    ],
    [
      'http://host/projects/p%2Fid/egress/revoke',
      'POST',
      JSON.stringify({ grantId: request.id, revision: 9 }),
    ],
  ]);
});

it('does not hide forbidden or stale responses', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json({ error: 'forbidden' }, 403))
    .mockResolvedValueOnce(json({ error: 'stale' }, 409));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await expect(client.getProjectEgress('other-project')).rejects.toMatchObject({ status: 403 });
  await expect(
    client.revokeProjectEgress('p', { grantId: request.id, revision: 7 }),
  ).rejects.toBeInstanceOf(VerityApiError);
});

describe('policy validation', () => {
  it('rejects unsafe revision and target shapes before UI actions use them', () => {
    expect(() => projectEgressPolicySchema.parse({ ...policy, revision: -1 })).toThrow();
    expect(() =>
      projectEgressPolicySchema.parse({
        ...policy,
        requests: { example: { ...request, target: { ...request.target, port: 70000 } } },
      }),
    ).toThrow();
    expect(() =>
      projectEgressPolicySchema.parse({
        ...policy,
        requests: { example: { ...request, revision: '7' } },
      }),
    ).toThrow();
  });
});

it('reopens only an explicitly selected target at the current policy revision', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json({ request: { ...request, revision: 8 } }));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await client.reopenProjectEgress('p/id', { target: request.target, revision: 7 });
  expect(fetch.mock.calls[0]).toEqual([
    'http://host/projects/p%2Fid/egress/reopen',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ target: request.target, revision: 7 }),
    }),
  ]);
});
