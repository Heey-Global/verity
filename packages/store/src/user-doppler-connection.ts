import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import { lockDopplerTopology } from './doppler-connections.js';
import type { Database } from './schema.js';

export class DopplerBindingsChangedError extends Error {
  constructor() {
    super('Doppler bindings changed. Try connecting your token again.');
    this.name = 'DopplerBindingsChangedError';
  }
}

/** A person's own Doppler token for one project and one Doppler connection
 *  (ADR 0023 §3, ADR 0031). */
export class UserDopplerConnectionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  /** The token as owned, erasable bytes; only for resolving that person's secrets. */
  async tokenBytes(
    userId: string,
    projectId: string,
    connectionId: string,
  ): Promise<Buffer | undefined> {
    const row = await this.db
      .selectFrom('user_doppler_connections')
      .select('token')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.cipher.decryptBytes(row.token);
  }

  /** The connections the person holds a token for in the project, without
   *  decrypting anything. */
  async statuses(userId: string, projectId: string): Promise<Map<string, { updatedAt: Date }>> {
    const rows = await this.db
      .selectFrom('user_doppler_connections')
      .select(['connection_id', 'updated_at'])
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .execute();
    return new Map(rows.map((row) => [row.connection_id, { updatedAt: row.updated_at }]));
  }

  async set(
    userId: string,
    projectId: string,
    connectionId: string,
    token: string,
    expectedBindingIds?: readonly string[],
  ): Promise<void> {
    const encrypted = this.cipher.encrypt(token);
    await this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
      if (expectedBindingIds !== undefined) {
        const current = await tx
          .selectFrom('project_doppler_bindings')
          .select('id')
          .where('project_id', '=', projectId)
          .where('connection_id', '=', connectionId)
          .execute();
        if (
          current.length === 0 ||
          current.length !== expectedBindingIds.length ||
          current.some(({ id }) => !expectedBindingIds.includes(id))
        )
          throw new DopplerBindingsChangedError();
      }
      await tx
        .insertInto('user_doppler_connections')
        .values({
          user_id: userId,
          project_id: projectId,
          connection_id: connectionId,
          token: encrypted,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['user_id', 'project_id', 'connection_id'])
            .doUpdateSet({ token: encrypted, updated_at: sql`now()` }),
        )
        .execute();
    });
  }

  async delete(userId: string, projectId: string, connectionId: string): Promise<void> {
    await this.db
      .deleteFrom('user_doppler_connections')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .where('connection_id', '=', connectionId)
      .execute();
  }

  /** Every token of the person in the project, when they leave it. */
  async deleteAll(userId: string, projectId: string): Promise<void> {
    await this.db
      .deleteFrom('user_doppler_connections')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .execute();
  }
}
