import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RemoteReturnPathDiagnostics,
  RETURN_PATH_LIMITS,
  returnPathSelection,
  selectedReturnPathExpiry,
} from './remote-return-path-diagnostics.js';

const frame = {
  type: 'stream.data',
  streamId: 'target',
  seq: 0,
  payload: 'secret-ticket',
  headers: 'secret-header',
};
describe('return-path diagnostics', () => {
  it('preserves target callback totals after trace eviction without copying secrets', () => {
    const diagnostics = new RemoteReturnPathDiagnostics('session');
    diagnostics.record('send', 'observed', frame, 100, 20);
    for (let i = 0; i < RETURN_PATH_LIMITS.events + 1; i++)
      diagnostics.record('emitted_message', 'observed');
    diagnostics.record('callback', 'accepted', frame, 100, 20);
    expect(diagnostics.snapshot()).toMatchObject({
      droppedEvents: RETURN_PATH_LIMITS.events + 3 - RETURN_PATH_LIMITS.events / 2,
      streams: [
        {
          stream: createHash('sha256').update('target').digest('hex').slice(0, 16),
          enqueuedFrames: 1,
          completedFrames: 1,
          firstSend: { seq: 0 },
          firstCallback: { seq: 0, outcome: 'accepted' },
          errorFrames: 0,
          encodedBytes: 100,
          decodedBytes: 20,
        },
      ],
    });
    const serialized = JSON.stringify(diagnostics.snapshot());
    for (const secret of ['secret-ticket', 'secret-header', 'target', '"session":"session"'])
      expect(serialized).not.toContain(secret);
  });
  it('bounds stream attribution and explicitly reports overflow', () => {
    const diagnostics = new RemoteReturnPathDiagnostics('session');
    for (let i = 0; i < RETURN_PATH_LIMITS.streams + 1; i++)
      diagnostics.record('send', 'observed', { ...frame, streamId: `stream${i}` });
    expect(diagnostics.snapshot()).toMatchObject({ droppedStreams: 1 });
    expect(diagnostics.snapshot().streams).toHaveLength(RETURN_PATH_LIMITS.streams);
  });
  it('uses independent generations and preserves event order and callback failures', () => {
    const first = new RemoteReturnPathDiagnostics('same');
    const second = new RemoteReturnPathDiagnostics('same');
    first.record('send', 'observed', frame);
    first.record('close', 'observed');
    first.record('callback', 'error', frame);
    expect(first.snapshot().generation).not.toBe(second.snapshot().generation);
    expect(first.snapshot()).toMatchObject({
      streams: [{ errorFrames: 1 }],
      events: [{ eventOrder: 1 }, { eventOrder: 2 }, { eventOrder: 3 }],
    });
  });
  it('records only allowlisted errors and frame metadata', () => {
    const diagnostics = new RemoteReturnPathDiagnostics('session');
    diagnostics.record(
      'ws_error',
      'error',
      { type: 'secret', streamId: 'invalid secret', seq: -1 },
      0,
      0,
      { code: 'secret-code', message: 'secret-message' },
    );
    diagnostics.record('ws_error', 'error', undefined, 0, 0, { code: 'ECONNRESET' });
    const serialized = JSON.stringify(diagnostics.snapshot());
    expect(serialized).not.toContain('secret');
    expect(serialized).toContain('ECONNRESET');
    expect(diagnostics.snapshot()).toMatchObject({
      events: [{ type: 'unknown', errorCode: 'unknown' }, { errorCode: 'ECONNRESET' }],
    });
  });
  it('exports each buffered event once and reserves final summary capacity', () => {
    const diagnostics = new RemoteReturnPathDiagnostics('session');
    diagnostics.record('send', 'observed', frame);
    expect(diagnostics.exportSummary()?.events).toHaveLength(1);
    expect(diagnostics.exportSummary()?.events).toHaveLength(0);
    for (let i = 0; i < RETURN_PATH_LIMITS.events; i++) diagnostics.exportSummary();
    expect(diagnostics.exportSummary()).toBeUndefined();
    expect(diagnostics.exportSummary(true)).toMatchObject({ stage: 'summary' });
    expect(diagnostics.exportSummary(true)).toBeUndefined();
  });
  it('enables only the authenticated selected installation while consent is live', () => {
    const selection = { installationId: 'selected', expiresAt: 1000 };
    expect(
      selectedReturnPathExpiry(selection, { enabled: true, installationId: 'selected' }, 999),
    ).toBe(1000);
    expect(
      selectedReturnPathExpiry(selection, { enabled: true, installationId: 'other' }, 999),
    ).toBeUndefined();
    expect(
      selectedReturnPathExpiry(selection, { enabled: false, installationId: 'selected' }, 999),
    ).toBeUndefined();
    expect(
      selectedReturnPathExpiry(selection, { enabled: true, installationId: 'selected' }, 1000),
    ).toBeUndefined();
    expect(
      selectedReturnPathExpiry(undefined, { enabled: true, installationId: 'selected' }, 999),
    ).toBeUndefined();
  });
  it.each(['1', '2026-10-11T12:00:00', '2026-10-11T12:00:00+02:00', '2026-02-30T12:00:00Z'])(
    'rejects ambiguous or normalized expiry %s',
    (expiry) => {
      expect(() =>
        returnPathSelection({
          VERITY_RETURN_PATH_INSTALLATION_ID: 'id',
          VERITY_RETURN_PATH_EXPIRES_AT: expiry,
        }),
      ).toThrow();
    },
  );
  it('requires explicit installation and absolute bounded expiry', () => {
    const now = Date.now();
    expect(returnPathSelection({}, now)).toBeUndefined();
    expect(() => returnPathSelection({ VERITY_RETURN_PATH_INSTALLATION_ID: 'id' }, now)).toThrow();
    expect(() =>
      returnPathSelection(
        {
          VERITY_RETURN_PATH_INSTALLATION_ID: 'id',
          VERITY_RETURN_PATH_EXPIRES_AT: new Date(
            now + RETURN_PATH_LIMITS.durationMs + 1,
          ).toISOString(),
        },
        now,
      ),
    ).toThrow();
    const expiresAt = now + RETURN_PATH_LIMITS.durationMs;
    expect(
      returnPathSelection(
        {
          VERITY_RETURN_PATH_INSTALLATION_ID: 'id',
          VERITY_RETURN_PATH_EXPIRES_AT: new Date(expiresAt).toISOString(),
        },
        now,
      ),
    ).toEqual({ installationId: 'id', expiresAt });
    expect(
      returnPathSelection(
        {
          VERITY_RETURN_PATH_INSTALLATION_ID: 'id',
          VERITY_RETURN_PATH_EXPIRES_AT: new Date(expiresAt).toISOString(),
        },
        expiresAt + 1,
      )?.expiresAt,
    ).toBeLessThan(expiresAt + 1);
  });
});
