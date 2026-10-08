import { Writable } from 'node:stream';
import type { IntegrationStore } from '@verity/store';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerIntegrationRoutes } from './routes.js';

it.each([
  ['edit', 'missing'],
  ['edit', 'non_message'],
] as const)(
  'identifies a rejected %s with a %s target without logging content',
  async (kind, targetState) => {
    const records: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        records.push(chunk.toString());
        callback();
      },
    });
    const app = Fastify({ logger: { stream, level: 'warn' } });
    const ingestEvent = vi.fn();
    const store = {
      getEvent: vi.fn(async () =>
        targetState === 'missing' ? null : { kind: 'edit', body: 'private target text' },
      ),
      ingestEvent,
    } as unknown as IntegrationStore;
    const token = 'a-secret-long-enough-for-the-worker-route';
    registerIntegrationRoutes(app, { store, dataRoot: '/unused', connectorToken: token });
    try {
      // Repeated failures must remain identifiable without becoming successful imports.
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: 'POST',
          url: '/internal/integrations/matrix/event',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            accountId: '@account:example.test',
            sourceId: '!room:example.test',
            eventId: '$edit',
            targetEventId: '$target',
            kind,
            sender: '@private-sender:example.test',
            occurredAt: '2026-10-05T07:47:00Z',
            body: kind === 'edit' ? 'private replacement text' : null,
          },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: 'target_message_not_found' });
      }
      expect(ingestEvent).not.toHaveBeenCalled();
      const logs = records.join('');
      const failures = logs
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line: string) => JSON.parse(line) as Record<string, unknown>);
      expect(failures).toHaveLength(2);
      for (const failure of failures) {
        expect(failure).toMatchObject({
          code: 'target_message_not_found',
          accountId: '@account:example.test',
          sourceId: '!room:example.test',
          eventId: '$edit',
          targetEventId: '$target',
          kind,
          targetState,
        });
      }
      expect(logs).not.toContain('private');
      expect(logs).not.toContain(token);
    } finally {
      await app.close();
    }
  },
);
