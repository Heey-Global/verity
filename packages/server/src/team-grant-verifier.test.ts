import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseVerifiedTeamGrant,
  type TeamGrantVerificationContext,
} from './team-grant-verifier.js';

const vectors = JSON.parse(
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../scripts/team-grant-contract/generate-vectors.mjs', import.meta.url),
      ),
    ],
    { encoding: 'utf8' },
  ),
) as { testPublicKey: string; valid: string; invalid: Record<string, string> };
const context: TeamGrantVerificationContext = {
  installationId: 'installation_fixture',
  keys: new Map([['fixture_key_1', Buffer.from(vectors.testPublicKey, 'base64url')]]),
  nowSeconds: 1_800_000_100,
  trustedTimeFloorSeconds: 1_800_000_000,
};

function withPart(assertion: string, index: number, part: string): string {
  const segments = assertion.split('.');
  segments[index] = part;
  return segments.join('.');
}

describe('team grant verifier', () => {
  it('verifies the fixture with a pinned public key and expected installation', () => {
    expect(parseVerifiedTeamGrant(vectors.valid, context)).toMatchObject({
      installationId: context.installationId,
      generation: 7,
      capabilities: ['team-sharing'],
    });
  });

  it.each(Object.entries(vectors.invalid).filter(([name]) => name !== 'notYetValid'))(
    'rejects %s',
    (_name, assertion) => {
      expect(() => parseVerifiedTeamGrant(assertion, context)).toThrow();
    },
  );

  it('rejects an unknown key even when the assertion is otherwise valid', () => {
    expect(() => parseVerifiedTeamGrant(vectors.valid, { ...context, keys: new Map() })).toThrow();
  });

  it('rejects wrong installation, expiry, not-before and clock rollback independently', () => {
    expect(() =>
      parseVerifiedTeamGrant(vectors.valid, { ...context, installationId: 'other_installation' }),
    ).toThrow();
    expect(() =>
      parseVerifiedTeamGrant(vectors.valid, { ...context, nowSeconds: 1_800_000_900 }),
    ).toThrow();
    expect(() =>
      parseVerifiedTeamGrant(vectors.invalid.notYetValid!, {
        ...context,
        nowSeconds: 1_800_000_050,
        trustedTimeFloorSeconds: 1_800_000_000,
      }),
    ).toThrow(/not currently valid/u);
    expect(() =>
      parseVerifiedTeamGrant(vectors.valid, {
        ...context,
        trustedTimeFloorSeconds: context.nowSeconds + 31,
      }),
    ).toThrow();
  });

  it('rejects noncanonical base64url and extra JWS segments', () => {
    expect(() => parseVerifiedTeamGrant(`${vectors.valid}.x`, context)).toThrow();
    const payload = vectors.valid.split('.')[1]!;
    expect(() =>
      parseVerifiedTeamGrant(withPart(vectors.valid, 1, `${payload}=`), context),
    ).toThrow();
    expect(() =>
      parseVerifiedTeamGrant(withPart(vectors.valid, 1, `${payload}\n`), context),
    ).toThrow();
  });
});
