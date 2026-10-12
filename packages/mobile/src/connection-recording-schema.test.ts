import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  recordingCoreRecordSchema,
  recordingUplinkRecordSchema,
} from './connection-recording-schema.js';

// Read the producer fixture: silently stripping transport would hide the receive gap.
const transport: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL('../../server/src/fixtures/recording-transport.json', import.meta.url),
    'utf8',
  ),
);
const common = {
  event: 'remote.return_path',
  schemaVersion: 1,
  session: '0000000000000000',
  generation: '1111111111111111',
  party: 'installation',
  direction: 'in',
  stage: 'summary',
  outcome: 'observed',
  eventOrder: 1,
  elapsedMs: 0,
};
const core = {
  ...common,
  summaryOrder: 1,
  droppedEvents: 0,
  emittedMessages: 0,
  emittedBytes: 0,
  lastError: null,
  lastClose: null,
  droppedStreamObservations: 0,
  streams: [],
  events: [],
};
it.each([
  [recordingCoreRecordSchema, core],
  [recordingUplinkRecordSchema, common],
])(
  'preserves supported transport observations and excludes unknown nested fields',
  (schema, record) => {
    expect(schema.parse(record)).not.toHaveProperty('transport');
    const observed = {
      ...transport,
      socketBytesRead: 27,
      socketPaused: true,
      receiverState: 4,
      receiverFin: false,
    };
    const parsed = schema.parse({
      ...record,
      transport: { ...observed, headers: 'secret', payload: 'secret', remoteAddress: 'secret' },
    });
    expect(parsed.transport).toEqual(observed);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    for (const invalid of [
      { socketBytesRead: -1 },
      { receiverState: 7 },
      { receiverFragmented: 3 },
      { socketPaused: 'secret' },
      { socketBytesWritten: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(schema.safeParse({ ...record, transport: { ...transport, ...invalid } }).success).toBe(
        false,
      );
    }
  },
);
