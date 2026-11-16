import { expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

it('sends interruption and turn cancellation only when explicitly requested', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ error: 'fixture refusal' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await expect(
    client.recreateProjectContainer('p', { interruptServices: true, cancelTurns: true }),
  ).rejects.toThrow('fixture refusal');
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
    interruptServices: true,
    cancelTurns: true,
  });
  await expect(client.recreateProjectContainer('p')).rejects.toThrow('fixture refusal');
  expect(fetch.mock.calls[1]![1]!.body).toBeUndefined();
});
