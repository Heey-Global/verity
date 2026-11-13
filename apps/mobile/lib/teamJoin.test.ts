import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 0,
  getItemAsync: async (key: string) => mockSecure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockSecure.set(key, value),
  deleteItemAsync: async (key: string) => void mockSecure.delete(key),
}));
jest.mock('expo-crypto', () => {
  const { createHash, randomBytes } =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytes: (count: number) => new Uint8Array(randomBytes(count)),
    digest: async (_algorithm: string, bytes: Uint8Array) => {
      const out = createHash('sha256').update(bytes).digest();
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    },
  };
});
const mockCalls: string[] = [];
const mockSetToken = jest.fn(async (..._args: unknown[]) => {
  mockCalls.push('token');
  return true;
});
jest.mock('./authToken', () => ({
  clearStoredAuthState: async () => undefined,
  setAuthToken: (...args: unknown[]) => mockSetToken(...args),
}));
const mockSetBaseUrl = jest.fn(async (_url: string) => void mockCalls.push('baseUrl'));
jest.mock('./client', () => ({ setVerityBaseUrl: (url: string) => mockSetBaseUrl(url) }));
jest.mock('./deviceLabel', () => ({ deviceLabel: () => 'Lena’s iPhone' }));
const mockVerify = jest.fn(async (_input: unknown) => undefined);
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch: (pin: string) => ({ pin }),
  verifyPairedIdentity: (input: unknown) => mockVerify(input),
}));
const mockProfile = { current: null as unknown };
const mockSaveProfile = jest.fn(async (profile: unknown) => {
  mockCalls.push('profile');
  mockProfile.current = profile;
});
const mockOthers = { current: [] as unknown[] };
jest.mock('./serverProfile', () => ({
  getServerProfile: () => mockProfile.current,
  getOtherServerProfiles: () => mockOthers.current,
  activateServerProfile: (profile: unknown) => mockSaveProfile(profile),
}));
const mockIdentity = jest.fn();
const mockJoin = jest.fn();
const mockClients: Array<{ baseUrl: string; fetch: unknown }> = [];
jest.mock('@verity/mobile', () => {
  const actual = jest.requireActual('@verity/mobile');
  return {
    ...actual,
    VerityClient: class {
      constructor(options: { baseUrl: string; fetch: unknown }) {
        mockClients.push(options);
      }
      fetchPairingIdentity = (challenge: string) => mockIdentity(challenge);
      joinTeam = (body: unknown) => mockJoin(body);
    },
  };
});

import { VerityApiError } from '@verity/mobile';

import { parseTeamJoinLink } from './teamInvitationLink';
import { joinTeam, TeamJoinError } from './teamJoin';

const fixture = (
  JSON.parse(
    readFileSync(
      join(__dirname, '../../../scripts/team-control-contract/wire-fixtures.json'),
      'utf8',
    ),
  ) as Array<{ schema: string; valid: boolean; value: Record<string, unknown> }>
).find((entry) => entry.schema === 'invitationLink' && entry.valid)!.value;
const linkFrom = (value: Record<string, unknown>) =>
  parseTeamJoinLink(
    `https://verity.build/join#${Buffer.from(
      JSON.stringify({ ...value, expiresAt: Date.now() + 86_400_000 }),
    ).toString('base64url')}`,
  );
const link = linkFrom(fixture);

beforeEach(() => {
  mockSecure.clear();
  mockCalls.length = 0;
  mockClients.length = 0;
  mockProfile.current = null;
  mockOthers.current = [];
  jest.clearAllMocks();
  mockIdentity.mockResolvedValue({
    serverId: link.serverId,
    identityKey: link.identityKey,
    signature: 'sig',
  });
  mockJoin.mockImplementation(async () => {
    mockCalls.push('join');
    return { token: 'device-token', tokenId: 'tok-1', userId: 'u-lena', projectId: 'p1' };
  });
});

it('joins over the pinned address and stores the credential before switching servers', async () => {
  await expect(joinTeam(link, ' Lena ')).resolves.toEqual({ projectId: 'p1' });
  // Only the link's address, only with the link's pin.
  expect(mockClients).toEqual([
    { baseUrl: link.coreOrigin, fetch: { pin: link.tlsPin }, uploadFetch: { pin: link.tlsPin } },
  ]);
  expect(mockVerify).toHaveBeenCalledWith(
    expect.objectContaining({ identityKey: link.identityKey, expectedServerId: link.serverId }),
  );
  expect(mockJoin).toHaveBeenCalledWith(
    expect.objectContaining({ invitationId: link.invitationId, displayName: 'Lena' }),
  );
  expect(mockSetToken).toHaveBeenCalledWith(link.coreOrigin, 'device-token', 'tok-1');
  expect(mockCalls).toEqual(['join', 'token', 'profile', 'baseUrl']);
  expect(mockProfile.current).toMatchObject({
    serverId: link.serverId,
    activeUrl: link.coreOrigin,
    endpoints: [{ url: link.coreOrigin, transport: 'direct', tlsPin: link.tlsPin }],
  });
});

it('refuses a server whose key is not the one in the link, before redeeming', async () => {
  mockIdentity.mockResolvedValue({ serverId: link.serverId, identityKey: 'other', signature: 's' });
  await expect(joinTeam(link, 'Lena')).rejects.toMatchObject({ reason: 'identity' });
  expect(mockJoin).not.toHaveBeenCalled();
  expect(mockProfile.current).toBeNull();
});

it('refuses a link whose server id does not derive from its key, before connecting', async () => {
  const forged = { ...link, serverId: 'srv_AQEBAQEBAQEBAQEBAQEBAQ' };
  await expect(joinTeam(forged, 'Lena')).rejects.toMatchObject({ reason: 'invalid' });
  expect(mockClients).toHaveLength(0);
});

it('retries a lost answer as a replay of the same redemption', async () => {
  mockJoin.mockRejectedValueOnce(new Error('network lost'));
  await expect(joinTeam(link, 'Lena')).rejects.toThrow('network lost');
  await joinTeam(link, 'Lena');
  const [first, second] = mockJoin.mock.calls.map(
    ([body]) => (body as { redemptionId: string }).redemptionId,
  );
  expect(second).toBe(first);
});

it('reports a used, revoked or expired invitation as unavailable', async () => {
  mockJoin.mockRejectedValue(new VerityApiError(410, 'gone'));
  await expect(joinTeam(link, 'Lena')).rejects.toBeInstanceOf(TeamJoinError);
  await expect(joinTeam(link, 'Lena')).rejects.toMatchObject({ reason: 'unavailable' });
  expect(mockSetToken).not.toHaveBeenCalled();
});

it('joins a second server next to the one the app already uses', async () => {
  mockProfile.current = { serverId: 'srv_mine', activeUrl: 'https://mine.example' };
  await joinTeam(link, 'Lena');
  // Activating keeps the previous server among the others (serverProfile.test).
  expect(mockSaveProfile).toHaveBeenCalledWith(
    expect.objectContaining({ serverId: link.serverId, sharedBy: 'Holger Teske' }),
  );
});

it('refuses to join a server this app already knows, without contacting it', async () => {
  mockOthers.current = [{ serverId: link.serverId, activeUrl: link.coreOrigin }];
  await expect(joinTeam(link, 'Lena')).rejects.toMatchObject({ reason: 'known_server' });
  expect(mockClients).toHaveLength(0);
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
});
