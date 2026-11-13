import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => {
    throw new Error('the tests inject the tunnel');
  },
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
  createPinnedFetch: (pin: string, useRemote: boolean, port?: number) => ({ pin, useRemote, port }),
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
import { joinTeam, TeamJoinError, type JoinTeamDeps } from './teamJoin';
import { TeamJoinAdmissionError } from './teamJoinAdmission';

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

const PORT = 41_234;
const admission = jest.fn();
const tunnel = { start: jest.fn(), stop: jest.fn() };
const deps: JoinTeamDeps = { admission, tunnel: () => tunnel };
const finish = jest.fn();

beforeEach(() => {
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
  admission.mockImplementation(async () => {
    mockCalls.push('admission');
    return {
      sessionId: 'session_1',
      redemptionId: 'redemption_from_uplink',
      ticket: 'app_ticket',
      expiresAt: Date.now() + 60_000,
      finish,
    };
  });
  tunnel.start.mockImplementation(async () => {
    mockCalls.push('tunnel');
    return PORT;
  });
  tunnel.stop.mockImplementation(async () => void mockCalls.push('stop'));
});

it('joins through the tunnel Uplink opened, with the pin and redemption from the right side', async () => {
  await expect(joinTeam(link, ' Lena ', deps)).resolves.toEqual({ projectId: 'p1' });
  expect(admission).toHaveBeenCalledWith({
    uplinkOrigin: link.uplinkOrigin,
    installationHandle: link.installationHandle,
    invitationId: link.invitationId,
  });
  const dataUrl = new URL(link.uplinkOrigin);
  dataUrl.protocol = 'wss:';
  dataUrl.pathname = '/data';
  expect(tunnel.start).toHaveBeenCalledWith(
    dataUrl.href,
    'app_ticket',
    'session_1',
    link.coreOrigin,
  );
  expect(finish).toHaveBeenCalled();
  // Only through that tunnel, only with the link's pin: never the direct route.
  const pinned = { pin: link.tlsPin, useRemote: false, port: PORT };
  expect(mockClients).toEqual([{ baseUrl: link.coreOrigin, fetch: pinned, uploadFetch: pinned }]);
  expect(mockVerify).toHaveBeenCalledWith(
    expect.objectContaining({ identityKey: link.identityKey, expectedServerId: link.serverId }),
  );
  // The redemption is Uplink's; the app never makes one.
  expect(mockJoin).toHaveBeenCalledWith(
    expect.objectContaining({
      invitationId: link.invitationId,
      redemptionId: 'redemption_from_uplink',
      displayName: 'Lena',
    }),
  );
  expect(mockSetToken).toHaveBeenCalledWith(link.coreOrigin, 'device-token', 'tok-1');
  expect(mockCalls).toEqual(['admission', 'tunnel', 'join', 'stop', 'token', 'profile', 'baseUrl']);
  expect(mockProfile.current).toMatchObject({
    serverId: link.serverId,
    activeUrl: link.coreOrigin,
    endpoints: [{ url: link.coreOrigin, transport: 'direct', tlsPin: link.tlsPin }],
  });
});

it('refuses a server whose key is not the one in the link, before redeeming', async () => {
  mockIdentity.mockResolvedValue({ serverId: link.serverId, identityKey: 'other', signature: 's' });
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'identity' });
  expect(mockJoin).not.toHaveBeenCalled();
  expect(mockProfile.current).toBeNull();
  // The borrowed tunnel never outlives the attempt.
  expect(tunnel.stop).toHaveBeenCalled();
});

it('refuses a link whose server id does not derive from its key, before connecting', async () => {
  const forged = { ...link, serverId: 'srv_AQEBAQEBAQEBAQEBAQEBAQ' };
  await expect(joinTeam(forged, 'Lena', deps)).rejects.toMatchObject({ reason: 'invalid' });
  expect(admission).not.toHaveBeenCalled();
  expect(mockClients).toHaveLength(0);
});

it('retries a lost answer once in the same tunnel, as a replay of the same redemption', async () => {
  mockJoin.mockRejectedValueOnce(new Error('network lost'));
  await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
  const [first, second] = mockJoin.mock.calls.map(
    ([body]) => (body as { redemptionId: string }).redemptionId,
  );
  expect(second).toBe(first);
  expect(admission).toHaveBeenCalledTimes(1);
});

it('reports a used, revoked or expired invitation as unavailable, from Uplink or the server', async () => {
  admission.mockRejectedValueOnce(new TeamJoinAdmissionError('unavailable'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'unavailable' });
  expect(tunnel.start).not.toHaveBeenCalled();
  mockJoin.mockRejectedValue(new VerityApiError(410, 'gone'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toBeInstanceOf(TeamJoinError);
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'unavailable' });
  expect(mockSetToken).not.toHaveBeenCalled();
});

it('joins a second server next to the one the app already uses', async () => {
  mockProfile.current = { serverId: 'srv_mine', activeUrl: 'https://mine.example' };
  await joinTeam(link, 'Lena', deps);
  // Activating keeps the previous server among the others (serverProfile.test).
  expect(mockSaveProfile).toHaveBeenCalledWith(
    expect.objectContaining({ serverId: link.serverId, sharedBy: 'Holger Teske' }),
  );
});

it('refuses to join a server this app already knows, without contacting it', async () => {
  mockOthers.current = [{ serverId: link.serverId, activeUrl: link.coreOrigin }];
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'known_server' });
  expect(admission).not.toHaveBeenCalled();
  expect(mockClients).toHaveLength(0);
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
});
