import type { DevicePushTokenRecord, PushReceiptRecord } from '@verity/store';
import Expo, {
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushReceiptId,
  type ExpoPushTicket,
} from 'expo-server-sdk';

const DEFAULT_RECEIPT_DELAY_MS = 15 * 60_000;
const DEFAULT_RECEIPT_RETRY_MS = 15 * 60_000;
const DEFAULT_RECEIPT_POLL_MS = 60_000;
const DEFAULT_MAX_RECEIPT_ATTEMPTS = 8;

export interface PushNotification {
  title: string;
  body: string;
  categoryId: string;
  data: Record<string, unknown>;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
}

export interface PushSendResult {
  targets: number;
  ticketsAccepted: number;
  ticketErrors: number;
  receiptsQueued: number;
  pruned: number;
  transportErrors: number;
}

export interface PushReceiptResult {
  due: number;
  delivered: number;
  receiptErrors: number;
  missing: number;
  retried: number;
  expired: number;
  pruned: number;
  transportErrors: number;
}

export interface PushTokenStore {
  listDevicePushTokens(): Promise<DevicePushTokenRecord[]>;
  deleteDevicePushToken(expoToken: string): Promise<boolean>;
  enqueuePushReceipt(record: {
    receiptId: string;
    expoToken: string;
    availableAt: number;
  }): Promise<boolean>;
  listDuePushReceipts(now: number, limit?: number): Promise<PushReceiptRecord[]>;
  reschedulePushReceipt(receiptId: string, availableAt: number, attempts: number): Promise<boolean>;
  deletePushReceipt(receiptId: string): Promise<boolean>;
}

export interface ExpoPushTransport {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  getPushNotificationReceiptsAsync(
    receiptIds: ExpoPushReceiptId[],
  ): Promise<Record<string, ExpoPushReceipt>>;
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  chunkPushNotificationReceiptIds(receiptIds: ExpoPushReceiptId[]): ExpoPushReceiptId[][];
}

export interface PushLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface PushSender {
  send(notification: PushNotification): Promise<PushSendResult>;
  processDueReceipts(): Promise<PushReceiptResult>;
  start(): void;
  close(): Promise<void>;
}

export interface PushSenderOptions {
  store: PushTokenStore;
  transport: ExpoPushTransport;
  logger?: PushLogger | undefined;
  now?: (() => number) | undefined;
  receiptDelayMs?: number | undefined;
  receiptRetryMs?: number | undefined;
  receiptPollMs?: number | undefined;
  maxReceiptAttempts?: number | undefined;
}

export function createExpoPushTransport(accessToken?: string): ExpoPushTransport {
  return new Expo(accessToken ? { accessToken } : {});
}

class DefaultPushSender implements PushSender {
  private readonly now: () => number;
  private readonly receiptDelayMs: number;
  private readonly receiptRetryMs: number;
  private readonly receiptPollMs: number;
  private readonly maxReceiptAttempts: number;
  private timer: NodeJS.Timeout | undefined;
  private receiptCycle: Promise<PushReceiptResult> | undefined;

  constructor(private readonly options: PushSenderOptions) {
    this.now = options.now ?? Date.now;
    this.receiptDelayMs = options.receiptDelayMs ?? DEFAULT_RECEIPT_DELAY_MS;
    this.receiptRetryMs = options.receiptRetryMs ?? DEFAULT_RECEIPT_RETRY_MS;
    this.receiptPollMs = options.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS;
    this.maxReceiptAttempts = options.maxReceiptAttempts ?? DEFAULT_MAX_RECEIPT_ATTEMPTS;
  }

