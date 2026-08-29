import type { DevicePushTokenRecord, PushReceiptRecord } from '@verity/store';
import type {
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushReceiptId,
  ExpoPushTicket,
} from 'expo-server-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  createPushSender,
  type ExpoPushTransport,
  type PushLogger,
  type PushTokenStore,
} from './push-sender.js';

class FakeStore implements PushTokenStore {
  readonly tokens: DevicePushTokenRecord[];
  readonly receipts: PushReceiptRecord[] = [];

  constructor(...expoTokens: string[]) {
    this.tokens = expoTokens.map((expoToken, index) => ({
      authTokenId: `auth-${index}`,
      expoToken,
      platform: 'ios',
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  listDevicePushTokens(): Promise<DevicePushTokenRecord[]> {
    return Promise.resolve([...this.tokens]);
  }

  deleteDevicePushToken(expoToken: string): Promise<boolean> {
    const index = this.tokens.findIndex((token) => token.expoToken === expoToken);
    if (index < 0) return Promise.resolve(false);
    this.tokens.splice(index, 1);
    for (let cursor = this.receipts.length - 1; cursor >= 0; cursor -= 1) {
      if (this.receipts[cursor]?.expoToken === expoToken) this.receipts.splice(cursor, 1);
    }
    return Promise.resolve(true);
  }

  enqueuePushReceipt(record: {
    receiptId: string;
    expoToken: string;
    availableAt: number;
  }): Promise<boolean> {
    if (!this.tokens.some((token) => token.expoToken === record.expoToken)) {
      return Promise.resolve(false);
    }
    this.receipts.push({ ...record, attempts: 0, createdAt: 0 });
    return Promise.resolve(true);
  }

  listDuePushReceipts(now: number): Promise<PushReceiptRecord[]> {
    return Promise.resolve(this.receipts.filter((receipt) => receipt.availableAt <= now));
  }

  reschedulePushReceipt(
    receiptId: string,
    availableAt: number,
    attempts: number,
  ): Promise<boolean> {
    const receipt = this.receipts.find((candidate) => candidate.receiptId === receiptId);
    if (receipt === undefined) return Promise.resolve(false);
    receipt.availableAt = availableAt;
    receipt.attempts = attempts;
    return Promise.resolve(true);
  }

  deletePushReceipt(receiptId: string): Promise<boolean> {
    const index = this.receipts.findIndex((receipt) => receipt.receiptId === receiptId);
    if (index < 0) return Promise.resolve(false);
    this.receipts.splice(index, 1);
    return Promise.resolve(true);
  }
}

class FakeTransport implements ExpoPushTransport {
  readonly sent: ExpoPushMessage[][] = [];
  tickets: ExpoPushTicket[] = [];
  receipts: Record<string, ExpoPushReceipt> = {};
  failSend = false;
  failReceipts = false;

  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    this.sent.push(messages);
    if (this.failSend) return Promise.reject(new Error('sensitive transport response'));
    return Promise.resolve(this.tickets.splice(0, messages.length));
  }

  getPushNotificationReceiptsAsync(): Promise<Record<string, ExpoPushReceipt>> {
    if (this.failReceipts) return Promise.reject(new Error('sensitive receipt response'));
    return Promise.resolve(this.receipts);
  }

  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    const chunks: ExpoPushMessage[][] = [];
    for (let index = 0; index < messages.length; index += 2) {
      chunks.push(messages.slice(index, index + 2));
    }
    return chunks;
  }

  chunkPushNotificationReceiptIds(receiptIds: ExpoPushReceiptId[]): ExpoPushReceiptId[][] {
    return receiptIds.length === 0 ? [] : [receiptIds];
  }
}

function fakeLogger(): Omit<PushLogger, 'info' | 'warn'> & {
  info: ReturnType<typeof vi.fn<PushLogger['info']>>;
  warn: ReturnType<typeof vi.fn<PushLogger['warn']>>;
} {
  return {
    info: vi.fn<PushLogger['info']>(),
    warn: vi.fn<PushLogger['warn']>(),
  };
}

describe('PushSender', () => {
  it('fans out in chunks, persists accepted tickets, and prunes immediate dead tokens', async () => {
    const store = new FakeStore('ExpoPushToken[one]', 'ExpoPushToken[two]', 'ExpoPushToken[dead]');
    const transport = new FakeTransport();
    transport.tickets = [
      { status: 'ok', id: 'receipt-1' },
      { status: 'error', message: 'too fast', details: { error: 'MessageRateExceeded' } },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ];
    const logger = fakeLogger();
    const sender = createPushSender({ store, transport, logger, now: () => 1_000 });

    await expect(
      sender.send({
        title: 'Verity needs you',
        body: 'Open Verity to continue.',
        categoryId: 'PERMISSION_PROMPT',
        data: { sessionId: 'session-1', kind: 'permission' },
      }),
    ).resolves.toEqual({
      targets: 3,
      ticketsAccepted: 1,
      ticketErrors: 2,
      receiptsQueued: 1,
      pruned: 1,
      transportErrors: 0,
    });

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent.flat()).toMatchObject([
      {
        to: 'ExpoPushToken[one]',
        title: 'Verity needs you',
        body: 'Open Verity to continue.',
        categoryId: 'PERMISSION_PROMPT',
        data: { sessionId: 'session-1', kind: 'permission', deviceId: 'auth-0' },
      },
      { to: 'ExpoPushToken[two]', data: { deviceId: 'auth-1' } },
      { to: 'ExpoPushToken[dead]', data: { deviceId: 'auth-2' } },
    ]);
    expect(store.receipts).toMatchObject([
      { receiptId: 'receipt-1', expoToken: 'ExpoPushToken[one]', availableAt: 901_000 },
    ]);
    expect(store.tokens.map((token) => token.expoToken)).toEqual([
      'ExpoPushToken[one]',
      'ExpoPushToken[two]',
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('ExpoPushToken');
  });

  it('settles delivery receipts, prunes dead tokens, and retries missing receipts', async () => {
    let now = 10_000;
    const store = new FakeStore(
      'ExpoPushToken[ok]',
      'ExpoPushToken[dead]',
      'ExpoPushToken[missing]',
      'ExpoPushToken[credentials]',
    );
    for (const [index, token] of store.tokens.entries()) {
      store.receipts.push({
        receiptId: `receipt-${index}`,
        expoToken: token.expoToken,
        availableAt: now,
        attempts: 0,
        createdAt: 0,
      });
    }
    const transport = new FakeTransport();
    transport.receipts = {
      'receipt-0': { status: 'ok' },
      'receipt-1': {
        status: 'error',
        message: 'gone',
        details: { error: 'DeviceNotRegistered' },
      },
      'receipt-3': {
        status: 'error',
        message: 'bad key',
        details: { error: 'InvalidCredentials' },
      },
    };
    const sender = createPushSender({
      store,
      transport,
      now: () => now,
      receiptRetryMs: 500,
    });

    await expect(sender.processDueReceipts()).resolves.toEqual({
      due: 4,
      delivered: 1,
      receiptErrors: 2,
      missing: 1,
      retried: 1,
      expired: 0,
      pruned: 1,
      transportErrors: 0,
    });
    expect(store.tokens.map((token) => token.expoToken)).not.toContain('ExpoPushToken[dead]');
    expect(store.receipts).toMatchObject([
      {
        receiptId: 'receipt-2',
        expoToken: 'ExpoPushToken[missing]',
        availableAt: 10_500,
        attempts: 1,
      },
    ]);

    now = 10_500;
    await sender.processDueReceipts();
    expect(store.receipts[0]).toMatchObject({ receiptId: 'receipt-2', attempts: 2 });
  });

  it('contains transport failures, retries receipts, and expires bounded work', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    const logger = fakeLogger();
    transport.failSend = true;
    const sender = createPushSender({
      store,
      transport,
      logger,
      now: () => 1_000,
      receiptRetryMs: 100,
      maxReceiptAttempts: 2,
    });
    await expect(
      sender.send({ title: 'Verity', body: 'Open Verity.', categoryId: 'DONE', data: {} }),
    ).resolves.toMatchObject({ transportErrors: 1 });

    store.receipts.push({
      receiptId: 'receipt-1',
      expoToken: 'ExpoPushToken[one]',
      availableAt: 0,
      attempts: 0,
      createdAt: 0,
    });
    transport.failReceipts = true;
    await expect(sender.processDueReceipts()).resolves.toMatchObject({
      due: 1,
      retried: 1,
      transportErrors: 1,
    });
    store.receipts[0]!.availableAt = 0;
    await expect(sender.processDueReceipts()).resolves.toMatchObject({
      due: 1,
      expired: 1,
      transportErrors: 1,
    });
    expect(store.receipts).toEqual([]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sensitive');
  });

  it('counts an omitted ticket as an error instead of losing the target', async () => {
    const store = new FakeStore('ExpoPushToken[one]', 'ExpoPushToken[two]');
    const transport = new FakeTransport();
    transport.tickets = [{ status: 'ok', id: 'receipt-1' }];
    const sender = createPushSender({ store, transport, now: () => 1_000 });

    await expect(
      sender.send({ title: 'Verity', body: 'Open Verity.', categoryId: 'DONE', data: {} }),
    ).resolves.toMatchObject({
      targets: 2,
      ticketsAccepted: 1,
      ticketErrors: 1,
      receiptsQueued: 1,
    });
  });

  it('logs and contains an unexpected background receipt-cycle failure', async () => {
    const store = new FakeStore();
    vi.spyOn(store, 'listDuePushReceipts').mockRejectedValueOnce(
      new Error('sensitive database response'),
    );
    const logger = fakeLogger();
    const sender = createPushSender({
      store,
      transport: new FakeTransport(),
      logger,
      receiptPollMs: 60_000,
    });

    sender.start();
    await sender.close();

    expect(logger.warn).toHaveBeenCalledWith(
      { component: 'push' },
      'verity: Expo push receipt cycle failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sensitive');
  });
});
