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
  const notification = { title: 'Verity', body: 'Open Verity.', categoryId: 'DONE', data: {} };

  it('backs off a failed device across producers and resets after acceptance', async () => {
    let now = 0;
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    transport.tickets = [
      { status: 'error', message: 'private', details: { error: 'MessageRateExceeded' } },
    ];
    const logger = fakeLogger();
    const sender = createPushSender({ store, transport, logger, now: () => now });
    await sender.send(notification);
    for (let i = 0; i < 100; i++) await sender.send({ ...notification, data: { finding: i } });
    expect(transport.sent).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    now = 60_000;
    transport.tickets = [
      { status: 'error', message: 'private', details: { error: 'MessageRateExceeded' } },
    ];
    await sender.send(notification);
    now = 179_999;
    await sender.send(notification);
    expect(transport.sent).toHaveLength(2);
    now = 180_000;
    transport.tickets = [{ status: 'ok', id: 'recovered' }];
    await expect(sender.send(notification)).resolves.toMatchObject({ ticketsAccepted: 1 });
    transport.tickets = [{ status: 'ok', id: 'next' }];
    await expect(sender.send({ ...notification, data: { next: true } })).resolves.toMatchObject({
      ticketsAccepted: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { component: 'push', errorCode: 'MessageRateExceeded', attempts: 2, retryAfterMs: 120_000 },
      'verity: Expo push target deferred',
    );
  });

  it('deduplicates concurrent identical sends and gates different producers after failure', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    let finish!: (tickets: ExpoPushTicket[]) => void;
    const send = vi.spyOn(transport, 'sendPushNotificationsAsync').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sender = createPushSender({ store, transport, now: () => 0 });
    const first = sender.send(notification, store.tokens);
    const duplicate = sender.send(
      notification,
      store.tokens.map((token) => ({ ...token, updatedAt: 1, userId: 'user' })),
    );
    const different = sender.send({ ...notification, data: { finding: 2 } }, store.tokens);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish([{ status: 'error', message: 'private', details: { error: 'InvalidCredentials' } }]);
    await expect(first).resolves.toMatchObject({ ticketErrors: 1 });
    await expect(duplicate).resolves.toMatchObject({ ticketErrors: 1 });
    await expect(different).resolves.toMatchObject({ ticketsAccepted: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.tokens).toHaveLength(1);
  });

  it('pauses credential failures without pruning and recovers after the cooldown', async () => {
    let now = 0;
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    transport.tickets = [
      { status: 'error', message: 'credential secret', details: { error: 'InvalidCredentials' } },
    ];
    const logger = fakeLogger();
    const sender = createPushSender({ store, transport, logger, now: () => now });
    await sender.send(notification);
    now = 899_999;
    await sender.send(notification);
    expect(transport.sent).toHaveLength(1);
    expect(store.tokens).toHaveLength(1);
    now = 900_000;
    transport.tickets = [{ status: 'ok', id: 'fixed' }];
    await expect(sender.send(notification)).resolves.toMatchObject({ ticketsAccepted: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/credential secret|ExpoPushToken/);
  });

  it('contains transport and missing-ticket storms while allowing healthy targets', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    transport.failSend = true;
    const sender = createPushSender({ store, transport, now: () => 0 });
    await sender.send(notification);
    transport.failSend = false;
    await sender.send(notification);
    expect(transport.sent).toHaveLength(1);
    const healthy = new FakeStore('ExpoPushToken[healthy]');
    transport.tickets = [{ status: 'ok', id: 'healthy' }];
    await expect(sender.send(notification, healthy.tokens)).resolves.toMatchObject({
      ticketsAccepted: 1,
    });
    const missing = new FakeStore('ExpoPushToken[missing]');
    await sender.send(notification, missing.tokens);
    await sender.send(notification, missing.tokens);
    expect(transport.sent).toHaveLength(3);
  });

  it('suppresses stale explicit targets after pruning and deduplicates target lists', async () => {
    const store = new FakeStore('ExpoPushToken[dead]');
    const stale = [...store.tokens, ...store.tokens];
    const transport = new FakeTransport();
    transport.tickets = [
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ];
    const sender = createPushSender({ store, transport, now: () => 0 });
    await expect(sender.send(notification, stale)).resolves.toMatchObject({
      targets: 1,
      pruned: 1,
    });
    await sender.send(notification, stale);
    expect(transport.sent.flat()).toHaveLength(1);
    expect(store.tokens).toHaveLength(0);
  });

  it('caps exponential backoff at an hour and resets it after success', async () => {
    let now = 0;
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    const logger = fakeLogger();
    const sender = createPushSender({ store, transport, logger, now: () => now });
    for (let attempt = 0; attempt < 10; attempt++) {
      transport.tickets = [
        { status: 'error', message: 'private', details: { error: 'MessageRateExceeded' } },
      ];
      await sender.send(notification);
      const delay = Math.min(60_000 * 2 ** attempt, 3_600_000);
      now += delay - 1;
      await sender.send(notification);
      expect(transport.sent).toHaveLength(attempt + 1);
      now++;
    }
    expect(logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({ retryAfterMs: 3_600_000 });
    transport.tickets = [{ status: 'ok', id: 'recovered' }];
    await sender.send(notification);
    transport.tickets = [
      { status: 'error', message: 'private', details: { error: 'MessageRateExceeded' } },
    ];
    await sender.send(notification);
    expect(logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({ attempts: 1, retryAfterMs: 60_000 });
  });

  it('backs off receipt credential failures and logs only allowlisted codes', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    store.receipts.push({
      receiptId: 'r',
      expoToken: store.tokens[0]!.expoToken,
      availableAt: 0,
      attempts: 0,
      createdAt: 0,
    });
    const transport = new FakeTransport();
    transport.receipts = {
      r: { status: 'error', message: 'private', details: { error: 'InvalidCredentials' } },
    };
    const logger = fakeLogger();
    const sender = createPushSender({ store, transport, logger, now: () => 0 });
    await sender.processDueReceipts();
    await sender.send(notification);
    expect(transport.sent).toHaveLength(0);
    expect(store.tokens).toHaveLength(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      errorCode: 'InvalidCredentials',
      retryAfterMs: 900_000,
    });
    const other = new FakeStore('ExpoPushToken[other]');
    const ticket: ExpoPushTicket = { status: 'error', message: 'private', details: {} };
    Object.assign(ticket.details!, { error: 'ExpoPushToken[secret]' });
    transport.tickets = [ticket];
    await sender.send(notification, other.tokens);
    expect(logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({ errorCode: 'UnknownError' });
    expect(JSON.stringify([...logger.warn.mock.calls, ...logger.info.mock.calls])).not.toMatch(
      /private|ExpoPushToken|Open Verity/,
    );
  });

  it('drains queued sends before closing', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    let finish!: (tickets: ExpoPushTicket[]) => void;
    const send = vi.spyOn(transport, 'sendPushNotificationsAsync').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    transport.tickets = [{ status: 'ok', id: 'second' }];
    const sender = createPushSender({ store, transport });
    const first = sender.send(notification, store.tokens);
    const second = sender.send({ ...notification, data: { next: true } }, store.tokens);
    let closed = false;
    const closing = sender.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(closed).toBe(false);
    finish([{ status: 'ok', id: 'first' }]);
    await Promise.all([first, second, closing]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(closed).toBe(true);
  });

  it('drains broadcasts still looking up tokens before closing', async () => {
    const store = new FakeStore('ExpoPushToken[one]');
    let finishLookup!: (tokens: DevicePushTokenRecord[]) => void;
    vi.spyOn(store, 'listDevicePushTokens').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    const transport = new FakeTransport();
    transport.tickets = [{ status: 'ok', id: 'broadcast' }];
    const sender = createPushSender({ store, transport });
    const broadcast = sender.send(notification);
    let closed = false;
    const closing = sender.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf('function'));
    expect(closed).toBe(false);
    finishLookup(store.tokens);
    await Promise.all([broadcast, closing]);
    expect(transport.sent).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
    expect(closed).toBe(true);
  });

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
        sound: 'default',
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
        sound: 'default',
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

  it('sends an informational push without a sound', async () => {
    // A `sound` key on every message would buzz the operator for each finished
    // turn; only the pushes that block on them should ask for one.
    const store = new FakeStore('ExpoPushToken[one]');
    const transport = new FakeTransport();
    transport.tickets = [{ status: 'ok', id: 'receipt-1' }];
    const sender = createPushSender({ store, transport, now: () => 1_000 });

    await sender.send({
      title: 'Turn complete',
      body: 'A session finished its turn.',
      categoryId: 'SESSION_STATUS',
      data: { sessionId: 'session-1', kind: 'completed' },
    });

    expect(transport.sent.flat()[0]).not.toHaveProperty('sound');
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
