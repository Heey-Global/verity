import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export type ProviderConnectionKind = 'claude' | 'codex' | 'opencode';

/** A person's own provider account (ADR 0023 §3). */
export interface UserProviderConnection {
  userId: string;
  provider: ProviderConnectionKind;
  /** Decrypted; only for the gateway projection and the person's own refresh. */
  credential: string;
  baseUrl: string | null;
  models: string | null;
  updatedAt: Date;
}

export interface UserProviderConnectionStatus {
  provider: ProviderConnectionKind;
  baseUrl: string | null;
  models: string | null;
  updatedAt: Date;
}

export class UserProviderConnectionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async get(
    userId: string,
    provider: ProviderConnectionKind,
  ): Promise<UserProviderConnection | undefined> {
    const row = await this.db
      .selectFrom('user_provider_connections')
      .selectAll()
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          userId: row.user_id,
          provider: row.provider,
          credential: this.cipher.decrypt(row.credential),
          baseUrl: row.base_url,
          models: row.models,
          updatedAt: row.updated_at,
        };
  }

  /** Every person's connection of one provider, decrypted, for the gateway projection. */
  async listByProvider(provider: ProviderConnectionKind): Promise<UserProviderConnection[]> {
    const rows = await this.db
      .selectFrom('user_provider_connections')
      .selectAll()
      .where('provider', '=', provider)
      .orderBy('user_id')
      .execute();
    return rows.map((row) => ({
      userId: row.user_id,
      provider: row.provider,
      credential: this.cipher.decrypt(row.credential),
      baseUrl: row.base_url,
      models: row.models,
      updatedAt: row.updated_at,
    }));
  }

  /** Which providers the person connected, without decrypting anything. */
  async status(userId: string): Promise<UserProviderConnectionStatus[]> {
    const rows = await this.db
      .selectFrom('user_provider_connections')
      .select(['provider', 'base_url', 'models', 'updated_at'])
      .where('user_id', '=', userId)
      .orderBy('provider')
      .execute();
    return rows.map((row) => ({
      provider: row.provider,
      baseUrl: row.base_url,
      models: row.models,
      updatedAt: row.updated_at,
    }));
  }

  async set(
    userId: string,
    provider: ProviderConnectionKind,
    input: { credential: string; baseUrl?: string | null; models?: string | null },
  ): Promise<void> {
    const values = {
      credential: this.cipher.encrypt(input.credential),
      base_url: input.baseUrl ?? null,
      models: input.models ?? null,
    };
    await this.db
      .insertInto('user_provider_connections')
      .values({ user_id: userId, provider, ...values })
      .onConflict((conflict) =>
        conflict
          .columns(['user_id', 'provider'])
          .doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }

  async delete(userId: string, provider: ProviderConnectionKind): Promise<void> {
    await this.db
      .deleteFrom('user_provider_connections')
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .execute();
  }

  /** The person's own default model for a project, or null. */
  async projectDefaultModel(userId: string, projectId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('user_project_preferences')
      .select('default_model')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row?.default_model ?? null;
  }

  async setProjectDefaultModel(
    userId: string,
    projectId: string,
    model: string | null,
  ): Promise<void> {
    await this.db
      .insertInto('user_project_preferences')
      .values({ user_id: userId, project_id: projectId, default_model: model })
      .onConflict((conflict) =>
        conflict
          .columns(['user_id', 'project_id'])
          .doUpdateSet({ default_model: model, updated_at: sql`now()` }),
      )
      .execute();
  }
}
