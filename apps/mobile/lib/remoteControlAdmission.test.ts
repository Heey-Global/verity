jest.mock('expo-crypto', () => ({
  getRandomBytes: () => new Uint8Array(16).fill(7),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    require('node:crypto').createHash('sha256').update(value).digest('hex'),
}));

import { createHash } from 'node:crypto';
import {
  requestRemoteControlAdmission,
  type RemoteAdmissionOptions,
} from './remoteControlAdmission';

class FakeSocket {
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown, code?: number): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, code });
  }
}

function start(
  signal?: AbortSignal,
  diagnosticArming?: RemoteAdmissionOptions['diagnosticArming'],
) {
  const socket = new FakeSocket();
  const pending = requestRemoteControlAdmission({
    uplinkOrigin: 'https://uplink.example',
    installationHandle: 'handle_one',
    ...(signal ? { signal } : {}),
    ...(diagnosticArming ? { diagnosticArming } : {}),
    socketFactory: (url) => {
      expect(url).toBe('wss://uplink.example/remote-control');
      return socket as unknown as WebSocket;
    },
  });
  socket.emit('open');
  const connect = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
  return { socket, pending, connect };
}

describe('remote admission', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  it('keeps admission open until the data attachment completes', async () => {
    const { socket, pending, connect } = start();
    expect(connect).toMatchObject({
      type: 'connect',
      installationHandle: 'handle_one',
      capabilities: ['remote-control-v1'],
    });
    expect(connect.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    socket.emit(
      'message',
      JSON.stringify({
        type: 'connect.ready',
        requestId: connect.requestId,
        sessionId: 'session_one',
        ticket: 'app_ticket',
        expiresAt: Date.now() + 60_000,
        capability: 'remote-control-v1',
      }),
    );
    const admission = await pending;
    expect(socket.closed).toBe(false);
    expect(admission).toMatchObject({ sessionId: 'session_one', ticket: 'app_ticket' });
    expect(console.info).toHaveBeenCalledWith('Remote Control admission ready', {
      requestId: connect.requestId,
      sessionId: 'session_one',
      elapsedMs: expect.any(Number),
    });
    expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toContain('app_ticket');
    admission.finish();
    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(1);
  });

  it('cancels a pending request without keeping its ticket', async () => {
    const controller = new AbortController();
    const { socket, pending, connect } = start(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(socket.sent[1]).toBe(
      JSON.stringify({ type: 'connect.cancel', requestId: connect.requestId }),
    );
    expect(socket.closed).toBe(true);
  });

  it('rejects mismatched and malformed responses', async () => {
    const { socket, pending } = start();
    socket.emit(
      'message',
      JSON.stringify({
        type: 'connect.ready',
        requestId: 'another_request',
        sessionId: 'session_one',
        ticket: 'app_ticket',
        expiresAt: Date.now() + 60_000,
        capability: 'remote-control-v1',
      }),
    );
    await expect(pending).rejects.toThrow('Invalid remote admission response');
    expect(socket.closed).toBe(true);
  });

  it('reports a matching service refusal without exposing a ticket', async () => {
    const { socket, pending, connect } = start();
    socket.emit(
      'message',
      JSON.stringify({ type: 'connect.error', requestId: connect.requestId, code: 'unavailable' }),
    );
    await expect(pending).rejects.toThrow('Remote admission failed: unavailable');
    expect(console.warn).toHaveBeenCalledWith('Remote Control admission failed', {
      requestId: connect.requestId,
      opened: true,
      elapsedMs: expect.any(Number),
      reason: 'Remote admission failed: unavailable.',
    });
    expect(socket.closed).toBe(true);
  });

  it('rejects an origin that could redirect admission', () => {
    expect(() =>
      requestRemoteControlAdmission({
        uplinkOrigin: 'https://uplink.example/control?target=other',
        installationHandle: 'handle_one',
      }),
    ).toThrow('HTTPS Uplink origin');
  });
});

describe('selected recording admission hold', () => {
  const runId = '00000000-0000-4000-8000-000000000002';
  const installationFingerprint = 'a'.repeat(16);
  const confirmation = () => ({
    runId,
    phase: 'starting',
    installationFingerprint,
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    selection: {
      confirmed: true,
      sessionHash: createHash('sha256').update('selected').digest('hex').slice(0, 16),
      preparationExpiresAt: new Date(Date.now() + 15000).toISOString(),
    },
  });
  const deliver = (f: ReturnType<typeof start>) =>
    f.socket.emit(
      'message',
      JSON.stringify({
        type: 'connect.ready',
        requestId: f.connect.requestId,
        sessionId: 'selected',
        ticket: 'private-ticket',
        expiresAt: Date.now() + 60000,
        capability: 'remote-control-v1',
      }),
    );
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('does not release the App ticket before a matching confirmed preparing ACK', async () => {
    let release!: (value: unknown) => void;
    const arm = jest.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const f = start(undefined, { runId, installationFingerprint, arm });
    const attached = jest.fn();
    const pending = f.pending.then((value) => {
      attached();
      return value;
    });
    deliver(f);
    await Promise.resolve();
    await Promise.resolve();
    expect(arm).toHaveBeenCalledWith('selected', expect.any(AbortSignal));
    expect(attached).not.toHaveBeenCalled();
    expect(f.socket.closed).toBe(false);
    release(confirmation());
    const admission = await pending;
    expect(admission.ticket).toBe('private-ticket');
    expect(attached).toHaveBeenCalledTimes(1);
    admission.finish();
  });
  it.each(['before-arm', 'during-arm'])(
    'accepts normal broker completion %s without releasing the ticket early',
    async (timing) => {
      let release!: (value: unknown) => void;
      let armSignal!: AbortSignal;
      const arm = jest.fn(async (_session, signal: AbortSignal) => {
        armSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const f = start(undefined, { runId, installationFingerprint, arm });
      const settled = jest.fn();
      void f.pending.then(settled, settled);
      deliver(f);
      if (timing === 'during-arm') {
        await Promise.resolve();
        await Promise.resolve();
      }
      f.socket.emit('close', undefined, 1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(arm).toHaveBeenCalledTimes(1);
      expect(armSignal.aborted).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      release(confirmation());
      const admission = await f.pending;
      expect(admission.ticket).toBe('private-ticket');
      admission.finish();
      expect(f.socket.sent).toHaveLength(1);
    },
  );
  it('rejects normal close before a validated ready reply', async () => {
    const arm = jest.fn();
    const f = start(undefined, { runId, installationFingerprint, arm });
    f.socket.emit('close', undefined, 1000);
    await expect(f.pending).rejects.toThrow('connection closed');
    expect(arm).not.toHaveBeenCalled();
  });
  it('rejects abnormal broker close during arming', async () => {
    let signal!: AbortSignal;
    const f = start(undefined, {
      runId,
      installationFingerprint,
      arm: async (_id, abort) => {
        signal = abort;
        return new Promise(() => {});
      },
    });
    deliver(f);
    await Promise.resolve();
    await Promise.resolve();
    f.socket.emit('close', undefined, 1006);
    await expect(f.pending).rejects.toThrow('connection closed');
    expect(signal.aborted).toBe(true);
  });
  it.each([
    'foreign_session',
    'foreign_installation',
    'foreign_run',
    'missing_confirmation',
    'already_recording',
  ])('cancels instead of releasing DATA for %s', async (kind) => {
    const receipt = confirmation();
    if (kind === 'foreign_session') receipt.selection.sessionHash = 'f'.repeat(16);
    if (kind === 'foreign_installation') receipt.installationFingerprint = 'f'.repeat(16);
    if (kind === 'foreign_run') receipt.runId = '00000000-0000-4000-8000-000000000099';
    if (kind === 'missing_confirmation') receipt.selection.confirmed = false;
    if (kind === 'already_recording') receipt.phase = 'recording';
    const f = start(undefined, { runId, installationFingerprint, arm: async () => receipt });
    deliver(f);
    await expect(f.pending).rejects.toThrow('arming unconfirmed');
    expect(f.socket.closed).toBe(true);
    expect(JSON.parse(f.socket.sent.at(-1)!)).toMatchObject({ type: 'connect.cancel' });
  });
  it.each([false, true])(
    'bounds lost ACKs and ignores late confirmation (broker closed: %s)',
    async (brokerClosed) => {
      jest.useFakeTimers();
      let release!: (value: unknown) => void;
      let signal!: AbortSignal;
      const f = start(undefined, {
        runId,
        installationFingerprint,
        arm: async (_id, abort) => {
          signal = abort;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      const assertion = expect(f.pending).rejects.toThrow('arming timed out');
      deliver(f);
      await Promise.resolve();
      await Promise.resolve();
      if (brokerClosed) f.socket.emit('close', undefined, 1000);
      await jest.advanceTimersByTimeAsync(15000);
      await assertion;
      expect(signal.aborted).toBe(true);
      release(confirmation());
      await Promise.resolve();
      expect(f.socket.closed).toBe(true);
    },
  );
  it.each([false, true])(
    'cancels arming on Stop and ignores late confirmation (broker closed: %s)',
    async (brokerClosed) => {
      const controller = new AbortController();
      let release!: (value: unknown) => void;
      let signal!: AbortSignal;
      const f = start(controller.signal, {
        runId,
        installationFingerprint,
        arm: async (_id, abort) => {
          signal = abort;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      deliver(f);
      await Promise.resolve();
      await Promise.resolve();
      if (brokerClosed) f.socket.emit('close', undefined, 1000);
      controller.abort();
      await expect(f.pending).rejects.toThrow('cancelled');
      expect(signal.aborted).toBe(true);
      release(confirmation());
      await Promise.resolve();
      expect(f.socket.closed).toBe(true);
    },
  );
});
