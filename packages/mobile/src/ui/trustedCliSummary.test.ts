import { describe, expect, it } from 'vitest';

import {
  trustedCliInjectionSummary,
  trustedCliSecretLabel,
  trustedCliSummary,
} from './trustedCliSummary.js';

describe('trustedCliSummary', () => {
  it('names every secret a run carries and where each one lands', () => {
    const summary = trustedCliSummary({
      secrets: [
        { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID' },
        { secretAlias: 'ASC_API_KEY_P8', env: 'ASC_KEY_FILE', injection: 'file' },
      ],
      command: ['/usr/local/bin/fastlane', 'deliver'],
    });
    expect(summary).toEqual({
      secrets: [
        { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID', injection: 'env' },
        { secretAlias: 'ASC_API_KEY_P8', env: 'ASC_KEY_FILE', injection: 'file' },
      ],
      command: ['/usr/local/bin/fastlane', 'deliver'],
      executable: '/usr/local/bin/fastlane',
      entryScript: null,
    });
    // File injection changes what is approved — a path Verity writes into the
    // sandbox rather than a value in a variable — so the card says which it is.
    expect(trustedCliInjectionSummary(summary!)).toBe(
      'ASC_API_KEY_ID as ASC_KEY_ID, ASC_API_KEY_P8 as a file at ASC_KEY_FILE',
    );
    expect(trustedCliSecretLabel(summary!)).toBe('2 secrets');
  });

  it('keeps the single-secret headline naming its alias', () => {
    const summary = trustedCliSummary({
      secrets: [{ secretAlias: 'TS_AUTHKEY', env: 'TS_AUTHKEY' }],
      command: ['/usr/bin/tailscale', 'up'],
    });
    expect(trustedCliSecretLabel(summary!)).toBe('TS_AUTHKEY');
    expect(trustedCliInjectionSummary(summary!)).toBe('TS_AUTHKEY as TS_AUTHKEY');
  });

  it('shows the hash and loading boundary for a worktree entry script', () => {
    expect(
      trustedCliSummary({
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
        command: ['/usr/bin/python3', '/work/project/deploy.py'],
        entryScript: {
          path: '/work/project/deploy.py',
          projectPath: 'deploy.py',
          sha256: 'a'.repeat(64),
          loading: 'isolated',
        },
      })?.entryScript,
    ).toEqual({
      path: '/work/project/deploy.py',
      projectPath: 'deploy.py',
      sha256: 'a'.repeat(64),
      loading: 'isolated',
    });
  });

  it('summarizes nothing rather than part of an invocation it cannot read', () => {
    // The pre-`secrets` flat shape. A card that silently rendered a blank
    // summary for it would still offer an Allow button.
    expect(
      trustedCliSummary({
        secretAlias: 'TS_AUTHKEY',
        env: 'TS_AUTHKEY',
        command: ['/usr/bin/tailscale', 'up'],
      }),
    ).toBeNull();
    // One unreadable entry among readable ones is the dangerous case: the card
    // must not show the two it understood and drop the third.
    expect(
      trustedCliSummary({
        secrets: [{ secretAlias: 'TS_AUTHKEY', env: 'TS_AUTHKEY' }, { secretAlias: 'ASC_KEY_ID' }],
        command: ['/usr/bin/tailscale', 'up'],
      }),
    ).toBeNull();
    expect(trustedCliSummary({ secrets: [], command: ['/usr/bin/tailscale', 'up'] })).toBeNull();
    expect(
      trustedCliSummary({
        secrets: [{ secretAlias: 'TS_AUTHKEY', env: 'TS_AUTHKEY' }],
        command: ['/usr/bin/tailscale', 42],
      }),
    ).toBeNull();
    expect(trustedCliSummary({ secrets: [{ secretAlias: 'TS_AUTHKEY', env: 'TS_AUTHKEY' }] })).toBe(
      null,
    );
    // An injection mode the card does not know is not `env`. Rendering it as one
    // would promise a variable where a file may be written instead.
    expect(
      trustedCliSummary({
        secrets: [{ secretAlias: 'TS_AUTHKEY', env: 'TS_AUTHKEY', injection: 'stdin' }],
        command: ['/usr/bin/tailscale', 'up'],
      }),
    ).toBeNull();
    expect(trustedCliSummary(null)).toBeNull();
    expect(trustedCliSummary('verity_secret_run')).toBeNull();
  });
});
