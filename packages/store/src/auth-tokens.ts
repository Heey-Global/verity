import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** A minted per-device API token as stored: an opaque public `id` (for listing/
 *  revoking), the SHA-256 `tokenHash` the gate matches against, and an optional
 *  human `label`. The raw token itself is never persisted. `lastSeenAt` is null
 *  until the device makes its first authenticated request after the server
 *  learned to stamp it. */
export interface AuthTokenRecord {
  expiresAt: number | null;
  id: string;
  userId: string;
  tokenHash: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export class AuthTokenStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly notifyBackupRevocations: () => Promise<void>,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  // ── Per-device API auth tokens (C1 auth gate) ─────────────────────────────
  // Stores only the SHA-256 hash of each token, no cipher envelope, so the auth
  // gate can validate a device while the store is still SEALED (same rationale
  // as secret_key_meta). The raw token is returned to the device exactly once.

  /** Persist a newly minted token (only its hash). */
  async insertAuthToken(record: {
    expiresAt?: number | null;
    id: string;
    tokenHash: string;
    label?: string | null;
    /** The person the device belongs to; absent → the column default (the administrator). */
    userId?: string;
  }): Promise<string> {
    const row = await this.db
      .insertInto('auth_tokens')
      .values({
        id: record.id,
        token_hash: record.tokenHash,
        ...(record.userId === undefined ? {} : { user_id: record.userId }),
        label: record.label ?? null,
        expires_at: record.expiresAt == null ? null : new Date(record.expiresAt).toISOString(),
      })
      .returning('user_id')
      .executeTakeFirstOrThrow();
    return row.user_id;
  }

  /** Every token hash currently valid — loaded once to seed the gate's in-memory
   *  set (avoids a DB round-trip on the per-request hot path). */
  async listAuthTokenHashes(): Promise<string[]> {
    const rows = await this.db.selectFrom('auth_tokens').select('token_hash').execute();
    return rows.map((r) => r.token_hash);
  }

  /** Tokens as records (id + label + createdAt + lastSeenAt), newest first — the
   *  device-management view. Never exposes the token or its hash's usefulness. */
  async listAuthTokens(): Promise<AuthTokenRecord[]> {
    const rows = await this.db
      .selectFrom('auth_tokens')
      .select(['id', 'user_id', 'token_hash', 'label', 'created_at', 'last_seen_at', 'expires_at'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      tokenHash: r.token_hash,
      expiresAt: r.expires_at === null ? null : new Date(r.expires_at).getTime(),
      label: r.label,
      createdAt: new Date(r.created_at).getTime(),
      lastSeenAt: r.last_seen_at === null ? null : new Date(r.last_seen_at).getTime(),
    }));
  }

  /** Rename a paired device. Returns false when the id matches no row — a device
   *  revoked from another phone while this one had the rename field open. */
  async renameAuthToken(id: string, label: string): Promise<boolean> {
    const res = await this.db
      .updateTable('auth_tokens')
      .set({ label })
      .where('id', '=', id)
      .executeTakeFirst();
    return (res?.numUpdatedRows ?? 0n) > 0n;
  }

  /** Stamp a device's last authenticated request. Called off the request's
   *  critical path and throttled by the registry, never per request. */
  async touchAuthToken(id: string, expiresAt?: number): Promise<void> {
    await this.db
      .updateTable('auth_tokens')
      .set({
        last_seen_at: new Date().toISOString(),
        ...(expiresAt === undefined ? {} : { expires_at: new Date(expiresAt).toISOString() }),
      })
      .where('id', '=', id)
      .execute();
  }

  /** Revoke a single device token by its public id. Returns true if a row went. */
  async deleteAuthToken(id: string): Promise<boolean> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const policy = await trx
        .selectFrom('backup_policy')
        .select('journal_enabled')
        .where('id', '=', 1)
        .forShare()
        .executeTakeFirst();
      await sql`lock table auth_tokens in row exclusive mode`.execute(trx);
      const record = await trx
        .selectFrom('auth_tokens')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!record) return false;
      if (policy?.journal_enabled)
        await trx
          .insertInto('backup_revocation_outbox')
          .values({ id: randomUUID(), device_id: id })
          .execute();
      const res = await trx.deleteFrom('auth_tokens').where('id', '=', id).executeTakeFirst();
      return (res?.numDeletedRows ?? 0n) > 0n;
    });
    if (deleted) await this.notifyBackupRevocations();
    return deleted;
  }

  /** Revoke every device token (e.g. on GitHub disconnect / master-password
   *  change) — forces all devices to re-authenticate. */
  async deleteAllAuthTokens(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const policy = await trx
        .selectFrom('backup_policy')
        .select('journal_enabled')
        .where('id', '=', 1)
        .forShare()
        .executeTakeFirst();
      await sql`lock table auth_tokens in share row exclusive mode`.execute(trx);
      if (policy?.journal_enabled) {
        const devices = await trx.selectFrom('auth_tokens').select('id').forUpdate().execute();
        for (const device of devices)
          await trx
            .insertInto('backup_revocation_outbox')
            .values({ id: randomUUID(), device_id: device.id })
            .execute();
      }
      await trx.deleteFrom('auth_tokens').execute();
    });
    await this.notifyBackupRevocations();
  }

  /** Runtime backup policy is disabled explicitly by restore before any token cleanup. */
  async setBackupJournaling(enabled: boolean): Promise<void> {
    await this.db
      .updateTable('backup_policy')
      .set({ journal_enabled: enabled })
      .where('id', '=', 1)
      .execute();
  }

  async listBackupRevocations(): Promise<{ id: string; deviceId: string; revokedAt: string }[]> {
    const rows = await this.db
      .selectFrom('backup_revocation_outbox')
      .selectAll()
      .orderBy('created_at')
      .limit(1000)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      revokedAt: row.created_at.toISOString(),
    }));
  }

  async acknowledgeBackupRevocation(id: string): Promise<void> {
    await this.db.deleteFrom('backup_revocation_outbox').where('id', '=', id).execute();
  }
}
