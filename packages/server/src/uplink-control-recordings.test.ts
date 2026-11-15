import { readFileSync as readEvidenceFixture } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { VeritySettingsPatch, EventStore } from '@verity/store';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import {
  UplinkControlClient,
  UPLINK_CONTROL_URL,
  type RemoteConnectorRequest,
  type RemoteConnectorReservation,
} from './uplink-control-client.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason ?? ''));
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
  });
  ping = vi.fn();
  send(value: string, callback?: (error?: Error) => void): void {
    this.sent.push(value);
    callback?.();
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  message(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

function setup(
  options: {
    restoreShareIds?: () => Promise<string[]>;
    readError?: Error;
    settingsRead?: Promise<{ uplinkSubscriptionKey: string; uplinkInstallationId: null }>;
    pendingRemovals?: string[];
    disableFeatures?: (reason: string) => Promise<void>;
    installationId?: string;
    premiumSharingEnabled?: boolean;
    premiumRemoteAccessEnabled?: boolean;
    expectedInstallationId?: string;
    url?: string;
    offerRemoteControl?: boolean;
    offerTeam?: boolean;
    reserveRemoteConnector?: (
      request: RemoteConnectorRequest,
      signal: AbortSignal,
    ) => Promise<RemoteConnectorReservation | 'unavailable' | 'limit_reached'>;
  } = {},
) {
  const socket = new FakeSocket();
  const settings: {
    uplinkSubscriptionKey: string;
    uplinkInstallationId: string | null;
    premiumSharingEnabled?: boolean;
    premiumRemoteAccessEnabled?: boolean;
  } = {
    uplinkSubscriptionKey: 'subscription-fixture',
    uplinkInstallationId: options.installationId ?? null,
    ...(options.premiumSharingEnabled !== undefined
      ? { premiumSharingEnabled: options.premiumSharingEnabled }
      : {}),
    ...(options.premiumRemoteAccessEnabled !== undefined
      ? { premiumRemoteAccessEnabled: options.premiumRemoteAccessEnabled }
      : {}),
  };
  const store = {
    getVeritySettings: vi.fn(async () => {
      if (options.readError) throw options.readError;
      if (options.settingsRead) return options.settingsRead;
      return settings;
    }),
    updateVeritySettings: vi.fn(async (patch: VeritySettingsPatch) => ({ ...settings, ...patch })),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => options.pendingRemovals ?? []),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
  const disabled = vi.fn(options.disableFeatures ?? (async () => undefined));
  const expired = vi.fn(async () => undefined);
  const pinLocked = vi.fn(async () => undefined);
  const socketFactory = vi.fn(() => socket as unknown as WebSocket);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new UplinkControlClient({
    url: options.url ?? UPLINK_CONTROL_URL,
    ...(options.expectedInstallationId === undefined
      ? {}
      : { expectedInstallationId: options.expectedInstallationId }),
    store: store as unknown as EventStore & typeof store,
    serverVersion: 'test',
    restoreShareIds: options.restoreShareIds ?? (async () => ['existing-share']),
    webSocketFactory: socketFactory,
    onFeaturesDisabled: disabled,
    onShareExpired: expired,
    onSharePinLocked: pinLocked,
    ...(options.offerRemoteControl !== undefined
      ? { offerRemoteControl: options.offerRemoteControl }
      : {}),
    ...(options.offerTeam !== undefined ? { offerTeam: options.offerTeam } : {}),
    ...(options.reserveRemoteConnector
      ? { reserveRemoteConnector: options.reserveRemoteConnector }
      : {}),
    log,
  });
  return { client, socket, socketFactory, store, settings, disabled, expired, pinLocked, log };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

describe('coordinated Uplink recordings', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  async function ready(capability: boolean | 2 | 3 = true) {
    const fixture = setup({
      offerRemoteControl: true,
      reserveRemoteConnector: vi.fn(async () => ({
        diagnosticId: runId,
        attach: async () => {},
        release: () => {},
      })),
    });
    fixture.client.start();
    await flush();
    fixture.socket.open();
    fixture.socket.message({
      type: 'welcome',
      installationId: 'installation-1',
      handle: Buffer.alloc(16, 7).toString('base64url'),
      features: ['sharing', 'remote-control'],
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
      capabilities: [
        'remote-control-v1',
        ...(capability ? ['remote-diagnostics-v1'] : []),
        ...(capability === 2 ? ['remote-diagnostics-v2'] : []),
        ...(capability === 3 ? ['remote-diagnostics-v3'] : []),
      ],
      channels: ['http', 'ws', 'remote'],
    });
    await flush();
    return fixture;
  }
  function reply(socket: FakeSocket, fields: Record<string, unknown> = {}) {
    const request = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    socket.message({
      type: 'diagnostics.started',
      requestId: request.requestId,
      runId,
      state: 'recording',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      retainedUntil: new Date(Date.now() + 3600000).toISOString(),
      collectorReady: true,
      recordCount: 0,
      droppedRecords: 0,
      ...fields,
    });
    return request;
  }
  it('requires negotiated capture support and leaves old Uplinks untouched', async () => {
    const { client, socket } = await ready(false);
    await expect(client.startRecording(runId, 120000)).rejects.toThrow('diagnostics_not_available');
    expect(socket.sent.some((raw) => raw.includes('diagnostics.start'))).toBe(false);
    await client.stop();
  });
  it('sends an installation-bound request and waits for the armed acknowledgement', async () => {
    const { client, socket } = await ready();
    const pending = client.startRecording(runId, 120000);
    const request = reply(socket);
    expect(request).toEqual({
      type: 'diagnostics.start',
      requestId: expect.any(String),
      runId,
      durationMs: 120000,
    });
    await expect(pending).resolves.toBeUndefined();
    await client.stop();
  });
  it.each([
    { runId: '22222222-2222-4222-8222-222222222222' },
    { collectorReady: false },
    { state: 'stopped' },
    { recordCount: -1 },
    { payload: 'x'.repeat(33000) },
  ])('rejects malformed or mismatched acknowledgement %j', async (fields) => {
    const { client, socket } = await ready();
    const pending = client.startRecording(runId, 120000);
    reply(socket, fields);
    await expect(pending).rejects.toThrow();
    await client.stop();
  });
  it('bounds a lost acknowledgement and ignores its late response', async () => {
    vi.useFakeTimers();
    const { client, socket } = await ready();
    const pending = client.startRecording(runId, 120000);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    reply(socket);
    await flush();
    expect(socket.close).not.toHaveBeenCalled();
    await client.stop();
    vi.useRealTimers();
  });
  it('projects a stopped paginated export and rejects a stalled cursor', async () => {
    const { client, socket } = await ready();
    const event = {
      event: 'remote.return_path',
      schemaVersion: 1,
      session: '0000000000000000',
      generation: '1111111111111111',
      party: 'installation',
      direction: 'in',
      stage: 'emitted_message',
      outcome: 'observed',
      eventOrder: 1,
      elapsedMs: 3,
      encodedBytes: 100,
      payload: 'secret',
    };
    const dates = {
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      retainedUntil: new Date(Date.now() + 3600000).toISOString(),
    };
    const pending = client.exportRecording(runId);
    reply(socket, {
      ...dates,
      type: 'diagnostics.exported',
      state: 'stopped',
      cursor: 0,
      nextCursor: 1,
      recordCount: 2,
      records: [event],
    });
    await flush();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'diagnostics.export',
      cursor: 1,
    });
    reply(socket, {
      ...dates,
      type: 'diagnostics.exported',
      state: 'stopped',
      cursor: 1,
      nextCursor: null,
      recordCount: 2,
      records: [{ ...event, eventOrder: 2 }],
    });
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toMatchObject({
      recordCount: 2,
      records: [{ eventOrder: 1 }, { eventOrder: 2 }],
    });
    const stalled = client.exportRecording(runId);
    reply(socket, {
      type: 'diagnostics.exported',
      state: 'stopped',
      cursor: 0,
      nextCursor: 0,
      recordCount: 1,
      records: [],
    });
    await expect(stalled).rejects.toThrow('invalid_diagnostics_cursor');
    await client.stop();
  });
  it('pins v2, verifies a paginated golden export and rejects modified evidence', async () => {
    const fixture = JSON.parse(
      readEvidenceFixture(
        new URL('../../events/src/fixtures/socket-evidence-v2.json', import.meta.url),
        'utf8',
      ),
    ) as {
      document: { runId: string; records: unknown[] } & Record<string, unknown>;
      exportHash: string;
    };
    const { client, socket } = await ready(2);
    const id = fixture.document.runId;
    const start = client.startRecording(id, 120000, 2);
    const request = reply(socket, {
      ...fixture.document,
      records: undefined,
      runId: id,
      state: 'recording',
      endedAt: null,
      stopReason: null,
      exportHash: null,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    expect(request.diagnosticsVersion).toBe(2);
    await start;
    const sendPage = (cursor: number, nextCursor: number | null, exportHash = fixture.exportHash) =>
      reply(socket, {
        ...fixture.document,
        type: 'diagnostics.exported',
        exportHash,
        cursor,
        nextCursor,
        records: fixture.document.records.slice(cursor, cursor + 1),
      });
    const pending = client.exportRecording(id);
    sendPage(0, 1);
    await flush();
    sendPage(1, null);
    await expect(pending).resolves.toEqual({ ...fixture.document, exportHash: fixture.exportHash });
    const corrupted = client.exportRecording(id);
    sendPage(0, 1, '0'.repeat(64));
    await flush();
    sendPage(1, null, '0'.repeat(64));
    await expect(corrupted).rejects.toThrow('invalid_diagnostics_hash');
    const mutated = client.exportRecording(id);
    const first = fixture.document.records[0] as Record<string, unknown>;
    reply(socket, {
      ...fixture.document,
      type: 'diagnostics.exported',
      exportHash: fixture.exportHash,
      cursor: 0,
      nextCursor: 1,
      records: [{ ...first, lagMs: 1 }],
    });
    await flush();
    sendPage(1, null);
    await expect(mutated).rejects.toThrow('invalid_diagnostics_hash');
    const changed = client.exportRecording(id);
    sendPage(0, 1);
    await flush();
    sendPage(1, null, '0'.repeat(64));
    await expect(changed).rejects.toThrow('diagnostics_export_changed');
    await expect(client.startRecording(id, 120000, 1)).rejects.toThrow(
      'diagnostics_version_conflict',
    );
    await client.stop();
  });
  it('pins v3 selection, returns authoritative status and rejects changed paginated metadata', async () => {
    const { createHash } = await import('node:crypto');
    const { canonicalEvidenceJson } = await import('@verity/events');
    const fixture = JSON.parse(
      readEvidenceFixture(
        new URL('../../events/src/fixtures/socket-evidence-v3.json', import.meta.url),
        'utf8',
      ),
    ) as {
      document: { runId: string; records: Record<string, unknown>[] } & Record<string, unknown>;
      preparing: Record<string, unknown>;
      ready: Record<string, unknown>;
    };
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(fixture.preparing.startedAt as string));
    const { client, socket } = await ready(3);
    const target = 'selected-session';
    const targetSession = createHash('sha256').update(target).digest('hex').slice(0, 16);
    const document = {
      ...fixture.document,
      targetSession,
      records: fixture.document.records.map((record) => ({ ...record, session: targetSession })),
    };
    const exportHash = createHash('sha256').update(canonicalEvidenceJson(document)).digest('hex');
    const id = document.runId;
    socket.message({
      type: 'session.request',
      requestId: 'selected_request',
      sessionId: target,
      capability: 'remote-control-v1',
      decisionExpiresAt: Date.now() + 15000,
    });
    await flush();
    socket.message({
      type: 'session.ticket',
      sessionId: target,
      ticket: 'ticket',
      expiresAt: Date.now() + 15000,
      capability: 'remote-control-v1',
    });
    await flush();
    const start = client.startRecording(id, 30000, 3, target);
    const request = reply(socket, {
      ...fixture.preparing,
      requestId: JSON.parse(socket.sent.at(-1)!).requestId,
      targetSession,
    });
    expect(request).toMatchObject({
      diagnosticsVersion: 3,
      targetSessionId: target,
      durationMs: 30000,
    });
    await start;
    const status = client.recordingStatus(id);
    reply(socket, {
      ...fixture.ready,
      requestId: JSON.parse(socket.sent.at(-1)!).requestId,
      targetSession,
    });
    await expect(status).resolves.toMatchObject({
      version: 3,
      targetSession,
      readiness: { ready: true },
    });
    const page = (cursor: number, changed = false) =>
      reply(socket, {
        ...document,
        type: 'diagnostics.exported',
        exportHash,
        cursor,
        nextCursor: cursor === 0 ? 3 : null,
        records: document.records.slice(cursor, cursor + 3),
        ...(changed ? { burstStartedAt: fixture.document.startedAt } : {}),
      });
    const exported = client.exportRecording(id);
    page(0);
    await flush();
    page(3);
    await expect(exported).resolves.toEqual({ ...document, exportHash });
    const changed = client.exportRecording(id);
    page(0);
    await flush();
    page(3, true);
    await expect(changed).rejects.toThrow('diagnostics_export_changed');
    const wrong = client.recordingStatus(id);
    reply(socket, { ...fixture.ready, requestId: JSON.parse(socket.sent.at(-1)!).requestId });
    await expect(wrong).rejects.toThrow('diagnostics_selection_mismatch');
    await expect(client.startRecording(id, 30000, 3, 'other-target')).rejects.toThrow(
      'diagnostics_version_conflict',
    );
    await client.stop();
    vi.useRealTimers();
  });
  it('does not silently downgrade v3 on a v2 peer', async () => {
    const { client, socket } = await ready(2);
    await expect(client.startRecording(runId, 30000, 3, 'target')).rejects.toThrow(
      'diagnostics_version_unavailable',
    );
    expect(socket.sent.some((raw) => raw.includes('diagnostics.start'))).toBe(false);
    await client.stop();
  });
  it('does not silently downgrade an explicit v2 request on an old Uplink', async () => {
    const { client, socket } = await ready();
    await expect(client.startRecording(runId, 120000, 2)).rejects.toThrow(
      'diagnostics_version_unavailable',
    );
    expect(socket.sent.some((raw) => raw.includes('diagnostics.start'))).toBe(false);
    await client.stop();
  });
});
