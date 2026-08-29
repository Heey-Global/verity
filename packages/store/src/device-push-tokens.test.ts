import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('device push tokens', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  async function pair(id: string): Promise<void> {
    await ctx.store.insertAuthToken({ id, tokenHash: `hash-${id}`, label: id });
  }

  it('registers and rotates one current token per paired device', async () => {
    await pair('phone');

    await ctx.store.upsertDevicePushToken({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[first]',
      platform: 'ios',
    });
    expect(await ctx.store.getDevicePushToken('phone')).toMatchObject({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[first]',
      platform: 'ios',
    });

    await ctx.store.upsertDevicePushToken({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[rotated]',
      platform: 'ios',
    });
    expect(await ctx.store.listDevicePushTokens()).toHaveLength(1);
    expect(await ctx.store.getDevicePushToken('phone')).toMatchObject({
      expoToken: 'ExpoPushToken[rotated]',
    });
  });

  it('moves an Expo token to its latest paired device', async () => {
    await pair('old-phone');
    await pair('new-phone');
    await ctx.store.upsertDevicePushToken({
      authTokenId: 'old-phone',
      expoToken: 'ExpoPushToken[same-installation]',
      platform: 'ios',
    });
    await ctx.store.upsertDevicePushToken({
      authTokenId: 'new-phone',
      expoToken: 'ExpoPushToken[same-installation]',
      platform: 'ios',
    });

    expect(await ctx.store.getDevicePushToken('old-phone')).toBeUndefined();
    expect(await ctx.store.getDevicePushToken('new-phone')).toMatchObject({
      expoToken: 'ExpoPushToken[same-installation]',
    });
  });

  it('resolves concurrent claims of one Expo token without failing', async () => {
    await pair('phone-a');
    await pair('phone-b');
    await expect(
      Promise.all(
        ['phone-a', 'phone-b'].map((authTokenId) =>
          ctx.store.upsertDevicePushToken({
            authTokenId,
            expoToken: 'ExpoPushToken[concurrent]',
            platform: 'ios',
          }),
        ),
      ),
    ).resolves.toHaveLength(2);

    const rows = await ctx.store.listDevicePushTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expoToken).toBe('ExpoPushToken[concurrent]');
  });

  it('cascades the push binding when a device pairing is revoked', async () => {
    await pair('phone');
    await ctx.store.upsertDevicePushToken({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[cascade]',
      platform: 'ios',
    });

    expect(await ctx.store.deleteAuthToken('phone')).toBe(true);
    expect(await ctx.store.listDevicePushTokens()).toEqual([]);
  });

  it('persists, reschedules, and settles due Expo receipts', async () => {
    await pair('phone');
    await ctx.store.upsertDevicePushToken({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[receipt]',
      platform: 'ios',
    });
    expect(
      await ctx.store.enqueuePushReceipt({
        receiptId: 'receipt-1',
        expoToken: 'ExpoPushToken[receipt]',
        availableAt: 2_000,
      }),
    ).toBe(true);
    expect(await ctx.store.listDuePushReceipts(1_999)).toEqual([]);
    expect(await ctx.store.listDuePushReceipts(2_000)).toMatchObject([
      { receiptId: 'receipt-1', expoToken: 'ExpoPushToken[receipt]', attempts: 0 },
    ]);

    expect(await ctx.store.reschedulePushReceipt('receipt-1', 3_000, 1)).toBe(true);
    expect(await ctx.store.listDuePushReceipts(2_999)).toEqual([]);
    expect(await ctx.store.listDuePushReceipts(3_000)).toMatchObject([
      { receiptId: 'receipt-1', attempts: 1 },
    ]);
    expect(await ctx.store.deletePushReceipt('receipt-1')).toBe(true);
    expect(await ctx.store.listDuePushReceipts(Date.UTC(2100, 0, 1))).toEqual([]);
  });

  it('does not queue receipts for stale tokens and cascades queued work on pruning', async () => {
    expect(
      await ctx.store.enqueuePushReceipt({
        receiptId: 'stale',
        expoToken: 'ExpoPushToken[missing]',
        availableAt: 0,
      }),
    ).toBe(false);

    await pair('phone');
    await ctx.store.upsertDevicePushToken({
      authTokenId: 'phone',
      expoToken: 'ExpoPushToken[dead]',
      platform: 'ios',
    });
    await ctx.store.enqueuePushReceipt({
      receiptId: 'pending',
      expoToken: 'ExpoPushToken[dead]',
      availableAt: 0,
    });
    expect(await ctx.store.deleteDevicePushToken('ExpoPushToken[dead]')).toBe(true);
    expect(await ctx.store.listDuePushReceipts(Date.UTC(2100, 0, 1))).toEqual([]);
  });
});
