import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

/** A person's own Doppler token for one project (ADR 0023 §3). */
export class UserDopplerConnectionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  /** The token as owned, erasable bytes; only for resolving that person's secrets. */
  async tokenBytes(userId: string, projectId: string): Promise<Buffer | undefined> {
    const row = await this.db
      .selectFrom('user_doppler_connections')
      .select('token')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.cipher.decryptBytes(row.token);
  }

  /** Whether the person connected the project, without decrypting anything. */
  async status(userId: string, projectId: string): Promise<{ updatedAt: Date } | undefined> {
    const row = await this.db
      .selectFrom('user_doppler_connections')
      .select('updated_at')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row === undefined ? undefined : { updatedAt: row.updated_at };
  }

  async set(userId: string, projectId: string, token: string): Promise<void> {
    const encrypted = this.cipher.encrypt(token);
    await this.db
      .insertInto('user_doppler_connections')
      .values({ user_id: userId, project_id: projectId, token: encrypted })
      .onConflict((conflict) =>
        conflict
          .columns(['user_id', 'project_id'])
          .doUpdateSet({ token: encrypted, updated_at: sql`now()` }),
      )
      .execute();
  }

  async delete(userId: string, projectId: string): Promise<void> {
    await this.db
      .deleteFrom('user_doppler_connections')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .execute();
  }
}
