import { describe, expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

describe('app identity and Server channel API', () => {
  it('sends the native app variant while changing only the Server channel', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ channel: 'staging' })));
    const client = new VerityClient({
      baseUrl: 'https://server.test',
      appVariant: 'staging',
      getToken: () => 'paired',
      fetch,
    });
    expect(await client.setServerUpdateChannel('staging')).toBe('staging');
    expect(fetch).toHaveBeenCalledWith(
      'https://server.test/server/update-channel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel: 'staging' }),
        headers: expect.objectContaining({
          'x-verity-app-variant': 'staging',
          authorization: 'Bearer paired',
        }),
      }),
    );
  });
});
