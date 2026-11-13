import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore, VeritySettingsPatch } from '@verity/store';
import { UplinkControlClient, type TeamJoinPending } from './uplink-control-client.js';
import { createRemoteConnectorPool } from './remote-control-connector.js';

// Core's side of a team join's tunnel (team bootstrap interface v1), over a
// real control socket and the real connector pool. The Uplink frames are the
// contract's own fixtures; the subscription has `team-sharing` and no
// `remote-control`, which a join must never need.
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../scripts/team-bootstrap-contract/wire-fixtures.json', import.meta.url),
    'utf8',
  ),
) as { schema: string; valid: boolean; value: Record<string, unknown> }[];
const valid = (schema: string) =>
  fixtures.find((fixture) => fixture.valid && fixture.schema === schema)!.value;
const PENDING = valid('joinPending');
// A ticket lives at most a minute; the fixture's fixed expiry is far ahead.
const ticket = () => ({ ...valid('sessionTicket'), expiresAt: Date.now() + 30_000 });
const TICKET = valid('sessionTicket');

interface Peer {
  socket: WebSocket;
  received: Record<string, unknown>[];
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture(decide: (pending: TeamJoinPending) => Promise<'accepted' | 'refused'>) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  const control: Peer[] = [];
  const data: Peer[] = [];
  server.on('connection', (socket, request) => {
    const peer: Peer = { socket, received: [] };
    (request.url === '/data' ? data : control).push(peer);
    socket.on('message', (raw) =>
      peer.received.push(JSON.parse(String(raw)) as Record<string, unknown>),
    );
  });
  const settings = { uplinkSubscriptionKey: 'test-subscription', uplinkInstallationId: null };
  const store = {
    getVeritySettings: vi.fn(async () => settings),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => ({ ...settings, ...patch })),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const pool = createRemoteConnectorPool({
    dataUrl: 'wss://uplink.example/data',
    localHost: '127.0.0.1',
    localPort: 1,
    webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/data`),
  });
  const admitted = vi.fn(decide);
  const reserved: string[] = [];
  const client = new UplinkControlClient({
    url: 'wss://uplink.example/control',
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    webSocketFactory: (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${address.port}/control`, options),
    offerTeam: true,
    admitTeamJoin: admitted,
    reserveRemoteConnector: async (request, signal) => {
      reserved.push(String(request.capability));
      return pool.reserve(request, signal);
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  cleanup.push(async () => {
    await client.stop();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  // Team work is what makes Core hold the connection: here, an open invitation.
  client.setTeamDemand(true);
  client.start();
  await vi.waitFor(() => expect(control[0]?.received[0]?.type).toBe('hello'), { timeout: 3_000 });
  const uplink = control[0]!;
  uplink.socket.send(
    JSON.stringify({
      type: 'welcome',
      installationId: 'installation-one',
      handle: 'AQEBAQEBAQEBAQEBAQEBAQ',
      features: ['team-sharing'],
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      limits: {},
      teamVersion: 1,
    }),
  );
  await vi.waitFor(() => expect(client.teamNegotiated()).toBe(true));
  return { uplink, data, admitted, reserved };
}

describe('team join tunnel on Core', () => {
  it('stores its decision, accepts, and attaches the tunnel for the accepted redemption', async () => {
    const f = await fixture(async () => 'accepted');
    f.uplink.socket.send(JSON.stringify(PENDING));
    await vi.waitFor(() =>
      expect(f.uplink.received).toContainEqual({
        type: 'session.accept',
        sessionId: PENDING.sessionId,
      }),
    );
    expect(f.admitted).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: PENDING.sessionId,
        invitationId: PENDING.invitationId,
        redemptionId: PENDING.redemptionId,
        projectId: PENDING.projectId,
        permissions: PENDING.permissions,
      }),
    );
    expect(f.reserved).toEqual(['team-bootstrap-v1']);
    f.uplink.socket.send(JSON.stringify(ticket()));
    await vi.waitFor(() =>
      expect(f.data[0]?.received[0]).toEqual({ type: 'attach', ticket: TICKET.ticket }),
    );
    // The tunnel only stands as a team join's: a Remote Control attach is refused.
    f.data[0]!.socket.send(
      JSON.stringify({
        type: 'attached',
        sessionId: PENDING.sessionId,
        capability: 'team-bootstrap-v1',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.data[0]!.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses a join Core does not admit, and never reserves a tunnel for it', async () => {
    const f = await fixture(async () => 'refused');
    f.uplink.socket.send(JSON.stringify(PENDING));
    await vi.waitFor(() =>
      expect(f.uplink.received).toContainEqual({
        type: 'session.refuse',
        sessionId: PENDING.sessionId,
        code: 'unavailable',
      }),
    );
    expect(f.reserved).toEqual([]);
  });

  it('opens no tunnel for a ticket naming another redemption', async () => {
    const f = await fixture(async () => 'accepted');
    f.uplink.socket.send(JSON.stringify(PENDING));
    await vi.waitFor(() =>
      expect(f.uplink.received.some((frame) => frame.type === 'session.accept')).toBe(true),
    );
    f.uplink.socket.send(JSON.stringify({ ...ticket(), redemptionId: 'another_redemption' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.data).toHaveLength(0);
  });
});
