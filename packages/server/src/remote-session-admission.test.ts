import { describe, expect, it, vi } from 'vitest';
import { reserveRemoteAdmission } from './remote-session-admission.js';
import type { RemoteConnectorReservation, TeamJoinPending } from './uplink-control-frames.js';

const request = { requestId: 'r', sessionId: 's', decisionExpiresAt: Date.now() + 15_000 };
const join: TeamJoinPending = {
  ...request,
  invitationId: 'i',
  redemptionId: 'd',
  projectId: 'p',
  permissions: ['read'],
};
const reservation = () => ({ attach: vi.fn(async () => undefined), release: vi.fn() });

describe('remote admission lifetime', () => {
  it('records no admission when no connector can be reserved', async () => {
    const admitTeamJoin = vi.fn(async () => 'accepted' as const);
    await expect(
      reserveRemoteAdmission(
        {
          reserveRemoteConnector: async () => 'limit_reached',
          admitTeamJoin,
        },
        request,
        new AbortController().signal,
        join,
      ),
    ).resolves.toBe('limit_reached');
    expect(admitTeamJoin).not.toHaveBeenCalled();
  });

  it('reserves before admission, passes cancellation and retires authority with transport', async () => {
    const connector = reservation();
    const order: string[] = [];
    const controller = new AbortController();
    const rollbackTeamJoin = vi.fn(async () => undefined);
    const result = await reserveRemoteAdmission(
      {
        reserveRemoteConnector: async () => {
          order.push('reserve');
          return connector;
        },
        admitTeamJoin: async (_, signal) => {
          expect(signal).toBe(controller.signal);
          order.push('admit');
          return 'accepted';
        },
        rollbackTeamJoin,
      },
      request,
      controller.signal,
      join,
    );
    expect(order).toEqual(['reserve', 'admit']);
    (result as RemoteConnectorReservation).release('closed');
    expect(connector.release).toHaveBeenCalledOnce();
    expect(rollbackTeamJoin).toHaveBeenCalledWith(join);
  });

  it('bounds hung admission and rolls back again when it finishes after cancellation', async () => {
    const connector = reservation();
    const controller = new AbortController();
    let finish!: (decision: 'accepted') => void;
    const admitted = new Promise<'accepted'>((resolve) => {
      finish = resolve;
    });
    const admitTeamJoin = vi.fn(() => admitted);
    const rollbackTeamJoin = vi.fn(async () => undefined);
    const result = reserveRemoteAdmission(
      {
        reserveRemoteConnector: async () => connector,
        admitTeamJoin,
        rollbackTeamJoin,
      },
      request,
      controller.signal,
      join,
    );
    await vi.waitFor(() => expect(admitTeamJoin).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).resolves.toBe('unavailable');
    expect(connector.release).toHaveBeenCalledOnce();
    expect(rollbackTeamJoin).toHaveBeenCalledOnce();
    finish('accepted');
    await vi.waitFor(() => expect(rollbackTeamJoin).toHaveBeenCalledTimes(2));
  });

  it('retires a reservation that finishes after cancellation without admitting', async () => {
    const connector = reservation();
    const controller = new AbortController();
    let finish!: (value: RemoteConnectorReservation) => void;
    const pending = new Promise<RemoteConnectorReservation>((resolve) => {
      finish = resolve;
    });
    const admitTeamJoin = vi.fn(async () => 'accepted' as const);
    const result = reserveRemoteAdmission(
      {
        reserveRemoteConnector: () => pending,
        admitTeamJoin,
      },
      request,
      controller.signal,
      join,
    );
    controller.abort();
    await expect(result).resolves.toBe('unavailable');
    finish(connector);
    await vi.waitFor(() => expect(connector.release).toHaveBeenCalledOnce());
    expect(admitTeamJoin).not.toHaveBeenCalled();
  });
});