  async send(notification: PushNotification): Promise<PushSendResult> {
    const tokens = await this.options.store.listDevicePushTokens();
    const result: PushSendResult = {
      targets: tokens.length,
      ticketsAccepted: 0,
      ticketErrors: 0,
      receiptsQueued: 0,
      pruned: 0,
      transportErrors: 0,
    };
    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token.expoToken,
      title: notification.title,
      body: notification.body,
      categoryId: notification.categoryId,
      // Bind every action payload to the paired device/server identity that
      // received it. The app rejects a destructive action after switching or
      // re-pairing to another Verity server.
      data: { ...notification.data, deviceId: token.authTokenId },
      priority: notification.priority ?? 'high',
      ...(notification.ttl === undefined ? {} : { ttl: notification.ttl }),
    }));

    for (const chunk of this.options.transport.chunkPushNotifications(messages)) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.options.transport.sendPushNotificationsAsync(chunk);
      } catch {
        result.transportErrors += chunk.length;
        this.options.logger?.warn(
          { component: 'push', messages: chunk.length },
          'verity: Expo push-ticket request failed',
        );
        continue;
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const ticket = tickets[index];
        const message = chunk[index];
        const expoToken = typeof message?.to === 'string' ? message.to : undefined;
        if (ticket === undefined || expoToken === undefined) {
          result.ticketErrors += 1;
          continue;
        }
        if (ticket.status === 'error') {
          result.ticketErrors += 1;
          if (
            ticket.details?.error === 'DeviceNotRegistered' &&
            (await this.options.store.deleteDevicePushToken(expoToken))
          ) {
            result.pruned += 1;
          }
          continue;
        }
        result.ticketsAccepted += 1;
        if (
          await this.options.store.enqueuePushReceipt({
            receiptId: ticket.id,
            expoToken,
            availableAt: this.now() + this.receiptDelayMs,
          })
        ) {
          result.receiptsQueued += 1;
        }
      }
    }

    this.options.logger?.info({ component: 'push', ...result }, 'verity: Expo push send completed');
    return result;
  }

  async processDueReceipts(): Promise<PushReceiptResult> {
    const due = await this.options.store.listDuePushReceipts(this.now());
    const result: PushReceiptResult = {
      due: due.length,
      delivered: 0,
      receiptErrors: 0,
      missing: 0,
      retried: 0,
      expired: 0,
      pruned: 0,
      transportErrors: 0,
    };
    const byId = new Map(due.map((record) => [record.receiptId, record]));

    for (const chunk of this.options.transport.chunkPushNotificationReceiptIds([...byId.keys()])) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await this.options.transport.getPushNotificationReceiptsAsync(chunk);
      } catch {
        result.transportErrors += chunk.length;
        for (const receiptId of chunk) {
          const record = byId.get(receiptId);
          if (record !== undefined) await this.retryReceipt(record, result);
        }
        this.options.logger?.warn(
          { component: 'push', receipts: chunk.length },
          'verity: Expo push-receipt request failed',
        );
        continue;
      }

      for (const receiptId of chunk) {
        const record = byId.get(receiptId);
        if (record === undefined) continue;
        const receipt = receipts[receiptId];
        if (receipt === undefined) {
          result.missing += 1;
          await this.retryReceipt(record, result);
          continue;
        }
        if (receipt.status === 'ok') {
          result.delivered += 1;
          await this.options.store.deletePushReceipt(receiptId);
          continue;
        }
        result.receiptErrors += 1;
        if (
          receipt.details?.error === 'DeviceNotRegistered' &&
          (await this.options.store.deleteDevicePushToken(record.expoToken))
        ) {
          result.pruned += 1;
        }
        // The receipt is terminal. This is a no-op when token pruning already
        // removed it through ON DELETE CASCADE.
        await this.options.store.deletePushReceipt(receiptId);
      }
    }

    if (result.due > 0) {
      this.options.logger?.info(
        { component: 'push', ...result },
        'verity: Expo push receipts processed',
      );
    }
    return result;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      if (this.receiptCycle !== undefined) return;
      this.receiptCycle = this.processDueReceipts()
        .catch(() => {
          this.options.logger?.warn(
            { component: 'push' },
            'verity: Expo push receipt cycle failed',
          );
          return {
            due: 0,
            delivered: 0,
            receiptErrors: 0,
            missing: 0,
            retried: 0,
            expired: 0,
            pruned: 0,
            transportErrors: 1,
          };
        })
        .finally(() => {
          this.receiptCycle = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, this.receiptPollMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.receiptCycle;
  }

  private async retryReceipt(record: PushReceiptRecord, result: PushReceiptResult): Promise<void> {
    const attempts = record.attempts + 1;
    if (attempts >= this.maxReceiptAttempts) {
      if (await this.options.store.deletePushReceipt(record.receiptId)) result.expired += 1;
      return;
    }
    if (
      await this.options.store.reschedulePushReceipt(
        record.receiptId,
        this.now() + this.receiptRetryMs,
        attempts,
      )
    ) {
      result.retried += 1;
    }
  }
}

export function createPushSender(options: PushSenderOptions): PushSender {
  return new DefaultPushSender(options);
}
