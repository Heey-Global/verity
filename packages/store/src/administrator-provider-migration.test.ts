import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { createRawDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';

it.each([false, true])(
  'preserves original logins and consolidates personal admin accounts: %s',
  async (personal) => {
    const raw = createRawDb();
    try {
      const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
      const before = await migrator.migrateTo('0227_sandbox_update_state');
      if (before.error) throw new Error('Migration failed', { cause: before.error });
      const store = new EventStore(raw.db, createSecretCipher('ac'.repeat(32)));
      await sql`insert into users (id, role, status) values (${ADMIN}, 'administrator', 'active'),
      ('member', 'member', 'active') on conflict (id) do nothing`.execute(raw.db);
      await store.updateVeritySettings({
        claudeCodeOauthCredentialsJson: 'original-claude',
        codexAuthJson: 'original-codex',
        opencodeApiKey: 'original-key',
        opencodeBaseUrl: 'https://original.example/v1',
        opencodeModels: 'a\nb',
        opencodeDisabledModels: 'b',
      });
      await store.userProviderConnections.set('member', 'claude', { credential: 'member-only' });
      if (personal) {
        for (const provider of ['claude', 'codex', 'opencode'] as const)
          await store.userProviderConnections.set(ADMIN, provider, {
            credential: `personal-${provider}`,
            baseUrl: 'https://personal.example/v1',
            models: 'c',
          });
      }
      const encryptedBefore = await store.getVeritySettingsRaw();
      const personalBefore = await raw.db
        .selectFrom('user_provider_connections')
        .selectAll()
        .execute();
      const after = await migrator.migrateToLatest();
      if (after.error) throw new Error('Migration failed', { cause: after.error });
      expect(await store.getVeritySettings()).toMatchObject(
        personal
          ? {
              claudeCodeOauthCredentialsJson: 'personal-claude',
              codexAuthJson: 'personal-codex',
              opencodeApiKey: 'personal-opencode',
              opencodeBaseUrl: 'https://personal.example/v1',
              opencodeModels: 'c',
              opencodeDisabledModels: null,
            }
          : {
              claudeCodeOauthCredentialsJson: 'original-claude',
              codexAuthJson: 'original-codex',
              opencodeApiKey: 'original-key',
              opencodeDisabledModels: 'b',
            },
      );
      const encryptedAfter = await store.getVeritySettingsRaw();
      expect(encryptedAfter?.claudeCodeOauthCredentialsJson).toBe(
        personal
          ? personalBefore.find((row) => row.user_id === ADMIN && row.provider === 'claude')
              ?.credential
          : encryptedBefore?.claudeCodeOauthCredentialsJson,
      );
      expect(await store.userProviderConnections.status(ADMIN)).toEqual([]);
      expect((await store.userProviderConnections.get('member', 'claude'))?.credential).toBe(
        'member-only',
      );
    } finally {
      await raw.close();
    }
  },
);
