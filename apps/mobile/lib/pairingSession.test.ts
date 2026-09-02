const clients: Array<{
  opts: { getToken?: () => string | null | undefined };
  fetchOnboardingStatus: jest.Mock;
}> = [];
const mockEnroll = jest.fn();
const mockRedeem = jest.fn();
const mockStatus = jest.fn();

jest.mock('@verity/mobile', () => ({
  VerityClient: class {
    opts: { getToken?: () => string | null | undefined };
    fetchOnboardingStatus = jest.fn(() => mockStatus());
    fetchPairingIdentity = jest.fn().mockResolvedValue({
      identityKey: 'identity-key',
      serverId: 'server-id',
      signature: 'signature',
    });
    enrollPairingInvitation = mockEnroll;
    redeemPairingCode = mockRedeem;
    constructor(opts: { getToken?: () => string | null | undefined }) {
      this.opts = opts;
      clients.push(this);
    }
  },
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(32).fill(1) }));
const mockSecureItems = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: (key: string) => Promise.resolve(mockSecureItems.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    mockSecureItems.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    mockSecureItems.delete(key);
    return Promise.resolve();
  },
}));
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch: () => jest.fn(),
  verifyPairedIdentity: jest.fn().mockResolvedValue(undefined),
}));
const mockSetAuthToken = jest.fn();
const mockSetBaseUrl = jest.fn();
const mockSaveProfile = jest.fn();
jest.mock('./authToken', () => ({
  setAuthToken: (...args: unknown[]) => mockSetAuthToken(...args),
  copyAuthTokenToEndpoint: jest.fn(),
}));
jest.mock('./client', () => ({
  setVerityBaseUrl: (...args: unknown[]) => mockSetBaseUrl(...args),
}));
jest.mock('./deviceLabel', () => ({ deviceLabel: () => 'iPad' }));
jest.mock('./serverProfile', () => ({
  profileFromPairing: (_payload: unknown, url: string) => ({ activeUrl: url }),
  saveServerProfile: (...args: unknown[]) => mockSaveProfile(...args),
  getServerProfile: jest.fn(),
  selectServerEndpoint: jest.fn(),
  addServerEndpoint: jest.fn(),
}));

import { establishPairing } from './pairingSession';

beforeEach(() => {
  clients.length = 0;
  mockEnroll.mockReset().mockResolvedValue({ token: 'new-device-token', tokenId: 'device-id' });
  mockRedeem.mockReset().mockResolvedValue({
    bootstrapToken: 'bootstrap-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  mockStatus.mockReset().mockResolvedValue({ complete: true });
  mockSetAuthToken.mockReset().mockResolvedValue(true);
  mockSetBaseUrl.mockReset().mockResolvedValue(undefined);
  mockSaveProfile.mockReset().mockResolvedValue(undefined);
  mockSecureItems.clear();
});

it('enrolls a device even when an installer bootstrap is retained for the same server', async () => {
  mockStatus.mockRejectedValueOnce(new TypeError('temporary network failure'));
  await expect(
    establishPairing(
      {
        version: 1,
        kind: 'installer',
        serverId: 'server-id',
        identityKey: 'identity-key',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pairingCode: 'installer-pairing-code-0123456789',
        suggestedUrl: 'https://verity.example:8082',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      'https://verity.example:8082',
    ),
  ).rejects.toThrow('temporary network failure');

  await establishPairing(
    {
      version: 1,
      kind: 'device',
      serverId: 'server-id',
      identityKey: 'identity-key',
      tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pairingCode: 'device-pairing-code-0123456789',
      suggestedUrl: 'https://verity.example:8082',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    'https://verity.example:8082',
  );

  expect(mockRedeem).toHaveBeenCalledTimes(1);
  expect(mockEnroll).toHaveBeenCalledTimes(1);
  expect(mockSecureItems.size).toBe(0);
  expect(mockSetAuthToken).toHaveBeenCalledWith(
    'https://verity.example:8082',
    'new-device-token',
    'device-id',
  );
});

it('uses the newly enrolled bearer for the post-pairing status request', async () => {
  await establishPairing(
    {
      version: 1,
      kind: 'device',
      serverId: 'server-id',
      identityKey: 'identity-key',
      tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
      suggestedUrl: 'https://verity.example:8082',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    'https://verity.example:8082',
  );

  expect(clients).toHaveLength(2);
  expect(clients[1]?.opts.getToken?.()).toBe('new-device-token');
  expect(clients[0]?.fetchOnboardingStatus).not.toHaveBeenCalled();
  expect(clients[1]?.fetchOnboardingStatus).toHaveBeenCalledTimes(1);
});

it('keeps the verified profile and enrolled token when the final status read fails', async () => {
  mockStatus.mockRejectedValue(new TypeError('temporary network failure'));
  await expect(
    establishPairing(
      {
        version: 1,
        kind: 'device',
        serverId: 'server-id',
        identityKey: 'identity-key',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
        suggestedUrl: 'https://verity.example:8082',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      'https://verity.example:8082',
    ),
  ).rejects.toThrow('temporary network failure');
  expect(mockSecureItems.size).toBe(1);
  expect(mockSaveProfile).toHaveBeenCalledTimes(1);
  expect(mockSetBaseUrl).toHaveBeenCalledWith('https://verity.example:8082');
  expect(mockSetAuthToken).toHaveBeenCalledWith(
    'https://verity.example:8082',
    'new-device-token',
    'device-id',
  );
  mockStatus.mockResolvedValue({ complete: true });
  await establishPairing(
    {
      version: 1,
      kind: 'device',
      serverId: 'server-id',
      identityKey: 'identity-key',
      tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
      suggestedUrl: 'https://verity.example:8082',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    'https://verity.example:8082',
  );
  expect(mockEnroll).toHaveBeenCalledTimes(1);
  expect(mockSaveProfile).toHaveBeenCalledTimes(2);
  expect(mockSecureItems.size).toBe(0);
});

it('does not configure local routing when enrollment is rejected', async () => {
  mockEnroll.mockRejectedValue(new Error('invalid or expired pairing invitation'));
  await expect(
    establishPairing(
      {
        version: 1,
        kind: 'device',
        serverId: 'server-id',
        identityKey: 'identity-key',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
        suggestedUrl: 'https://verity.example:8082',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      'https://verity.example:8082',
    ),
  ).rejects.toThrow('invalid or expired pairing invitation');
  expect(mockSetAuthToken).not.toHaveBeenCalled();
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
});

it('keeps the enrollment retry record when the device credential cannot be persisted', async () => {
  mockSetAuthToken.mockResolvedValue(false);
  await expect(
    establishPairing(
      {
        version: 1,
        kind: 'device',
        serverId: 'server-id',
        identityKey: 'identity-key',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pairingCode: 'persistent-attempt-code-0123456789',
        suggestedUrl: 'https://verity.example:8082',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      'https://verity.example:8082',
    ),
  ).rejects.toThrow('Could not save the device credential');
  expect(mockSecureItems.size).toBe(1);
  expect(mockSaveProfile).not.toHaveBeenCalled();
});
