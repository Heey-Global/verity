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
const mockStoredTokenId = jest.fn(async (_url: string) => null as string | null);
jest.mock('./authToken', () => ({
  getStoredAuthTokenId: (url: string) => mockStoredTokenId(url),
  adoptStoredAuthToken: jest.fn(),
  setAuthToken: (...args: unknown[]) => mockSetToken(...args),
}));
const mockSetBaseUrl = jest.fn(async (_url: string, signal?: AbortSignal, commit?: () => void) => {
  throwIfAborted(signal);
  mockCalls.push('baseUrl');
  commit?.();
});
jest.mock('./client', () => ({
  setVerityBaseUrl: (...args: Parameters<typeof mockSetBaseUrl>) => mockSetBaseUrl(...args),
}));
jest.mock('./deviceLabel', () => ({ deviceLabel: () => 'Lena’s iPhone' }));
const mockTransport = jest.fn(async (_binding: unknown, ..._args: unknown[]) => new Response('{}'));
const mockVerify = jest.fn(async (_input: unknown) => undefined);
jest.mock('./pinnedTransport', () => ({
  createPinnedFetch:
    (pin: string, useRemote: boolean, port?: number) =>
    (...args: unknown[]) =>
      mockTransport({ pin, useRemote, port }, ...args),
  verifyPairedIdentity: (input: unknown) => mockVerify(input),
}));
const mockProfile = { current: null as unknown };
const mockSaveProfile = jest.fn(
  async (profile: unknown, signal?: AbortSignal, finalize?: () => Promise<void>) => {
    mockCalls.push('profile');
    mockProfile.current = profile;
    throwIfAborted(signal);
    await finalize?.();
  },
);
const mockOthers = { current: [] as unknown[] };
jest.mock('./serverProfile', () => ({
  getServerProfile: () => mockProfile.current,
  getOtherServerProfiles: () => mockOthers.current,
  activateServerProfile: (...args: Parameters<typeof mockSaveProfile>) => mockSaveProfile(...args),
}));
const mockProgress = { current: null as unknown };
const mockSaveProgress = jest.fn(async (value: unknown) => {
  mockCalls.push('save');
  mockProgress.current = value;
});
jest.mock('./teamJoinState', () => ({
  loadTeamJoinProgress: async () => mockProgress.current,
  saveTeamJoinProgress: (value: unknown) => mockSaveProgress(value),
  clearTeamJoinProgress: async () => {
    mockProgress.current = null;
  },
}));
const mockRemote = jest.fn();
jest.mock('./remoteControlAdmission', () => ({
  requestRemoteControlAdmission: (...args: unknown[]) => mockRemote(...args),
}));
const mockComplete = jest.fn();
const mockCapabilities = jest.fn();
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
      people = {
        teamJoinCapabilities: () => mockCapabilities(),
        completeTeamJoin: () => mockComplete(),
      };
      fetchPairingIdentity = (challenge: string) => mockIdentity(challenge);
      joinTeam = (body: unknown) => mockJoin(body);
    },
  };
});

import { VerityApiError } from '@verity/mobile';

