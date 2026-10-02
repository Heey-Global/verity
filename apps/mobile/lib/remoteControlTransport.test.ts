import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockAppStateListeners: Array<(state: string) => void> = [];
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.push(listener);
      return { remove: jest.fn() };
    },
  },
}));
const mockAdmission = jest.fn();
const mockProfile = jest.fn();
const mockToken = jest.fn();
const mockStart = jest.fn();
const mockIsActive = jest.fn();
const mockStop = jest.fn();
const mockRequest = jest.fn();
const mockCancelRequest = jest.fn();
const mockLastStopReason = jest.fn();
const mockDiagnosticSummary = jest.fn();
// Undefined models a native build that only speaks SOCKS; tests opt into the fallback.
let mockSetProxyMode: jest.Mock | undefined;

jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (...args: unknown[]) => mockAdmission(...args),
}));
jest.mock('./serverProfile', () => ({ getServerProfile: () => mockProfile() }));
jest.mock('./authToken', () => ({ getAuthToken: (...args: unknown[]) => mockToken(...args) }));
jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) =>
    name === 'VerityPinnedTransport'
      ? { request: mockRequest, cancelRequest: mockCancelRequest, setProxyMode: mockSetProxyMode }
      : {
          isSupported: async () => true,
          start: mockStart,
          isActive: mockIsActive,
          stop: mockStop,
          lastStopReason: mockLastStopReason,
          diagnosticSummary: mockDiagnosticSummary,
        },
}));

Object.defineProperty(globalThis, 'Response', {
  configurable: true,
  value: class TestResponse {},
});
Object.defineProperty(globalThis, 'Headers', {
  configurable: true,
  value: class TestHeaders {},
});
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: jest.fn(),
});

afterEach(() => {
  mockSetProxyMode = undefined;
});

const { remoteControlFailureForUrl, remoteControlPortForUrl, reportDirectRouteFailure } =
  require('./remoteControlTransport') as typeof import('./remoteControlTransport');

const coreUrl = 'https://verity.example';
const descriptor = {
  version: 1 as const,
  installationId: '27ad741c-d58c-4b37-ab3b-e32068176c32',
  installationHandle: 'STO_txvEudnAmaYQdCpu2A',
  uplinkOrigin: 'https://uplink.verity.build',
};
const profile = {
  serverId: 'paired-core-id',
  activeUrl: coreUrl,
  endpoints: [{ url: coreUrl, transport: 'direct', tlsPin: `sha256-${'a'.repeat(43)}` }],
  remoteControl: descriptor,
};

