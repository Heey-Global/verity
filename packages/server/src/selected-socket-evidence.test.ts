import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  selectedEvidenceExportSchema,
  selectedEvidenceHashInput,
  selectedEvidenceMetadataSchema,
} from '@verity/events';
import { parseRecordingResponse } from './uplink-recording.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../events/src/fixtures/socket-evidence-v3.json', import.meta.url),
    'utf8',
  ),
) as {
  document: Record<string, unknown>;
  exportHash: string;
  preparing: Record<string, unknown>;
  ready: Record<string, unknown>;
};
const evidence = () =>
  selectedEvidenceExportSchema.parse({ ...fixture.document, exportHash: fixture.exportHash });
it('preserves the actual Uplink v3 golden document and hash including terminal peer identity', () => {
  const parsed = evidence();
  expect(parsed).toEqual({ ...fixture.document, exportHash: fixture.exportHash });
  expect(createHash('sha256').update(selectedEvidenceHashInput(parsed)).digest('hex')).toBe(
    fixture.exportHash,
  );
  for (const response of [fixture.preparing, fixture.ready])
    expect(parseRecordingResponse(response, parsed.runId, 3)).toEqual(response);
});
it('rejects unknown fields, unselected sessions, altered cadence and missing sequence', () => {
  const parsed = evidence();
  for (const value of [
    { ...parsed, token: 'private' },
    { ...parsed, targetSession: '0000000000000000' },
    { ...parsed, records: parsed.records.slice(1) },
    {
      ...parsed,
      records: parsed.records.map((r, i) => (i === 0 ? { ...r, targetIntervalMs: 100 } : r)),
    },
    { ...parsed, samplingPolicy: { ...parsed.samplingPolicy, burstTrigger: 'always' } },
    {
      ...parsed,
      records: parsed.records.map((r, i) => (i === 0 ? { ...r, payload: 'private' } : r)),
    },
  ])
    expect(selectedEvidenceExportSchema.safeParse(value).success).toBe(false);
});
it('rejects false readiness and mixed versions without imposing cross-clock UTC order', () => {
  const metadata = Object.fromEntries(
    Object.entries(fixture.ready).filter(
      ([key]) => !['type', 'requestId', 'exportHash'].includes(key),
    ),
  );
  const ready = selectedEvidenceMetadataSchema.parse(metadata);
  for (const value of [
    { ...ready, state: 'preparing' },
    { ...ready, captureStartedAt: null },
    { ...ready, omittedBindings: 1 },
    { ...ready, readiness: { ...ready.readiness, app: { ...ready.readiness.app, active: false } } },
    {
      ...ready,
      readiness: { ...ready.readiness, app: { ...ready.readiness.app, socketLifetimeId: null } },
    },
  ])
    expect(selectedEvidenceMetadataSchema.safeParse(value).success).toBe(false);
  expect(() => parseRecordingResponse(fixture.ready, ready.runId, 2)).toThrow();
  expect(() => parseRecordingResponse(fixture.ready, ready.runId, 1)).toThrow();
  expect(
    selectedEvidenceMetadataSchema.safeParse({
      ...ready,
      captureExpiresAt: '2020-01-01T00:00:00.000Z',
    }).success,
  ).toBe(true);
});
it('includes all sampling and selection metadata in the canonical digest', () => {
  const parsed = evidence();
  const changed = { ...parsed, burstStartedAt: parsed.startedAt };
  expect(createHash('sha256').update(selectedEvidenceHashInput(changed)).digest('hex')).not.toBe(
    parsed.exportHash,
  );
});
