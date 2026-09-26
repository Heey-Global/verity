jest.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(16).fill(7) }));

import { requestRemoteControlAdmission } from './remoteControlAdmission';

class FakeSocket {
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function start(signal?: AbortSignal) {
  const socket = new FakeSocket();
  const pending = requestRemoteControlAdmission({
    uplinkOrigin: 'https://uplink.example',
    installationHandle: 'handle_one',
    ...(signal ? { signal } : {}),
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
