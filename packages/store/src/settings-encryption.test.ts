import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { migrateToLatest } from './db.js';
import { EventStore } from './store.js';
import { createRawDb, truncateAll, type RawTestDb } from './testing.js';

// Test-only 32-byte key, built at runtime so no secret-shaped literal lands in
// source (not a real secret).
const KEY = Buffer.alloc(32, 0x11).toString('hex');

// A store wired with a REAL cipher (unlike the default passthrough in
// createTestDb), so these tests exercise at-rest encryption end to end.
let raw: RawTestDb;
let store: EventStore;

beforeAll(async () => {
  raw = createRawDb();
  await migrateToLatest(raw.db);
  store = new EventStore(raw.db, createSecretCipher(KEY));
});

afterAll(async () => {
  await raw.close();
});

beforeEach(async () => {
  await truncateAll(raw.db);
});

/** Read the raw (still-encrypted) column values straight from the table,
 *  bypassing the store's decrypt-on-read, to prove what actually lands on disk. */
async function rawVerityRow(): Promise<Record<string, string | null>> {
  const row = await raw.db
    .selectFrom('verity_settings')
    .select([
      'git_ssh_private_key',
      'git_ssh_public_key',
      'github_app_id',
      'github_app_installation_id',
      'github_app_private_key',
      'doppler_service_token',
      'transcribe_base_url',
      'transcribe_api_key',
      'transcribe_model',
      'claude_code_oauth_credentials_json',
      'codex_auth_json',
      'uplink_subscription_key',
      'uplink_installation_id',
    ])
    .where('id', '=', 'global')
    .executeTakeFirst();
  return row as Record<string, string | null>;
}

