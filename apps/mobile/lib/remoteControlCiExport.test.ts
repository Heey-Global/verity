import { remoteControlCiInputs } from './remoteControlCiExport';
import type { VerityServerProfile } from './serverProfile';

jest.mock('expo-secure-store', () => ({}));
const profile: VerityServerProfile = {
  version: 1,
  serverId: 'server',
  identityKey: 'private-identity',
  activeUrl: 'https://core.example',
  endpoints: [
    { url: 'https://core.example', transport: 'direct', tlsPin: `sha256-${'A'.repeat(43)}` },
  ],
  remoteControl: {
    version: 1,
    installationId: 'installation',
    installationHandle: 'handle',
    uplinkOrigin: 'https://uplink.example',
  },
};
it('shares exactly the workflow inputs for the active paired endpoint', () => {
  const report = remoteControlCiInputs({
    ...profile,
    token: 'secret',
    ticket: 'secret',
  } as VerityServerProfile);
  expect(report).toEqual({
    uplink_origin: profile.remoteControl!.uplinkOrigin,
    installation_handle: profile.remoteControl!.installationHandle,
    core_url: profile.activeUrl,
    core_pin: profile.endpoints[0]!.tlsPin,
  });
  expect(JSON.stringify(report)).not.toContain('secret');
  expect(JSON.stringify(report)).not.toContain(profile.identityKey);
});
it.each([
  null,
  { ...profile, remoteControl: undefined },
  { ...profile, activeUrl: 'https://other.example' },
  { ...profile, endpoints: [{ url: profile.activeUrl, transport: 'direct' as const }] },
])('rejects incomplete pairing instead of choosing another endpoint', (input) => {
  expect(() => remoteControlCiInputs(input)).toThrow();
});
