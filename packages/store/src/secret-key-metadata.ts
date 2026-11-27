import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Master-password key-derivation metadata (non-secret): the scrypt salt and a
 *  verifier (a fixed marker encrypted under the derived key). The raw key is
 *  never stored — only re-derived in memory on unlock. */
export interface SecretKeyMetaRecord {
  salt: string;
  verifier: string;
}

export class SecretKeyMetadataStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /**
   * Read the master-password key-derivation metadata (salt + verifier). Reads
   * NO encrypted column, so it works while the store is sealed — that's the
   * whole point: the unlock flow reads this to derive + verify the key.
   */
  async getSecretKeyMeta(): Promise<SecretKeyMetaRecord | undefined> {
    const row = await this.db
      .selectFrom('secret_key_meta')
      .select(['salt', 'verifier'])
      .where('id', '=', 'global')
      .executeTakeFirst();
    return row ? { salt: row.salt, verifier: row.verifier } : undefined;
  }

  /** Persist the salt + verifier when a master password is set (or changed). */
  async setSecretKeyMeta(meta: SecretKeyMetaRecord): Promise<void> {
    await this.db
      .insertInto('secret_key_meta')
      .values({ id: 'global', salt: meta.salt, verifier: meta.verifier })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          salt: meta.salt,
          verifier: meta.verifier,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /**
   * Atomically persist the meta ONLY if none exists yet. Returns true when this
   * call inserted (won the first-run race), false when a row was already present.
   * Closes the TOCTOU in first-run `/secret/init`: concurrent inits derive under
   * different salts, but only the winner's meta lands and only it should unlock.
   */
  async insertSecretKeyMetaIfAbsent(meta: SecretKeyMetaRecord): Promise<boolean> {
    const res = await this.db
      .insertInto('secret_key_meta')
      .values({ id: 'global', salt: meta.salt, verifier: meta.verifier })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst();
    return (res?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }
}
