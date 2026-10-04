import type { IntegrationStore } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { readMatrixDiagnosticSnapshot } from './matrix-diagnostic-snapshot.js';

function setup() {
  const source = {
    accountId: 'account',
    sourceId: 'room',
    status: 'active',
    activatedAt: new Date('2026-01-02T00:00:00Z'),
    lastIngestedAt: null,
    importDiagnostics: [],
    importDiagnosticsTruncated: false,
    importDiagnosticsReportedAt: null,
  };
  const listSources = vi.fn(async () => [source]);
  const getEvent = vi.fn(async () => ({
    kind: 'message',
    occurredAt: new Date('2026-01-03T00:00:00Z'),
    targetEventId: null,
    body: 'private',
    sender: 'private',
  }));
  return {
    source,
    listSources,
    getEvent,
    store: { listSources, getEvent } as unknown as IntegrationStore,
    authorize: vi.fn(async () => {}),
  };
}
const selected = { accountId: 'account', sourceId: 'room', eventId: 'event' };
it('checks project authority before lookup and strips receipt content', async () => {
  const h = setup();
  h.authorize.mockRejectedValueOnce(new Error('denied'));
  await expect(
    readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project', selected),
  ).rejects.toThrow('denied');
  expect(h.getEvent).not.toHaveBeenCalled();
  const result = await readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project', selected);
  expect(result.event?.stored).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('rejects an unrelated room before reading its stored event', async () => {
  const h = setup();
  await expect(
    readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project', {
      ...selected,
      sourceId: 'other',
    }),
  ).rejects.toThrow('target room unavailable');
  expect(h.getEvent).not.toHaveBeenCalled();
});
it('does not expose receipts from a previous room activation', async () => {
  const h = setup();
  h.getEvent.mockResolvedValueOnce({
    kind: 'message',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    targetEventId: null,
    body: 'private',
    sender: 'private',
  });
  expect(
    (await readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project', selected)).event,
  ).toEqual({ stored: false });
});
it('rejects a receipt when the room is rebound during lookup', async () => {
  const h = setup();
  h.listSources
    .mockResolvedValueOnce([h.source])
    .mockResolvedValueOnce([{ ...h.source, activatedAt: new Date('2026-01-04T00:00:00Z') }]);
  await expect(
    readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project', selected),
  ).rejects.toThrow('target room unavailable');
});

it('does not expose diagnostic source exceptions', async () => {
  const h = setup();
  h.listSources.mockRejectedValueOnce(new Error('database password private'));
  await expect(readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project')).rejects.toThrow(
    'Matrix diagnostic evidence unavailable',
  );
});

it('drops room diagnostics when binding changes during a snapshot read', async () => {
  const h = setup();
  h.listSources.mockResolvedValueOnce([h.source]).mockResolvedValueOnce([]);
  expect((await readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project')).sources).toEqual([]);
});

it('keeps failed rooms ahead of healthy rooms under the snapshot cap', async () => {
  const h = setup();
  const healthy = Array.from({ length: 20 }, (_, index) => ({
    ...h.source,
    sourceId: `healthy-${index}`,
  }));
  const failed = {
    ...h.source,
    sourceId: 'failed',
    importDiagnostics: [
      {
        sourceId: 'failed',
        eventId: 'event',
        occurredAt: '2026-01-03T00:00:00Z',
        lastAttemptAt: '2026-01-03T00:01:00Z',
        attempts: 1,
        httpStatus: 422,
        code: 'target_message_not_found' as const,
      },
    ],
  };
  h.listSources.mockResolvedValue([...healthy, failed] as unknown as typeof healthy);
  const result = await readMatrixDiagnosticSnapshot(h.store, h.authorize, 'project');
  expect(result.truncated).toBe(true);
  expect(result.sources).toHaveLength(20);
  expect(result.sources.some((source) => source.sourceId === failed.sourceId)).toBe(true);
});
