import { describe, expect, it } from 'vitest';
import { isReleaseBotLogin, releaseBotLogins } from './release-bot-logins.mjs';

describe('release bot logins', () => {
  it('trusts GitHub Actions history and the configured release app', () => {
    const logins = releaseBotLogins('verity-release-bot[bot]');
    expect(logins).toEqual(['github-actions[bot]', 'verity-release-bot[bot]']);
    expect(isReleaseBotLogin('github-actions[bot]', logins)).toBe(true);
    expect(isReleaseBotLogin('app/github-actions', logins)).toBe(true);
    expect(isReleaseBotLogin('verity-release-bot[bot]', logins)).toBe(true);
    expect(isReleaseBotLogin('app/verity-release-bot', logins)).toBe(true);
  });

  it('keeps humans, other apps and missing logins untrusted', () => {
    const logins = releaseBotLogins('verity-release-bot[bot]');
    for (const login of ['h-teske', 'renovate[bot]', 'app/renovate', '', null, undefined])
      expect(isReleaseBotLogin(login, logins)).toBe(false);
  });

  it('fails closed when the app slug is unresolved', () => {
    // A workflow that could not mint a token passes `[bot]` alone.
    expect(() => releaseBotLogins('[bot]')).toThrow('Invalid release bot login');
    expect(releaseBotLogins('')).toEqual(['github-actions[bot]']);
  });

  it('rejects logins that are not app identities', () => {
    expect(() => releaseBotLogins('h-teske')).toThrow('Invalid release bot login');
  });
});
