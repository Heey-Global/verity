import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export interface UserGithubAuthorization {
  userId: string;
  githubUserId: string;
  login: string;
  /** Decrypted only for the server's own GitHub calls; never returned by an API. */
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

/** A person's own GitHub App user authorization, keyed by the authenticated user. */
export class UserGithubAuthorizationStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async get(userId: string): Promise<UserGithubAuthorization | undefined> {
    const row = await this.db
      .selectFrom('user_github_authorizations')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      userId: row.user_id,
      githubUserId: row.github_user_id,
      login: row.login,
      accessToken: this.cipher.decrypt(row.access_token),
      accessExpiresAt: row.access_expires_at,
      refreshToken: row.refresh_token === null ? null : this.cipher.decrypt(row.refresh_token),
      refreshExpiresAt: row.refresh_expires_at,
    };
  }

  /** The connected GitHub account alone, without decrypting any token. */
  async account(userId: string): Promise<{ githubUserId: string; login: string } | undefined> {
    const row = await this.db
      .selectFrom('user_github_authorizations')
      .select(['github_user_id', 'login'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? { githubUserId: row.github_user_id, login: row.login } : undefined;
  }

  async save(input: UserGithubAuthorization): Promise<void> {
    const values = {
      github_user_id: input.githubUserId,
      login: input.login,
      access_token: this.cipher.encrypt(input.accessToken),
      access_expires_at: input.accessExpiresAt?.toISOString() ?? null,
      refresh_token: input.refreshToken === null ? null : this.cipher.encrypt(input.refreshToken),
      refresh_expires_at: input.refreshExpiresAt?.toISOString() ?? null,
    };
    await this.db
      .insertInto('user_github_authorizations')
      .values({ user_id: input.userId, ...values })
      .onConflict((conflict) =>
        conflict.column('user_id').doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }

  async delete(userId: string): Promise<void> {
    await this.db.deleteFrom('user_github_authorizations').where('user_id', '=', userId).execute();
  }
}
