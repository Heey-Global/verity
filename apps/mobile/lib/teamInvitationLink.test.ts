import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  invitationLink,
  parseTeamJoinLink,
  serverIdFor,
  TeamJoinLinkError,
} from './teamInvitationLink';

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

describe('parseTeamJoinLink', () => {
  // The contract's own fixtures decide what a valid link is, so a field the
  // contract adds or tightens shows up here instead of in a failed join.
  const fixtures = (
    JSON.parse(
      readFileSync(
        join(__dirname, '../../../scripts/team-control-contract/wire-fixtures.json'),
        'utf8',
      ),
    ) as Array<{ name: string; schema: string; valid: boolean; value: Record<string, unknown> }>
  ).filter((fixture) => fixture.schema === 'invitationLink');
  const encode = (value: unknown) =>
    `https://verity.build/join#${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  const before = new Date(1_700_000_000_000);
  const sha256 = async (bytes: Uint8Array) => {
    const digest = createHash('sha256').update(bytes).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.length);
  };

  it('has contract fixtures to check against', () => {
    expect(fixtures.some((fixture) => fixture.valid)).toBe(true);
    expect(fixtures.some((fixture) => !fixture.valid)).toBe(true);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    async (_name, fixture) => {
      let accepted: boolean;
      try {
        const link = parseTeamJoinLink(encode(fixture.value), before);
        accepted = (await serverIdFor(link.identityKey, sha256)) === link.serverId;
      } catch (error) {
        expect(error).toBeInstanceOf(TeamJoinLinkError);
        accepted = false;
      }
      expect(accepted).toBe(fixture.valid);
    },
  );

  it('reads back the link this app builds for an inviter', () => {
    const valid = fixtures.find((fixture) => fixture.valid)!.value;
    const built = invitationLink(
      { ...(valid as unknown as Parameters<typeof invitationLink>[0]) },
      {
        ...profile,
        serverId: valid.serverId as string,
        identityKey: valid.identityKey as string,
        activeUrl: valid.coreOrigin as string,
        endpoints: [
          {
            url: valid.coreOrigin as string,
            transport: 'direct',
            tlsPin: valid.tlsPin as string,
          },
        ],
      },
    )!;
    expect(parseTeamJoinLink(built, before)).toMatchObject({
      tlsPin: valid.tlsPin,
      coreOrigin: valid.coreOrigin,
      secret: valid.secret,
    });
  });

  it('refuses display names with format controls the contract would let through', () => {
    const valid = fixtures.find((fixture) => fixture.valid && 'display' in fixture.value)!.value;
    const spoofed = {
      ...valid,
      // U+202E reverses what follows on the join screen.
      display: { inviterName: 'Holger \u202e', projectName: 'verity' },
    };
    expect(() => parseTeamJoinLink(encode(spoofed), before)).toThrow(
      expect.objectContaining({ reason: 'invalid' }),
    );
  });

  it('tells an expired invitation apart from a broken link', () => {
    const valid = fixtures.find((fixture) => fixture.valid)!.value;
    const after = new Date((valid.expiresAt as number) + 1);
    expect(() => parseTeamJoinLink(encode(valid), after)).toThrow(
      expect.objectContaining({ reason: 'expired' }),
    );
    expect(() => parseTeamJoinLink('https://verity.build/join#e30', before)).toThrow(
      expect.objectContaining({ reason: 'invalid' }),
    );
    // Another host serving the same fragment is not an invitation.
    expect(() =>
      parseTeamJoinLink(encode(valid).replace('verity.build', 'verity.example'), before),
    ).toThrow(expect.objectContaining({ reason: 'invalid' }));
  });
});
