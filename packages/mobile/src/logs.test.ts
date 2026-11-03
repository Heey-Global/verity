import { describe, expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

it('keeps build selection provenance and requests the encoded operation ID', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({
          provenance: { source: 'build', operationId: 'build/one', supportConsent: 'required' },
          state: 'unavailable',
          diagnostic: null,
        }),
      ),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  const result = await client.buildDiagnostic('build/one');
  const input = fetch.mock.calls[0]![0];
  if (typeof input !== 'string') throw new Error('Expected a URL string');
  expect(input).toContain('/audit/operations/build%2Fone/diagnostics');
  expect(result.provenance.supportConsent).toBe('required');
});

describe('system log selections', () => {
  it('sends source, time and severity and parses explicit stale/partial state', async () => {
    const window = { since: '2026-10-28T12:00:00Z', until: '2026-10-28T13:00:00Z' };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            source: 'host',
            window,
            state: 'available',
            supportConsent: 'required',
            stale: true,
            truncated: true,
            entries: [],
          }),
        ),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.systemLogs({ source: 'host', level: 'all', ...window });
    const input = fetch.mock.calls[0]![0];
    if (typeof input !== 'string') throw new Error('Expected a URL string');
    const url = new URL(input);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: 'host',
      level: 'all',
      ...window,
    });
    expect(result.stale).toBe(true);
    expect(result.truncated).toBe(true);
  });
});
