import { InMemoryEventBus } from '@verity/session';
import { createSealableSecretCipher } from '@verity/store';
import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLogin,
  app,
  bus,
  CLAUDE_SORTED,
  conductor,
  ctx,
  dispatchTurn,
  worktreeRoot,
} from './server-fixture.test-helper.js';
import { buildServer, CLAUDE_MODELS, DEFAULT_MODEL } from './server.js';

describe('agent login routes', () => {
  it('starts, polls, and submits provider login sessions through the service', async () => {
    agentLogin.start.mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      status: 'ready',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'UXAB-12345',
      needsCode: false,
      configured: false,
      message: null,
    });
    agentLogin.get.mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      status: 'complete',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'UXAB-12345',
      needsCode: false,
      configured: true,
      message: null,
    });
    agentLogin.submitCode.mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      provider: 'claude',
      status: 'complete',
      verificationUri: 'https://claude.com/cai/oauth/authorize?code=true',
      userCode: null,
      needsCode: true,
      configured: true,
      message: null,
    });

    const start = await app.inject({ method: 'POST', url: '/settings/agent-logins/codex/start' });
    expect(start.statusCode).toBe(200);
    expect(start.json().login.userCode).toBe('UXAB-12345');
    expect(agentLogin.start).toHaveBeenCalledWith('codex');

    const poll = await app.inject({
      method: 'GET',
      url: '/settings/agent-logins/11111111-1111-4111-8111-111111111111',
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().login.configured).toBe(true);

    const submit = await app.inject({
      method: 'POST',
      url: '/settings/agent-logins/22222222-2222-4222-8222-222222222222/submit-code',
      payload: { code: ' claude-code ' },
    });
    expect(submit.statusCode).toBe(200);
    expect(agentLogin.submitCode).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'claude-code',
    );
  });

  it('disconnects provider logins by clearing only that provider secret material', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: '{"accessToken":"fresh-token"}',
      codexAuthJson: '{"token":"codex"}',
    });

    const claude = await app.inject({ method: 'DELETE', url: '/settings/agent-logins/claude' });
    expect(claude.statusCode).toBe(200);
    expect(claude.json().settings.claudeCodeOauthCredentialsConfigured).toBe(false);
    expect(claude.json().settings.codexAuthJsonConfigured).toBe(true);

    const afterClaude = await ctx.store.getVeritySettings();
    expect(afterClaude?.claudeCodeOauthCredentialsJson).toBeNull();
    expect(afterClaude?.codexAuthJson).toBe('{"token":"codex"}');

    const codex = await app.inject({ method: 'DELETE', url: '/settings/agent-logins/codex' });
    expect(codex.statusCode).toBe(200);
    expect(codex.json().settings.codexAuthJsonConfigured).toBe(false);
  });
});

