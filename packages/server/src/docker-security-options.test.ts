import { describe, expect, it } from 'vitest';
import { hasNoNewPrivileges, normalizeSecurityOptions } from './docker-security-options.js';

describe('Docker security option compatibility', () => {
  it.each(['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true'])(
    'recognizes enabled option %s',
    (option) => expect(hasNoNewPrivileges([option])).toBe(true),
  );
  it.each([undefined, [], ['no-new-privileges=false'], ['no-new-privileges:false']])(
    'does not accept absent or disabled hardening: %j',
    (options) => expect(hasNoNewPrivileges(options)).toBe(false),
  );
  it('deduplicates inherited spellings without changing other security policies', () => {
    expect(
      normalizeSecurityOptions([
        'no-new-privileges:true',
        'seccomp=profile.json',
        'no-new-privileges=true',
      ]),
    ).toEqual(['no-new-privileges=true', 'seccomp=profile.json']);
  });
});
