import * as SecureStore from 'expo-secure-store';

import {
  activateServerProfile,
  addServerEndpoint,
  getOtherServerProfiles,
  getServerProfile,
  hydrateServerProfile,
  removeOtherServerProfile,
  profileFromPairing,
  saveRemoteControlDescriptor,
  saveServerProfile,
} from './serverProfile';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const pairing = {
  version: 1 as const,
  serverId: 'srv_0123456789abcdef',
  identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
  suggestedUrl: 'https://192.168.1.42:8082',
  expiresAt: '2026-08-29T12:15:00.000Z',
};

describe('server profile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a direct profile without persisting the pairing secret', async () => {
    const profile = profileFromPairing(pairing, pairing.suggestedUrl);
    await saveServerProfile(profile);
    const encoded = (SecureStore.setItemAsync as jest.Mock).mock.calls[0]?.[1] as string;
    expect(encoded).not.toContain(pairing.pairingCode);
    expect(JSON.parse(encoded)).toMatchObject({
      serverId: pairing.serverId,
      activeUrl: pairing.suggestedUrl,
    });
  });

  it('adds an Uplink endpoint under the same immutable identity', async () => {
    await saveServerProfile(profileFromPairing(pairing, pairing.suggestedUrl));
    const updated = await addServerEndpoint({
      url: 'https://my-server.uplink.verity.build/path',
      transport: 'uplink',
    });
    expect(updated.serverId).toBe(pairing.serverId);
    expect(updated.endpoints).toContainEqual({
      url: 'https://my-server.uplink.verity.build',
      transport: 'uplink',
    });
  });

  it('fails closed when persisted profile integrity is invalid', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({
        ...profileFromPairing(pairing, pairing.suggestedUrl),
        identityKey: '../bad',
      }),
    );
    await expect(hydrateServerProfile()).rejects.toThrow(/paired server profile/u);
  });

  it('keeps a routing handle during a control outage and removes it on disablement', async () => {
    await saveServerProfile(profileFromPairing(pairing, pairing.suggestedUrl));
    const enabled = await saveRemoteControlDescriptor({
      version: 1,
      enabled: true,
      installationId: '27ad741c-d58c-4b37-ab3b-e32068176c32',
      installationHandle: 'STO_txvEudnAmaYQdCpu2A',
      uplinkOrigin: 'https://uplink.verity.build',
      capabilities: ['remote-control-v1'],
    });
    const writes = (SecureStore.setItemAsync as jest.Mock).mock.calls.length;
    expect(
      await saveRemoteControlDescriptor({ version: 1, enabled: false, reason: 'unavailable' }),
    ).toEqual(enabled);
    expect((SecureStore.setItemAsync as jest.Mock).mock.calls).toHaveLength(writes);
    expect(
      await saveRemoteControlDescriptor({ version: 1, enabled: false, reason: 'disabled' }),
    ).not.toHaveProperty('remoteControl');
  });
});

describe('several servers', () => {
  const stored = new Map<string, string>();
  const other = {
    ...profileFromPairing(
      { ...pairing, serverId: 'srv_fedcba9876543210', suggestedUrl: 'https://10.0.0.7:8443' },
      'https://10.0.0.7:8443',
    ),
    sharedBy: 'Holger',
  };
  beforeEach(() => {
    stored.clear();
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(
      async (key: string) => stored.get(key) ?? null,
    );
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(
      async (key: string, value: string) => void stored.set(key, value),
    );
  });

  it('keeps the previously active server when another one becomes active', async () => {
    const mine = profileFromPairing(pairing, pairing.suggestedUrl);
    await saveServerProfile(mine);
    await activateServerProfile(other);
    expect(getServerProfile()?.serverId).toBe(other.serverId);
    expect(getServerProfile()?.sharedBy).toBe('Holger');
    expect(getOtherServerProfiles().map((profile) => profile.serverId)).toEqual([mine.serverId]);

    // Switching back swaps them; neither is lost or duplicated, across a restart too.
    await activateServerProfile(getOtherServerProfiles()[0]!);
    await hydrateServerProfile();
    expect(getServerProfile()?.serverId).toBe(mine.serverId);
    expect(getOtherServerProfiles().map((profile) => profile.serverId)).toEqual([other.serverId]);
  });

  it('drops one unreadable stored server without losing the others', async () => {
    await saveServerProfile(profileFromPairing(pairing, pairing.suggestedUrl));
    stored.set(
      'verity.serverProfiles.others.v1',
      JSON.stringify([{ ...other, identityKey: '../bad' }, other]),
    );
    await hydrateServerProfile();
    expect(getOtherServerProfiles().map((profile) => profile.serverId)).toEqual([other.serverId]);
  });

  it('keeps both servers stored at every step of a switch', async () => {
    const mine = profileFromPairing(pairing, pairing.suggestedUrl);
    await saveServerProfile(mine);
    await activateServerProfile(other);
    await activateServerProfile(getOtherServerProfiles()[0]!);
    // Replay every intermediate state of the second switch: no write may leave
    // one of the two servers in neither the active slot nor the others.
    const writes = (SecureStore.setItemAsync as jest.Mock).mock.calls.slice(-3);
    const state = new Map<string, string>();
    for (const [key, value] of writes.slice(0, -3)) state.set(key as string, value as string);
    const known = () => {
      const ids = new Set<string>();
      const active = state.get('verity.serverProfile.v1');
      if (active) ids.add((JSON.parse(active) as { serverId: string }).serverId);
      for (const profile of JSON.parse(state.get('verity.serverProfiles.others.v1') ?? '[]') as {
        serverId: string;
      }[])
        ids.add(profile.serverId);
      return ids;
    };
    state.set('verity.serverProfile.v1', JSON.stringify(other));
    state.set('verity.serverProfiles.others.v1', JSON.stringify([mine]));
    for (const [key, value] of writes) {
      state.set(key as string, value as string);
      expect([...known()].sort()).toEqual([mine.serverId, other.serverId].sort());
    }
  });

  it('forgets a server that is not the active one', async () => {
    await saveServerProfile(profileFromPairing(pairing, pairing.suggestedUrl));
    await activateServerProfile(other);
    await removeOtherServerProfile(pairing.serverId);
    expect(getOtherServerProfiles()).toEqual([]);
    expect(getServerProfile()?.serverId).toBe(other.serverId);
  });
});
