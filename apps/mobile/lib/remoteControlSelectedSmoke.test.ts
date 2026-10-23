const mockAdminFetch = jest.fn();
const mockPinnedFetch = jest.fn((_pin: string, _remote: boolean) => mockAdminFetch);
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch: (pin: string, remote: boolean) => mockPinnedFetch(pin, remote),
}));
const mockRequestOnce = jest.fn();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({ requestOnce: mockRequestOnce }),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytes: () => new Uint8Array(16).fill(7),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    require('node:crypto').createHash('sha256').update(value).digest('hex'),
}));
import { createHash } from 'node:crypto';
import { createPairedSelectedRecordingArming } from './selectedRecordingArming';
import { remoteControlSmokeGet } from './remoteControlSmoke';
class Socket {
  sent: string[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {}
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}
it('keeps the native DATA request behind actual admission confirmation', async () => {
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const socket = new Socket();
  const runId = '00000000-0000-4000-8000-000000000002';
  const installationFingerprint = 'a'.repeat(16);
  let release!: (value: unknown) => void;
  mockAdminFetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  mockRequestOnce.mockResolvedValue({ status: 200, bodyBase64: 'b2s=' });
  try {
    const pending = remoteControlSmokeGet({
      uplinkOrigin: 'https://uplink.example',
      installationHandle: 'handle_one',
      coreUrl: 'https://core.example',
      corePin: 'paired-pin',
      socketFactory: () => socket as unknown as WebSocket,
      diagnosticArming: createPairedSelectedRecordingArming({
        coreUrl: 'https://core.example',
        corePin: 'paired-pin',
        getToken: () => 'paired-admin-token',
        runId,
        installationFingerprint,
        durationMs: 30000,
      }),
    });
    socket.emit('open');
    const request = JSON.parse(socket.sent[0]!);
    socket.emit(
      'message',
      JSON.stringify({
        type: 'connect.ready',
        requestId: request.requestId,
        sessionId: 'selected',
        ticket: 'private-ticket',
        expiresAt: Date.now() + 60000,
        capability: 'remote-control-v1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRequestOnce).not.toHaveBeenCalled();
    expect(mockPinnedFetch).toHaveBeenCalledWith('paired-pin', false);
    expect(mockAdminFetch).toHaveBeenCalledWith(
      'https://core.example/api/remote-control/recordings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer paired-admin-token' }),
        body: JSON.stringify({
          runId,
          durationMs: 30000,
          diagnosticsVersion: 3,
          targetSessionId: 'selected',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    release({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        startedAt: new Date().toISOString(),
        core: { state: 'recording', records: 0, dropped: 0 },
        uplink: { state: 'recording' },
        error: null,
        runId,
        phase: 'starting',
        installationFingerprint,
        expiresAt: new Date(Date.now() + 45000).toISOString(),
        selection: {
          confirmed: true,
          sessionHash: createHash('sha256').update('selected').digest('hex').slice(0, 16),
          preparationExpiresAt: new Date(Date.now() + 15000).toISOString(),
          readiness: null,
        },
      }),
    });
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(mockRequestOnce).toHaveBeenCalledTimes(1);
  } finally {
    info.mockRestore();
  }
});
