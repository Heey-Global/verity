const mockAdmission = jest.fn();
const mockProfile = jest.fn();
const mockToken = jest.fn();
const mockStart = jest.fn();
const mockIsActive = jest.fn();
const mockStop = jest.fn();
const mockRequest = jest.fn();
const mockCancelRequest = jest.fn();

jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (...args: unknown[]) => mockAdmission(...args),
}));
jest.mock('./serverProfile', () => ({ getServerProfile: () => mockProfile() }));
jest.mock('./authToken', () => ({ getAuthToken: (...args: unknown[]) => mockToken(...args) }));
jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) =>
    name === 'VerityPinnedTransport'
      ? { request: mockRequest, cancelRequest: mockCancelRequest }
      : { isSupported: async () => true, start: mockStart, isActive: mockIsActive, stop: mockStop },
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

import { remoteControlFailureForUrl, remoteControlPortForUrl } from './remoteControlTransport';

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
    mockRequest.mockReset().mockResolvedValue({ status: 200 });
    mockCancelRequest.mockReset().mockResolvedValue(undefined);
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
    await Promise.resolve();
    await Promise.resolve();
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
});
