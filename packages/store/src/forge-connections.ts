import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export type ForgeConnectionProvider = 'github' | 'forgejo';
export interface ForgeConnection {
  id: string;
  provider: ForgeConnectionProvider;
  baseUrl: string;
  label: string;
  customCaPem?: string | null;
}
export interface ForgeConnectionCredentials {
  personalToken: string | null;
  githubAppId: string | null;
  githubAppInstallationId: string | null;
  githubAppPrivateKey: string | null;
}
export type ForgeConnectionInput = ForgeConnection & ForgeConnectionCredentials;

/** Metadata remains readable while sealed; credentials require explicit access. */
export class ForgeConnectionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<ForgeConnection[]> {
    const rows = await this.db
      .selectFrom('forge_connections')
      .select(['id', 'provider', 'base_url', 'label', 'custom_ca_pem'])
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      baseUrl: row.base_url,
      label: row.label,
      ...(row.custom_ca_pem === null ? {} : { customCaPem: row.custom_ca_pem }),
    }));
  }

  async get(id: string): Promise<ForgeConnection | undefined> {
    return (await this.list()).find((connection) => connection.id === id);
  }

  async credentials(id: string): Promise<ForgeConnectionCredentials | undefined> {
    const row = await this.db
      .selectFrom('forge_connections')
      .select([
        'personal_token',
        'github_app_id',
        'github_app_installation_id',
        'github_app_private_key',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      personalToken: row.personal_token === null ? null : this.cipher.decrypt(row.personal_token),
      githubAppId: row.github_app_id,
      githubAppInstallationId: row.github_app_installation_id,
      githubAppPrivateKey:
        row.github_app_private_key === null
          ? null
          : this.cipher.decrypt(row.github_app_private_key),
    };
  }

  /** Replace credentials atomically; an existing connection cannot change identity. */
  async upsert(input: ForgeConnectionInput): Promise<void> {
    const url = new URL(input.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Forge base URL must use HTTPS without credentials, query or fragment');
    }
    const baseUrl = url.toString().replace(/\/$/u, '');
    const row = {
      id: input.id,
      provider: input.provider,
      base_url: baseUrl,
      label: input.label,
      custom_ca_pem: input.customCaPem ?? null,
      personal_token:
        input.personalToken === null ? null : this.cipher.encrypt(input.personalToken),
      github_app_id: input.githubAppId,
      github_app_installation_id: input.githubAppInstallationId,
      github_app_private_key:
        input.githubAppPrivateKey === null ? null : this.cipher.encrypt(input.githubAppPrivateKey),
    };
    const result = await this.db
      .insertInto('forge_connections')
      .values(row)
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet({
            label: row.label,
            custom_ca_pem: row.custom_ca_pem,
            personal_token: row.personal_token,
            github_app_id: row.github_app_id,
            github_app_installation_id: row.github_app_installation_id,
            github_app_private_key: row.github_app_private_key,
            updated_at: sql`now()`,
          })
          .where('forge_connections.provider', '=', input.provider)
          .where('forge_connections.base_url', '=', baseUrl),
      )
      .returning('id')
      .executeTakeFirst();
    if (!result) throw new Error('Cannot change forge connection provider or base URL');
  }

  /** Referenced connections are protected by foreign keys. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('forge_connections').where('id', '=', id).execute();
  }
}
