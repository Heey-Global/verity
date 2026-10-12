import { describe, expect, it } from 'vitest';
import { recordingTransportState } from '../../packages/server/src/recording-transport-state.js';
import { RemoteReturnPathDiagnostics } from '../../packages/server/src/remote-return-path-diagnostics.js';
import { projectCoreRecording, MAX_INPUT_BYTES } from './project-core-recording.mjs';

function emittedSummary(): Record<string, unknown> & {
  transport: ReturnType<typeof recordingTransportState>;
} {
  const recorder = new RemoteReturnPathDiagnostics('test-session');
  recorder.record(
    'send',
    'accepted',
    { type: 'stream.data', streamId: 'A'.repeat(32), seq: 0 },
    42,
    10,
  );
  recorder.record(
    'callback',
    'accepted',
    { type: 'stream.data', streamId: 'A'.repeat(32), seq: 0 },
    42,
    10,
  );
  recorder.record('close_requested', 'observed');
  return { ...recorder.exportSummary()!, transport: recordingTransportState(undefined) };
}

describe('Core recording projection', () => {
  it('reads actual emitted summaries through Pino and Docker envelopes', () => {
    const record = emittedSummary();
    const pino = {
      ...record,
      time: Date.now(),
      level: 30,
      msg: 'private logger text',
      hostname: 'private',
    };
    const result = projectCoreRecording(
      JSON.stringify(pino) + '\n' + JSON.stringify({ log: JSON.stringify(pino) + '\n' }),
    );
    expect(result.records).toEqual([
      { ...record, time: pino.time },
      { ...record, time: pino.time },
    ]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.records).toBe(2);
  });

  it('never copies unexpected fields at any observed nesting level', () => {
    const record = emittedSummary();
    const streams = record.streams as Record<string, unknown>[];
    const events = record.events as Record<string, unknown>[];
    const secret = 'canary-ticket-must-not-export';
    const injected = {
      ...record,
      authorization: secret,
      transport: { ...record.transport, payload: secret, remoteAddress: secret },
      lastCloseRequest: { eventOrder: 3, elapsedMs: 1, reason: secret },
      streams: streams.map((stream) => ({
        ...stream,
        payload: secret,
        firstSend: { ...(stream.firstSend as object), token: secret },
      })),
      events: events.map((event) => ({ ...event, url: secret })),
      lastError: { eventOrder: 1, elapsedMs: 1, errorCode: 'unknown', message: secret },
    };
    const result = projectCoreRecording(JSON.stringify(injected));
    expect(result.records).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('reports malformed lines and invalid diagnostic records instead of claiming absence', () => {
    const result = projectCoreRecording(
      'broken\n' +
        JSON.stringify({ ...emittedSummary(), session: 'raw-identifier' }) +
        '\n' +
        JSON.stringify({ event: 'unrelated' }),
    );
    expect(result.records).toEqual([]);
    expect(result.coverage).toMatchObject({
      invalidLines: 1,
      rejectedRecords: 1,
      ignoredLines: 1,
      complete: false,
    });
  });

  it('accepts older summaries and rejects malformed transport observations', () => {
    const { transport, lastCloseRequest, ...legacy } = emittedSummary();
    expect(projectCoreRecording(JSON.stringify(legacy)).records).toEqual([legacy]);
    expect(lastCloseRequest).not.toBeNull();
    for (const invalid of [
      { receiverState: 7 },
      { socketBytesRead: -1 },
      { socketPaused: 'private' },
    ]) {
      expect(
        projectCoreRecording(
          JSON.stringify({ ...emittedSummary(), transport: { ...transport, ...invalid } }),
        ).coverage.rejectedRecords,
      ).toBe(1);
    }
  });

  it('bounds input and rejects unsupported schemas', () => {
    expect(() => projectCoreRecording(' '.repeat(MAX_INPUT_BYTES + 1))).toThrow('input_too_large');
    expect(
      projectCoreRecording(JSON.stringify({ ...emittedSummary(), schemaVersion: 2 })).coverage
        .rejectedRecords,
    ).toBe(1);
  });
});
