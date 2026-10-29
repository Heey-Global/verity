import { expect, it } from 'vitest';
import { syncRevocationOutbox } from './revocations.js';

function outbox(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    deviceId: `device-${index}`,
    revokedAt: '2026-01-01T00:00:00.000Z',
  }));
  const published = new Set<string>();
  return {
    rows,
    published,
    store: {
      async listBackupRevocations() {
        return rows.slice(0, 1000);
      },
      async acknowledgeBackupRevocation(id: string) {
        if (!published.has(id)) throw new Error('Acknowledged before publication');
        rows.splice(
          rows.findIndex((row) => row.id === id),
          1,
        );
      },
    },
    journal: {
      async queue(_deviceId: string, event?: { eventId?: string }) {
        published.add(event!.eventId!);
        return true;
      },
    },
  };
}

it('drains a backlog beyond one database page only after durable publication', async () => {
  const fixture = outbox(1001);
  await syncRevocationOutbox(fixture.store, fixture.journal);
  expect(fixture.rows).toEqual([]);
  expect(fixture.published.size).toBe(1001);
});

it('bounds continuous backlog work and leaves the remainder for the next tick', async () => {
  const fixture = outbox(16001);
  await syncRevocationOutbox(fixture.store, fixture.journal);
  expect(fixture.rows).toHaveLength(1);
  await syncRevocationOutbox(fixture.store, fixture.journal);
  expect(fixture.rows).toEqual([]);
});

it('retains failed transfers and stops between events on shutdown', async () => {
  const fixture = outbox(2);
  await expect(
    syncRevocationOutbox(fixture.store, {
      async queue() {
        return false;
      },
    }),
  ).rejects.toThrow('destination unavailable');
  expect(fixture.rows).toHaveLength(2);
  const controller = new AbortController();
  await expect(
    syncRevocationOutbox(
      fixture.store,
      {
        async queue(deviceId, event) {
          const result = await fixture.journal.queue(deviceId, event);
          controller.abort();
          return result;
        },
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fixture.rows.map((row) => row.id)).toEqual(['1']);
});