describe('shared remote control transport', () => {
  beforeEach(() => {
    // Port 0 is the direct route; these tests start away from the paired network.
    mockRequest
      .mockReset()
      .mockImplementation(async (...args: unknown[]) =>
        args[6] === 0 ? Promise.reject(new Error('NSURLErrorDomain:-1003')) : { status: 200 },
      );
    mockCancelRequest.mockReset().mockResolvedValue(undefined);
    mockLastStopReason.mockReset().mockResolvedValue(null);
    mockDiagnosticSummary.mockReset().mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('admits once for concurrent API connections and reuses the native data attachment', async () => {
    const finish = jest.fn();
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish,
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    mockIsActive.mockResolvedValue(true);

    // A direct request failed first; only then does Uplink carry the traffic.
    reportDirectRouteFailure(coreUrl);
    const [first, second] = await Promise.all([
      remoteControlPortForUrl(`${coreUrl}/api/sessions`),
      remoteControlPortForUrl(`${coreUrl}/api/status`),
    ]);
    expect([first, second]).toEqual([4_321, 4_321]);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(
      'wss://uplink.verity.build/data',
      'ticket',
      'session',
      coreUrl,
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-probe-/),
      `${coreUrl}/healthz`,
      'GET',
      {},
      null,
      profile.endpoints[0]?.tlsPin,
      4_321,
    );
    expect(await remoteControlPortForUrl(`${coreUrl}/api/more`)).toBe(4_321);
    expect(mockAdmission).toHaveBeenCalledTimes(1);

    // A revoked descriptor must stop the attachment before the next request.
    mockProfile.mockReturnValue({ ...profile, remoteControl: undefined });
    expect(await remoteControlPortForUrl(`${coreUrl}/api/more`)).toBe(0);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('finishes a stale admission before starting a replacement profile', async () => {
    const next = {
      ...profile,
      serverId: 'replacement-core',
      remoteControl: { ...descriptor, installationHandle: 'AAAAAAAAAAAAAAAAAAAAAA' },
    };
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    let resolveFirst: ((value: unknown) => void) | undefined;
    mockAdmission.mockReset();
    mockAdmission
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue({
        ticket: 'second',
        sessionId: 'second',
        finish: jest.fn(),
        cancel: jest.fn(),
      });
    mockStart.mockClear().mockResolvedValue(4_321);
    mockStop.mockClear();

    reportDirectRouteFailure(coreUrl);
    const first = remoteControlPortForUrl(`${coreUrl}/api/first`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolveFirst).toBeDefined();
    mockProfile.mockReturnValue(next);
    reportDirectRouteFailure(coreUrl);
    const second = remoteControlPortForUrl(`${coreUrl}/api/second`);
    resolveFirst?.({ ticket: 'first', sessionId: 'first', finish: jest.fn(), cancel: jest.fn() });

    expect(await first).toBe(0);
    expect(await second).toBe(4_321);
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct when the attached tunnel cannot reach the pinned Core', async () => {
    mockProfile.mockReturnValue({ ...profile, remoteControl: undefined });
    await remoteControlPortForUrl(`${coreUrl}/api/reset`);
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    mockStop.mockClear();
    mockRequest.mockRejectedValue(new Error('Pinned TLS transport failed'));

    reportDirectRouteFailure(coreUrl);
    expect(await remoteControlPortForUrl(`${coreUrl}/api/sessions`)).toBe(0);
    expect(remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe('probe');
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('reports why the native attachment ended', async () => {
    // The previous failure armed the 15 s direct-only back-off.
    const now = Date.now() + 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockRejectedValue(new Error('native start failed'));
    mockLastStopReason.mockResolvedValue('data socket failed:\n  timed out');

    expect(await remoteControlPortForUrl(`${coreUrl}/api/sessions`)).toBe(0);
    // Without the native reason every drop reads as a bare stage name and the
    // cause stays invisible on the phone.
    expect(remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe(
      'attachment (data socket failed: timed out)',
    );
  });

  it('logs the reason when an established attachment has ended', async () => {
    const now = Date.now() + 120_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockResolvedValue(true);
    expect(await remoteControlPortForUrl(`${coreUrl}/api/first`)).toBe(4_321);

    mockIsActive.mockResolvedValue(false);
    mockLastStopReason.mockResolvedValue('heartbeat timeout');
    expect(await remoteControlPortForUrl(`${coreUrl}/api/second`)).toBe(4_321);
    expect(warn).toHaveBeenCalledWith('Remote Control tunnel ended: heartbeat timeout');
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it('prefers the direct route while the paired address answers', async () => {
    const now = Date.now() + 180_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    mockProfile.mockReturnValue({ ...profile, remoteControl: undefined });
    await remoteControlPortForUrl(`${coreUrl}/api/reset`);
    mockStop.mockClear();
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockResolvedValue(true);
    mockRequest.mockResolvedValue({ status: 200 });

    // On VPN or LAN every request used to detour through the hosted Uplink,
    // which is what made the app slow exactly where it had been fast.
    expect(await remoteControlPortForUrl(`${coreUrl}/api/sessions`)).toBe(0);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-probe-/),
      `${coreUrl}/healthz`,
      'GET',
      {},
      null,
      profile.endpoints[0]?.tlsPin,
      0,
    );
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockAdmission).not.toHaveBeenCalled();

    // A failed direct request moves the next one onto Uplink without waiting
    // for the cached answer to expire.
    reportDirectRouteFailure(`${coreUrl}/api/status`);
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(4_321);
    expect(mockAdmission).toHaveBeenCalledTimes(1);

    // Back on the paired network: the stale answer is re-checked in the
    // background while the tunnel keeps serving, then the route switches back.
    clock.mockReturnValue(now + 31_000);
    mockRequest.mockClear();
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(4_321);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-probe-/),
      `${coreUrl}/healthz`,
      'GET',
      {},
      null,
      profile.endpoints[0]?.tlsPin,
      0,
    );
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(0);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
    // A live remote transfer can still be using this tunnel when a later
    // request discovers that the paired address is reachable again.
    expect(mockStop).not.toHaveBeenCalled();

    // A newer direct transport failure must win over an older probe that
    // finishes later; otherwise the next request uses a known broken route.
    reportDirectRouteFailure(`${coreUrl}/api/status`);
    clock.mockReturnValue(now + 62_000);
    let finishStaleProbe: ((value: { status: number }) => void) | undefined;
    mockRequest.mockImplementation((...args: unknown[]) =>
      args[6] === 0
        ? new Promise((resolve) => {
            finishStaleProbe = resolve;
          })
        : Promise.resolve({ status: 200 }),
    );
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(4_321);
    reportDirectRouteFailure(`${coreUrl}/api/status`);
    finishStaleProbe?.({ status: 200 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await remoteControlPortForUrl(`${coreUrl}/api/status`)).toBe(4_321);
  });

  it('does not reuse a pending direct probe after switching paired servers', async () => {
    const now = Date.now() + 300_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    mockIsActive.mockResolvedValue(true);
    mockRequest.mockImplementation(async (...args: unknown[]) =>
      args[6] === 0 ? Promise.reject(new Error('direct unavailable')) : { status: 200 },
    );
    expect(await remoteControlPortForUrl(`${coreUrl}/api/first`)).toBe(4_321);

    let finishOldProbe: ((value: { status: number }) => void) | undefined;
    mockRequest.mockImplementation((...args: unknown[]) => {
      if (args[1] === `${coreUrl}/healthz` && args[6] === 0) {
        return new Promise((resolve) => {
          finishOldProbe = resolve;
        });
      }
      return Promise.resolve({ status: 200 });
    });
    jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect(await remoteControlPortForUrl(`${coreUrl}/api/again`)).toBe(4_321);
    expect(finishOldProbe).toBeDefined();

    const otherUrl = 'https://other-verity.example';
    mockProfile.mockReturnValue({
      ...profile,
      serverId: 'other-core',
      activeUrl: otherUrl,
      endpoints: [{ url: otherUrl, transport: 'direct', tlsPin: `sha256-${'b'.repeat(43)}` }],
    });
    mockStop.mockClear();
    expect(await remoteControlPortForUrl(`${otherUrl}/api/sessions`)).toBe(0);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-probe-/),
      `${otherUrl}/healthz`,
      'GET',
      {},
      null,
      `sha256-${'b'.repeat(43)}`,
      0,
    );
    finishOldProbe?.({ status: 200 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await remoteControlPortForUrl(`${otherUrl}/api/again`)).toBe(0);
  });
});

describe('remote diagnostics', () => {
  beforeEach(() => {
    jest.resetModules();
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockRequest.mockRejectedValue(new Error('offline'));
    mockDiagnosticSummary.mockReset().mockResolvedValue(null);
    mockLastStopReason.mockReset().mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tests Uplink through Core health even when the direct route is reachable', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    expect(await transport.testRemoteControlForUrl(`${coreUrl}/api/sessions`)).toEqual({
      ready: true,
      detail: 'Core health check passed through Uplink',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-probe-/),
      `${coreUrl}/healthz`,
      'GET',
      {},
      null,
      profile.endpoints[0]?.tlsPin,
      4_321,
    );
    expect(mockRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      `${coreUrl}/healthz`,
      'GET',
      {},
      null,
      profile.endpoints[0]?.tlsPin,
      0,
    );
  });

  it('explains why an explicit Remote Control test cannot start', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockClear();
    mockProfile.mockReturnValue({ ...profile, remoteControl: undefined });
    expect(await transport.testRemoteControlForUrl(`${coreUrl}/api/sessions`)).toEqual({
      ready: false,
      detail: 'routing (no remote descriptor saved)',
    });
    expect(mockAdmission).not.toHaveBeenCalled();
  });

  it('does not replace an active tunnel when its health check fails', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: 'probe (Remote Core probe failed.)',
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('tries CONNECT when a health check on an active SOCKS tunnel stalls after Core answered', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let mode = 'socks';
    mockSetProxyMode = jest.fn(async (next: string) => {
      mode = next;
    });
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    mockRequest.mockImplementation(async () => {
      if (mode === 'socks') {
        throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
      }
      return { status: 200 };
    });
    mockDiagnosticSummary.mockResolvedValue(
      'local=3, opened=3, received=9, last=local_connected, sentBytes=5418, receivedBytes=20403, deliveredBytes=20403, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    );

    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: true,
      detail: 'Core health check passed through Uplink',
    });
    expect(mockSetProxyMode.mock.calls).toEqual([['socks'], ['connect']]);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('names both proxy failures on an active tunnel', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest.fn().mockResolvedValue(undefined);
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    mockRequest.mockRejectedValue(
      new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].'),
    );
    mockDiagnosticSummary.mockResolvedValue(
      'local=3, opened=3, received=9, last=local_connected, sentBytes=5418, receivedBytes=20403, deliveredBytes=20403, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    );

    expect(await transport.testRemoteControlForUrl(coreUrl)).toMatchObject({
      ready: false,
      detail: expect.stringContaining('via connect Remote Core probe timed out'),
    });
    expect(mockSetProxyMode.mock.calls).toEqual([['socks'], ['connect'], ['socks']]);
  });

  it('recovers a failed read on the active tunnel without another admission', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let mode = 'socks';
    mockSetProxyMode = jest.fn(async (next: string) => {
      mode = next;
    });
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    mockRequest.mockImplementation(async () => {
      if (mode === 'socks') {
        throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
      }
      return { status: 200 };
    });
    mockDiagnosticSummary.mockResolvedValue(
      'local=3, opened=3, received=9, last=local_connected, sentBytes=5418, receivedBytes=20403, deliveredBytes=20403, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    );

    expect(await transport.recoverRemoteControlRead(`${coreUrl}/sessions`, 4_321)).toBe(4_321);
    expect(mockSetProxyMode.mock.calls).toEqual([['socks'], ['connect']]);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('replaces an attachment the native stall watchdog ended and retries on it', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValueOnce(4_321).mockResolvedValueOnce(4_999);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    // The attachment carried one stream and then went dead without a close;
    // the watchdog ended it. Waiting out the 15 s back-off here costs every
    // read on the screen its own timeout first.
    mockIsActive.mockResolvedValue(false);
    mockLastStopReason.mockResolvedValue('stall: no reply on a stream within 10 s');
    expect(await transport.recoverRemoteControlRead(`${coreUrl}/sessions`, 4_321)).toBe(4_999);
    expect(mockAdmission).toHaveBeenCalledTimes(2);
    expect(mockStart).toHaveBeenCalledTimes(2);
    // The other reads that failed at the same moment retry on the replacement
    // rather than each attaching again or reporting a failure.
    expect(await transport.recoverRemoteControlRead(`${coreUrl}/status`, 4_321)).toBe(4_999);
    expect(mockStart).toHaveBeenCalledTimes(2);
    // A replacement that stalls on its reads as well is not replaced again
    // within the window: that would re-admit every ten seconds.
    mockIsActive.mockResolvedValue(false);
    expect(await transport.recoverRemoteControlRead(`${coreUrl}/status`, 4_999)).toBe(0);
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it('does not wait for a native stop after a probe failure that is not a timeout', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    mockRequest
      .mockReset()
      .mockRejectedValue(new Error('Pinned TLS verification failed [PIN_MISMATCH].'));
    mockDiagnosticSummary.mockResolvedValue(null);
    const startedAt = Date.now();
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(false);
    // A rejected pin is answered at once; only a timeout can be a stall.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(mockIsActive).not.toHaveBeenCalled();
  });

  it('gives the probe longer than the native stall watchdog', () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    const swift = readFileSync(join(__dirname, '..', 'native', 'RemoteAppTunnel.swift'), 'utf8');
    const deadline = Number(swift.match(/stallDeadlineSeconds: UInt64 = (\d+)/u)?.[1]);
    expect(deadline).toBeGreaterThan(0);
    // Otherwise a dead attachment's probe reads as an ordinary timeout and
    // backs off for 15 s instead of attaching again.
    expect(transport.PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(deadline * 1000 + 1_000);
  });

  it('retries a read that failed on a superseded attachment on the current one', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValueOnce(4_321).mockResolvedValueOnce(4_999);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    // Route selection replaced the attachment after it ended for another reason.
    mockIsActive.mockResolvedValueOnce(false);
    mockLastStopReason.mockResolvedValue('heartbeat timeout');
    transport.reportDirectRouteFailure(coreUrl);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(4_999);
    // A read that was still failing on the old port retries on the live one without a probe.
    mockRequest.mockClear();
    expect(await transport.recoverRemoteControlRead(`${coreUrl}/sessions`, 4_321)).toBe(4_999);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not replace an attachment that ended for another reason', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4_321);
    mockIsActive.mockReset().mockResolvedValue(true);
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(true);
    mockIsActive.mockResolvedValue(false);
    mockLastStopReason.mockResolvedValue('heartbeat timeout');
    expect(await transport.recoverRemoteControlRead(`${coreUrl}/sessions`, 4_321)).toBe(0);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
  });

  it('attaches once more when the first attachment stalls under its probe', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValueOnce(4_321).mockResolvedValueOnce(4_999);
    mockIsActive.mockReset().mockResolvedValue(true);
    mockRequest.mockReset().mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 4_321)
        throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
      return { status: 200 };
    });
    mockLastStopReason.mockResolvedValue('stall: no reply on a stream within 10 s');
    mockDiagnosticSummary.mockResolvedValue(null);
    // A stale stall reason on an attachment that stays live through the grace
    // period must not trigger a replacement.
    jest.useFakeTimers();
    try {
      const first = transport.testRemoteControlForUrl(coreUrl);
      await jest.advanceTimersByTimeAsync(3_500);
      expect((await first).ready).toBe(false);
    } finally {
      jest.useRealTimers();
    }
    expect(mockStart).toHaveBeenCalledTimes(1);
    mockIsActive.mockResolvedValue(false);
    mockStart.mockReset().mockResolvedValueOnce(4_321).mockResolvedValueOnce(4_999);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: true,
      detail: 'Core health check passed through Uplink',
    });
    expect(mockStart).toHaveBeenCalledTimes(2);
    // When the replacement stalls as well it is not replaced again; that is
    // the back-off's job.
    mockStart.mockResolvedValue(4_321);
    mockRequest.mockImplementation(async () => {
      throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
    });
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(false);
    expect(mockStart).toHaveBeenCalledTimes(3);
  });

  it('waits briefly for the native stop before classifying a probe timeout', async () => {
    jest.useFakeTimers();
    try {
      const transport =
        require('./remoteControlTransport') as typeof import('./remoteControlTransport');
      mockAdmission.mockReset().mockResolvedValue({
        ticket: 'ticket',
        sessionId: 'session',
        finish: jest.fn(),
        cancel: jest.fn(),
      });
      mockStart.mockReset().mockResolvedValueOnce(4_321).mockResolvedValueOnce(4_999);
      // The watchdog arms on the first sent bytes, the probe on the request:
      // the stop may land a moment after the probe gave up.
      mockIsActive.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
      mockRequest.mockReset().mockImplementation(async (...args: unknown[]) => {
        if (args[6] === 4_321)
          throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
        return { status: 200 };
      });
      mockLastStopReason.mockResolvedValue('stall: no reply on a stream within 10 s');
      mockDiagnosticSummary.mockResolvedValue(null);
      const result = transport.testRemoteControlForUrl(coreUrl);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(await result).toEqual({
        ready: true,
        detail: 'Core health check passed through Uplink',
      });
      expect(mockStart).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['NO_AUTH_CHALLENGE', ' [TLS:NO_AUTH_CHALLENGE]'],
    [
      'NO_AUTH_CHALLENGE;tx2,proxy1,connect1,tls1,response0',
      ' [TLS:NO_AUTH_CHALLENGE; tx2,proxy1,connect1,tls1,response0]',
    ],
    ['PIN_AND_CHAIN_TRUST_ACCEPTED', ' [TLS:PIN_AND_CHAIN_TRUST_ACCEPTED]'],
    [undefined, ''],
    ['ticket=private-value', ''],
  ])('preserves the timed-out probe phase safely: %s', async (phase, suffix) => {
    jest.useFakeTimers();
    try {
      mockProfile.mockReturnValue(profile);
      mockToken.mockReturnValue('device-bearer');
      mockIsActive.mockResolvedValue(true);
      mockRequest.mockImplementation(() => new Promise(() => undefined));
      mockCancelRequest.mockResolvedValue(phase);
      const transport =
        require('./remoteControlTransport') as typeof import('./remoteControlTransport');
      const result = transport.testRemoteControlForUrl(coreUrl);
      // The probe gives up at 12 s and then grants the native stop 3 s to land.
      await jest.advanceTimersByTimeAsync(16_000);
      expect(await result).toEqual({
        ready: false,
        detail: `probe (Remote Core probe timed out${suffix}.)`,
      });
      const requestId = mockRequest.mock.calls.at(-1)?.[0];
      expect(mockCancelRequest).toHaveBeenCalledWith(requestId);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['throws', 'stalls', 'cancels request'])(
    'keeps the probe bounded when cancellation %s',
    async (mode) => {
      jest.useFakeTimers();
      try {
        let failRequest: ((error: Error) => void) | undefined;
        mockRequest.mockImplementation(
          () =>
            new Promise((_, reject) => {
              failRequest = reject;
            }),
        );
        mockCancelRequest.mockImplementation(() => {
          if (mode === 'throws') throw new Error('private native error');
          if (mode === 'cancels request') {
            failRequest?.(new Error('cancelled'));
            return Promise.resolve('NO_AUTH_CHALLENGE');
          }
          return new Promise(() => undefined);
        });
        const transport =
          require('./remoteControlTransport') as typeof import('./remoteControlTransport');
        const result = transport.testRemoteControlForUrl(coreUrl);
        // The probe gives up at 12 s and then grants the native stop 3 s to land.
        await jest.advanceTimersByTimeAsync(16_000);
        expect(await result).toEqual({
          ready: false,
          detail:
            mode === 'cancels request'
              ? 'probe (Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].)'
              : 'probe (Remote Core probe timed out.)',
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('shows local tunnel stream progress after a failed Core probe', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    mockDiagnosticSummary.mockResolvedValue('local=1, opened=1, received=0, last=stream_opened');
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail:
        'probe (Remote Core probe failed.; tunnel local=1, opened=1, received=0, last=stream_opened)',
    });
  });

  it('shows directional bytes and sticky reset causes separately from frame counts', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    const summary =
      'local=6, opened=6, received=7, last=stream_opened, sentBytes=1024, receivedBytes=64, deliveredBytes=32, localResets=1, remoteResets=2, lastReset=remote_reset_upstream_error';
    mockDiagnosticSummary.mockResolvedValue(summary);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe failed.; tunnel ${summary})`,
    });
  });

  it('shows the record-level stream trace after a failed Core probe', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    // Without the trace a handshake the device abandons is indistinguishable
    // from one that never received Core's reply.
    const summary =
      'local=25, opened=22, received=74, last=local_connected, sentBytes=39738, receivedBytes=149598, deliveredBytes=149598, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2;s2=up1806.dn6801.tnone.d12.open.pconnect.o22.inone.hnone;s3=up0.dn0.tnone.d3.reset.psocks.onone.inone.hhrr';
    mockDiagnosticSummary.mockResolvedValue(summary);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe failed.; tunnel ${summary})`,
    });
  });

  it.each([
    // Native builds before and after the stream key and frame counts.
    's1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    's1=k8C2A065A.up1932.dn3080.fo4.fi7.t57.d60329.local.psocks.o22-20-23-23-23.i22-20-23-23-23-23-23.h2',
  ])('accepts a stream trace from either native build: %s', async (trace) => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    const summary = `local=1, opened=1, received=0, last=stream_opened, sentBytes=0, receivedBytes=0, deliveredBytes=0, localResets=0, remoteResets=0, lastReset=none, streams=${trace}`;
    mockDiagnosticSummary.mockResolvedValue(summary);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe failed.; tunnel ${summary})`,
    });
  });

  it.each([
    'streams=s1=up1.dn1.t1.d1.local.psocks.o22.i22.h2;s2=https://x',
    'streams=s1=up1.dn1.t1.d1.local.psocks.o22.i22.h2;s2=up1.dn1.t1.d1.local.psocks.o22.i22.h2;s3=up1.dn1.t1.d1.local.psocks.o22.i22.h2;s4=up1.dn1.t1.d1.local.psocks.o22.i22.h2',
    'streams=s1=up1.dn1.t1.d1.local.pother.o22.i22.h2',
  ])('drops a malformed stream trace but keeps the counters: %s', async (trace) => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    const base =
      'local=1, opened=1, received=0, last=stream_opened, sentBytes=0, receivedBytes=0, deliveredBytes=0, localResets=0, remoteResets=0, lastReset=none';
    mockDiagnosticSummary.mockResolvedValue(`${base}, ${trace}`);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe failed.; tunnel ${base})`,
    });
  });

  it('completes the Core probe through HTTP CONNECT when SOCKS fails', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest.fn().mockResolvedValue(undefined);
    let mode = 'socks';
    mockSetProxyMode.mockImplementation(async (next: string) => {
      mode = next;
    });
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      if (mode === 'socks') throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
      return { status: 200 };
    });
    mockDiagnosticSummary.mockResolvedValue(
      'local=3, opened=3, received=9, last=local_connected, sentBytes=5418, receivedBytes=20403, deliveredBytes=20403, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    );
    transport.reportDirectRouteFailure(coreUrl);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(4321);
    expect(mockSetProxyMode.mock.calls).toEqual([['socks'], ['connect']]);
    // The dialect that answered stays selected for the requests that follow.
    expect(mode).toBe('connect');
  });

  it('re-syncs the native dialect after a failed restore', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('bridge lost'))
      .mockResolvedValue(undefined);
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4321);
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
    });
    mockDiagnosticSummary.mockResolvedValue(
      'local=2, opened=2, received=6, last=remote_stream.end, sentBytes=3612, receivedBytes=13602, deliveredBytes=13602, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn6801.t210.d520.local.psocks.o22.i22-23-23.h2',
    );
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(false);
    // Native may still be on the trial dialect; JavaScript must not assume otherwise.
    expect((await transport.testRemoteControlForUrl(coreUrl)).ready).toBe(false);
    expect(mockSetProxyMode.mock.calls).toEqual([
      ['socks'],
      ['connect'],
      ['socks'],
      ['socks'],
      ['connect'],
      ['socks'],
    ]);
  });

  it('does not change the dialect when Core never answered through the tunnel', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest.fn().mockResolvedValue(undefined);
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4321);
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
    });
    // A Core that is down looks the same to the client; only the probe's own
    // stream tells that no reply ever arrived, so a second probe is pointless.
    const summary =
      'local=1, opened=1, received=0, last=stream_opened, sentBytes=1806, receivedBytes=6801, deliveredBytes=6801, localResets=0, remoteResets=0, lastReset=none, streams=s1=up1806.dn0.tnone.d900.open.psocks.o22.inone.hnone';
    mockDiagnosticSummary.mockResolvedValue(summary);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].; tunnel ${summary})`,
    });
    expect(mockSetProxyMode.mock.calls).toEqual([['socks']]);
  });

  it('does not change the dialect for a rejected certificate', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest.fn().mockResolvedValue(undefined);
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4321);
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      throw new Error('Pinned TLS verification failed [PIN_MISMATCH].');
    });
    mockDiagnosticSummary.mockResolvedValue(null);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: 'probe (Pinned TLS verification failed [PIN_MISMATCH])',
    });
    expect(mockSetProxyMode.mock.calls).toEqual([['socks']]);
  });

  it('restores the dialect and names both failures when CONNECT fails too', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockSetProxyMode = jest.fn().mockResolvedValue(undefined);
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      throw new Error('Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].');
    });
    const summary =
      'local=2, opened=2, received=6, last=remote_stream.end, sentBytes=3612, receivedBytes=13602, deliveredBytes=13602, localResets=0, remoteResets=0, lastReset=none';
    mockDiagnosticSummary.mockResolvedValue(summary);
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].; via connect Remote Core probe timed out [TLS:NO_AUTH_CHALLENGE].; tunnel ${summary})`,
    });
    expect(mockSetProxyMode.mock.calls).toEqual([['socks'], ['connect'], ['socks']]);
  });

  it('does not display arbitrary native diagnostic text', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4_321);
    mockRequest.mockRejectedValue(new Error('Remote Core probe failed.'));
    mockDiagnosticSummary.mockResolvedValue('ticket=private-value');
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: 'probe (Remote Core probe failed.)',
    });
  });

  it('explains why Uplink was not attempted without a saved descriptor', () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockProfile.mockReturnValue({ ...profile, remoteControl: undefined });
    expect(transport.remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe(
      'routing (no remote descriptor saved)',
    );
  });

  it('preserves the Uplink admission error code for the visible transport error', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockRejectedValue(new Error('Remote admission failed: unavailable.'));
    transport.reportDirectRouteFailure(coreUrl);
    expect(await transport.remoteControlPortForUrl(`${coreUrl}/api/sessions`)).toBe(0);
    expect(transport.remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe(
      'admission (Remote admission failed: unavailable.)',
    );
  });

  it('preserves bounded native TLS causes through the visible probe error', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4321);
    const detail =
      'Pinned TLS transport failed [NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE:streamDomain:3:streamCode:-9802:underlying:kCFErrorDomainCFNetwork:-1200:underlying:NSOSStatusErrorDomain:-9802]';
    mockRequest.mockRejectedValue(new Error(detail));
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: `probe (${detail})`,
    });
  });

  it.each([
    'NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE:underlying:private-ticket:-9802',
    'NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE:streamCode:https://private.example',
    'NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE' +
      ':underlying:NSOSStatusErrorDomain:-9802'.repeat(3),
  ])('does not expose malformed or excessive native cause chains: %s', async (cause) => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockResolvedValue(4321);
    mockRequest.mockRejectedValue(new Error(`Pinned TLS transport failed [${cause}]`));
    expect(await transport.testRemoteControlForUrl(coreUrl)).toEqual({
      ready: false,
      detail: 'probe',
    });
  });

  it('does not log arbitrary exception text containing credentials', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockRejectedValue(new Error('https://private.example/?ticket=secret'));
    transport.reportDirectRouteFailure(coreUrl);
    await transport.remoteControlPortForUrl(`${coreUrl}/api/sessions`);
    expect(transport.remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe('admission');
    expect(console.warn).toHaveBeenCalledWith(
      'Remote Control admission failed: unclassified failure',
    );
  });
});

