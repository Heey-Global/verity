const mockActive = jest.fn();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({ isSupported: async () => true, isActive: () => mockActive() }),
}));
const mockFetch = jest.fn();
const mockToken = jest.fn();
const mockProfile = jest.fn();
const mockPinned = jest.fn((..._args: unknown[]) => mockFetch);
jest.mock('./serverProfile', () => ({ getServerProfile: () => mockProfile() }));
jest.mock('./authToken', () => ({ getAuthToken: () => mockToken() }));
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch: (...args: unknown[]) => mockPinned(...args),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async () => 'a'.repeat(64),
}));
import { selectedRecordingContext } from './selectedRecordingContext';
const remote = {
  installationId: 'installation',
  installationHandle: 'h'.repeat(22),
  uplinkOrigin: 'https://relay.test',
};
const profile = {
  serverId: 'core',
  activeUrl: 'https://core.test',
  endpoints: [{ transport: 'direct', url: 'https://core.test', tlsPin: 'pin' }],
  remoteControl: remote,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockActive.mockResolvedValue(false);
  mockProfile.mockReturnValue(profile);
  mockToken.mockReturnValue('token');
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      version: 1,
      enabled: true,
      ...remote,
      capabilities: ['remote-control-v1'],
    }),
  });
});
it('uses pinned direct transport and verifies paired installation', async () => {
  const context = selectedRecordingContext();
  expect(mockPinned).toHaveBeenCalledWith('pin', false);
  await expect(context.verify()).resolves.toBe('a'.repeat(16));
});
it('refuses missing authentication', () => {
  mockToken.mockReturnValue(null);
  expect(() => selectedRecordingContext()).toThrow('Unlock');
  expect(mockFetch).not.toHaveBeenCalled();
});
it('refuses an uplink active endpoint', () => {
  mockProfile.mockReturnValue({ ...profile, activeUrl: 'https://relay.test' });
  expect(() => selectedRecordingContext()).toThrow('Select a paired');
});
it('refuses mismatched installation identity', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      version: 1,
      enabled: true,
      ...remote,
      installationId: 'foreign',
      capabilities: ['remote-control-v1'],
    }),
  });
  await expect(selectedRecordingContext().verify()).rejects.toThrow('does not match');
});
it('refuses a pairing changed during verification', async () => {
  const context = selectedRecordingContext();
  mockProfile.mockReturnValue({ ...profile });
  await expect(context.verify()).rejects.toThrow('does not match');
});

it('refuses an active native tunnel without stopping it', async () => {
  mockActive.mockResolvedValue(true);
  await expect(selectedRecordingContext().assertInactive()).rejects.toThrow('existing DATA tunnel');
});
it('bounds an unresponsive native status query', async () => {
  jest.useFakeTimers();
  try {
    mockActive.mockReturnValue(new Promise(() => {}));
    const pending = expect(selectedRecordingContext().assertInactive()).rejects.toThrow(
      'Native status unavailable',
    );
    await jest.advanceTimersByTimeAsync(3001);
    await pending;
  } finally {
    jest.useRealTimers();
  }
});
