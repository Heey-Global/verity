import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { VeritySettingsRecord } from '@verity/store';
import {
  openCodeSettingsConfig,
  ensureOpenCodeSettingsMaterialized,
  materializeOpenCodeSettings,
} from './provisioner.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('openCodeSettingsConfig', () => {
  it('builds a provider config only from complete settings', () => {
    expect(openCodeSettingsConfig(undefined)).toBeUndefined();
    const config = openCodeSettingsConfig({
      opencodeBaseUrl: 'https://api.example.test/v1',
      opencodeApiKey: 'provider-key-fixture',
      opencodeModels: 'model-a\nmodel-b\nmodel-a',
      opencodeDisabledModels: 'model-b',
    } as VeritySettingsRecord);
    expect(JSON.parse(config ?? '{}')).toMatchObject({
      permission: {
        read: { '/knowledge/**': 'allow' },
        external_directory: { '/knowledge/**': 'allow' },
      },
      provider: {
        verity: {
          npm: '@opencode/ai/providers/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:47821/opencode',
            apiKey: 'verity-opencode-gateway-placeholder-v1',
          },
          models: { 'model-a': { name: 'model-a' } },
        },
      },
    });
    expect(config).not.toContain('provider-key-fixture');
    expect(config).not.toContain('api.example.test');
    expect(config).not.toContain('model-b');
  });

  it('updates the stable directory mounted by running sandboxes', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-opencode-settings-'));
    try {
      const first = materializeOpenCodeSettings(undefined, root);
      expect(JSON.parse(readFileSync(join(first, 'opencode.json'), 'utf8'))).not.toHaveProperty(
        'provider',
      );
      expect(JSON.parse(readFileSync(join(first, 'opencode.json'), 'utf8'))).toHaveProperty(
        'permission.external_directory./knowledge/**',
        'allow',
      );
      expect(statSync(first).mode & 0o777).toBe(0o755);
      expect(statSync(join(first, 'opencode.json')).mode & 0o777).toBe(0o644);
      const second = materializeOpenCodeSettings(
        {
          opencodeBaseUrl: 'https://api.example.test/v1',
          opencodeApiKey: 'provider-key-fixture',
          opencodeModels: 'model-a',
        } as VeritySettingsRecord,
        root,
      );
      expect(second).toBe(first);
      expect(JSON.parse(readFileSync(join(first, 'opencode.json'), 'utf8'))).toHaveProperty(
        'provider.verity.models.model-a',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a configured provider when boot cannot read the settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-opencode-settings-'));
    try {
      // The silent failure: the Server boots sealed, cannot decrypt the provider
      // settings, and regenerates the config the control-plane Runner mounts. The
      // Runner keeps starting and every OpenCode turn runs against a config with no
      // provider in it — an outage that looks like a model problem, not a boot
      // problem, and that outlives the unseal for as long as nobody re-saves the
      // settings.
      materializeOpenCodeSettings(
        {
          opencodeBaseUrl: 'https://api.example.test/v1',
          opencodeApiKey: 'provider-key-fixture',
          opencodeModels: 'model-a',
        } as VeritySettingsRecord,
        root,
      );
      expect(ensureOpenCodeSettingsMaterialized(undefined, root)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')),
      ).toHaveProperty('provider.verity.models.model-a');
      // Nothing there is the case the boot write exists for: OPENCODE_CONFIG names
      // this path in a Runner spec that was fixed at container create, so the file
      // has to exist before the first turn rather than because of one.
      rmSync(join(root, 'opencode'), { recursive: true, force: true });
      expect(ensureOpenCodeSettingsMaterialized(undefined, root)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')),
      ).not.toHaveProperty('provider');
      // Withholding the fallback must not turn into never writing: settings that DO
      // name a provider are authoritative, so a boot that can read them replaces
      // whatever the file holds. Otherwise the fallback written during a sealed boot
      // would outlive the unseal on any deployment whose settings nobody re-saves.
      expect(
        ensureOpenCodeSettingsMaterialized(
          {
            opencodeBaseUrl: 'https://api.example.test/v1',
            opencodeApiKey: 'provider-key-fixture',
            opencodeModels: 'model-b',
          } as VeritySettingsRecord,
          root,
        ),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')),
      ).toHaveProperty('provider.verity.models.model-b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
