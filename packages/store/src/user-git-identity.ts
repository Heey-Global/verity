import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export interface UserGitIdentity {
  userId: string;
  authorName: string | null;
  authorEmail: string | null;
  /** Decrypted only for the signing route; never returned by an API. */
  sshPrivateKey: string | null;
  sshPublicKey: string | null;
}

/** A person's git identity and signing key, keyed by the authenticated user. */
export class UserGitIdentityStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async get(userId: string): Promise<UserGitIdentity | undefined> {
    const row = await this.db
      .selectFrom('user_git_identities')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      userId: row.user_id,
      authorName: row.author_name,
      authorEmail: row.author_email,
      sshPrivateKey: row.ssh_private_key === null ? null : this.cipher.decrypt(row.ssh_private_key),
      sshPublicKey: row.ssh_public_key,
    };
  }

  /** The author name and email alone, without decrypting the signing key. */
  async author(
    userId: string,
  ): Promise<{ authorName: string | null; authorEmail: string | null } | undefined> {
    const row = await this.db
      .selectFrom('user_git_identities')
      .select(['author_name', 'author_email'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? { authorName: row.author_name, authorEmail: row.author_email } : undefined;
  }

  /** Set a person's identity; only the given fields change. */
  async set(userId: string, input: Partial<Omit<UserGitIdentity, 'userId'>>): Promise<void> {
    const values = {
      ...(input.authorName !== undefined ? { author_name: input.authorName } : {}),
      ...(input.authorEmail !== undefined ? { author_email: input.authorEmail } : {}),
      ...(input.sshPrivateKey !== undefined
        ? {
            ssh_private_key:
              input.sshPrivateKey === null ? null : this.cipher.encrypt(input.sshPrivateKey),
          }
        : {}),
      ...(input.sshPublicKey !== undefined ? { ssh_public_key: input.sshPublicKey } : {}),
    };
    await this.db
      .insertInto('user_git_identities')
      .values({ user_id: userId, ...values })
      .onConflict((conflict) =>
        conflict.column('user_id').doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }
}
