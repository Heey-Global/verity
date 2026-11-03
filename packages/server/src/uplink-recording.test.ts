import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecordingResponse } from './uplink-recording.js';

const runId = '11111111-1111-4111-8111-111111111111';
const event = {
  event: 'remote.return_path',
  schemaVersion: 1,
  session: '0000000000000000',
  generation: '1111111111111111',
  party: 'installation',
  direction: 'in',
  stage: 'parser',
  outcome: 'error',
  eventOrder: 1,
  elapsedMs: 3,
  reason: 'invalid_frame',
  wsCode: 'other',
  lastError: { stage: 'parser', reason: 'invalid_frame', eventOrder: 1, elapsedMs: 3 },
  totals: [],
};
const response = {
  type: 'diagnostics.exported',
  requestId: runId,
  runId,
  state: 'stopped',
  expiresAt: '2026-10-12T08:02:00.000Z',
  retainedUntil: '2026-10-12T09:00:00.000Z',
  collectorReady: true,
  recordCount: 1,
  droppedRecords: 0,
  cursor: 0,
  nextCursor: null,
  records: [event],
};
describe('Uplink recording boundary', () => {
  it('accepts the synthetic negotiated protocol fixture and reports all fixed errors', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/uplink-recording.json', import.meta.url), 'utf8'),
    ) as { responses: { runId: string }[]; errors: { runId: string; code: string }[] };
    for (const reply of fixture.responses)
      expect(parseRecordingResponse(reply, reply.runId)).toEqual(reply);
    for (const reply of fixture.errors)
      expect(() => parseRecordingResponse(reply, reply.runId)).toThrow(`diagnostics_${reply.code}`);
  });

  it('retains fixed diagnostic classifications while projecting secret fields at every level', () => {
    const parsed = parseRecordingResponse(
      {
        ...response,
        token: 'secret-top',
        records: [
          {
            ...event,
            ticket: 'secret-event',
            lastError: { ...event.lastError, message: 'secret-error' },
          },
        ],
      },
      runId,
    );
    expect(parsed).toMatchObject({
      records: [
        { reason: 'invalid_frame', wsCode: 'other', lastError: { reason: 'invalid_frame' } },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
  it.each([
    { reason: 'token=private' },
    { wsCode: 'private-error' },
    { lastError: null },
    { stream: 'private-stream' },
  ])('rejects free text and malformed optional metadata %j', (fields) => {
    expect(() =>
      parseRecordingResponse({ ...response, records: [{ ...event, ...fields }] }, runId),
    ).toThrow('invalid_diagnostics_response');
  });
  it('keeps collector readiness distinct from traffic or retained metadata', () => {
    expect(
      parseRecordingResponse({ ...response, records: [], recordCount: 0 }, runId),
    ).toMatchObject({ collectorReady: true, recordCount: 0, records: [] });
  });
});

it('rejects a declared export beyond the negotiated per-run record budget', () => {
  expect(() => parseRecordingResponse({ ...response, recordCount: 2048 }, runId)).not.toThrow();
  expect(() => parseRecordingResponse({ ...response, recordCount: 2049 }, runId)).toThrow(
    'invalid_diagnostics_response',
  );
});

it('preserves strict v2 pages and rejects wrong negotiated versions', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../events/src/fixtures/socket-evidence-v2.json', import.meta.url),
      'utf8',
    ),
  ) as { document: Record<string, unknown> & { runId: string }; exportHash: string };
  const page = {
    ...fixture.document,
    exportHash: fixture.exportHash,
    type: 'diagnostics.exported',
    requestId: runId,
    cursor: 0,
    nextCursor: null,
  };
  expect(parseRecordingResponse(page, fixture.document.runId, 2)).toEqual(page);
  expect(() => parseRecordingResponse(page, fixture.document.runId, 1)).toThrow();
  expect(() => parseRecordingResponse(response, runId, 2)).toThrow();
  expect(() =>
    parseRecordingResponse({ ...page, secret: 'private' }, fixture.document.runId, 2),
  ).toThrow();
});

it.each([
  [{ ...response, secret: 'private', records: [], padding: 'x'.repeat(32768) }, runId, 1, 'size'],
  [{ ...response, version: 99 }, runId, 1, 'version'],
  [{ ...response, version: 99 }, runId, 3, 'version'],
  [{ ...response, state: 'private' }, runId, 1, 'schema'],
  [response, '22222222-2222-4222-8222-222222222222', 1, 'run_id'],
] as const)(
  'classifies invalid replies without exposing peer content',
  (value, expectedRun, version, reason) => {
    expect(() => parseRecordingResponse(value, expectedRun, version)).toThrow(
      new Error(`invalid_diagnostics_response_${reason}`),
    );
  },
);

it('classifies inconsistent finalized lifecycle metadata', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../events/src/fixtures/socket-evidence-v2.json', import.meta.url),
      'utf8',
    ),
  ) as { document: Record<string, unknown> & { runId: string } };
  expect(() =>
    parseRecordingResponse(
      {
        ...Object.fromEntries(
          Object.entries(fixture.document).filter(([key]) => key !== 'records'),
        ),
        type: 'diagnostics.stopped',
        requestId: runId,
        exportHash: null,
      },
      fixture.document.runId,
      2,
    ),
  ).toThrow(new Error('invalid_diagnostics_response_lifecycle'));
});

it('preserves unversioned protocol errors for newer negotiated versions', () => {
  for (const version of [2, 3] as const)
    expect(() =>
      parseRecordingResponse(
        { type: 'diagnostics.error', requestId: runId, runId, code: 'not_found' },
        runId,
        version,
      ),
    ).toThrow(new Error('diagnostics_not_found'));
});
