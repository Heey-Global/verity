import { createHash } from 'node:crypto';
import type { DevicePushTokenRecord, PushReceiptRecord } from '@verity/store';
import Expo, {
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushReceiptId,
  type ExpoPushTicket,
} from 'expo-server-sdk';

const SEND_RETRY_MS = 60_000;
const CREDENTIAL_RETRY_MS = 15 * 60_000;
const MAX_SEND_RETRY_MS = 60 * 60_000;
const MAX_FAILURE_STATES = 10_000;
const FAILURE_RETENTION_MS = 24 * 60 * 60_000;

// Never log a provider's free-form message or unrecognized error string.
function safePushError(error: unknown): string {
  return typeof error === 'string' &&
    [
      'DeveloperError',
      'DeviceNotRegistered',
      'ExpoError',
      'InvalidCredentials',
      'MessageRateExceeded',
      'MessageTooBig',
      'ProviderError',
      'MismatchSenderId',
      'MissingTicket',
      'TransportError',
    ].includes(error)
    ? error
    : 'UnknownError';
}

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
  /** iOS plays no sound and no haptic for an alert without one: a push that
   * leaves it out lands silently in Notification Center. Set it for the pushes
   * that block on the operator. */
  sound?: 'default';
  ttl?: number;
}

export interface PushSendResult {
  /** Unique selected devices, including those deferred by a failure cooldown. */
  targets: number;
  /** Selected devices awaiting a failure cooldown; omitted by legacy senders. */
  deferred?: number;
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
  /** Send to the given devices, or to every registered device when `tokens` is
   * omitted (announcements that belong to no session). */
  send(
    notification: PushNotification,
    tokens?: readonly DevicePushTokenRecord[],
  ): Promise<PushSendResult>;
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
  // Process-local cooldowns: pending producers retry after expiry; one-shot
  // notifications are not queued. Restarting the server clears the cooldowns.
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  private readonly activeSends = new Set<Promise<PushSendResult>>();
  private readonly sends = new Map<string, Promise<PushSendResult>>();
  private sendTail: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private receiptCycle: Promise<PushReceiptResult> | undefined;

  constructor(private readonly options: PushSenderOptions) {
    this.now = options.now ?? Date.now;
    this.receiptDelayMs = options.receiptDelayMs ?? DEFAULT_RECEIPT_DELAY_MS;
    this.receiptRetryMs = options.receiptRetryMs ?? DEFAULT_RECEIPT_RETRY_MS;
    this.receiptPollMs = options.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS;
    this.maxReceiptAttempts = options.maxReceiptAttempts ?? DEFAULT_MAX_RECEIPT_ATTEMPTS;
  }

  send(
    notification: PushNotification,
    targets?: readonly DevicePushTokenRecord[],
  ): Promise<PushSendResult> {
    // Track before token lookup yields, so shutdown also drains broadcasts that
    // have not reached the serialized transport queue yet.
    const active = this.enqueueSend(notification, targets);
    this.activeSends.add(active);
    void active.then(
      () => this.activeSends.delete(active),
      () => this.activeSends.delete(active),
    );
    return active;
  }

