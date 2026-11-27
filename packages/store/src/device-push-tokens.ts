import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface DevicePushTokenRecord {
  authTokenId: string;
  expoToken: string;
  platform: 'ios';
  createdAt: number;
  updatedAt: number;
}

export interface PushReceiptRecord {
  receiptId: string;
  expoToken: string;
  availableAt: number;
  attempts: number;
  createdAt: number;
}

export class DevicePushTokenStore {
  /** PGlite does not enforce table-lock conflicts across its concurrent async
   * transactions, so serialize this rare dual-unique mutation in-process too.
   * The SQL table lock below remains the cross-process Postgres guard. */
  private pushTokenMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Register or rotate the current Expo token for a paired device. An Expo
   * token can belong to only one pairing; moving it prunes the old binding. */
  async upsertDevicePushToken(record: {
    authTokenId: string;
    expoToken: string;
    platform: 'ios';
  }): Promise<void> {
    const mutation = this.pushTokenMutationTail.then(() =>
      this.db.transaction().execute(async (trx) => {
        // Registration is rare and this tiny table has two uniqueness axes
        // (device + Expo token). Serialize cross-process writers so two pairings
        // cannot both pass the DELETE then collide at INSERT. Reads/sends remain
        // unaffected by this lock mode.
        await sql`lock table device_push_tokens in share row exclusive mode`.execute(trx);
        await trx
          .deleteFrom('device_push_tokens')
          .where('expo_token', '=', record.expoToken)
          .where('auth_token_id', '!=', record.authTokenId)
          .execute();
        await trx
          .insertInto('device_push_tokens')
          .values({
            auth_token_id: record.authTokenId,
            expo_token: record.expoToken,
            platform: record.platform,
          })
          .onConflict((oc) =>
            oc.column('auth_token_id').doUpdateSet({
              expo_token: record.expoToken,
              platform: record.platform,
              updated_at: sql`now()`,
            }),
          )
          .execute();
      }),
    );
    // A failed write must not poison the queue for later registrations.
    this.pushTokenMutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  async getDevicePushToken(authTokenId: string): Promise<DevicePushTokenRecord | undefined> {
    const row = await this.db
      .selectFrom('device_push_tokens')
      .selectAll()
      .where('auth_token_id', '=', authTokenId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          authTokenId: row.auth_token_id,
          expoToken: row.expo_token,
          platform: row.platform,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at).getTime(),
        };
  }

  /** The push tokens of the given users' devices, with the user each belongs to. */
  async listDevicePushTokensForUsers(
    userIds: readonly string[],
  ): Promise<(DevicePushTokenRecord & { userId: string })[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('device_push_tokens as t')
      .innerJoin('auth_tokens as a', 'a.id', 't.auth_token_id')
      .innerJoin('users as u', 'u.id', 'a.user_id')
      .select([
        't.auth_token_id',
        't.expo_token',
        't.platform',
        't.created_at',
        't.updated_at',
        'a.user_id',
      ])
      .where('a.user_id', 'in', [...userIds])
      .where('u.status', '=', 'active')
      .orderBy('t.created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      authTokenId: row.auth_token_id,
      expoToken: row.expo_token,
      platform: row.platform,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
      userId: row.user_id,
    }));
  }

  async listDevicePushTokens(): Promise<DevicePushTokenRecord[]> {
    const rows = await this.db
      .selectFrom('device_push_tokens')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      authTokenId: row.auth_token_id,
      expoToken: row.expo_token,
      platform: row.platform,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }));
  }

  /** Remove a dead Expo token. Its pending receipt work cascades in the DB. */
  async deleteDevicePushToken(expoToken: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('device_push_tokens')
      .where('expo_token', '=', expoToken)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Persist a successful Expo ticket only while its token is still current.
   * The shared row lock closes a rotation race: a concurrent token delete waits
   * for this insert, then cascades the newly-created receipt row. */
  async enqueuePushReceipt(record: {
    receiptId: string;
    expoToken: string;
    availableAt: number;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('device_push_tokens')
        .select('expo_token')
        .where('expo_token', '=', record.expoToken)
        .forShare()
        .executeTakeFirst();
      if (token === undefined) return false;
      const result = await trx
        .insertInto('push_receipts')
        .values({
          receipt_id: record.receiptId,
          expo_token: record.expoToken,
          available_at: new Date(record.availableAt).toISOString(),
        })
        .onConflict((conflict) => conflict.column('receipt_id').doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    });
  }

  async listDuePushReceipts(now: number, limit = 1_000): Promise<PushReceiptRecord[]> {
    const rows = await this.db
      .selectFrom('push_receipts')
      .selectAll()
      .where('available_at', '<=', new Date(now))
      .orderBy('available_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      receiptId: row.receipt_id,
      expoToken: row.expo_token,
      availableAt: new Date(row.available_at).getTime(),
      attempts: row.attempts,
      createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async reschedulePushReceipt(
    receiptId: string,
    availableAt: number,
    attempts: number,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('push_receipts')
      .set({ available_at: new Date(availableAt).toISOString(), attempts })
      .where('receipt_id', '=', receiptId)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async deletePushReceipt(receiptId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('push_receipts')
      .where('receipt_id', '=', receiptId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
