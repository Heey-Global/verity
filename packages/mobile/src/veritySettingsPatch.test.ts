import { describe, expect, it } from 'vitest';

import type { VeritySettings } from './api.js';
import { secretPatchFromDraft, type SecretSettingsDraft } from './secretSettings.js';
import {
  changedSecretSettings,
  changedTextSettings,
  requiresContainerApply,
  textSettingsDirty,
  type VerityTextSettingsDraft,
} from './veritySettingsPatch.js';

function makeSettings(overrides: Partial<VeritySettings> = {}): VeritySettings {
  return {
    gitUserName: 'Ada',
    gitUserEmail: 'ada@example.com',
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
    transcribeBaseUrl: 'https://api.example.com/v1',
    transcribeModel: 'whisper-large-v3',
    transcribeBackendMode: 'external',
    transcribeApiKeyConfigured: true,
    transcribeLocalAvailable: false,
    transcribeExternalConfigured: true,
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

describe('changedTextSettings', () => {
  // The reason the settings surface can be split across screens at all. A patch
  // key the operator did not touch is a `null` write to a field owned by another
  // screen — the GitHub screen clearing the transcription endpoint, silently,
  // with nothing on screen to suggest it happened.
  it('never emits a key the draft does not carry', () => {
    const settings = makeSettings();
    const githubDraft: VerityTextSettingsDraft = {
      gitUserName: 'Grace',
      gitUserEmail: 'ada@example.com',
    };

    const patch = changedTextSettings(githubDraft, settings);

    expect(Object.keys(patch)).toEqual(['gitUserName']);
    expect(patch).not.toHaveProperty('transcribeBaseUrl');
    expect(patch).not.toHaveProperty('transcribeModel');
  });

  it('is empty when nothing changed, so an unchanged blur issues no request', () => {
    const settings = makeSettings();

    expect(
      changedTextSettings({ gitUserName: 'Ada', gitUserEmail: 'ada@example.com' }, settings),
    ).toEqual({});
    expect(textSettingsDirty({ gitUserName: 'Ada' }, settings)).toBe(false);
  });

  it('trims, and treats a blank box as a deliberate clear', () => {
    const settings = makeSettings();

    expect(changedTextSettings({ gitUserName: '  Grace  ' }, settings)).toEqual({
      gitUserName: 'Grace',
    });
    expect(changedTextSettings({ gitUserName: '   ' }, settings)).toEqual({ gitUserName: null });
    // …but re-typing the same value with stray whitespace is not a change.
    expect(changedTextSettings({ gitUserName: ' Ada ' }, settings)).toEqual({});
  });

  it('treats an unset optional field and an empty box as the same value', () => {
    // `opencodeBaseUrl` is absent from older servers' responses. An absent value
    // must not read as a change, or every blur would write `null` back forever.
    const settings = makeSettings({ opencodeBaseUrl: undefined });

    expect(changedTextSettings({ opencodeBaseUrl: '' }, settings)).toEqual({});
    expect(changedTextSettings({ opencodeBaseUrl: 'https://api.example.com' }, settings)).toEqual({
      opencodeBaseUrl: 'https://api.example.com',
    });
  });

  it('saves every edited field when the screen owns several', () => {
    const settings = makeSettings();

    expect(
      changedTextSettings({ gitUserName: 'Grace', gitUserEmail: 'grace@example.com' }, settings),
    ).toEqual({ gitUserName: 'Grace', gitUserEmail: 'grace@example.com' });
  });

  it('has no stored value to compare against before settings load', () => {
    expect(changedTextSettings({ gitUserName: 'Ada' }, null)).toEqual({ gitUserName: 'Ada' });
    expect(changedTextSettings({ gitUserName: '' }, null)).toEqual({});
  });
});

const EMPTY_SECRET_DRAFT: SecretSettingsDraft = {
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitSshPrivateKey: '',
  codexAuthJson: '',
  opencodeApiKey: '',
  dopplerServiceToken: '',
  uplinkSubscriptionKey: '',
  transcribeApiKey: '',
};

const FILLED_SECRET_DRAFT: SecretSettingsDraft = {
  githubAppId: 'app-1',
  githubAppInstallationId: 'inst-1',
  githubAppPrivateKey: 'pem',
  gitSshPrivateKey: 'pem',
  codexAuthJson: '{}',
  opencodeApiKey: 'key',
  dopplerServiceToken: 'dp.sa.token',
  uplinkSubscriptionKey: 'key',
  transcribeApiKey: 'key',
};

// The write-only credentials, read off the existing builder rather than listed:
// they are precisely the keys it emits for a filled draft and omits for a blank
// one. A credential added to `secretPatchFromDraft` joins this list unprompted.
const WRITE_ONLY_SECRET_KEYS = Object.keys(secretPatchFromDraft(FILLED_SECRET_DRAFT)).filter(
  (key) => !(key in secretPatchFromDraft(EMPTY_SECRET_DRAFT)),
);

describe('changedSecretSettings', () => {
  it.each(WRITE_ONLY_SECRET_KEYS)('sends %s alone when only that box was filled', (key) => {
    expect(changedSecretSettings({ [key]: 'pasted' })).toEqual({ [key]: 'pasted' });
  });

  // The failure this exists to prevent is silent and remote: the operator pastes
  // a Doppler token on Connected services, and the next `git push` from an agent
  // fails because the GitHub App identifiers the SAME request carried as `null`
  // are gone. Nothing on either screen ever said so.
  it('never carries the GitHub App identifiers a screen did not render', () => {
    const wholeDraft = secretPatchFromDraft({
      ...EMPTY_SECRET_DRAFT,
      dopplerServiceToken: 'dp.sa.token',
    });
    expect(wholeDraft.githubAppId).toBeNull();
    expect(wholeDraft.githubAppInstallationId).toBeNull();

    expect(changedSecretSettings({ dopplerServiceToken: 'dp.sa.token' })).toEqual({
      dopplerServiceToken: 'dp.sa.token',
    });
  });

  it.each(WRITE_ONLY_SECRET_KEYS)('leaves a configured %s alone for an empty box', (key) => {
    expect(changedSecretSettings({ [key]: '   ' })).toEqual({});
  });

  it('trims what it does send', () => {
    expect(changedSecretSettings({ opencodeApiKey: '  sk-1  ' })).toEqual({
      opencodeApiKey: 'sk-1',
    });
  });

  it('has nothing to send for an untouched screen', () => {
    expect(changedSecretSettings({})).toEqual({});
  });
});

describe('requiresContainerApply', () => {
  // Derived from the secret patch builder rather than restated: a credential
  // added there in future is covered here the day it is added. Every one of them
  // is baked into a container's environment at creation, so a running container
  // keeps the old value until it is recreated.
  it.each(Object.keys(secretPatchFromDraft(FILLED_SECRET_DRAFT)))(
    'asks for a reprovision after saving %s',
    (key) => {
      expect(requiresContainerApply({ [key]: 'value' })).toBe(true);
    },
  );

  it('does not ask for a reprovision after an app- or server-only setting', () => {
    expect(requiresContainerApply({ advancedModeEnabled: true })).toBe(false);
    expect(requiresContainerApply({ transcribeBackendMode: 'external' })).toBe(false);
  });

  it('asks once any container-visible key rides along', () => {
    expect(requiresContainerApply({ advancedModeEnabled: true, gitUserName: 'Ada' })).toBe(true);
  });

  it('has nothing to apply for an empty patch', () => {
    expect(requiresContainerApply({})).toBe(false);
  });
});
