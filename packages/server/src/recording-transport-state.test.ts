import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { recordingTransportState } from './recording-transport-state.js';
import { parseRecordingResponse } from './uplink-recording.js';
import {
  RemoteReturnPathDiagnostics,
  RETURN_PATH_LIMITS,
} from './remote-return-path-diagnostics.js';
import { coreRecordingSummary as recordingCoreRecordSchema } from './coordinated-recording-schema.js';

const runId = '11111111-1111-4111-8111-111111111111';

describe('recording transport state', () => {
  it('retains close intent after detail overflow and clears it for a new consent window', () => {
    const diagnostics = new RemoteReturnPathDiagnostics('synthetic');
    const observations = RETURN_PATH_LIMITS.events + 1;
    for (let i = 0; i < observations; i++) diagnostics.record('emitted_message', 'observed');
    diagnostics.record('close_requested', 'observed');
    const summary = diagnostics.exportSummary();
    expect(summary?.droppedEvents).toBeGreaterThan(0);
    expect(summary).toMatchObject({ lastCloseRequest: { eventOrder: observations + 1 } });
    diagnostics.beginWindow(Date.now() + 1000);
    expect(diagnostics.exportSummary()).toMatchObject({ lastCloseRequest: null });
  });

  it('distinguishes bytes received before message emission without changing read flow', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing address');
    const connecting = once(server, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    try {
      const [peer] = (await connecting) as [WebSocket];
      await once(client, 'open');
      const message = vi.fn();
      peer.on('message', message);
      const before = recordingTransportState(peer);
      client.send('private-fragment', { fin: false });
      await vi.waitFor(() => {
        const state = recordingTransportState(peer);
        expect(state.socketBytesRead).toBeGreaterThan(before.socketBytesRead!);
        expect(state.receiverFragmented).toBe(1);
        expect(state.receiverFin).toBe(false);
        expect(state.receiverMessageLength).toBeGreaterThan(0);
      });
      const state = recordingTransportState(peer);
      expect(message).not.toHaveBeenCalled();
      expect(state.socketPaused).toBe(false);
      expect(state.receiverNeedDrain).toBe(false);
      expect(JSON.stringify(state)).not.toMatch(/private|127\.0\.0\.1/);
      client.send('end', { fin: true });
      await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
      expect(recordingTransportState(peer).receiverFragmented).toBe(0);
      const closed = once(peer, 'close');
      client.close(1000);
      await closed;
      expect(recordingTransportState(peer)).toMatchObject({
        wsState: WebSocket.CLOSED,
        closeFrameSent: true,
        closeFrameReceived: true,
      });
    } finally {
      client.terminate();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps unsupported and malformed internals unknown and projects metadata only', () => {
    const missing = recordingTransportState(undefined);
    expect(missing).toEqual(
      JSON.parse(
        readFileSync(new URL('./fixtures/recording-transport.json', import.meta.url), 'utf8'),
      ),
    );
    expect(Object.values(missing).filter((value) => value !== null)).toEqual([1]);
    const state = recordingTransportState({
      _socket: {
        bytesRead: -1,
        bytesWritten: Number.POSITIVE_INFINITY,
        writableLength: 'private',
        isPaused: () => true,
        writableNeedDrain: true,
        remoteAddress: 'private-address',
      },
      _receiver: { _state: 99, _fragmented: 8, _buffers: ['private-payload'] },
    } as unknown as WebSocket);
    expect(state).toMatchObject({
      socketBytesRead: null,
      socketBytesWritten: null,
      socketWritableLength: null,
      socketPaused: true,
      socketNeedDrain: true,
      receiverState: null,
      receiverFragmented: null,
    });
    expect(JSON.stringify(state)).not.toContain('private');
  });

  it('does not let inaccessible runtime properties interrupt capture or invent plaintext', () => {
    const ws = {
      _socket: {
        get encrypted() {
          throw new Error('private');
        },
        get bytesRead() {
          throw new Error('private');
        },
        isPaused() {
          throw new Error('private');
        },
      },
      get _receiver() {
        throw new Error('private');
      },
    } as unknown as WebSocket;
    expect(recordingTransportState(ws)).toMatchObject({
      socketEncrypted: null,
      socketBytesRead: null,
      socketPaused: null,
      receiverState: null,
    });
  });

  it('retains transport through both export boundaries while excluding future private fields', () => {
    const transport = recordingTransportState(undefined);
    const core = new RemoteReturnPathDiagnostics('synthetic');
    core.record('close_requested', 'observed');
    const coreRecord = { ...core.exportSummary(), transport: { ...transport, payload: 'private' } };
    const parsedCore = recordingCoreRecordSchema.parse(coreRecord);
    expect(parsedCore.transport).toEqual(transport);
    expect(parsedCore.lastCloseRequest).toMatchObject({ eventOrder: 1 });
    expect(parsedCore.events).toEqual([]);
    const event = {
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
      transport: { ...transport, headers: 'private' },
    };
    const parsed = parseRecordingResponse(
      {
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
      },
      runId,
    );
    if (parsed.type !== 'diagnostics.exported') throw new Error('missing export');
    expect(parsed.records[0]?.transport).toEqual(transport);
    expect(JSON.stringify([parsedCore, parsed])).not.toContain('private');
    expect(
      recordingCoreRecordSchema.safeParse({
        ...coreRecord,
        transport: { ...transport, socketBytesRead: -1 },
      }).success,
    ).toBe(false);
  });
});
