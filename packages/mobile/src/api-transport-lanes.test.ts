import { describe, expect, it, vi } from 'vitest';
import { VerityClient, type TransportRequestInit } from './api.js';

function capturedClient() {
  const stopped = new Error('request captured');
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(stopped);
  return { client: new VerityClient({ baseUrl: 'https://core.example', fetch }), fetch, stopped };
}

describe('transport admission metadata', () => {
  it.each([
    ['session detail', (client: VerityClient) => client.getSession('s/1'), 'interactive'],
    [
      'history page',
      (client: VerityClient) => client.getHistory('s/1', { beforeSeq: 50 }),
      'interactive',
    ],
    ['activity', (client: VerityClient) => client.getActivity('s/1'), 'interactive'],
    ['session list', (client: VerityClient) => client.listSessions(), 'interactive'],
    ['project list', (client: VerityClient) => client.listProjects(), 'interactive'],
    ['branches', (client: VerityClient) => client.getBranches('s/1'), 'background'],
    ['dev servers', (client: VerityClient) => client.listSessionDevServers('s/1'), 'background'],
    [
      'managed servers',
      (client: VerityClient) => client.listManagedDevServers('s/1'),
      'background',
    ],
    [
      'public shares',
      (client: VerityClient) => client.listPublicPreviewShares('p/1'),
      'background',
    ],
    [
      'session shares',
      (client: VerityClient) => client.listSessionLocalPreviewShares('s/1'),
      'background',
    ],
    [
      'project shares',
      (client: VerityClient) => client.listProjectLocalPreviewShares('p/1'),
      'background',
    ],
    ['files', (client: VerityClient) => client.listSessionFiles('s/1'), 'background'],
    ['other reads', (client: VerityClient) => client.listModels(), 'background'],
    ['mutation', (client: VerityClient) => client.createLiveTicket(), undefined],
  ] as const)('classifies %s at the fetch boundary', async (_name, invoke, expected) => {
    const { client, fetch, stopped } = capturedClient();
    await expect(invoke(client)).rejects.toBe(stopped);
    expect((fetch.mock.calls[0]?.[1] as TransportRequestInit).transportLane).toBe(expected);
  });

  it.each([
    (client: VerityClient, signal: AbortSignal) => client.getBranches('s', signal),
    (client: VerityClient, signal: AbortSignal) => client.listSessionDevServers('s', signal),
    (client: VerityClient, signal: AbortSignal) => client.listManagedDevServers('s', signal),
    (client: VerityClient, signal: AbortSignal) => client.listPublicPreviewShares('p', signal),
    (client: VerityClient, signal: AbortSignal) =>
      client.listSessionLocalPreviewShares('s', signal),
    (client: VerityClient, signal: AbortSignal) =>
      client.listProjectLocalPreviewShares('p', signal),
  ])('preserves the caller signal for slow reads', async (invoke) => {
    const { client, fetch, stopped } = capturedClient();
    const controller = new AbortController();
    await expect(invoke(client, controller.signal)).rejects.toBe(stopped);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
