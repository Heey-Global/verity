import { invitationLink } from './teamInvitationLink';

const fields = {
  version: 1 as const,
  purpose: 'team-member' as const,
  invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
  secret: 'NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ',
  expiresAt: 1_800_000_000_000,
  serverId: 'srv_EREREREREREREREREREREQ',
  identityKey: 'MCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERE',
  uplinkOrigin: 'https://uplink.verity.build',
  installationId: '0b7f6e5d-4c3b-4a29-8817-161514131211',
  installationHandle: 'EREREREREREREREREREREQ',
  display: { inviterName: 'Holger', projectName: 'verity' },
};
const profile = {
  version: 1 as const,
  serverId: fields.serverId,
  identityKey: fields.identityKey,
  activeUrl: 'https://192.168.1.20:8443',
  endpoints: [
    { url: 'https://192.168.1.20:8443', transport: 'direct' as const, tlsPin: 'sha256-pin' },
  ],
};

const decode = (link: string) =>
  JSON.parse(
    Buffer.from(link.slice('https://verity.build/join#'.length), 'base64url').toString('utf8'),
  ) as Record<string, unknown>;

// The pin must come from this app's own paired profile, and only for the server
// it paired with: a server answering with another identity gets no link.
it('completes the link with the pinned address of the server this app paired with', () => {
  const link = invitationLink(fields, profile)!;
  expect(decode(link)).toMatchObject({
    tlsPin: 'sha256-pin',
    coreOrigin: 'https://192.168.1.20:8443',
    invitationId: fields.invitationId,
    purpose: 'team-member',
  });
  expect(invitationLink({ ...fields, serverId: 'srv_other' }, profile)).toBeUndefined();
  expect(
    invitationLink(fields, { ...profile, endpoints: [{ url: 'https://x', transport: 'uplink' }] }),
  ).toBeUndefined();
});
