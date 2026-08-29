import { describe, expect, it, vi } from 'vitest';

import { revokeLegacyDopplerToken } from './doppler-token-revoke.js';

describe('legacy Doppler token revocation', () => {
  const input = {
    project: 'cluster',
    config: 'production',
    slug: 'old-slug',
    credential: Buffer.from('central-broker-fixture'),
  };

  it.each([204, 404])('accepts HTTP %s without reading the response body', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    await expect(revokeLegacyDopplerToken(input, { fetch })).resolves.toBeUndefined();
  });

  it('returns only a fixed sanitized status error', async () => {
    const fetch = vi.fn(async () => new Response('central-broker-fixture', { status: 401 }));
    await expect(revokeLegacyDopplerToken(input, { fetch })).rejects.toThrow(
      'legacy Doppler token revocation failed (HTTP 401)',
    );
  });
});
