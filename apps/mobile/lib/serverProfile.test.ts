import * as SecureStore from 'expo-secure-store';

import {
  addServerEndpoint,
  hydrateServerProfile,
  profileFromPairing,
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
});