describe('EventStore — secret encryption at rest (ADR 0002 D3)', () => {
  // Neutral fixture strings — the cipher round-trips arbitrary bytes; the tests
  // don't parse these as keys, so we avoid secret-shaped PEM literals in source.
  const sshSecret = 'ssh-private-key-fixture-value';
  const appSecret = 'app-private-key-fixture-value';

  it('encrypts the SSH private key + GitHub App private key, but not non-secret fields', async () => {
    const record = await store.updateVeritySettings({
      gitSshPrivateKey: sshSecret,
      gitSshPublicKey: 'ssh-ed25519 AAAA public',
      githubAppId: '3836338',
      githubAppInstallationId: '135112757',
      githubAppPrivateKey: appSecret,
    });

    // The returned record is plaintext (decrypted on read).
    expect(record.gitSshPrivateKey).toBe(sshSecret);
    expect(record.githubAppPrivateKey).toBe(appSecret);
    expect(record.githubAppId).toBe('3836338');
    expect(record.githubAppInstallationId).toBe('135112757');

    // On disk, the secrets are enciphered; the non-secret fields are plaintext.
    const rawRow = await rawVerityRow();
    expect(rawRow.git_ssh_private_key?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.git_ssh_private_key).not.toContain(sshSecret);
    expect(rawRow.github_app_private_key?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.github_app_private_key).not.toContain(appSecret);
    expect(rawRow.github_app_id).toBe('3836338'); // non-secret, plaintext
    expect(rawRow.github_app_installation_id).toBe('135112757');
    expect(rawRow.git_ssh_public_key).toBe('ssh-ed25519 AAAA public'); // non-secret

    // getVeritySettings decrypts symmetrically.
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      gitSshPrivateKey: sshSecret,
      githubAppPrivateKey: appSecret,
      githubAppId: '3836338',
      githubAppInstallationId: '135112757',
    });
  });

  it('re-encrypts the App private key on update (ciphertext changes, plaintext stable)', async () => {
    await store.updateVeritySettings({ githubAppPrivateKey: 'key-v1' });
    const first = (await rawVerityRow()).github_app_private_key;
    await store.updateVeritySettings({ githubAppPrivateKey: 'key-v1' });
    const second = (await rawVerityRow()).github_app_private_key;
    expect(first).not.toBe(second); // random IV → fresh ciphertext
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      githubAppPrivateKey: 'key-v1',
    });
  });

  it('encrypts the project Doppler token at rest but not its ref', async () => {
    const projectId = randomUUID();
    await store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    await store.updateProjectSettings(projectId, {
      dopplerToken: 'doppler-token-fixture-value',
      dopplerTokenRef: 'doppler://verity/prod',
    });

    const rawRow = await raw.db
      .selectFrom('project_settings')
      .select(['doppler_token', 'doppler_token_ref'])
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    expect(rawRow?.doppler_token?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.doppler_token).not.toContain('doppler-token-fixture-value');
    expect(rawRow?.doppler_token_ref).toBe('doppler://verity/prod'); // ref is not a secret

    await expect(store.getProjectSettings(projectId)).resolves.toMatchObject({
      dopplerToken: 'doppler-token-fixture-value',
      dopplerTokenRef: 'doppler://verity/prod',
    });
  });

  it('encrypts the account-level Doppler service token at rest and decrypts on read (#320)', async () => {
    // Neutral fixture — not a real Doppler token; the cipher round-trips any bytes.
    const dopplerSecret = 'doppler-service-token-fixture-value';
    const record = await store.updateVeritySettings({ dopplerServiceToken: dopplerSecret });
    // Returned record is plaintext (decrypted on read).
    expect(record.dopplerServiceToken).toBe(dopplerSecret);

    // On disk the token is enciphered.
    const rawRow = await rawVerityRow();
    expect(rawRow.doppler_service_token?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.doppler_service_token).not.toContain(dopplerSecret);

    // getVeritySettings decrypts it; getVeritySettingsRaw does NOT (returns the
    // stored ciphertext, sealed-safe) — the presence-only read path.
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      dopplerServiceToken: dopplerSecret,
    });
    const rawRead = await store.getVeritySettingsRaw();
    expect(rawRead?.dopplerServiceToken?.startsWith('enc:v1:')).toBe(true);
    expect(rawRead?.dopplerServiceToken).not.toBe(dopplerSecret);
  });

  it('encrypts the transcription API key while keeping URL and model plaintext', async () => {
    const apiKey = 'transcription-api-key-fixture';
    const record = await store.updateVeritySettings({
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeApiKey: apiKey,
      transcribeModel: 'whisper-test',
    });
    expect(record).toMatchObject({
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeApiKey: apiKey,
      transcribeModel: 'whisper-test',
    });

    const rawRow = await rawVerityRow();
    expect(rawRow.transcribe_base_url).toBe('https://api.example.test/v1');
    expect(rawRow.transcribe_model).toBe('whisper-test');
    expect(rawRow.transcribe_api_key?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.transcribe_api_key).not.toContain(apiKey);

    const rawRead = await store.getVeritySettingsRaw();
    expect(rawRead?.transcribeApiKey?.startsWith('enc:v1:')).toBe(true);
    expect(rawRead?.transcribeApiKey).not.toBe(apiKey);
  });

  it('encrypts the Claude Code + Codex subscription logins at rest and decrypts on read', async () => {
    // Neutral fixtures — the cipher round-trips arbitrary bytes.
    const claudeCredentials =
      '{"claudeAiOauth":{"accessToken":"claude-access-fixture-value","refreshToken":"claude-refresh-fixture-value"}}';
    const codexAuth = '{"tokens":{"access_token":"codex-auth-json-fixture-value"}}';
    const record = await store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: claudeCredentials,
      codexAuthJson: codexAuth,
    });
    expect(record.claudeCodeOauthCredentialsJson).toBe(claudeCredentials);
    expect(record.codexAuthJson).toBe(codexAuth);

    // On disk both are enciphered and the plaintext is absent.
    const rawRow = await rawVerityRow();
    expect(rawRow.claude_code_oauth_credentials_json?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.claude_code_oauth_credentials_json).not.toContain('claude-refresh-fixture-value');
    expect(rawRow.codex_auth_json?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.codex_auth_json).not.toContain('codex-auth-json-fixture-value');

    // Decrypting read returns plaintext; the raw (sealed-safe) read does not.
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      claudeCodeOauthCredentialsJson: claudeCredentials,
      codexAuthJson: codexAuth,
    });
    const rawRead = await store.getVeritySettingsRaw();
    expect(rawRead?.claudeCodeOauthCredentialsJson?.startsWith('enc:v1:')).toBe(true);
    expect(rawRead?.codexAuthJson?.startsWith('enc:v1:')).toBe(true);
  });

  it('encrypts the Uplink subscription key while retaining its assigned public identity', async () => {
    const subscriptionKey = 'uplink-subscription-fixture-value';
    await store.updateVeritySettings({
      uplinkSubscriptionKey: subscriptionKey,
      uplinkInstallationId: 'installation-fixture',
    });
    const rawRow = await rawVerityRow();
    expect(rawRow.uplink_subscription_key?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow.uplink_subscription_key).not.toContain(subscriptionKey);
    expect(rawRow.uplink_installation_id).toBe('installation-fixture');
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      uplinkSubscriptionKey: subscriptionKey,
      uplinkInstallationId: 'installation-fixture',
    });
  });

  it('encrypts the minted Doppler token at rest but keeps the binding plaintext (#320)', async () => {
    const projectId = randomUUID();
    await store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const mintedSecret = 'doppler-minted-scoped-token-fixture-value';
    await store.updateProjectSettings(projectId, {
      dopplerProject: 'my-project',
      dopplerConfig: 'dev',
      dopplerMintedToken: mintedSecret,
      // The slug is an opaque identifier, NOT a secret — persisted plaintext.
      dopplerMintedTokenSlug: 'minted-token-slug-fixture',
    });

    const rawRow = await raw.db
      .selectFrom('project_settings')
      .select([
        'doppler_minted_token',
        'doppler_minted_token_slug',
        'doppler_project',
        'doppler_config',
      ])
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    // Minted token is a secret — enciphered on disk.
    expect(rawRow?.doppler_minted_token?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.doppler_minted_token).not.toContain(mintedSecret);
    // Binding is non-secret config — plaintext on disk.
    expect(rawRow?.doppler_project).toBe('my-project');
    expect(rawRow?.doppler_config).toBe('dev');
    // Slug is a non-secret identifier — stored plaintext, never enciphered.
    expect(rawRow?.doppler_minted_token_slug).toBe('minted-token-slug-fixture');

    // getProjectSettings decrypts the minted token symmetrically; the slug
    // round-trips as plaintext.
    await expect(store.getProjectSettings(projectId)).resolves.toMatchObject({
      dopplerProject: 'my-project',
      dopplerConfig: 'dev',
      dopplerMintedToken: mintedSecret,
      dopplerMintedTokenSlug: 'minted-token-slug-fixture',
    });
    // getProjectSettingsRaw does NOT decrypt (sealed-safe presence-only read).
    const rawRead = await store.getProjectSettingsRaw(projectId);
    expect(rawRead?.dopplerMintedToken?.startsWith('enc:v1:')).toBe(true);
    expect(rawRead?.dopplerMintedToken).not.toBe(mintedSecret);
    // The binding survives the no-decrypt read too (it's plaintext either way).
    expect(rawRead?.dopplerProject).toBe('my-project');
    expect(rawRead?.dopplerConfig).toBe('dev');
  });

  it('clears the cached minted token when set to null (rebind path) (#320)', async () => {
    const projectId = randomUUID();
    await store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await store.updateProjectSettings(projectId, {
      dopplerProject: 'p1',
      dopplerConfig: 'dev',
      dopplerMintedToken: 'minted-fixture-value',
      dopplerMintedTokenSlug: 'minted-slug-fixture',
    });
    // Rebind clears the cache — both the token and its slug.
    await store.updateProjectSettings(projectId, {
      dopplerProject: 'p2',
      dopplerMintedToken: null,
      dopplerMintedTokenSlug: null,
    });
    await expect(store.getProjectSettings(projectId)).resolves.toMatchObject({
      dopplerProject: 'p2',
      dopplerConfig: 'dev',
      dopplerMintedToken: null,
      dopplerMintedTokenSlug: null,
    });
  });

  it('reads a pre-encryption plaintext secret unchanged (back-compat, no data migration)', async () => {
    // Simulate a row written before encryption was enabled: raw plaintext in the
    // secret column, no `enc:v1:` envelope.
    await raw.db
      .insertInto('verity_settings')
      .values({ id: 'global', git_ssh_private_key: 'legacy-plaintext-key' })
      .execute();
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      gitSshPrivateKey: 'legacy-plaintext-key',
    });
  });
});
