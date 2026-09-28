const mockAdmission = jest.fn();
const mockProfile = jest.fn();
const mockToken = jest.fn();
const mockStart = jest.fn();
const mockIsActive = jest.fn();
const mockStop = jest.fn();
const mockRequest = jest.fn();
const mockCancelRequest = jest.fn();
const mockLastStopReason = jest.fn();

jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (...args: unknown[]) => mockAdmission(...args),
}));
jest.mock('./serverProfile', () => ({ getServerProfile: () => mockProfile() }));
jest.mock('./authToken', () => ({ getAuthToken: (...args: unknown[]) => mockToken(...args) }));
jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) =>
    name === 'VerityPinnedTransport'
      ? { request: mockRequest, cancelRequest: mockCancelRequest }
      : {
          isSupported: async () => true,
          start: mockStart,
          isActive: mockIsActive,
          stop: mockStop,
          lastStopReason: mockLastStopReason,
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

import {
  remoteControlFailureForUrl,
  remoteControlPortForUrl,
  reportDirectRouteFailure,
} from './remoteControlTransport';

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

    const first = remoteControlPortForUrl(`${coreUrl}/api/first`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolveFirst).toBeDefined();
    mockProfile.mockReturnValue(next);
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
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

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
    expect(await transport.remoteControlPortForUrl(`${coreUrl}/api/sessions`)).toBe(0);
    expect(transport.remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe(
      'admission (Remote admission failed: unavailable.)',
    );
  });

  it('does not log arbitrary exception text containing credentials', async () => {
    const transport =
      require('./remoteControlTransport') as typeof import('./remoteControlTransport');
    mockAdmission.mockRejectedValue(new Error('https://private.example/?ticket=secret'));
    await transport.remoteControlPortForUrl(`${coreUrl}/api/sessions`);
    expect(transport.remoteControlFailureForUrl(`${coreUrl}/api/sessions`)).toBe('admission');
    expect(console.warn).toHaveBeenCalledWith(
      'Remote Control admission failed: unclassified failure',
    );
  });
});
