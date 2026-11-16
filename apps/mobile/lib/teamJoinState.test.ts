const mockItems = new Map<string, string>();
const mockWrite = jest.fn(async (key: string, value: string) => {
  mockItems.set(key, value);
});
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: async (key: string) => mockItems.get(key) ?? null,
  setItemAsync: (key: string, value: string) => mockWrite(key, value),
  deleteItemAsync: async (key: string) => {
    mockItems.delete(key);
  },
}));
import { loadTeamJoinProgress, saveTeamJoinProgress, type TeamJoinProgress } from './teamJoinState';
const progress = (): TeamJoinProgress => ({
  version: 1,
  displayName: 'Sam',
  link: {
    invitationId: 'invite',
    secret: 'secret',
    expiresAt: Date.now() + 60_000,
    serverId: 'server',
    identityKey: 'identity',
    tlsPin: 'pin',
    coreOrigin: 'https://core.example',
    uplinkOrigin: 'https://uplink.example',
    installationId: 'installation',
    installationHandle: 'handle',
  },
  admission: {
    sessionId: 'session',
    redemptionId: 'redemption',
    ticket: 'ticket',
    expiresAt: Date.now() + 60_000,
  },
});
beforeEach(() => {
  mockItems.clear();
  mockWrite.mockClear();
});
it('recovers the server binding and credential from one durable encrypted-storage record', async () => {
  const saved = {
    ...progress(),
    credential: { token: 'device', tokenId: 'id', projectId: 'project' },
  };
  saved.link.secret = '';
  await saveTeamJoinProgress(saved);
  await expect(loadTeamJoinProgress()).resolves.toEqual(saved);
  expect(mockWrite).toHaveBeenCalledTimes(1);
});
it('detects a keychain write that did not persist', async () => {
  mockWrite.mockImplementationOnce(async () => undefined);
  await expect(saveTeamJoinProgress(progress())).rejects.toThrow('Could not save');
});
it('retires expired invitation material without discarding a saved device credential', async () => {
  const saved = progress();
  saved.admission.expiresAt = Date.now() - 1;
  await saveTeamJoinProgress(saved);
  await expect(loadTeamJoinProgress()).rejects.toThrow('new invitation');
  await expect(loadTeamJoinProgress()).resolves.toBeNull();
  saved.credential = { token: 'device', tokenId: 'id', projectId: 'project' };
  saved.link.secret = '';
  await saveTeamJoinProgress(saved);
  await expect(loadTeamJoinProgress()).resolves.toEqual(saved);
});
