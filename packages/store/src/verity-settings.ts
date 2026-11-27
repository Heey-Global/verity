import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { EgressDestinationMutation } from './egress-destination-mutation.js';
import { normalizeSetting } from './normalize-setting.js';
import type { Database } from './schema.js';

export interface VeritySettingsRecord {
  gitUserName: string | null;
  gitUserEmail: string | null;
  gitSshPrivateKeyPath: string | null;
  gitSshPrivateKey: string | null;
  gitSshPublicKeyPath: string | null;
  gitSshPublicKey: string | null;
  gitKnownHostsPath: string | null;
  gitKnownHosts: string | null;
  gitAllowedSignersPath: string | null;
  gitAllowedSigners: string | null;
  githubAppId: string | null;
  githubAppInstallationId: string | null;
  githubAppPrivateKey: string | null;
  /** The App's OAuth client, used only for each person's own GitHub
   *  authorization (ADR 0023 §3). The secret is encrypted at rest. */
  githubAppClientId: string | null;
  githubAppClientSecret: string | null;
  /** Account-level Doppler Service Account token (#320). A secret, encrypted at
   *  rest; decrypted on read via {@link VeritySettingsStore.getVeritySettings}. */
  dopplerServiceToken: string | null;
  transcribeBaseUrl?: string | null;
  /** OpenAI-compatible transcription token, encrypted at rest. */
  transcribeApiKey?: string | null;
  transcribeModel?: string | null;
  /** Explicit selection made by the app. Null preserves the legacy environment
   * fallback for installations that predate the first-use chooser. */
  transcribeBackendMode?: 'local' | 'external' | null;
  /** Full Claude OAuth credential state from `~/.claude/.credentials.json`.
   *  A secret, encrypted at rest; used by the server to refresh access tokens
   *  for Claude account usage probes. */
  claudeCodeOauthCredentialsJson: string | null;
  /** Subscription-login credential acquired from `codex login`. The encrypted
   *  database value is projected only to the agent gateway credential authority;
   *  it is never materialized into an agent runtime or Sandbox. */
  codexAuthJson: string | null;
  opencodeBaseUrl?: string | null;
  /** OpenCode provider credential, encrypted at rest. */
  opencodeApiKey?: string | null;
  /** Server-discovered OpenCode model ids, cached as newline-separated values. */
  opencodeModels?: string | null;
  /** Models hidden by the user. Newly discovered models remain enabled by default. */
  opencodeDisabledModels?: string | null;
  /** Google connection for Drive imports and Slides editing (ADRs 0009/0016).
   *  Client id + account email are non-secret;
   *  the refresh token is a secret, encrypted at rest and decrypted on read via
   *  {@link VeritySettingsStore.getVeritySettings}. */
  googleDriveClientId: string | null;
  googleDriveAccountEmail: string | null;
  googleDriveRefreshToken: string | null;
  /** True after OAuth consent has explicitly included Gmail read/compose scopes. */
  gmailAuthorized: boolean;
  /** True after OAuth consent has explicitly included Calendar event scopes. */
  calendarAuthorized: boolean;
  /** True after explicit consent to read Google Contacts. */
  contactsAuthorized: boolean;
  /** Scopes actually granted to the shared Google credential. */
  googleGrantedScopes: string[];
  /** Verity Uplink subscription credential, encrypted at rest. */
  uplinkSubscriptionKey?: string | null;
  /** Stable identity assigned and validated by the Uplink. */
  uplinkInstallationId?: string | null;
  /** Operator switches for the paid Uplink features. Uplink grants a feature;
   * the switch decides whether this server uses it. Both default to on. */
  premiumSharingEnabled?: boolean;
  premiumRemoteAccessEnabled?: boolean;
  /** System-wide network protection. When on, every project container starts behind
   * the host egress fence from its next start. Defaults to off. */
  projectEgressEnabled?: boolean;
  advancedModeEnabled?: boolean;
  /** Days an unassigned live meeting is kept after it ends; null means the default. */
  unassignedMeetingRetentionDays?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type VeritySettingsKey =
  | 'advancedModeEnabled'
  | 'unassignedMeetingRetentionDays'
  | 'gitUserName'
  | 'gitUserEmail'
  | 'gitSshPrivateKeyPath'
  | 'gitSshPrivateKey'
  | 'gitSshPublicKeyPath'
  | 'gitSshPublicKey'
  | 'gitKnownHostsPath'
  | 'gitKnownHosts'
  | 'gitAllowedSignersPath'
  | 'gitAllowedSigners'
  | 'githubAppId'
  | 'githubAppInstallationId'
  | 'githubAppPrivateKey'
  | 'githubAppClientId'
  | 'githubAppClientSecret'
  | 'dopplerServiceToken'
  | 'transcribeBaseUrl'
  | 'transcribeApiKey'
  | 'transcribeModel'
  | 'transcribeBackendMode'
  | 'claudeCodeOauthCredentialsJson'
  | 'codexAuthJson'
  | 'opencodeBaseUrl'
  | 'opencodeApiKey'
  | 'opencodeModels'
  | 'opencodeDisabledModels'
  | 'googleDriveClientId'
  | 'googleDriveAccountEmail'
  | 'googleDriveRefreshToken'
  | 'gmailAuthorized'
  | 'calendarAuthorized'
  | 'contactsAuthorized'
  | 'googleGrantedScopes'
  | 'uplinkSubscriptionKey'
  | 'uplinkInstallationId'
  | 'premiumSharingEnabled'
  | 'premiumRemoteAccessEnabled'
  | 'projectEgressEnabled';

export type VeritySettingsPatch = {
  [K in VeritySettingsKey]?: VeritySettingsRecord[K] | undefined;
};

export class VeritySettingsStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly cipher: SecretCipher,
    private readonly egressDestinationMutation: EgressDestinationMutation,
    private readonly setLegacyDopplerToken: (
      token: string | null,
      tx: Kysely<Database>,
    ) => Promise<void>,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  private encryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.encrypt(value);
  }

  private decryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.decrypt(value);
  }

  async readEgressDestinations() {
    return this.db
      .selectFrom('verity_settings')
      .select(['opencode_base_url', 'transcribe_base_url'])
      .where('id', '=', 'global')
      .executeTakeFirst();
  }

  private veritySettingsRowToRecord(
    row: {
      git_user_name: string | null;
      git_user_email: string | null;
      git_ssh_private_key_path: string | null;
      git_ssh_private_key: string | null;
      git_ssh_public_key_path: string | null;
      git_ssh_public_key: string | null;
      git_known_hosts_path: string | null;
      git_known_hosts: string | null;
      git_allowed_signers_path: string | null;
      git_allowed_signers: string | null;
      github_app_id: string | null;
      github_app_installation_id: string | null;
      github_app_private_key: string | null;
      github_app_client_id: string | null;
      github_app_client_secret: string | null;
      doppler_service_token: string | null;
      transcribe_base_url: string | null;
      transcribe_api_key: string | null;
      transcribe_model: string | null;
      transcribe_backend_mode: string | null;
      claude_code_oauth_credentials_json: string | null;
      codex_auth_json: string | null;
      opencode_base_url: string | null;
      opencode_api_key: string | null;
      opencode_models: string | null;
      opencode_disabled_models: string | null;
      google_drive_client_id: string | null;
      google_drive_account_email: string | null;
      google_drive_refresh_token: string | null;
      gmail_authorized: boolean;
      calendar_authorized: boolean;
      contacts_authorized: boolean;
      google_granted_scopes: string[];
      uplink_subscription_key: string | null;
      uplink_installation_id: string | null;
      premium_sharing_enabled: boolean;
      premium_remote_access_enabled: boolean;
      project_egress_enabled: boolean;
      advanced_mode_enabled: boolean;
      unassigned_meeting_retention_days: number | null;
      created_at: Date;
      updated_at: Date;
      // When false, secret columns are returned in their STORED (possibly
      // encrypted) form without decrypting — for public read paths that only
      // strip/`configured`-check them, so they work while the store is sealed.
    },
    decrypt = true,
  ): VeritySettingsRecord {
    return {
      advancedModeEnabled: row.advanced_mode_enabled,
      unassignedMeetingRetentionDays: row.unassigned_meeting_retention_days,
      gitUserName: row.git_user_name,
      gitUserEmail: row.git_user_email,
      gitSshPrivateKeyPath: row.git_ssh_private_key_path,
      gitSshPrivateKey: decrypt
        ? this.decryptSecret(row.git_ssh_private_key)
        : row.git_ssh_private_key,
      gitSshPublicKeyPath: row.git_ssh_public_key_path,
      gitSshPublicKey: row.git_ssh_public_key,
      gitKnownHostsPath: row.git_known_hosts_path,
      gitKnownHosts: row.git_known_hosts,
      gitAllowedSignersPath: row.git_allowed_signers_path,
      gitAllowedSigners: row.git_allowed_signers,
      githubAppId: row.github_app_id,
      githubAppInstallationId: row.github_app_installation_id,
      githubAppPrivateKey: decrypt
        ? this.decryptSecret(row.github_app_private_key)
        : row.github_app_private_key,
      githubAppClientId: row.github_app_client_id,
      githubAppClientSecret: decrypt
        ? this.decryptSecret(row.github_app_client_secret)
        : row.github_app_client_secret,
      dopplerServiceToken: decrypt
        ? this.decryptSecret(row.doppler_service_token)
        : row.doppler_service_token,
      transcribeBaseUrl: row.transcribe_base_url,
      transcribeApiKey: decrypt
        ? this.decryptSecret(row.transcribe_api_key)
        : row.transcribe_api_key,
      transcribeModel: row.transcribe_model,
      transcribeBackendMode:
        row.transcribe_backend_mode === 'local' || row.transcribe_backend_mode === 'external'
          ? row.transcribe_backend_mode
          : null,
      claudeCodeOauthCredentialsJson: decrypt
        ? this.decryptSecret(row.claude_code_oauth_credentials_json)
        : row.claude_code_oauth_credentials_json,
      codexAuthJson: decrypt ? this.decryptSecret(row.codex_auth_json) : row.codex_auth_json,
      opencodeBaseUrl: row.opencode_base_url,
      opencodeApiKey: decrypt ? this.decryptSecret(row.opencode_api_key) : row.opencode_api_key,
      opencodeModels: row.opencode_models,
      opencodeDisabledModels: row.opencode_disabled_models,
      googleDriveClientId: row.google_drive_client_id,
      googleDriveAccountEmail: row.google_drive_account_email,
      googleDriveRefreshToken: decrypt
        ? this.decryptSecret(row.google_drive_refresh_token)
        : row.google_drive_refresh_token,
      gmailAuthorized: row.gmail_authorized,
      calendarAuthorized: row.calendar_authorized,
      contactsAuthorized: row.contacts_authorized,
      googleGrantedScopes: row.google_granted_scopes,
      uplinkSubscriptionKey: decrypt
        ? this.decryptSecret(row.uplink_subscription_key)
        : row.uplink_subscription_key,
      uplinkInstallationId: row.uplink_installation_id,
      premiumSharingEnabled: row.premium_sharing_enabled,
      premiumRemoteAccessEnabled: row.premium_remote_access_enabled,
      projectEgressEnabled: row.project_egress_enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly veritySettingsColumns = [
    'advanced_mode_enabled',
    'git_user_name',
    'git_user_email',
    'git_ssh_private_key_path',
    'git_ssh_private_key',
    'git_ssh_public_key_path',
    'git_ssh_public_key',
    'git_known_hosts_path',
    'git_known_hosts',
    'git_allowed_signers_path',
    'git_allowed_signers',
    'github_app_id',
    'github_app_installation_id',
    'github_app_private_key',
    'github_app_client_id',
    'github_app_client_secret',
    'doppler_service_token',
    'transcribe_base_url',
    'transcribe_api_key',
    'transcribe_model',
    'transcribe_backend_mode',
    'claude_code_oauth_credentials_json',
    'codex_auth_json',
    'opencode_base_url',
    'opencode_api_key',
    'opencode_models',
    'opencode_disabled_models',
    'google_drive_client_id',
    'google_drive_account_email',
    'google_drive_refresh_token',
    'gmail_authorized',
    'calendar_authorized',
    'contacts_authorized',
    'google_granted_scopes',
    'uplink_subscription_key',
    'uplink_installation_id',
    'premium_sharing_enabled',
    'premium_remote_access_enabled',
    'project_egress_enabled',
    'advanced_mode_enabled',
    'unassigned_meeting_retention_days',
    'created_at',
    'updated_at',
  ] as const;

  async getVeritySettings(): Promise<VeritySettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('verity_settings')
      .select(this.veritySettingsColumns)
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? this.veritySettingsRowToRecord(row) : undefined;
  }

  /**
   * Read settings WITHOUT decrypting the secret columns — for public read paths
   * (GET /settings, first-run seeding) that only strip or `configured`-check
   * secrets. Works while the store is sealed; the returned record's secret
   * fields hold the STORED (possibly encrypted) form, so they must NOT be used
   * as plaintext.
   */
  async getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('verity_settings')
      .select(this.veritySettingsColumns)
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? this.veritySettingsRowToRecord(row, false) : undefined;
  }

  async updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord> {
    if (patch.opencodeBaseUrl !== undefined || patch.transcribeBaseUrl !== undefined)
      return this.egressDestinationMutation(() =>
        this.updateVeritySettingsWithoutInventoryBarrier(patch),
      );
    return this.updateVeritySettingsWithoutInventoryBarrier(patch);
  }

  private async updateVeritySettingsWithoutInventoryBarrier(
    patch: VeritySettingsPatch,
    tx?: Kysely<Database>,
  ): Promise<VeritySettingsRecord> {
    if (tx === undefined && patch.dopplerServiceToken !== undefined)
      return this.db.transaction().execute(async (transaction) => {
        await this.setLegacyDopplerToken(normalizeSetting(patch.dopplerServiceToken), transaction);
        return this.updateVeritySettingsWithoutInventoryBarrier(patch, transaction);
      });
    const values = {
      id: 'global',
      advanced_mode_enabled: patch.advancedModeEnabled ?? false,
      unassigned_meeting_retention_days: patch.unassignedMeetingRetentionDays ?? null,
      git_user_name: normalizeSetting(patch.gitUserName),
      git_user_email: normalizeSetting(patch.gitUserEmail),
      git_ssh_private_key_path: normalizeSetting(patch.gitSshPrivateKeyPath),
      git_ssh_private_key: this.encryptSecret(normalizeSetting(patch.gitSshPrivateKey)),
      git_ssh_public_key_path: normalizeSetting(patch.gitSshPublicKeyPath),
      git_ssh_public_key: normalizeSetting(patch.gitSshPublicKey),
      git_known_hosts_path: normalizeSetting(patch.gitKnownHostsPath),
      git_known_hosts: normalizeSetting(patch.gitKnownHosts),
      git_allowed_signers_path: normalizeSetting(patch.gitAllowedSignersPath),
      git_allowed_signers: normalizeSetting(patch.gitAllowedSigners),
      github_app_id: normalizeSetting(patch.githubAppId),
      github_app_installation_id: normalizeSetting(patch.githubAppInstallationId),
      github_app_private_key: this.encryptSecret(normalizeSetting(patch.githubAppPrivateKey)),
      github_app_client_id: normalizeSetting(patch.githubAppClientId),
      github_app_client_secret: this.encryptSecret(normalizeSetting(patch.githubAppClientSecret)),
      doppler_service_token: this.encryptSecret(normalizeSetting(patch.dopplerServiceToken)),
      transcribe_base_url: normalizeSetting(patch.transcribeBaseUrl),
      transcribe_api_key: this.encryptSecret(normalizeSetting(patch.transcribeApiKey)),
      transcribe_model: normalizeSetting(patch.transcribeModel),
      transcribe_backend_mode: normalizeSetting(patch.transcribeBackendMode),
      claude_code_oauth_credentials_json: this.encryptSecret(
        normalizeSetting(patch.claudeCodeOauthCredentialsJson),
      ),
      codex_auth_json: this.encryptSecret(normalizeSetting(patch.codexAuthJson)),
      opencode_base_url: normalizeSetting(patch.opencodeBaseUrl),
      opencode_api_key: this.encryptSecret(normalizeSetting(patch.opencodeApiKey)),
      opencode_models: normalizeSetting(patch.opencodeModels),
      opencode_disabled_models: normalizeSetting(patch.opencodeDisabledModels),
      google_drive_client_id: normalizeSetting(patch.googleDriveClientId),
      google_drive_account_email: normalizeSetting(patch.googleDriveAccountEmail),
      google_drive_refresh_token: this.encryptSecret(
        normalizeSetting(patch.googleDriveRefreshToken),
      ),
      gmail_authorized: patch.gmailAuthorized ?? false,
      calendar_authorized: patch.calendarAuthorized ?? false,
      contacts_authorized: patch.contactsAuthorized ?? false,
      google_granted_scopes: JSON.stringify(patch.googleGrantedScopes ?? []),
      uplink_subscription_key: this.encryptSecret(normalizeSetting(patch.uplinkSubscriptionKey)),
      uplink_installation_id: normalizeSetting(patch.uplinkInstallationId),
      premium_sharing_enabled: patch.premiumSharingEnabled ?? true,
      premium_remote_access_enabled: patch.premiumRemoteAccessEnabled ?? true,
      project_egress_enabled: patch.projectEgressEnabled ?? false,
    };
    const row = await (tx ?? this.db)
      .insertInto('verity_settings')
      .values(values)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          ...(patch.advancedModeEnabled !== undefined
            ? { advanced_mode_enabled: patch.advancedModeEnabled }
            : {}),
          ...(patch.gitUserName !== undefined
            ? { git_user_name: normalizeSetting(patch.gitUserName) }
            : {}),
          ...(patch.gitUserEmail !== undefined
            ? { git_user_email: normalizeSetting(patch.gitUserEmail) }
            : {}),
          ...(patch.gitSshPrivateKeyPath !== undefined
            ? { git_ssh_private_key_path: normalizeSetting(patch.gitSshPrivateKeyPath) }
            : {}),
          ...(patch.gitSshPrivateKey !== undefined
            ? { git_ssh_private_key: this.encryptSecret(normalizeSetting(patch.gitSshPrivateKey)) }
            : {}),
          ...(patch.gitSshPublicKeyPath !== undefined
            ? { git_ssh_public_key_path: normalizeSetting(patch.gitSshPublicKeyPath) }
            : {}),
          ...(patch.gitSshPublicKey !== undefined
            ? { git_ssh_public_key: normalizeSetting(patch.gitSshPublicKey) }
            : {}),
          ...(patch.gitKnownHostsPath !== undefined
            ? { git_known_hosts_path: normalizeSetting(patch.gitKnownHostsPath) }
            : {}),
          ...(patch.gitKnownHosts !== undefined
            ? { git_known_hosts: normalizeSetting(patch.gitKnownHosts) }
            : {}),
          ...(patch.gitAllowedSignersPath !== undefined
            ? { git_allowed_signers_path: normalizeSetting(patch.gitAllowedSignersPath) }
            : {}),
          ...(patch.gitAllowedSigners !== undefined
            ? { git_allowed_signers: normalizeSetting(patch.gitAllowedSigners) }
            : {}),
          ...(patch.githubAppId !== undefined
            ? { github_app_id: normalizeSetting(patch.githubAppId) }
            : {}),
          ...(patch.githubAppInstallationId !== undefined
            ? { github_app_installation_id: normalizeSetting(patch.githubAppInstallationId) }
            : {}),
          ...(patch.githubAppPrivateKey !== undefined
            ? { github_app_private_key: values.github_app_private_key }
            : {}),
          ...(patch.githubAppClientId !== undefined
            ? { github_app_client_id: normalizeSetting(patch.githubAppClientId) }
            : {}),
          ...(patch.githubAppClientSecret !== undefined
            ? {
                github_app_client_secret: this.encryptSecret(
                  normalizeSetting(patch.githubAppClientSecret),
                ),
              }
            : {}),
          ...(patch.dopplerServiceToken !== undefined
            ? { doppler_service_token: values.doppler_service_token }
            : {}),
          ...(patch.transcribeBaseUrl !== undefined
            ? { transcribe_base_url: normalizeSetting(patch.transcribeBaseUrl) }
            : {}),
          ...(patch.transcribeApiKey !== undefined
            ? { transcribe_api_key: values.transcribe_api_key }
            : {}),
          ...(patch.transcribeModel !== undefined
            ? { transcribe_model: normalizeSetting(patch.transcribeModel) }
            : {}),
          ...(patch.transcribeBackendMode !== undefined
            ? { transcribe_backend_mode: normalizeSetting(patch.transcribeBackendMode) }
            : {}),
          ...(patch.claudeCodeOauthCredentialsJson !== undefined
            ? {
                claude_code_oauth_credentials_json: this.encryptSecret(
                  normalizeSetting(patch.claudeCodeOauthCredentialsJson),
                ),
              }
            : {}),
          ...(patch.codexAuthJson !== undefined
            ? { codex_auth_json: this.encryptSecret(normalizeSetting(patch.codexAuthJson)) }
            : {}),
          ...(patch.opencodeBaseUrl !== undefined
            ? { opencode_base_url: normalizeSetting(patch.opencodeBaseUrl) }
            : {}),
          ...(patch.opencodeApiKey !== undefined
            ? { opencode_api_key: this.encryptSecret(normalizeSetting(patch.opencodeApiKey)) }
            : {}),
          ...(patch.opencodeModels !== undefined
            ? { opencode_models: normalizeSetting(patch.opencodeModels) }
            : {}),
          ...(patch.opencodeDisabledModels !== undefined
            ? { opencode_disabled_models: normalizeSetting(patch.opencodeDisabledModels) }
            : {}),
          ...(patch.googleDriveClientId !== undefined
            ? { google_drive_client_id: normalizeSetting(patch.googleDriveClientId) }
            : {}),
          ...(patch.googleDriveAccountEmail !== undefined
            ? { google_drive_account_email: normalizeSetting(patch.googleDriveAccountEmail) }
            : {}),
          ...(patch.googleDriveRefreshToken !== undefined
            ? {
                google_drive_refresh_token: this.encryptSecret(
                  normalizeSetting(patch.googleDriveRefreshToken),
                ),
              }
            : {}),
          ...(patch.gmailAuthorized !== undefined
            ? { gmail_authorized: patch.gmailAuthorized }
            : {}),
          ...(patch.calendarAuthorized !== undefined
            ? { calendar_authorized: patch.calendarAuthorized }
            : {}),
          ...(patch.contactsAuthorized !== undefined
            ? { contacts_authorized: patch.contactsAuthorized }
            : {}),
          ...(patch.googleGrantedScopes !== undefined
            ? { google_granted_scopes: JSON.stringify(patch.googleGrantedScopes) }
            : {}),
          ...(patch.uplinkSubscriptionKey !== undefined
            ? {
                uplink_subscription_key: this.encryptSecret(
                  normalizeSetting(patch.uplinkSubscriptionKey),
                ),
              }
            : {}),
          ...(patch.uplinkInstallationId !== undefined
            ? { uplink_installation_id: normalizeSetting(patch.uplinkInstallationId) }
            : {}),
          ...(patch.premiumSharingEnabled !== undefined
            ? { premium_sharing_enabled: patch.premiumSharingEnabled }
            : {}),
          ...(patch.premiumRemoteAccessEnabled !== undefined
            ? { premium_remote_access_enabled: patch.premiumRemoteAccessEnabled }
            : {}),
          ...(patch.projectEgressEnabled !== undefined
            ? { project_egress_enabled: patch.projectEgressEnabled }
            : {}),
          ...(patch.advancedModeEnabled !== undefined
            ? { advanced_mode_enabled: patch.advancedModeEnabled }
            : {}),
          ...(patch.unassignedMeetingRetentionDays !== undefined
            ? { unassigned_meeting_retention_days: patch.unassignedMeetingRetentionDays }
            : {}),
          updated_at: sql`now()`,
        }),
      )
      .returning(this.veritySettingsColumns)
      .executeTakeFirst();
    if (!row) {
      throw new Error('verity: updateVeritySettings RETURNING yielded no row — dialect bug');
    }
    return this.veritySettingsRowToRecord(row);
  }

  /** Persist the non-secret first-use transcription choice without decrypting
   * unrelated settings. This remains available while the secret store is sealed. */
  async updateTranscribeBackendMode(mode: 'local' | 'external'): Promise<void> {
    await this.db
      .insertInto('verity_settings')
      .values({ id: 'global', transcribe_backend_mode: mode })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ transcribe_backend_mode: mode, updated_at: sql`now()` }),
      )
      .execute();
  }
}