import { withReactNativeAbortController } from '../__tests__/support/reactNativeAbortController';
import { throwIfAborted } from './abortSignal';
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
  mockStoredTokenId.mockReset().mockResolvedValue(null);
  mockProgress.current = null;
  mockSaveProgress.mockImplementation(async (value: unknown) => {
    mockCalls.push('save');
    mockProgress.current = value;
  });
  mockCapabilities.mockResolvedValue({ completion: 1 });
  mockComplete.mockImplementation(async () => {
    mockCalls.push('complete');
    return { projectId: 'p1', confirmed: true };
  });
  mockRemote.mockResolvedValue({
    sessionId: 'resumed',
    ticket: 'resume_ticket',
    expiresAt: Date.now() + 60_000,
    cancel: jest.fn(),
    finish: jest.fn(),
  });
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
    signal: expect.any(AbortSignal),
  });
  const dataUrl = new URL(link.uplinkOrigin);
  dataUrl.protocol = 'wss:';
  dataUrl.pathname = '/data';
  expect(tunnel.start).toHaveBeenCalledWith(
    dataUrl.href,
    'app_ticket',
    'session_1',
    link.coreOrigin,
    'team-bootstrap-v1',
  );
  expect(finish).toHaveBeenCalled();
  // Only through that tunnel, only with the link's pin: never the direct route.
  expect(mockClients[0]).toMatchObject({
    baseUrl: link.coreOrigin,
    fetch: expect.any(Function),
    uploadFetch: expect.any(Function),
    getToken: expect.any(Function),
  });
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
  expect(mockSetToken).toHaveBeenCalledWith(link.coreOrigin, 'device-token', 'tok-1', false);
  expect(mockCalls).toEqual([
    'admission',
    'save',
    'tunnel',
    'join',
    'save',
    'complete',
    'stop',
    'token',
    'profile',
    'baseUrl',
  ]);
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
    expect.any(AbortSignal),
    expect.any(Function),
  );
});

it('refuses to join a server this app already knows, without contacting it', async () => {
  mockOthers.current = [{ serverId: link.serverId, activeUrl: link.coreOrigin }];
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'known_server' });
  expect(admission).not.toHaveBeenCalled();
  expect(mockClients).toHaveLength(0);
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
});

it('refuses a link naming the address of another server this app uses', async () => {
  mockOthers.current = [
    {
      serverId: 'srv_other',
      activeUrl: link.coreOrigin,
      endpoints: [{ url: link.coreOrigin, transport: 'direct', tlsPin: 'sha256-x' }],
    },
  ];
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'invalid' });
  expect(admission).not.toHaveBeenCalled();
  expect(mockSetToken).not.toHaveBeenCalled();
});

it('never authorizes activation when the credential cannot be durably saved', async () => {
  mockSaveProgress.mockImplementation(async (value: unknown) => {
    if ((value as { credential?: unknown }).credential) throw new Error('keychain unavailable');
    mockProgress.current = value;
  });
  await expect(joinTeam(link, 'Lena', deps)).rejects.toThrow('keychain unavailable');
  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(tunnel.stop).toHaveBeenCalled();
});

// React Native's AbortSignal has no throwIfAborted and no reason; a join that
// relied on either failed on a device before contacting Uplink.
it('joins on the AbortController React Native ships', async () => {
  await withReactNativeAbortController(async () => {
    await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
  });
  expect(mockSaveProfile).toHaveBeenCalled();
});

it('stops a join on React Native’s AbortController and keeps the saved progress', async () => {
  await withReactNativeAbortController(async () => {
    const controller = new AbortController();
    mockComplete.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('answer lost');
    });
    await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  });
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(mockProgress.current).toMatchObject({ credential: { token: 'device-token' } });
});

it('resumes with the saved bearer after a lost completion answer, without redeeming again', async () => {
  mockComplete.mockRejectedValue(new Error('answer lost'));
  const controller = new AbortController();
  mockComplete.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('answer lost');
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  expect(mockProgress.current).toMatchObject({
    credential: { token: 'device-token' },
    link: { secret: '' },
  });
  mockComplete.mockResolvedValue({ projectId: 'p1', confirmed: true });
  await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
  expect(mockJoin).toHaveBeenCalledTimes(1);
  expect(admission).toHaveBeenLastCalledWith(
    expect.objectContaining({ redemptionId: 'redemption_from_uplink' }),
  );
  expect(mockRemote).not.toHaveBeenCalled();
});

it('rejects an incompatible Core before redeeming the invitation', async () => {
  mockCapabilities.mockRejectedValue(new Error('not found'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'incompatible' });
  expect(mockJoin).not.toHaveBeenCalled();
  expect(mockComplete).not.toHaveBeenCalled();
});

