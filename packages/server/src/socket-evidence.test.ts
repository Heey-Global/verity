import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  canonicalEvidenceJson,
  socketEvidenceExportSchema,
  socketEvidenceHashInput,
} from '@verity/events';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../events/src/fixtures/socket-evidence-v2.json', import.meta.url),
    'utf8',
  ),
) as { document: Record<string, unknown>; exportHash: string };
const evidence = () =>
  socketEvidenceExportSchema.parse({ ...fixture.document, exportHash: fixture.exportHash });
it('preserves the Uplink golden document and independently reproduces its digest', () => {
  const parsed = evidence();
  expect(parsed).toEqual({ ...fixture.document, exportHash: fixture.exportHash });
  expect(createHash('sha256').update(socketEvidenceHashInput(parsed)).digest('hex')).toBe(
    fixture.exportHash,
  );
  expect(canonicalEvidenceJson({ b: 2, a: [3, 1] })).toBe('{"a":[3,1],"b":2}');
});
it.each([undefined, Infinity, NaN, new Date(), { missing: undefined }])(
  'rejects non-JSON hash input %s',
  (value) => {
    expect(() => canonicalEvidenceJson(value)).toThrow();
  },
);
it('rejects unknown metadata rather than silently changing signed evidence', () => {
  const parsed = evidence();
  expect(() => socketEvidenceExportSchema.parse({ ...parsed, token: 'secret' })).toThrow();
  const record = parsed.records[0]!;
  expect(() =>
    socketEvidenceExportSchema.parse({
      ...parsed,
      records: [{ ...record, payload: 'secret' }, parsed.records[1]],
    }),
  ).toThrow();
  expect(() =>
    socketEvidenceExportSchema.parse({
      ...parsed,
      records: [
        { ...record, snapshot: { ...record.snapshot, ticket: 'secret' } },
        parsed.records[1],
      ],
    }),
  ).toThrow();
});
it('rejects missing records, mixed ownership, reordered sequences and unfinished exports', () => {
  const parsed = evidence();
  for (const fields of [
    { records: parsed.records.slice(1) },
    { records: [...parsed.records].reverse() },
    { state: 'recording' },
    { endedAt: null },
    { runId: '00000000-0000-4000-8000-000000000099' },
  ])
    expect(() => socketEvidenceExportSchema.parse({ ...parsed, ...fields })).toThrow();
});
