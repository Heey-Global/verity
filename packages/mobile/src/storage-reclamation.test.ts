import { expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';
it('uses authenticated parameter-free maintenance requests and validates results', async () => {
  const status = { supported: true, state: 'idle', startedAt: null, completedAt: null, error: null, result: null, nativePending: false, nativeBuildkit: null };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(status)));
  const api = new VerityClient({ baseUrl: 'https://core.example', fetch, getToken: () => 'paired-token' });
  await expect(api.getStorageReclamation()).resolves.toEqual(status);
  await expect(api.reclaimStorage()).resolves.toEqual(status);
  expect(fetch.mock.calls.map(([url, init]) => [(url as string).replace('https://core.example', ''), init?.method, init?.body])).toEqual([
    ['/settings/storage/reclamation', 'GET', undefined], ['/settings/storage/reclamation', 'POST', undefined],
  ]);
  fetch.mockResolvedValueOnce(new Response('{}'));
  await expect(api.getStorageReclamation()).rejects.toThrow();
});