it('cleans up a failed tunnel start', async () => {
  tunnel.start.mockRejectedValueOnce(new Error('attachment failed'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toThrow('attachment failed');
  expect(tunnel.stop).toHaveBeenCalled();
  expect(finish).toHaveBeenCalled();
});

it('keeps the saved server binding when the same invitation id is supplied with another origin', async () => {
  const controller = new AbortController();
  mockComplete.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('lost');
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  mockComplete.mockResolvedValue({ projectId: 'p1', confirmed: true });
  await joinTeam({ ...link, coreOrigin: 'https://other.example' }, 'Lena', deps);
  expect(mockClients.at(-1)?.baseUrl).toBe(link.coreOrigin);
  expect(mockSetToken).toHaveBeenLastCalledWith(
    link.coreOrigin,
    'device-token',
    expect.any(String),
    false,
  );
});

it('retains the redemption beyond ticket expiry while the original recovery window remains', async () => {
  const controller = new AbortController();
  mockJoin.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('lost');
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  const saved = mockProgress.current as {
    admission: { expiresAt: number };
    recoveryExpiresAt: number;
  };
  saved.admission.expiresAt = Date.now() - 1;
  expect(saved.recoveryExpiresAt).toBeGreaterThan(Date.now());
  mockJoin.mockResolvedValue({
    token: 'device-token',
    tokenId: 't1',
    projectId: 'p1',
    completionExpiresAt: Date.now() + 60_000,
  });
  await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
  expect(admission).toHaveBeenLastCalledWith(
    expect.objectContaining({ redemptionId: 'redemption_from_uplink' }),
  );
});

it('does not switch profiles when cancelled during final credential storage', async () => {
  const controller = new AbortController();
  mockSetToken.mockImplementationOnce(async () => {
    controller.abort();
    return true;
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
  expect(mockProgress.current).toMatchObject({ credential: { token: 'device-token' } });
});

it('does not adopt credentials or switch the base URL after cancellation during profile activation', async () => {
  const controller = new AbortController();
  mockSaveProfile.mockImplementationOnce(async () => {
    controller.abort();
    controller.signal.throwIfAborted();
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  expect(mockSetBaseUrl).not.toHaveBeenCalled();
  expect(mockProgress.current).toMatchObject({ credential: { token: 'device-token' } });
});

it('releases terminal invitation progress so a replacement can be accepted', async () => {
  tunnel.start.mockRejectedValueOnce(new Error('attachment failed'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toThrow();
  admission.mockRejectedValueOnce(new TeamJoinAdmissionError('unavailable'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'unavailable' });
  expect(mockProgress.current).toBeNull();
  await expect(joinTeam({ ...link, invitationId: 'replacement' }, 'Lena', deps)).resolves.toEqual({
    projectId: 'p1',
  });
});

it.each([new Error('Uplink unreachable'), new TeamJoinAdmissionError('unavailable')])(
  'finishes with the saved bearer through pinned Core when bootstrap recovery fails: %s',
  async (failure) => {
    const controller = new AbortController();
    mockComplete.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('lost');
    });
    await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
    admission.mockRejectedValueOnce(failure);
    mockComplete.mockResolvedValue({ projectId: 'p1', confirmed: true });
    await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
    expect(mockJoin).toHaveBeenCalledTimes(1);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
    expect(mockRemote).not.toHaveBeenCalled();
  },
);

it.each(['start', 'transport'])(
  'recovers with the saved bearer when bootstrap %s fails after admission',
  async (failure) => {
    const controller = new AbortController();
    mockComplete.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('lost');
    });
    await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
    if (failure === 'start') tunnel.start.mockRejectedValueOnce(new Error('attachment failed'));
    mockTransport.mockImplementation(async (binding: unknown) => {
      if ((binding as { port?: number }).port !== undefined) throw new Error('tunnel broken');
      return new Response('{}');
    });
    mockComplete.mockImplementation(async () => {
      await (mockClients.at(-1)!.fetch as typeof fetch)(link.coreOrigin + '/team/join/complete');
      return { projectId: 'p1', confirmed: true };
    });
    await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
    expect(mockTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ pin: link.tlsPin, port: undefined }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockJoin).toHaveBeenCalledTimes(1);
    expect(mockRemote).not.toHaveBeenCalled();
  },
);

it('uses one ordinary Remote Control attachment when both bootstrap and direct transport fail', async () => {
  const controller = new AbortController();
  mockComplete.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('lost');
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  tunnel.start.mockImplementation(async (...args: unknown[]) =>
    args[4] === 'remote-control-v1' ? PORT + 1 : PORT,
  );
  mockTransport.mockImplementation(async (binding: unknown) => {
    if ((binding as { port?: number }).port !== PORT + 1) throw new Error('unreachable');
    return new Response('{}');
  });
  mockComplete.mockImplementation(async () => {
    await (mockClients.at(-1)!.fetch as typeof fetch)(link.coreOrigin + '/team/join/complete');
    return { projectId: 'p1', confirmed: true };
  });
  await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
  expect(mockRemote).toHaveBeenCalledTimes(1);
  expect(mockJoin).toHaveBeenCalledTimes(1);
});

it.each(['same-server', 'same-address'])(
  'preserves an intervening account when resuming a saved join: %s',
  async (collision) => {
    const controller = new AbortController();
    mockComplete.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('lost');
    });
    await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
    mockProfile.current = {
      serverId: collision === 'same-server' ? link.serverId : 'another-server',
      activeUrl: link.coreOrigin,
      endpoints: [{ url: link.coreOrigin }],
    };
    mockStoredTokenId.mockResolvedValueOnce('another-account');
    await expect(joinTeam(link, 'Lena', deps)).rejects.toBeInstanceOf(Error);
    expect(mockSetToken).not.toHaveBeenCalled();
    expect(mockSaveProfile).not.toHaveBeenCalled();
  },
);

it('allows a saved join to finish its own partially activated profile', async () => {
  const controller = new AbortController();
  mockComplete.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('lost');
  });
  await expect(joinTeam(link, 'Lena', { ...deps, signal: controller.signal })).rejects.toThrow();
  mockProfile.current = {
    serverId: link.serverId,
    activeUrl: link.coreOrigin,
    endpoints: [{ url: link.coreOrigin }],
  };
  mockStoredTokenId.mockResolvedValue('tok-1');
  mockComplete.mockResolvedValue({ projectId: 'p1', confirmed: true });
  await expect(joinTeam(link, 'Lena', deps)).resolves.toEqual({ projectId: 'p1' });
});

