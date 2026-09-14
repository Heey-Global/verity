import { describe, expect, it } from 'vitest';

import type { VeritySettings } from './api.js';
import {
  githubRepositoryAccessReady,
  settingsChecklist,
  settingsChecklistHeadline,
  verifiedCommitsReady,
  type SettingsChecklist,
} from './settingsChecklist.js';

function makeSettings(overrides: Partial<VeritySettings> = {}): VeritySettings {
  return {
    gitUserName: null,
    gitUserEmail: null,
    gitSshPrivateKeyPath: null,
    gitSshPublicKeyPath: null,
    gitKnownHostsPath: null,
    gitAllowedSignersPath: null,
    gitSshPrivateKeyConfigured: false,
    gitSshPublicKeyConfigured: false,
    gitKnownHostsConfigured: false,
    gitAllowedSignersConfigured: false,
    githubAppId: null,
    githubAppInstallationId: null,
    githubAppPrivateKeyConfigured: false,
    dopplerServiceTokenConfigured: false,
    uplinkSubscriptionKeyConfigured: false,
    uplinkInstallationId: null,
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeBackendMode: null,
    transcribeApiKeyConfigured: false,
    transcribeLocalAvailable: false,
    transcribeExternalConfigured: false,
    claudeCodeOauthCredentialsConfigured: false,
    codexAuthJsonConfigured: false,
    opencodeBaseUrl: null,
    opencodeModels: null,
    opencodeApiKeyConfigured: false,
    googleDriveClientId: null,
    googleDriveAccountEmail: null,
    googleDriveConnected: false,
    advancedModeEnabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CONNECTED_GITHUB: Partial<VeritySettings> = {
  githubAppId: '123',
  githubAppInstallationId: '456',
  githubAppPrivateKeyConfigured: true,
};

function readyChecklist(checklist: SettingsChecklist) {
  if (checklist.kind !== 'ready')
    throw new Error(`expected a ready checklist, got ${checklist.kind}`);
  return checklist;
}

describe('githubRepositoryAccessReady', () => {
  it('needs the whole App credential, not a usable-looking part of it', () => {
    expect(githubRepositoryAccessReady(makeSettings(CONNECTED_GITHUB))).toBe(true);
    // An installation id with no private key mints no token.
    expect(
      githubRepositoryAccessReady(
        makeSettings({ ...CONNECTED_GITHUB, githubAppPrivateKeyConfigured: false }),
      ),
    ).toBe(false);
    expect(
      githubRepositoryAccessReady(makeSettings({ ...CONNECTED_GITHUB, githubAppId: null })),
    ).toBe(false);
    expect(
      githubRepositoryAccessReady(
        makeSettings({ ...CONNECTED_GITHUB, githubAppInstallationId: null }),
      ),
    ).toBe(false);
  });
});

describe('verifiedCommitsReady', () => {
  it('accepts either a stored key or a deployment-level key path', () => {
    expect(verifiedCommitsReady(makeSettings({ gitSshPrivateKeyConfigured: true }))).toBe(true);
    expect(verifiedCommitsReady(makeSettings({ gitSshPrivateKeyPath: '/keys/id_ed25519' }))).toBe(
      true,
    );
    expect(verifiedCommitsReady(makeSettings({ gitSshPrivateKeyPath: '   ' }))).toBe(false);
    expect(verifiedCommitsReady(makeSettings())).toBe(false);
  });
});

describe('settingsChecklist', () => {
  it('counts every outstanding required step', () => {
    const checklist = readyChecklist(
      settingsChecklist({ settings: makeSettings(), secretStatus: 'sealed', failed: false }),
    );

    expect(checklist.items.map((item) => item.id)).toEqual([
      'secretStore',
      'githubAccess',
      'commitAuthor',
      'verifiedCommits',
    ]);
    expect(checklist.remaining).toBe(4);
    expect(settingsChecklistHeadline(checklist)).toBe('Setup · 4 to do');
  });

  it('is finished once the required steps are done', () => {
    const checklist = readyChecklist(
      settingsChecklist({
        settings: makeSettings({
          ...CONNECTED_GITHUB,
          gitUserName: 'Verity Bot',
          gitUserEmail: 'bot@example.test',
          gitSshPrivateKeyConfigured: true,
        }),
        secretStatus: 'unlocked',
        failed: false,
      }),
    );

    expect(checklist.remaining).toBe(0);
    expect(settingsChecklistHeadline(checklist)).toBe('All set');
  });

  it('leaves optional integrations out of the count', () => {
    // Doppler, the AI backend logins, transcription and MCP are opt-in. Counting
    // them would leave every deployment permanently mid-setup.
    const checklist = readyChecklist(
      settingsChecklist({
        settings: makeSettings({
          ...CONNECTED_GITHUB,
          gitUserName: 'Verity Bot',
          gitUserEmail: 'bot@example.test',
          gitSshPrivateKeyConfigured: true,
          dopplerServiceTokenConfigured: false,
          claudeCodeOauthCredentialsConfigured: false,
          codexAuthJsonConfigured: false,
          transcribeBackendMode: null,
        }),
        secretStatus: 'unlocked',
        failed: false,
      }),
    );

    expect(checklist.remaining).toBe(0);
  });

  it('drops the secret store when the deployment manages no cipher', () => {
    const checklist = readyChecklist(
      settingsChecklist({ settings: makeSettings(), secretStatus: 'unmanaged', failed: false }),
    );

    expect(checklist.items.map((item) => item.id)).toEqual([
      'githubAccess',
      'commitAuthor',
      'verifiedCommits',
    ]);
  });

  // The failure mode this guards is a header that reads "All set" because the
  // fetch it was computed from returned nothing — an operator told everything is
  // fine while the server is unreachable.
  it('never reports a count it could not compute', () => {
    expect(settingsChecklist({ settings: null, secretStatus: undefined, failed: true })).toEqual({
      kind: 'unavailable',
    });
    expect(
      settingsChecklist({ settings: makeSettings(), secretStatus: 'unlocked', failed: true }),
    ).toEqual({ kind: 'unavailable' });
    expect(settingsChecklist({ settings: null, secretStatus: 'unlocked', failed: false })).toEqual({
      kind: 'loading',
    });
    expect(
      settingsChecklist({ settings: makeSettings(), secretStatus: undefined, failed: false }),
    ).toEqual({ kind: 'loading' });

    expect(settingsChecklistHeadline({ kind: 'unavailable' })).toBe('Couldn’t load settings');
    expect(settingsChecklistHeadline({ kind: 'loading' })).toBe('Checking setup…');
    for (const kind of ['unavailable', 'loading'] as const) {
      expect(settingsChecklistHeadline({ kind })).not.toContain('to do');
      expect(settingsChecklistHeadline({ kind })).not.toContain('All set');
    }
  });
});