  private async enqueueSend(
    notification: PushNotification,
    targets?: readonly DevicePushTokenRecord[],
  ): Promise<PushSendResult> {
    const tokens = [
      ...new Map(
        (targets ?? (await this.options.store.listDevicePushTokens())).map((token) => [
          token.expoToken,
          token,
        ]),
      ).values(),
    ];
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          notification,
          tokens
            .map(({ expoToken, authTokenId }) => [expoToken, authTokenId])
            .sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')),
        ]),
      )
      .digest('hex');
    const existing = this.sends.get(key);
    if (existing !== undefined) return existing;
    // Serialize the eligibility check with transport completion: another producer
    // must observe a rejected device's backoff before attempting its next finding.
    const send = this.sendTail.then(() => this.sendOnce(notification, tokens));
    this.sendTail = send.catch(() => undefined);
    this.sends.set(key, send);
    try {
      return await send;
    } finally {
      this.sends.delete(key);
    }
  }

  private async sendOnce(
    notification: PushNotification,
    tokens: readonly DevicePushTokenRecord[],
  ): Promise<PushSendResult> {
    for (const [token, failure] of this.failures) {
      if (failure.retryAt + FAILURE_RETENTION_MS < this.now()) this.failures.delete(token);
    }
    const payloadKey = (token: string) =>
      createHash('sha256')
        .update(JSON.stringify([token, notification]))
        .digest('hex');
    const eligible = tokens.filter(
      (token) =>
        (this.failures.get(token.expoToken)?.retryAt ?? 0) <= this.now() &&
        (this.failures.get(payloadKey(token.expoToken))?.retryAt ?? 0) <= this.now(),
    );
    const result: PushSendResult = {
      targets: tokens.length,
      deferred: tokens.length - eligible.length,
      ticketsAccepted: 0,
      ticketErrors: 0,
      receiptsQueued: 0,
      pruned: 0,
      transportErrors: 0,
    };
    const messages: ExpoPushMessage[] = eligible.map((token) => ({
      to: token.expoToken,
      title: notification.title,
      body: notification.body,
      categoryId: notification.categoryId,
      // Bind every action payload to the paired device/server identity that
      // received it. The app rejects a destructive action after switching or
      // re-pairing to another Verity server.
      data: { ...notification.data, deviceId: token.authTokenId },
      priority: notification.priority ?? 'high',
      ...(notification.sound === undefined ? {} : { sound: notification.sound }),
      ...(notification.ttl === undefined ? {} : { ttl: notification.ttl }),
    }));

    for (const chunk of this.options.transport.chunkPushNotifications(messages)) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.options.transport.sendPushNotificationsAsync(chunk);
      } catch {
        result.transportErrors += chunk.length;
        for (const message of chunk) {
          if (typeof message.to === 'string') this.defer(message.to, 'TransportError');
        }
        this.options.logger?.warn(
          { component: 'push', messages: chunk.length, errorCode: 'TransportError' },
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
          if (expoToken !== undefined) this.defer(expoToken, 'MissingTicket');
          continue;
        }
        if (ticket.status === 'error') {
          result.ticketErrors += 1;
          this.defer(
            ticket.details?.error === 'MessageTooBig' ? payloadKey(expoToken) : expoToken,
            ticket.details?.error,
          );
          if (
            ticket.details?.error === 'DeviceNotRegistered' &&
            (await this.options.store.deleteDevicePushToken(expoToken))
          ) {
            result.pruned += 1;
          }
          continue;
        }
        this.failures.delete(expoToken);
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

    // Cooldown-only passes are deliberately silent; pending monitors can run
    // frequently even though no Expo request was made.
    if (eligible.length > 0) {
      this.options.logger?.info(
        { component: 'push', ...result, deferred: tokens.length - eligible.length },
        'verity: Expo push send completed',
      );
    }
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
        // Receipts do not retain the payload; a payload rejection does not
        // establish that the device is unavailable.
        if (receipt.details?.error !== 'MessageTooBig')
          this.defer(record.expoToken, receipt.details?.error);
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
    await Promise.allSettled(this.activeSends);
    await this.receiptCycle;
  }

  private defer(expoToken: string, error: unknown): void {
    const errorCode = safePushError(error);
    const attempts = Math.min((this.failures.get(expoToken)?.attempts ?? 0) + 1, 16);
    const base =
      errorCode === 'InvalidCredentials' || errorCode === 'MismatchSenderId'
        ? CREDENTIAL_RETRY_MS
        : SEND_RETRY_MS;
    const retryAfterMs =
      errorCode === 'DeviceNotRegistered'
        ? MAX_SEND_RETRY_MS
        : Math.min(base * 2 ** (attempts - 1), MAX_SEND_RETRY_MS);
    this.failures.delete(expoToken);
    this.failures.set(expoToken, { attempts, retryAt: this.now() + retryAfterMs });
    if (this.failures.size > MAX_FAILURE_STATES) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.options.logger?.warn(
      { component: 'push', errorCode, attempts, retryAfterMs },
      'verity: Expo push target deferred',
    );
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