it('rechecks account collisions after completion before writing the new credential', async () => {
  mockComplete.mockImplementation(async () => {
    mockProfile.current = {
      serverId: link.serverId,
      activeUrl: link.coreOrigin,
      endpoints: [{ url: link.coreOrigin }],
    };
    return { projectId: 'p1', confirmed: true };
  });
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'known_server' });
  expect(mockSetToken).not.toHaveBeenCalled();
  expect(mockSaveProfile).not.toHaveBeenCalled();
});

it('rejects formatting characters before reserving or saving a new join', async () => {
  await expect(joinTeam(link, 'Lena\u200b', deps)).rejects.toMatchObject({ reason: 'name' });
  expect(admission).not.toHaveBeenCalled();
  expect(mockSaveProgress).not.toHaveBeenCalled();
});

it('corrects a server-rejected name while preserving the original recovery admission', async () => {
  mockJoin.mockRejectedValueOnce(new VerityApiError(400, 'invalid name'));
  await expect(joinTeam(link, 'Lena', deps)).rejects.toMatchObject({ reason: 'name' });
  expect(mockProgress.current).toMatchObject({
    admission: { redemptionId: 'redemption_from_uplink' },
  });
  await expect(joinTeam(link, 'Sam', deps)).resolves.toEqual({ projectId: 'p1' });
  expect(mockJoin).toHaveBeenLastCalledWith(
    expect.objectContaining({ displayName: 'Sam', redemptionId: 'redemption_from_uplink' }),
  );
});
