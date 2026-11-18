import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore, VeritySettingsPatch } from '@verity/store';
import { UplinkControlClient } from './uplink-control-client.js';
import { teamSharingStatus } from './uplink-feature-state.js';

// Whether team invitations can get their link, as the control client derives it
// from a real control socket. An installation whose lease lacks `team-sharing`
// used to look exactly like one still connecting: the invitation waited for a
// link that could not come, with nothing in the app or the log to say why.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture(options: { key?: string | null; offerTeam?: boolean } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  const control: WebSocket[] = [];
  server.on('connection', (socket) => control.push(socket));
  const settings = {
    uplinkSubscriptionKey: options.key === undefined ? 'test-subscription' : options.key,
    uplinkInstallationId: null,
  };
  const store = {
    getVeritySettings: vi.fn(async () => settings),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => ({ ...settings, ...patch })),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const client = new UplinkControlClient({
    url: 'wss://uplink.example/control',
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    webSocketFactory: (_url, socketOptions) =>
      new WebSocket(`ws://127.0.0.1:${address.port}/control`, socketOptions),
    offerTeam: options.offerTeam ?? true,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  cleanup.push(async () => {
    await client.stop();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  /** Start with team work queued, as an open invitation does. */
  const startWithTeamWork = () => {
    client.setTeamDemand(true);
    client.start();
  };
  const welcome = async (fields: { features: string[]; teamVersion?: 1 }) => {
    await vi.waitFor(() => expect(control.length).toBeGreaterThan(0), { timeout: 3_000 });
    control.at(-1)!.send(
      JSON.stringify({
        type: 'welcome',
        installationId: 'installation-one',
        handle: 'AQEBAQEBAQEBAQEBAQEBAQ',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
        limits: {},
        ...fields,
      }),
    );
  };
  return { client, control, startWithTeamWork, welcome };
}

describe('team availability of the Uplink control client', () => {
  it('reports an admission without team-sharing as not entitled, also once it parked', async () => {
    const f = await fixture();
    f.startWithTeamWork();
    expect(f.client.teamAvailability()).toBe('uplink_offline');
    // The admission staging saw: sharing and remote control, no team v1.
    await f.welcome({ features: ['sharing', 'remote-control'] });
    await vi.waitFor(() => expect(f.client.teamAvailability()).toBe('not_entitled'));
    // No other demand: the client lets the connection go, and keeps the answer.
    await vi.waitFor(() => expect(f.client.diagnostics().control).toBe('idle'));
    expect(f.client.teamAvailability()).toBe('not_entitled');
  });

  it('tells a grant without team v1 apart from a working team connection', async () => {
    const withoutVersion = await fixture();
    withoutVersion.startWithTeamWork();
    await withoutVersion.welcome({ features: ['team-sharing'] });
    await vi.waitFor(() => expect(withoutVersion.client.teamAvailability()).toBe('not_negotiated'));

    const working = await fixture();
    working.startWithTeamWork();
    await working.welcome({ features: ['team-sharing'], teamVersion: 1 });
    await vi.waitFor(() => expect(working.client.teamAvailability()).toBe('available'));
    // A dropped connection is temporary: queued work keeps waiting for it.
    working.control[0]!.terminate();
    await vi.waitFor(() => expect(working.client.teamNegotiated()).toBe(false));
    expect(working.client.teamAvailability()).toBe('uplink_offline');
  });

  it('reports team invitations unavailable without a key or without team v1 on offer', async () => {
    const noKey = await fixture({ key: null });
    noKey.startWithTeamWork();
    await vi.waitFor(() => expect(noKey.client.teamAvailability()).toBe('unavailable'));

    const notOffered = await fixture({ offerTeam: false });
    expect(notOffered.client.teamAvailability()).toBe('unavailable');
    // Without a connector an invited person could not join, whatever Uplink grants.
    notOffered.startWithTeamWork();
    expect(notOffered.client.teamAvailability()).toBe('unavailable');
  });

  // Refused invitations create no team demand, so nothing would reconnect a
  // parked client: team sharing granted later stayed refused until a restart.
  it('checks a refusal again, so team sharing granted later takes effect', async () => {
    const f = await fixture();
    f.startWithTeamWork();
    await f.welcome({ features: ['sharing'] });
    await vi.waitFor(() => expect(f.client.diagnostics().control).toBe('idle'));
    f.client.setTeamDemand(false);
    const status = teamSharingStatus(f.client, () => 0);

    expect(status()).toBe('not_entitled');
    await vi.waitFor(() => expect(f.control).toHaveLength(2), { timeout: 3_000 });
    // One check per interval, however often the team page is read.
    expect(status()).toBe('not_entitled');
    await f.welcome({ features: ['sharing', 'team-sharing'], teamVersion: 1 });
    await vi.waitFor(() => expect(f.client.diagnostics().control).toBe('idle'));
    expect(f.control).toHaveLength(2);
    // The new lease is kept once the check parked again.
    expect(status()).toBe('uplink_offline');

    expect(teamSharingStatus(undefined)()).toBe('unavailable');
  });
});
