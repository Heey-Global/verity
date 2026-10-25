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

it('retains Core association and first-frame metadata without inferred proxy joins', () => {
  const association = {
    schemaVersion: 1,
    bindingSource: 'authenticated_control_session_request',
    processBootId: '00000000-0000-4000-8000-000000000001',
    socketLifetimeId: '00000000-0000-4000-8000-000000000002',
    session: core.session,
    request: 'a'.repeat(16),
    coverageStart: 'after_socket_creation',
    activatedAt: '2026-10-23T12:00:00.000Z',
    socketEndpoints: {
      local: { address: '127.0.0.1', port: 1234 },
      remote: { address: '2001:db8::1', port: 443 },
    },
    uplinkConnectionId: null,
    natAssociation: 'unknown',
    envoyAssociation: 'unknown',
  };
  expect(
    recordingCoreRecordSchema.safeParse({
      ...core,
      association: { ...association, session: 'f'.repeat(16) },
    }).success,
  ).toBe(false);
  const parsed = recordingCoreRecordSchema.parse({
    ...core,
    association,
    callbackMeaning: 'local_acceptance_not_peer_receipt',
    streams: [
      {
        stream: 'b'.repeat(16),
        enqueuedFrames: 1,
        completedFrames: 1,
        errorFrames: 0,
        encodedBytes: 50,
        decodedBytes: 5,
        firstSend: {
          type: 'stream.data',
          eventOrder: 1,
          elapsedMs: 0,
          encodedBytes: 50,
          decodedBytes: 5,
        },
      },
    ],
  });
  expect(parsed).toMatchObject({
    association,
    callbackMeaning: 'local_acceptance_not_peer_receipt',
    streams: [{ firstSend: { type: 'stream.data' } }],
  });
  expect(
    recordingCoreRecordSchema.safeParse({
      ...core,
      association: { ...association, uplinkConnectionId: association.socketLifetimeId },
    }).success,
  ).toBe(false);
});
