import { describe, expect, it } from 'vitest';

import type { SecretStatus } from './api.js';
import {
  MIN_MASTER_PASSWORD_LENGTH,
  secretPatchFromDraft,
  secretUiMode,
  secretWritable,
  validateMasterPassword,
  type SecretSettingsDraft,
} from './secretSettings.js';

const EMPTY_DRAFT: SecretSettingsDraft = {
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitSshPrivateKey: '',
  codexAuthJson: '',
  dopplerServiceToken: '',
  uplinkSubscriptionKey: '',
  transcribeApiKey: '',
};

describe('secretUiMode', () => {
  it.each([
    ['uninitialized', 'set'],
    ['sealed', 'unlock'],
    ['unlocked', 'ready'],
    ['unmanaged', 'hidden'],
  ] as Array<[SecretStatus, ReturnType<typeof secretUiMode>]>)('maps %s → %s', (status, mode) => {
    expect(secretUiMode(status)).toBe(mode);
  });
});

describe('secretWritable', () => {
  it('is true only when unlocked', () => {
    expect(secretWritable('unlocked')).toBe(true);
    expect(secretWritable('sealed')).toBe(false);
    expect(secretWritable('uninitialized')).toBe(false);
    expect(secretWritable('unmanaged')).toBe(false);
  });
});

describe('validateMasterPassword', () => {
  it('rejects a password shorter than the minimum', () => {
    const short = 'a'.repeat(MIN_MASTER_PASSWORD_LENGTH - 1);
    expect(validateMasterPassword(short, short)).toMatch(/at least/);
  });

  it('rejects a too-uniform password', () => {
    const pw = 'a'.repeat(MIN_MASTER_PASSWORD_LENGTH);
    expect(validateMasterPassword(pw, pw)).toMatch(/more varied/);
  });

  it('rejects a mismatched confirmation', () => {
    expect(validateMasterPassword('correct-horse-1', 'battery-staple-2')).toMatch(/do not match/);
  });

  it('accepts a strong-enough matching pair', () => {
    const pw = 'correct-horse-1';
    expect(validateMasterPassword(pw, pw)).toBeNull();
  });

  it('checks length before match (length message wins for a short mismatch)', () => {
    expect(validateMasterPassword('short', 'other')).toMatch(/at least/);
  });
});

describe('secretPatchFromDraft', () => {
  it('always includes the non-secret App identifiers, trimming blanks to null', () => {
    const patch = secretPatchFromDraft(EMPTY_DRAFT);
    expect(patch).toHaveProperty('githubAppId', null);
    expect(patch).toHaveProperty('githubAppInstallationId', null);
  });

  it('trims and keeps non-empty App identifiers', () => {
    const patch = secretPatchFromDraft({
      ...EMPTY_DRAFT,
      githubAppId: '  12345  ',
      githubAppInstallationId: '67890',
    });
    expect(patch.githubAppId).toBe('12345');
    expect(patch.githubAppInstallationId).toBe('67890');
  });

  it('omits secret values entirely when their paste field is empty', () => {
    const patch = secretPatchFromDraft(EMPTY_DRAFT);
    expect(patch).not.toHaveProperty('githubAppPrivateKey');
    expect(patch).not.toHaveProperty('gitSshPrivateKey');
  });

  it('omits a secret value that is only whitespace', () => {
    const patch = secretPatchFromDraft({
      ...EMPTY_DRAFT,
      githubAppPrivateKey: '   \n  ',
      gitSshPrivateKey: '\t',
    });
    expect(patch).not.toHaveProperty('githubAppPrivateKey');
    expect(patch).not.toHaveProperty('gitSshPrivateKey');
  });

  it('includes a non-empty secret value, trimmed', () => {
    // Neutral non-PEM fixtures — the builder trims arbitrary strings; using real
    // key-shaped literals only trips secret scanners.
    const patch = secretPatchFromDraft({
      ...EMPTY_DRAFT,
      githubAppPrivateKey: '  app-key-fixture-value  ',
      gitSshPrivateKey: 'ssh-key-fixture-value\n',
    });
    expect(patch.githubAppPrivateKey).toBe('app-key-fixture-value');
    expect(patch.gitSshPrivateKey).toBe('ssh-key-fixture-value');
  });

  it('omits Codex login JSON when empty, includes it trimmed when set', () => {
    expect(secretPatchFromDraft(EMPTY_DRAFT)).not.toHaveProperty('codexAuthJson');

    const patch = secretPatchFromDraft({
      ...EMPTY_DRAFT,
      codexAuthJson: '{"tokens":{"access_token":"codex-fixture"}}\n',
    });
    expect(patch.codexAuthJson).toBe('{"tokens":{"access_token":"codex-fixture"}}');
  });

  it('omits the Doppler token when empty, includes it trimmed when set', () => {
    expect(secretPatchFromDraft(EMPTY_DRAFT)).not.toHaveProperty('dopplerServiceToken');
    expect(
      secretPatchFromDraft({ ...EMPTY_DRAFT, dopplerServiceToken: '   \n' }),
    ).not.toHaveProperty('dopplerServiceToken');

    const patch = secretPatchFromDraft({
      ...EMPTY_DRAFT,
      dopplerServiceToken: '  dp.sa.doppler-fixture  ',
    });
    expect(patch.dopplerServiceToken).toBe('dp.sa.doppler-fixture');
  });

  it('keeps an existing transcription token unless a replacement is entered', () => {
    expect(secretPatchFromDraft(EMPTY_DRAFT)).not.toHaveProperty('transcribeApiKey');
    expect(
      secretPatchFromDraft({ ...EMPTY_DRAFT, transcribeApiKey: '  cloud-secret  ' }),
    ).toMatchObject({ transcribeApiKey: 'cloud-secret' });
  });
});
