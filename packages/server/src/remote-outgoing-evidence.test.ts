import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteConnectorPool } from './remote-control-connector.js';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import { CoordinatedRecordingManager } from './coordinated-recording.js';
import { coreRecordingSummary } from './coordinated-recording-schema.js';
import {
  RemoteReturnPathDiagnostics,
  RETURN_PATH_LIMITS,
} from './remote-return-path-diagnostics.js';

const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);
afterEach(() => vi.useRealTimers());

describe('bounded outgoing evidence', () => {
  it.each(['stream.data', 'stream.end', 'stream.reset', 'private-type'])(
    'retains %s classification through saturation and export without secrets',
    (type) => {
      const recorder = new RemoteReturnPathDiagnostics('private-session', Date.now() + 1000);
      for (let i = 0; i < RETURN_PATH_LIMITS.events; i++)
        recorder.record('emitted_message', 'observed');
      const frame = {
        type,
        streamId: 'private-stream',
        seq: 7,
        payload: 'private-payload',
        token: 'private-token',
      };
      recorder.record('send', 'observed', frame, 91, 12);
      recorder.record('callback', 'error', frame, 91, 12, { message: 'private-error' });
      const exported = coreRecordingSummary.parse(recorder.exportSummary());
      expect(exported.callbackMeaning).toBe('local_acceptance_not_peer_receipt');
      expect(exported.streams).toEqual([
        expect.objectContaining({
          stream: hash('private-stream'),
          enqueuedFrames: 1,
          completedFrames: 0,
          errorFrames: 1,
          firstSend: expect.objectContaining({
            type: type === 'private-type' ? 'unknown' : type,
            seq: 7,
            encodedBytes: 91,
            decodedBytes: 12,
          }),
          firstCallback: expect.objectContaining({
            type: type === 'private-type' ? 'unknown' : type,
            outcome: 'error',
            seq: 7,
          }),
        }),
      ]);
      expect(exported.events).toHaveLength(RETURN_PATH_LIMITS.events / 2);
      expect(exported.droppedEvents).toBeGreaterThan(0);
      expect(JSON.stringify(exported)).not.toContain('private');
    },
  );

  it('delivers retained frame classification through the coordinated support export', async () => {
    const activation = new ReturnPathActivation(() => ({
      enabled: true,
      installationId: 'installation',
    }));
    const manager = new CoordinatedRecordingManager(activation, {
      start: async () => {},
      stop: async () => {},
      export: async () => ({ records: [] }),
    });
    try {
      const runId = '01234567-0123-4123-8123-0123456789ab';
      await manager.start(runId, 60_000);
      const recorder = new RemoteReturnPathDiagnostics('session', Date.now() + 60_000);
      const frame = { type: 'stream.data', streamId: 'stream', seq: 3, payload: 'private' };
      recorder.record('send', 'observed', frame, 80, 4);
      recorder.record('callback', 'accepted', frame, 80, 4);
      manager.observe(recorder.exportSummary());
      await manager.stop(runId);
      const exported = await manager.export(runId);
      expect(exported).toMatchObject({
        core: {
          records: [
            expect.objectContaining({
              event: 'remote.return_path',
              callbackMeaning: 'local_acceptance_not_peer_receipt',
              streams: [
                expect.objectContaining({
                  firstSend: expect.objectContaining({ type: 'stream.data', seq: 3 }),
                  firstCallback: expect.objectContaining({
                    type: 'stream.data',
                    outcome: 'accepted',
                  }),
                }),
              ],
            }),
          ],
        },
      });
      expect(JSON.stringify(exported)).not.toContain('private');
    } finally {
      manager.dispose();
      activation.dispose();
    }
  });

  it('projects legacy summaries and strips untrusted added fields', () => {
    const recorder = new RemoteReturnPathDiagnostics('session');
    recorder.record('send', 'observed', { type: 'stream.data', streamId: 'stream' });
    const legacy = recorder.exportSummary()!;
    delete legacy.callbackMeaning;
    expect(coreRecordingSummary.safeParse(legacy).success).toBe(true);
    const projected = coreRecordingSummary.parse({ ...legacy, payload: 'secret' });
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('does not record callbacks or export after absolute expiry', () => {
    vi.useFakeTimers();
    const expiry = Date.now() + 1000;
    const recorder = new RemoteReturnPathDiagnostics('session', expiry);
    const frame = { type: 'stream.data', streamId: 'stream', seq: 0 };
    recorder.record('send', 'observed', frame);
    vi.setSystemTime(expiry);
    recorder.record('callback', 'accepted', frame);
    expect(recorder.exportSummary()).toBeUndefined();
    expect(recorder.snapshot()).toMatchObject({ streams: [{ completedFrames: 0 }] });
  });

  it.each([undefined, hash('selected'), hash('different')])(
    'filters exact sessions without changing no-selector behavior (%s)',
    async (selector) => {
      const snapshots: unknown[] = [];
      const expiry = Date.now() + 60_000;
      const pool = createRemoteConnectorPool({
        dataUrl: 'wss://uplink.example/data',
        localHost: '127.0.0.1',
        localPort: 443,
        returnPathExpiry: () => expiry,
        ...(selector === undefined ? {} : { returnPathSessionHash: selector }),
        onReturnPathSnapshot: (snapshot) => snapshots.push(snapshot),
      });
      const reservation = await pool.reserve(
        { requestId: 'request', sessionId: 'selected', decisionExpiresAt: Date.now() + 1000 },
        new AbortController().signal,
      );
      if (typeof reservation === 'string') throw new Error(reservation);
      expect(pool.diagnosticConnectorCount()).toBe(selector === hash('different') ? 0 : 1);
      reservation.release('test');
      expect(snapshots.length > 0).toBe(selector !== hash('different'));
      pool.disposeDiagnostics();
    },
  );

  it('keeps a reconnected different session silent and consent disabled after stop', async () => {
    let expiry: number | undefined = Date.now() + 60_000;
    const snapshots: unknown[] = [];
    const pool = createRemoteConnectorPool({
      dataUrl: 'wss://uplink.example/data',
      localHost: '127.0.0.1',
      localPort: 443,
      returnPathExpiry: () => expiry,
      returnPathSessionHash: hash('selected'),
      onReturnPathSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const reserve = async (sessionId: string) => {
      const reservation = await pool.reserve(
        { requestId: 'request', sessionId, decisionExpiresAt: Date.now() + 1000 },
        new AbortController().signal,
      );
      if (typeof reservation === 'string') throw new Error(reservation);
      return reservation;
    };
    const selected = await reserve('selected');
    selected.release('closed');
    const before = snapshots.length;
    const reconnected = await reserve('new-session');
    expect(pool.diagnosticConnectorCount()).toBe(0);
    reconnected.release('closed');
    expect(snapshots).toHaveLength(before);
    expiry = undefined;
    const disabled = await reserve('selected');
    expect(pool.diagnosticConnectorCount()).toBe(0);
    disabled.release('closed');
    expect(snapshots).toHaveLength(before);
    pool.disposeDiagnostics();
  });

  it('fails closed on wildcard or malformed session selectors', () => {
    for (const selector of ['', '*', 'first', 'A'.repeat(16), 'a'.repeat(17)])
      expect(() =>
        createRemoteConnectorPool({
          dataUrl: 'wss://uplink.example/data',
          localHost: '127.0.0.1',
          localPort: 443,
          returnPathSessionHash: selector,
        }),
      ).toThrow('session selector');
  });
});