describe('direct routing across background and diagnostics', () => {
  beforeEach(() => {
    jest.resetModules();
    mockAppStateListeners.length = 0;
    mockProfile.mockReturnValue(profile);
    mockToken.mockReturnValue('device-bearer');
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockStart.mockResolvedValue(4321);
    mockIsActive.mockResolvedValue(true);
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockSetProxyMode = undefined;
  });

  it('does not queue a healthy direct request behind a manual Uplink test', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let finishAdmission!: (value: unknown) => void;
    mockAdmission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAdmission = resolve;
        }),
    );
    const diagnostic = transport.testRemoteControlForUrl(coreUrl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const route = transport.remoteControlPortForUrl(coreUrl);
    const result = await Promise.race([
      route,
      new Promise((resolve) => setImmediate(() => resolve('blocked'))),
    ]);
    finishAdmission({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    await diagnostic;
    await route;
    expect(result).toBe(0);
  });

  it('reprobes direct immediately after foreground instead of reusing a negative cache', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    transport.reportDirectRouteFailure(coreUrl);
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(0);
    expect(mockAdmission).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('returns from a live tunnel to direct after foreground without closing active streams', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('direct offline');
      return { status: 200 };
    });
    transport.reportDirectRouteFailure(coreUrl);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(4321);
    mockStop.mockClear();
    mockRequest.mockResolvedValue({ status: 200 });
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(0);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('hands the running probe to a read sent before its verdict', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    expect(transport.pendingDirectVerdict(coreUrl)).toBeNull();
    let resolveProbe!: (value: { status: number }) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    expect(await transport.remoteControlPortForUrl(coreUrl, true)).toBe(0);
    const verdict = transport.pendingDirectVerdict(coreUrl);
    expect(verdict).not.toBeNull();
    resolveProbe({ status: 200 });
    expect(await verdict).toBe('reachable');
    expect(transport.pendingDirectVerdict(coreUrl)).toBeNull();
  });

  it.each([
    // Only a definite refusal condemns a read a waking VPN might still carry.
    ['Remote Core probe timed out.', 'unknown'],
    ['Pinned TLS transport failed [NSURLErrorDomain:-1001:NO_AUTH_CHALLENGE]', 'unknown'],
    ['Pinned TLS transport failed [NSURLErrorDomain:-1009:NO_AUTH_CHALLENGE]', 'unknown'],
    ['Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]', 'dead'],
    ['Pinned TLS transport failed [NSURLErrorDomain:-1004:NO_AUTH_CHALLENGE]', 'dead'],
    ['Pinned TLS verification failed [PIN_MISMATCH]', 'dead'],
    ['NSURLErrorDomain:-1003', 'unknown'],
  ])('tells a definite refusal from a transient failure: %s', async (failure, verdict) => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let rejectProbe!: (reason: Error) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject;
        }),
    );
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    expect(await transport.remoteControlPortForUrl(coreUrl, true)).toBe(0);
    const pending = transport.pendingDirectVerdict(coreUrl);
    rejectProbe(new Error(failure));
    expect(await pending).toBe(verdict);
    // A read cancelled on that verdict reports the refusal, not its own -999.
    expect(transport.lastDirectRefusal(coreUrl)).toBe(verdict === 'dead' ? failure : null);
  });

  it('holds a mutation for the probe verdict instead of sending it blind', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    // Off the VPN, a POST sent directly before anything is known fails on
    // screen: unlike a read it cannot be replayed through Uplink afterwards.
    mockRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[6] === 0) throw new Error('NSURLErrorDomain:-1003');
      return { status: 200 };
    });
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    expect(await transport.remoteControlPortForUrl(coreUrl, false)).toBe(4321);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
  });

  it('does not restore an old negative probe after foreground recovery', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let rejectOld!: (reason: Error) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const oldRoute = transport.remoteControlPortForUrl(coreUrl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }
    const freshRoute = transport.remoteControlPortForUrl(coreUrl);
    const result = await Promise.race([
      freshRoute,
      new Promise((resolve) => setImmediate(() => resolve('blocked'))),
    ]);
    rejectOld(new Error('old background failure'));
    await oldRoute;
    await freshRoute;
    expect(result).toBe(0);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(0);
    expect(mockAdmission).not.toHaveBeenCalled();
  });
  it('rechecks a failed direct route after a short VPN recovery window', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    transport.reportDirectRouteFailure(coreUrl);
    now.mockReturnValue(103_001);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(0);
    expect(mockAdmission).not.toHaveBeenCalled();
  });

  it('keeps direct recovery when an older direct probe later fails', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let rejectOld!: (reason: Error) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const route = transport.remoteControlPortForUrl(coreUrl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.reportDirectRouteSuccess(coreUrl);
    rejectOld(new Error('older failure'));
    expect(await route).toBe(0);
    expect(mockAdmission).not.toHaveBeenCalled();
  });

  it('sends the first request directly before the probe has answered', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    let resolveProbe!: (value: { status: number }) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    mockAdmission.mockReset().mockResolvedValue({
      ticket: 'ticket',
      sessionId: 'session',
      finish: jest.fn(),
      cancel: jest.fn(),
    });
    mockStart.mockReset().mockResolvedValue(4321);
    mockIsActive.mockResolvedValue(true);
    for (const listener of mockAppStateListeners) {
      listener('background');
      listener('active');
    }

    // A VPN that needs a few seconds to wake up used to fail the 3 s probe and
    // send the request into a long Uplink attempt, although the request itself
    // would have gone through directly.
    const result = await Promise.race([
      Promise.all([
        transport.remoteControlPortForUrl(coreUrl, true),
        transport.remoteControlPortForUrl(`${coreUrl}/api/status`, true),
      ]),
      new Promise((resolve) => setImmediate(() => resolve('blocked'))),
    ]);
    expect(result).toEqual([0, 0]);
    // One probe serves every request that starts before it answers.
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockAdmission).not.toHaveBeenCalled();

    // The request's own failure is what moves the route onto Uplink.
    transport.reportDirectRouteFailure(coreUrl);
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(4321);
    expect(mockAdmission).toHaveBeenCalledTimes(1);

    // The probe's late answer is older than the request's verdict.
    resolveProbe({ status: 200 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await transport.remoteControlPortForUrl(coreUrl)).toBe(4321);
  });
});
