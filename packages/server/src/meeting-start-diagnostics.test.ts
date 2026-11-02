import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { PreviewConnector } from '@verity/preview-tunnel';
import type { EventStore } from '@verity/store';
import { AttendeeMeetings } from './attendee-meetings.js';
import { registerAttendeeRoutes } from './attendee-routes.js';
import type { PreviewEdgeControl, PreviewCreateDiagnostic } from './preview-share-manager.js';

it.each(['capability_check', 'share_create', 'connector_connect'] as const)(
  'correlates secret-free %s failure before cleanup without starting a provider',
  async (phase) => {
    const logs: string[] = [];
    const rows = new Map<string, unknown>();
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
      },
      listAttendeeState: async () =>
        [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
    } as unknown as EventStore;
    const remove = vi.fn(async () => {
      expect(logs.some((line) => line.includes('Online meeting start failed'))).toBe(true);
    });
    const client = vi.fn();
    const edge: PreviewEdgeControl = {
      create: async (_input, report) => {
        const entry: PreviewCreateDiagnostic = {
          phase: phase === 'connector_connect' ? 'share_ready' : phase,
          code:
            phase === 'capability_check'
              ? 'webhook_not_negotiated'
              : phase === 'share_create'
                ? 'webhook_unsupported'
                : 'ready',
          shareCreateSent: phase !== 'capability_check',
        };
        report?.(entry);
        if (phase !== 'connector_connect')
          throw new Error('secret-provider-token https://secret.example/?pin=123456');
        return {
          shareId: 'test-share',
          publicOrigin: 'https://secret.example',
          edgeUrl: 'wss://secret.example/__verity/connector',
          connectorToken: 'secret-connector',
          sessionSecret: 'secret-session',
          expiresAt: new Date(Date.now() + 10000),
        };
      },
      remove,
    };
    const connect = vi
      .spyOn(PreviewConnector.prototype, 'connect')
      .mockRejectedValue(new Error('secret-connector'));
    const service = new AttendeeMeetings({ store, edge, ingest: vi.fn(), client });
    const app = Fastify({
      genReqId: () => 'diagnostic-request',
      logger: { stream: { write: (line: string) => logs.push(line) } },
    });
    registerAttendeeRoutes(app, service, () => true);
    await service.configure({
      apiKey: 'secret-api',
      webhookSecret: Buffer.alloc(32).toString('base64'),
    });
    await service.open();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions/session/live-meetings/online',
        payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      const events = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.msg === 'Online meeting start failed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        requestId: 'diagnostic-request',
        meetingId: expect.any(String),
        phase,
        code:
          phase === 'connector_connect'
            ? 'failed'
            : phase === 'capability_check'
              ? 'webhook_not_negotiated'
              : 'webhook_unsupported',
        shareCreateSent: phase !== 'capability_check',
        bindingPresent: phase === 'connector_connect',
        botCreateAttempted: false,
        event: 'failed',
      });
      const serialized = JSON.stringify(events);
      for (const secret of [
        'secret-',
        '123456',
        'meet.google',
        'https:',
        'wss:',
        'cause',
        'stack',
        'pinHash',
      ])
        expect(serialized).not.toContain(secret);
      expect(client).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(phase === 'connector_connect' ? 1 : 0);
    } finally {
      connect.mockRestore();
      await service.close();
      await app.close();
    }
  },
);