describe('GET/PATCH /settings', () => {
  // GET /settings now projects the DECRYPTED row so it can derive plan labels.
  // A secret the projection forgot to strip would then leave as plaintext, not
  // ciphertext — so every stored credential is planted and searched for.
  it('derives subscription plans without exposing any stored credential', async () => {
    const claudeCredentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'planted-claude-access',
        refreshToken: 'planted-claude-refresh',
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
    const secrets = {
      gitSshPrivateKey: 'planted-ssh-key',
      githubAppPrivateKey: 'planted-github-key',
      dopplerServiceToken: 'planted-doppler',
      transcribeApiKey: 'planted-transcribe',
      claudeCodeOauthCredentialsJson: claudeCredentials,
      codexAuthJson: JSON.stringify({ tokens: { access_token: 'planted-codex-access' } }),
      opencodeApiKey: 'planted-opencode',
      googleDriveRefreshToken: 'planted-drive',
      uplinkSubscriptionKey: 'planted-uplink',
    };
    await ctx.store.updateVeritySettings(secrets);

    const response = await app.inject({ method: 'GET', url: '/settings' });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.claudeSubscriptionPlan).toBe('Max 20x');
    expect(response.json().settings.codexSubscriptionPlan).toBeNull();
    expect(response.body).not.toMatch(/planted-/);
  });

  it('does not accept a manually supplied OpenCode model catalog', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { opencodeModels: 'manually-added-model' },
    });
    expect(response.statusCode).toBe(200);
    expect((await ctx.store.getVeritySettingsRaw())?.opencodeModels ?? null).toBeNull();
  });

  it('clears the OpenCode credential when its provider URL changes', async () => {
    await ctx.store.updateVeritySettings({
      opencodeBaseUrl: 'https://first-provider.example/v1',
      opencodeApiKey: 'provider-key',
    });
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { opencodeBaseUrl: 'https://second-provider.example/v1' },
    });
    expect(response.statusCode).toBe(200);
    const stored = await ctx.store.getVeritySettingsRaw();
    expect(stored?.opencodeBaseUrl).toBe('https://second-provider.example/v1');
    expect(stored?.opencodeApiKey).toBeNull();
  });

  it.each([
    { opencodeBaseUrl: 'http://provider.example/v1' },
    { opencodeBaseUrl: 'https://user:password@provider.example/v1' },
    { opencodeBaseUrl: 'https://provider.example/v1?api_key=secret' },
    { opencodeBaseUrl: 'https://provider.example/v1#fragment' },
    { opencodeApiKey: 'provider-key\nsmuggled-header' },
  ])('rejects OpenCode settings the credential gateway cannot safely use', async (payload) => {
    const response = await app.inject({ method: 'PATCH', url: '/settings', payload });
    expect(response.statusCode).toBe(400);
    const stored = await ctx.store.getVeritySettingsRaw();
    expect(stored?.opencodeBaseUrl ?? null).toBeNull();
    expect(stored?.opencodeApiKey ?? null).toBeNull();
  });

  it('persists a non-secret transcription choice while the secret store is sealed', async () => {
    const sealedApp = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: createSealableSecretCipher(),
    });
    try {
      const response = await sealedApp.inject({
        method: 'PATCH',
        url: '/settings/transcription/backend',
        payload: { mode: 'external' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ mode: 'external' });
      expect((await ctx.store.getVeritySettingsRaw())?.transcribeBackendMode).toBe('external');
    } finally {
      await sealedApp.close();
    }
  });

  it('refuses to store the removed local backend on either write path', async () => {
    // Nothing bundles a local speech-to-text backend any more, so `local` is a
    // choice no deployment can satisfy — accepting it would hand the app a mode
    // it renders as the selected backend while every upload is rejected. An
    // older app that still offers the option is told so (400) instead of being
    // silently switched to an off-host service behind the operator's back.
    await ctx.store.updateVeritySettings({ transcribeBackendMode: 'external' });

    const dedicated = await app.inject({
      method: 'PATCH',
      url: '/settings/transcription/backend',
      payload: { mode: 'local' },
    });
    expect(dedicated.statusCode).toBe(400);

    const settingsPatch = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { transcribeBackendMode: 'local' },
    });
    expect(settingsPatch.statusCode).toBe(400);

    // Neither rejected write left the removed mode behind, so no client can put
    // an installation back into the state migration 0083 exists to clear.
    expect((await ctx.store.getVeritySettingsRaw())?.transcribeBackendMode).toBe('external');
    const read = await app.inject({ method: 'GET', url: '/settings/transcription' });
    expect(read.json().transcribeBackendMode).toBe('external');
  });

  it('reports the transcription choice without secret material', async () => {
    await ctx.store.updateVeritySettings({
      transcribeBackendMode: 'external',
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeApiKey: 'never-return-this-token',
      transcribeModel: 'whisper-test',
    });
    const response = await app.inject({ method: 'GET', url: '/settings/transcription' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      transcribeBackendMode: 'external',
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeModel: 'whisper-test',
      transcribeApiKeyConfigured: true,
      // No deployment bundles a local backend any more, so the app's local
      // option stays permanently disabled.
      transcribeLocalAvailable: false,
      transcribeExternalConfigured: true,
    });
    expect(response.body).not.toContain('never-return-this-token');
  });

  it('ignores deployment-managed transcription credentials', async () => {
    const original = {
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      apiKey: process.env.VERITY_TRANSCRIBE_API_KEY,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    process.env.VERITY_TRANSCRIBE_BASE_URL = 'https://environment.test/v1';
    process.env.VERITY_TRANSCRIBE_API_KEY = 'environment-key';
    process.env.VERITY_TRANSCRIBE_MODEL = 'environment-model';
    try {
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: null,
        transcribeBaseUrl: null,
        transcribeApiKey: null,
        transcribeModel: null,
      });
      const response = await app.inject({ method: 'GET', url: '/settings/transcription' });
      expect(response.json()).toEqual({
        transcribeBackendMode: null,
        transcribeBaseUrl: null,
        transcribeModel: null,
        transcribeApiKeyConfigured: false,
        transcribeLocalAvailable: false,
        transcribeExternalConfigured: false,
      });
      expect(response.body).not.toContain('environment-key');
      const publicSettings = await app.inject({ method: 'GET', url: '/settings' });
      expect(publicSettings.json().settings.transcribeExternalConfigured).toBe(false);
    } finally {
      const envNames = {
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        apiKey: 'VERITY_TRANSCRIBE_API_KEY',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('reports no backend at all when the deployment configures none', async () => {
    const original = {
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      apiKey: process.env.VERITY_TRANSCRIBE_API_KEY,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    // What `VERITY_TRANSCRIBE_BASE_URL:-` renders to in Compose: present but
    // empty must read as "not configured", not as a configured endpoint.
    process.env.VERITY_TRANSCRIBE_BASE_URL = '';
    process.env.VERITY_TRANSCRIBE_API_KEY = 'environment-key';
    process.env.VERITY_TRANSCRIBE_MODEL = 'environment-model';
    try {
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: null,
        transcribeBaseUrl: null,
        transcribeApiKey: null,
        transcribeModel: null,
      });
      const response = await app.inject({ method: 'GET', url: '/settings/transcription' });
      expect(response.json()).toEqual({
        transcribeBackendMode: null,
        transcribeBaseUrl: null,
        transcribeModel: null,
        transcribeApiKeyConfigured: false,
        transcribeLocalAvailable: false,
        transcribeExternalConfigured: false,
      });
      const publicSettings = await app.inject({ method: 'GET', url: '/settings' });
      expect(publicSettings.json().settings.transcribeLocalAvailable).toBe(false);
      expect(publicSettings.json().settings.transcribeExternalConfigured).toBe(false);
    } finally {
      const envNames = {
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        apiKey: 'VERITY_TRANSCRIBE_API_KEY',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('does not mix stored backend URLs with credentials from a different environment endpoint', async () => {
    const original = {
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      apiKey: process.env.VERITY_TRANSCRIBE_API_KEY,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    process.env.VERITY_TRANSCRIBE_BASE_URL = 'https://environment.test/v1';
    process.env.VERITY_TRANSCRIBE_API_KEY = 'environment-key';
    process.env.VERITY_TRANSCRIBE_MODEL = 'environment-model';
    try {
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://different-provider.test/v1',
        transcribeApiKey: null,
        transcribeModel: null,
      });
      const response = await app.inject({ method: 'GET', url: '/settings/transcription' });
      expect(response.json()).toEqual({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://different-provider.test/v1',
        transcribeModel: null,
        transcribeApiKeyConfigured: false,
        transcribeLocalAvailable: false,
        transcribeExternalConfigured: false,
      });
    } finally {
      const envNames = {
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        apiKey: 'VERITY_TRANSCRIBE_API_KEY',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('does not report a deployment-supplied transcriber command as configured', async () => {
    const original = {
      command: process.env.VERITY_MEETING_TRANSCRIBE_COMMAND,
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    process.env.VERITY_MEETING_TRANSCRIBE_COMMAND = 'my-transcriber "$VERITY_AUDIO_FILE"';
    delete process.env.VERITY_TRANSCRIBE_BASE_URL;
    delete process.env.VERITY_TRANSCRIBE_MODEL;
    try {
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: null,
        transcribeApiKey: null,
        transcribeModel: null,
      });
      const publicSettings = await app.inject({ method: 'GET', url: '/settings' });
      expect(publicSettings.json().settings.transcribeExternalConfigured).toBe(false);
      const status = await app.inject({ method: 'GET', url: '/settings/transcription' });
      expect(status.json()).toMatchObject({
        transcribeBaseUrl: null,
        transcribeModel: null,
        transcribeExternalConfigured: false,
      });

      // Removing an already ignored variable cannot change readiness.
      delete process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
      const withoutCommand = await app.inject({ method: 'GET', url: '/settings' });
      expect(withoutCommand.json().settings.transcribeExternalConfigured).toBe(false);
      const statusWithoutCommand = await app.inject({
        method: 'GET',
        url: '/settings/transcription',
      });
      expect(statusWithoutCommand.json().transcribeExternalConfigured).toBe(false);
    } finally {
      const envNames = {
        command: 'VERITY_MEETING_TRANSCRIBE_COMMAND',
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('derives external readiness from the effective backend, not the stored fields alone', async () => {
    const original = {
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      apiKey: process.env.VERITY_TRANSCRIBE_API_KEY,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    process.env.VERITY_TRANSCRIBE_BASE_URL = 'https://environment.test/v1';
    process.env.VERITY_TRANSCRIBE_API_KEY = 'environment-key';
    process.env.VERITY_TRANSCRIBE_MODEL = 'environment-model';
    const externalConfigured = async (): Promise<unknown> => {
      const response = await app.inject({ method: 'GET', url: '/settings' });
      return response.json().settings.transcribeExternalConfigured;
    };
    try {
      // A complete backend configured in the app.
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://stored.example.test/v1',
        transcribeModel: 'stored-model',
      });
      expect(await externalConfigured()).toBe(true);

      // Same stored endpoint, no model: the environment's model belongs to a
      // DIFFERENT endpoint, so it cannot complete this one — this is exactly the
      // state whose upload the server rejects as unconfigured, and the state the
      // app must not paint as ready.
      await ctx.store.updateVeritySettings({ transcribeModel: null });
      expect(await externalConfigured()).toBe(false);

      // A matching deployment URL still cannot supply a missing stored model.
      await ctx.store.updateVeritySettings({ transcribeBaseUrl: 'https://environment.test/v1' });
      expect(await externalConfigured()).toBe(false);

      // Nothing stored at all remains unconfigured regardless of the environment.
      await ctx.store.updateVeritySettings({ transcribeBaseUrl: null });
      expect(await externalConfigured()).toBe(false);

      // Neither side configures one.
      delete process.env.VERITY_TRANSCRIBE_BASE_URL;
      expect(await externalConfigured()).toBe(false);
    } finally {
      const envNames = {
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        apiKey: 'VERITY_TRANSCRIBE_API_KEY',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('stores transcription configuration without ever returning the API key', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        transcribeBaseUrl: 'https://api.example.test/v1',
        transcribeApiKey: 'transcription-secret-fixture',
        transcribeModel: 'whisper-test',
        transcribeBackendMode: 'external',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeModel: 'whisper-test',
      transcribeBackendMode: 'external',
      transcribeApiKeyConfigured: true,
    });
    expect(response.json().settings).not.toHaveProperty('transcribeApiKey');
    expect(JSON.stringify(response.json())).not.toContain('transcription-secret-fixture');

    const read = await app.inject({ method: 'GET', url: '/settings' });
    expect(read.json().settings.transcribeApiKeyConfigured).toBe(true);
    expect(read.json().settings).not.toHaveProperty('transcribeApiKey');
    expect(JSON.stringify(read.json())).not.toContain('transcription-secret-fixture');
  });

  it('keeps the retired sandbox auto-update booleans on the wire for older apps', async () => {
    // The toggles and the nightly pass are gone — Verity repairs its own
    // sandboxes — but an app build from before the removal requires both fields,
    // and an app one release behind the Server is the normal state right after
    // the Server self-updates. Dropping them from the response would fail that
    // app's settings validation outright, so they stay, pinned to false. A stale
    // app may still PATCH them; that must be ignored, not rejected.
    const patched = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { sandboxAutoUpdateSecurity: true, sandboxAutoUpdateNormal: true },
    });
    expect(patched.statusCode).toBe(200);

    const read = await app.inject({ method: 'GET', url: '/settings' });
    expect(read.json().settings).toMatchObject({
      sandboxAutoUpdateSecurity: false,
      sandboxAutoUpdateNormal: false,
    });
  });

  it('clears a stored transcription API key when the backend URL changes', async () => {
    await ctx.store.updateVeritySettings({
      transcribeBaseUrl: 'https://old-provider.example/v1',
      transcribeApiKey: 'old-provider-secret',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { transcribeBaseUrl: 'https://new-provider.example/v1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({
      transcribeBaseUrl: 'https://new-provider.example/v1',
      transcribeApiKeyConfigured: false,
    });
    expect((await ctx.store.getVeritySettings())?.transcribeApiKey).toBeNull();
  });

  it('keeps an atomically replaced transcription API key when the backend URL changes', async () => {
    await ctx.store.updateVeritySettings({
      transcribeBaseUrl: 'https://old-provider.example/v1',
      transcribeApiKey: 'old-provider-secret',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        transcribeBaseUrl: 'https://new-provider.example/v1',
        transcribeApiKey: 'new-provider-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.transcribeApiKeyConfigured).toBe(true);
    expect((await ctx.store.getVeritySettings())?.transcribeApiKey).toBe('new-provider-secret');
  });

  it('stores central git signing settings without project scope', async () => {
    const initial = await app.inject({ method: 'GET', url: '/settings' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ settings: null });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        gitUserName: 'h-teske',
        gitUserEmail: 'developer@example.com',
        gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
        gitSshPrivateKey: 'not-a-real-private-key-fixture',
        gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
        gitSshPublicKey: 'ssh-ed25519 public',
        gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
        gitKnownHosts: 'github.com ssh-ed25519 AAA',
        gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
        gitAllowedSigners: '*@heey.global key',
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      settings: {
        gitUserName: 'h-teske',
        gitUserEmail: 'developer@example.com',
        gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
        gitSshPrivateKeyConfigured: true,
        gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
        gitSshPublicKeyConfigured: true,
        gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
        gitKnownHostsConfigured: true,
        gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
        gitAllowedSignersConfigured: true,
      },
    });
    expect(JSON.stringify(patch.json())).not.toContain('not-a-real-private-key-fixture');

    const updated = await app.inject({ method: 'GET', url: '/settings' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: {
        gitUserName: 'h-teske',
        gitUserEmail: 'developer@example.com',
        gitSshPrivateKeyConfigured: true,
      },
    });
    expect(JSON.stringify(updated.json())).not.toContain('not-a-real-private-key-fixture');
  });

  it('serializes credential patches through the runtime propagation hook', async () => {
    const persistAgentCredentials = vi.fn(async (_patch: unknown, persist: () => Promise<void>) =>
      persist(),
    );
    const settingsApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      persistAgentCredentials,
    });
    try {
      const response = await settingsApp.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          claudeCodeOauthCredentialsJson:
            '{"claudeAiOauth":{"accessToken":"fresh","refreshToken":"rotated"}}',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().settings.claudeCodeOauthCredentialsConfigured).toBe(true);
      expect(persistAgentCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeCodeOauthCredentialsJson: expect.stringContaining('rotated'),
        }),
        expect.any(Function),
      );
    } finally {
      await settingsApp.close();
    }
  });
});

describe('PATCH /projects/:id/settings', () => {
  it('saves project settings and normalizes blank strings to null', async () => {
    await ctx.store.upsertProject({
      id: 'p-settings',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-settings/settings',
      payload: {
        devcontainerEnabled: false,
        dopplerProject: ' verity ',
        dopplerConfig: ' prod ',
        defaultBranch: ' main ',
        defaultModel: 'claude-sonnet-4-6',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      settings: {
        projectId: 'p-settings',
        devcontainerEnabled: false,
        dopplerProject: 'verity',
        dopplerConfig: 'prod',
        defaultBranch: 'main',
        defaultModel: 'claude-sonnet-4-6',
      },
    });
  });

  it.each(['dopplerToken', 'dopplerTokenRef', 'dopplerMintedToken'])(
    'rejects the removed per-project credential field %s',
    async (field) => {
      await ctx.store.upsertProject({
        id: 'p-token',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        state: 'active',
      });
      const res = await app.inject({
        method: 'PATCH',
        url: '/projects/p-token/settings',
        payload: { [field]: 'legacy-credential-fixture', defaultBranch: 'main' },
      });

      expect(res.statusCode).toBe(400);
      expect(await ctx.store.getProjectSettings('p-token')).toBeUndefined();
      expect(JSON.stringify(res.json())).not.toContain('legacy-credential-fixture');
    },
  );

  it('sets the operator-authorized Doppler binding (plaintext) and exposes it publicly (#320)', async () => {
    await ctx.store.upsertProject({
      id: 'p-bind',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-bind/settings',
      payload: { dopplerProject: 'my-project', dopplerConfig: 'dev' },
    });
    expect(res.statusCode).toBe(200);
    // Binding is non-secret config and is surfaced plaintext.
    expect(res.json()).toMatchObject({
      settings: {
        projectId: 'p-bind',
        dopplerProject: 'my-project',
        dopplerConfig: 'dev',
      },
    });
    // The public shape never carries legacy credential fields.
    const settings = res.json<{ settings: Record<string, unknown> }>().settings;
    expect('dopplerMintedToken' in settings).toBe(false);
    expect('dopplerToken' in settings).toBe(false);
    expect('dopplerTokenRef' in settings).toBe(false);
  });

  it('404s unknown projects', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/missing/settings',
      payload: { defaultBranch: 'main' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project missing not found' });
  });

  it('rejects unsafe defaultBranch values before they can reach git worktree add', async () => {
    await ctx.store.upsertProject({
      id: 'p-settings-branch',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-settings-branch/settings',
      payload: { defaultBranch: '--upload-pack=sh' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
  });

  it('allows blank defaultBranch so the store can normalize it to null', async () => {
    await ctx.store.upsertProject({
      id: 'p-settings-blank-branch',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-settings-blank-branch/settings',
      payload: { defaultBranch: '   ' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      settings: { defaultBranch: null },
    });
  });
});

describe('project allowed agents', () => {
  async function project(id: string, state: 'active' | 'absent' = 'absent') {
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state,
    });
  }
  const patchSettings = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/projects/${id}/settings`, payload });

  it('rejects an empty, duplicated or unknown agent list', async () => {
    await project('p-agents-validate');
    for (const allowedAgents of [[], ['claude', 'claude'], ['gemini']]) {
      const res = await patchSettings('p-agents-validate', { allowedAgents });
      expect(res.statusCode).toBe(400);
    }
  });

  it('drops a default model the narrowed rule excludes and refuses a new excluded default', async () => {
    await project('p-agents-default');
    await patchSettings('p-agents-default', { defaultModel: 'claude-sonnet-5-5' });

    const narrowed = await patchSettings('p-agents-default', { allowedAgents: ['codex'] });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json()).toMatchObject({
      settings: { allowedAgents: ['codex'], defaultModel: null },
    });

    const excluded = await patchSettings('p-agents-default', { defaultModel: 'claude-opus-5-5' });
    expect(excluded.statusCode).toBe(400);
    expect(excluded.json()).toEqual({ error: 'Claude is not allowed in this project.' });

    const allowed = await patchSettings('p-agents-default', { defaultModel: 'codex/gpt-5.6-sol' });
    expect(allowed.json()).toMatchObject({ settings: { defaultModel: 'codex/gpt-5.6-sol' } });
  });

  it('validates the normalized model before persisting an explicit default', async () => {
    await project('p-agents-trim');
    await patchSettings('p-agents-trim', { allowedAgents: ['opencode'] });
    const excluded = await patchSettings('p-agents-trim', { defaultModel: ' codex/default ' });
    expect(excluded.statusCode).toBe(400);
    expect(excluded.json()).toEqual({ error: 'Codex is not allowed in this project.' });
    expect((await ctx.store.getProjectSettings('p-agents-trim'))?.defaultModel).toBeNull();
  });

  it('narrows GET /models to the project and resolves its default to the first allowed model', async () => {
    await project('p-agents-models');
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-token"}}',
      codexAuthJson: '{"tokens":{"access_token":"codex"}}',
    });
    await patchSettings('p-agents-models', { allowedAgents: ['codex'] });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.resolve(['codex/default', 'codex/gpt-5.6-sol']),
    });
    try {
      const all = (await withModels.inject('/models')).json<{ models: string[] }>();
      expect(all.models).toContain('claude-opus-5-5');
      const res = await withModels.inject('/models?projectId=p-agents-models');
      expect(res.json()).toEqual({
        models: ['codex/gpt-5.6-sol'],
        modelOrder: ['codex/gpt-5.6-sol'],
        default: 'codex/gpt-5.6-sol',
        allowedAgents: ['codex'],
      });
    } finally {
      await withModels.close();
    }
  });

  it('refuses a mid-session switch onto an excluded agent but keeps the current one', async () => {
    await project('p-agents-switch');
    await patchSettings('p-agents-switch', { allowedAgents: ['codex'] });
    await ctx.store.createSession({
      sessionId: 's-agents-switch',
      worktree: '/wt/s-agents-switch',
      model: 'claude-opus-5-5',
      projectId: 'p-agents-switch',
    });

    const refused = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-agents-switch',
      payload: { model: 'claude-sonnet-5-5' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'Claude is not allowed in this project.' });

    // Re-naming the model the session already runs is a no-op, not a switch.
    const unchanged = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-agents-switch',
      payload: { model: 'claude-opus-5-5' },
    });
    expect(unchanged.statusCode).toBe(200);
  });

  it('rejects excluded turn overrides while letting the current session model continue', async () => {
    await project('p-agents-turn', 'active');
    await patchSettings('p-agents-turn', { allowedAgents: ['codex'] });
    await ctx.store.createSession({
      sessionId: 's-agents-turn',
      worktree: '/wt/s-agents-turn',
      model: 'claude-opus-5-5',
      projectId: 'p-agents-turn',
    });
    dispatchTurn.mockResolvedValue({ queued: false });
    const refused = await app.inject({
      method: 'POST',
      url: '/sessions/s-agents-turn/turns',
      payload: { prompt: 'go', model: 'claude-sonnet-5-5' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'Claude is not allowed in this project.' });
    expect(dispatchTurn).not.toHaveBeenCalled();
    for (const model of ['codex/default', 'claude-opus-5-5', undefined]) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/sessions/s-agents-turn/turns',
        payload: { prompt: 'go', ...(model === undefined ? {} : { model }) },
      });
      expect(accepted.statusCode).toBe(202);
    }
    expect(dispatchTurn).toHaveBeenCalledTimes(3);
  });

  it('resolves dedicated Control sessions against the allowed project agents', async () => {
    await ctx.store.updateVeritySettings({
      advancedModeEnabled: true,
      codexAuthJson: '{"tokens":{"access_token":"codex"}}',
    });
    await app.inject({ method: 'GET', url: '/projects' });
    await patchSettings('verity-control', { allowedAgents: ['codex'] });
    const res = await app.inject({ method: 'POST', url: '/verity-control/session' });
    expect(res.statusCode).toBe(201);
    const session = await ctx.store.getSession(res.json<{ sessionId: string }>().sessionId);
    expect(session?.model.startsWith('codex/')).toBe(true);
    await patchSettings('verity-control', { allowedAgents: ['opencode'] });
    const before = readdirSync(worktreeRoot);
    const unavailable = await app.inject({ method: 'POST', url: '/verity-control/session' });
    expect(unavailable.statusCode).toBe(400);
    expect(readdirSync(worktreeRoot)).toEqual(before);
  });

  it.each([{ allowedAgents: null }, { allowedAgents: ['opencode'] }])(
    'refuses an unsupported Control default with agent rule %j',
    async ({ allowedAgents }) => {
      await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
      await app.inject({ method: 'GET', url: '/projects' });
      const saved = await patchSettings('verity-control', {
        allowedAgents,
        defaultModel: 'deepinfra/model',
      });
      expect(saved.statusCode).toBe(200);
      const before = readdirSync(worktreeRoot);
      const res = await app.inject({ method: 'POST', url: '/verity-control/session' });
      expect(res.statusCode).toBe(400);
      expect(readdirSync(worktreeRoot)).toEqual(before);
    },
  );
});

describe('GET /models (#143)', () => {
  async function configureAgentLogins({
    claude = false,
    codex = false,
  }: { claude?: boolean; codex?: boolean } = {}) {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: claude
        ? '{"claudeAiOauth":{"accessToken":"claude-token"}}'
        : null,
      codexAuthJson: codex ? '{"tokens":{"access_token":"codex"}}' : null,
    });
  }

  // Single guard on the curated Claude list + spawn default. The route tests above verify
  // BEHAVIOR (composition/sort/merge/dedupe) decoupled from the specific ids via CLAUDE_SORTED;
  // this is the ONE place an intentional list change (add/remove/reorder a model, or move the
  // default) must be reflected, so an accidental CLAUDE_MODELS edit is caught in exactly one spot.
  it('pins the curated Claude model list and the spawn default (the single source of record)', () => {
    expect(CLAUDE_MODELS).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  it('returns no subscription models before any agent login is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/models' });
    expect(res.statusCode).toBe(200);
    const body: { models: string[]; default?: string } = res.json();
    expect(body.models).toEqual([]);
    expect(body.default).toBeUndefined();
  });

  it('returns the Claude ids alphabetically when Claude is logged in', async () => {
    await configureAgentLogins({ claude: true });
    const res = await app.inject({ method: 'GET', url: '/models' });
    expect(res.statusCode).toBe(200);
    const body: { models: string[]; default?: string } = res.json();
    expect(body.models).toEqual([...CLAUDE_SORTED]);
    expect(body.default).toBe(DEFAULT_MODEL);
    expect(body.default).not.toContain('/');
    expect(res.json<{ moreModels: string[] }>().moreModels).toEqual(['claude-haiku-5-5']);
  });

  it('returns Codex only when only Codex is logged in', async () => {
    await configureAgentLogins({ codex: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () =>
        Promise.resolve(['codex/default', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      const body: { models: string[]; default?: string } = res.json();
      expect(body.models).toEqual(['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']);
      expect(body.default).toBe('codex/gpt-5.6-sol');
    } finally {
      await withModels.close();
    }
  });

  it('places Codex models after the top three priorities in the generic disclosure', async () => {
    await configureAgentLogins({ claude: true, codex: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () =>
        Promise.resolve([
          'codex/default',
          'codex/gpt-6.1-sol',
          'codex/gpt-5.6-sol',
          'codex/gpt-5.6-terra',
          'codex/gpt-5.6-luna',
          'codex/gpt-5.5',
          'codex/gpt-5.3-codex-spark',
        ]),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        models: [
          ...CLAUDE_SORTED,
          'codex/gpt-5.3-codex-spark',
          'codex/gpt-5.5',
          'codex/gpt-5.6-luna',
          'codex/gpt-5.6-sol',
          'codex/gpt-5.6-terra',
          'codex/gpt-6.1-sol',
        ],
        modelOrder: [
          ...CLAUDE_SORTED,
          'codex/gpt-6.1-sol',
          'codex/gpt-5.6-sol',
          'codex/gpt-5.6-terra',
          'codex/gpt-5.6-luna',
          'codex/gpt-5.5',
          'codex/gpt-5.3-codex-spark',
        ],
        moreModels: [
          'claude-haiku-5-5',
          'codex/gpt-5.6-luna',
          'codex/gpt-5.5',
          'codex/gpt-5.3-codex-spark',
        ],
        default: DEFAULT_MODEL,
      });
    } finally {
      await withModels.close();
    }
  });

  it('merges OpenCode provider-qualified ids and sorts the full list alphabetically', async () => {
    await configureAgentLogins({ claude: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () =>
        Promise.resolve(['deepinfra/zai-org/GLM-5.2', 'deepinfra/moonshotai/Kimi-K2.7-Code']),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.models).toEqual([
        ...CLAUDE_SORTED,
        'deepinfra/moonshotai/Kimi-K2.7-Code',
        'deepinfra/zai-org/GLM-5.2',
      ]);
      expect(body.default).toBe(DEFAULT_MODEL);
    } finally {
      await withModels.close();
    }
  });

  it('degrades to configured subscription models when the dynamic model list throws', async () => {
    await configureAgentLogins({ claude: true, codex: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:4096')),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.models).toEqual([...CLAUDE_SORTED]);
      expect(body.default).toBe(DEFAULT_MODEL);
    } finally {
      await withModels.close();
    }
  });

  it('prefers Claude and omits the legacy Codex default when both logins are configured', async () => {
    await configureAgentLogins({ claude: true, codex: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.resolve(['codex/default', 'codex/gpt-5.6-sol']),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.models).toEqual([...CLAUDE_SORTED, 'codex/gpt-5.6-sol']);
      expect(body.default).toBe(DEFAULT_MODEL);
    } finally {
      await withModels.close();
    }
  });

  it('filters Codex models out when Codex is not logged in', async () => {
    await configureAgentLogins({ claude: true, codex: false });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.resolve(['codex/default']),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.models).toEqual([...CLAUDE_SORTED]);
      expect(body.default).toBe(DEFAULT_MODEL);
    } finally {
      await withModels.close();
    }
  });

  it('de-duplicates a provider id that collides with a Claude id', async () => {
    await configureAgentLogins({ claude: true });
    const withModels = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listModels: () => Promise.resolve(['claude-opus-5-5', 'deepinfra/zai-org/GLM-5.2']),
    });
    try {
      const res = await withModels.inject({ method: 'GET', url: '/models' });
      const body = res.json<{ models: string[] }>();
      expect(body.models.filter((m) => m === 'claude-opus-5-5')).toHaveLength(1);
      expect(body.models).toContain('deepinfra/zai-org/GLM-5.2');
    } finally {
      await withModels.close();
    }
  });
});
