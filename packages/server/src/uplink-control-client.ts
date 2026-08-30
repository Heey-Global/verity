import { randomUUID } from 'node:crypto';
import type { VeritySettingsPatch, VeritySettingsRecord, EventStore } from '@verity/store';
import WebSocket from 'ws';
import type {
  PreviewEdgeBinding,
  PreviewEdgeControl,
  PreviewEdgeCreate,
} from './preview-share-manager.js';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const RECONNECT_MAX_MS = 30_000;
const ABANDONED_REQUEST_TTL_MS = 9 * 60 * 60_000;
const MAX_ABANDONED_CREATES = 1_024;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const UPLINK_CONTROL_URL = 'wss://uplink.verity.build/control';

interface SettingsStore extends EventStore {
  getVeritySettings(): Promise<VeritySettingsRecord | undefined>;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord>;
  addPendingUplinkShareRemoval(shareId: string): Promise<void>;
  listPendingUplinkShareRemovals(): Promise<string[]>;
  deletePendingUplinkShareRemoval(shareId: string): Promise<void>;
}

interface Pending {
  type: string;
  expectedResponseTypes: ReadonlySet<string>;
  expectedShareId?: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  inlineResponse: boolean;
}

export interface UplinkControlClientOptions {
  url: string;
  store: SettingsStore;
  serverVersion: string;
  webSocketFactory?: (url: string, options: { maxPayload: number }) => WebSocket;
  onFeaturesDisabled?: (reason: string) => Promise<void>;
  onShareExpired?: (shareId: string) => Promise<void>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/** Long-lived fail-closed client for the paid Uplink control plane. Credentials
 * are read from the encrypted settings store only. No environment/file fallback
 * is accepted by this class. */
export class UplinkControlClient implements PreviewEdgeControl {
  private socket: WebSocket | undefined;
  private stopped = true;
  private retryMs = 1_000;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private renewalTimer: NodeJS.Timeout | undefined;
  private features = new Set<string>();
  private pending = new Map<string, Pending>();
  private abandonedCreates = new Map<string, NodeJS.Timeout>();
  private orphanShareIds = new Set<string>();
  private lastReject: string | undefined;
  private unansweredPings = 0;
  private generation = 0;
  private authorityLossNotified = false;
  private welcomed = false;
  private controlReady = false;
  private messageTail: Promise<void> = Promise.resolve();
  private cleanupTail: Promise<void> = Promise.resolve();
  private cleanupRequired = false;
  private processingMessage = false;

  constructor(private readonly options: UplinkControlClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash) {
      throw new Error('Uplink control URL must be an authenticated WSS endpoint');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    void this.connect();
  }

  async stop(options: { revoke?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearAuthority('client stopped', options.revoke === true);
    this.socket?.close(1000, 'server shutdown');
    this.socket = undefined;
    await this.messageTail;
  }

  /** Called after a settings write so a new/replaced key takes effect now rather
   * than waiting for an unrelated network reconnect. */
  refreshCredentials(): void {
    this.lastReject = undefined;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearAuthority('Uplink credentials changed');
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    this.socket?.close(4000, 'credentials changed');
    if (!this.socket) this.scheduleReconnect(0);
  }

  isAvailable(): boolean {
    return (
      this.welcomed && this.socket?.readyState === WebSocket.OPEN && this.features.has('sharing')
    );
  }

  async create(input: PreviewEdgeCreate): Promise<PreviewEdgeBinding> {
    if (!this.isAvailable()) throw new Error('public preview sharing is not enabled by the Uplink');
    const response = await this.request('share.create', {
      duration: input.durationSeconds,
      pinHash: input.pinHash,
    });
    if (response.type === 'share.error') {
      throw new Error(
        `Uplink refused public preview: ${optionalString(response.code, 'internal')}`,
      );
    }
    if (response.type !== 'share.ready') throw new Error('unexpected Uplink share response');
    const rawShareId = stringField(response, 'shareId');
    if (!validUplinkShareId(rawShareId)) {
      // The Uplink created something but violated the ID contract. A bounded raw
      // string is still safe JSON and is the only handle capable of revoking it.
      if (rawShareId.length <= 256) await this.queueOrphanShare(rawShareId);
      throw new Error('Uplink returned an invalid share id');
    }
    try {
      const expiresAt = new Date(stringField(response, 'expiresAt'));
      if (!Number.isFinite(expiresAt.getTime())) throw new Error('invalid Uplink expiresAt');
      const publicOrigin = validatedBindingUrl(response, 'publicOrigin', 'https:');
      const edgeUrl = validatedBindingUrl(response, 'edgeUrl', 'wss:');
      if (
        publicOrigin.hostname !== edgeUrl.hostname ||
        edgeUrl.pathname !== '/__verity/connector'
      ) {
        throw new Error('invalid Uplink edge binding');
      }
      return {
        shareId: rawShareId,
        publicOrigin: publicOrigin.origin,
        edgeUrl: edgeUrl.toString(),
        connectorToken: stringField(response, 'connectorToken'),
        sessionSecret: stringField(response, 'sessionSecret'),
        expiresAt,
      };
    } catch (error) {
      // A valid raw id is sufficient to revoke an object even when every other
      // binding field is malformed. Never lose the only cleanup handle.
      await this.queueOrphanShare(rawShareId);
      throw error;
    }
  }

  async remove(shareId: string): Promise<void> {
    await this.options.store.addPendingUplinkShareRemoval(shareId);
    this.orphanShareIds.add(shareId);
    if (!this.controlReady) throw new Error('cannot revoke preview while Uplink is unavailable');
    const response = await this.request('share.remove', { shareId });
    if (response.type === 'remove.failed') {
      throw new Error(
        `Uplink failed to remove public preview: ${optionalString(response.code, 'internal')}`,
      );
    }
    if (response.type !== 'share.removed') throw new Error('unexpected Uplink removal response');
    await this.options.store.deletePendingUplinkShareRemoval(shareId);
    this.orphanShareIds.delete(shareId);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    const generation = this.generation;
    let settings: VeritySettingsRecord | undefined;
    try {
      settings = await this.options.store.getVeritySettings();
    } catch (error) {
      this.options.log?.warn({ error }, 'cannot read encrypted Uplink settings');
      this.clearAuthority('encrypted Uplink credentials are unavailable');
      this.scheduleReconnect();
      return;
    }
    if (this.stopped || generation !== this.generation || this.socket) return;
    const key: string | undefined = settings?.uplinkSubscriptionKey?.trim();
    if (!key) {
      this.clearAuthority('Uplink subscription key is not configured');
      this.scheduleReconnect(RECONNECT_MAX_MS);
      return;
    }
    if (this.lastReject === key) {
      this.clearAuthority('Uplink subscription key was rejected');
      this.scheduleReconnect(RECONNECT_MAX_MS);
      return;
    }
    const socket =
      this.options.webSocketFactory?.(this.options.url, { maxPayload: MAX_CONTROL_FRAME_BYTES }) ??
      new WebSocket(this.options.url, { maxPayload: MAX_CONTROL_FRAME_BYTES });
    this.socket = socket;
    this.welcomed = false;
    this.controlReady = false;
    socket.once('open', () => {
      if (this.stopped || generation !== this.generation || this.socket !== socket) {
        socket.close(1000, 'stale connection');
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          subscriptionKey: key,
          ...(settings?.uplinkInstallationId
            ? {
                installationId: settings.uplinkInstallationId,
              }
            : {}),
          serverVersion: this.options.serverVersion,
        }),
      );
    });
    socket.on('message', (data) => {
      const raw = rawDataText(data);
      const requestId = (() => {
        try {
          const parsed = JSON.parse(raw) as { requestId?: unknown };
          return typeof parsed.requestId === 'string' ? parsed.requestId : undefined;
        } catch {
          return undefined;
        }
      })();
      if (requestId !== undefined && this.pending.get(requestId)?.inlineResponse === true) {
        void this.onMessage(raw, key).catch((error: unknown) => {
          this.options.log?.warn({ error }, 'invalid Uplink control response');
          this.clearAuthority('invalid Uplink control message', !this.stopped);
          socket.close(1002, 'invalid control message');
        });
        return;
      }
      this.messageTail = this.messageTail
        .then(async () => {
          if (this.socket !== socket || generation !== this.generation) return;
          this.processingMessage = true;
          try {
            await this.onMessage(raw, key);
          } finally {
            this.processingMessage = false;
          }
        })
        .catch((error: unknown) => {
          this.options.log?.warn({ error }, 'invalid Uplink control message');
          this.clearAuthority('invalid Uplink control message', !this.stopped);
          socket.close(1002, 'invalid control message');
        });
    });
    socket.on('pong', () => {
      this.unansweredPings = 0;
    });
    socket.once('error', (error) => this.options.log?.warn({ error }, 'Uplink connection error'));
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearAuthority('Uplink disconnected', !this.stopped);
      this.scheduleReconnect();
    });
  }

  private async onMessage(raw: string, key: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      frame = parsed as Record<string, unknown>;
    } catch {
      this.clearAuthority('invalid Uplink control frame');
      this.socket?.close(1002, 'invalid control frame');
      return;
    }
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined;
    const frameType = typeof frame.type === 'string' ? frame.type : '';
    if (
      !this.welcomed &&
      !(this.controlReady && requestId && this.pending.has(requestId)) &&
      frameType !== 'welcome' &&
      frameType !== 'reject'
    ) {
      throw new Error(`Uplink ${frameType || 'frame'} arrived before welcome`);
    }
    if (this.welcomed && frameType === 'welcome') throw new Error('duplicate Uplink welcome');
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        const responseType = typeof frame.type === 'string' ? frame.type : '';
        if (!pending.expectedResponseTypes.has(responseType)) {
          throw new Error(`unexpected Uplink ${responseType || 'response'} for ${pending.type}`);
        }
        if (pending.expectedShareId !== undefined && frame.shareId !== pending.expectedShareId) {
          throw new Error(`mismatched Uplink shareId for ${pending.type}`);
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      const abandonedTimer = this.abandonedCreates.get(requestId);
      if (abandonedTimer && frame.type === 'share.error') {
        clearTimeout(abandonedTimer);
        this.abandonedCreates.delete(requestId);
        return;
      }
      if (abandonedTimer && frame.type === 'share.ready') {
        clearTimeout(abandonedTimer);
        this.abandonedCreates.delete(requestId);
        const shareId = typeof frame.shareId === 'string' ? frame.shareId : '';
        if (shareId.length > 0 && shareId.length <= 256) {
          await this.queueOrphanShare(shareId);
        }
        return;
      }
    }
    if (frame.type === 'welcome') {
      const installationId = stringField(frame, 'installationId');
      this.retryMs = 1_000;
      this.validateLease(frame);
      this.controlReady = true;
      await this.awaitRequiredCleanup();
      this.applyLease(frame);
      const settings = await this.options.store.getVeritySettings();
      if (settings?.uplinkInstallationId !== installationId) {
        await this.options.store.updateVeritySettings({ uplinkInstallationId: installationId });
      }
      this.welcomed = true;
      this.startHeartbeat();
      if (!this.features.has('sharing')) {
        await this.disableFeaturesOnce('Uplink did not grant public preview entitlement');
      }
      for (const shareId of await this.options.store.listPendingUplinkShareRemovals()) {
        this.orphanShareIds.add(shareId);
      }
      void this.flushOrphanShares();
      return;
    }
    if (frame.type === 'renewed') {
      const hadSharing = this.features.has('sharing');
      this.applyLease(frame);
      if (hadSharing && !this.features.has('sharing')) {
        const reason = 'Uplink removed public preview entitlement';
        this.cancelPending(reason);
        await this.disableFeaturesOnce(reason);
      }
      if (!hadSharing && this.features.has('sharing')) void this.flushOrphanShares();
      return;
    }
    if (frame.type === 'revoke') {
      this.lastReject = key;
      this.clearAuthority(optionalString(frame.reason, 'subscription revoked'));
      this.socket?.close(4003, 'revoked');
      return;
    }
    if (frame.type === 'reject') {
      const reason = optionalString(frame.reason, 'rejected');
      if (reason === 'unknown_key' || reason === 'revoked' || reason === 'expired') {
        this.lastReject = key;
      }
      this.clearAuthority(reason);
      this.socket?.close(4003, reason);
      return;
    }
    if (frame.type === 'share.expired') {
      await this.options.onShareExpired?.(stringField(frame, 'shareId'));
      return;
    }
    throw new Error(`unknown Uplink control frame: ${frameType || 'missing type'}`);
  }

  private applyLease(frame: Record<string, unknown>): void {
    const leaseUntil = this.validateLease(frame);
    this.features = new Set(
      Array.isArray(frame.features)
        ? frame.features.filter((v): v is string => typeof v === 'string')
        : [],
    );
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.leaseTimer = setTimeout(
      () => {
        this.clearAuthority('Uplink lease expired');
        this.socket?.close(4001, 'lease expired');
      },
      Math.max(0, leaseUntil - Date.now()),
    );
    const renewIn = Math.max(1_000, Math.floor((leaseUntil - Date.now()) * 0.6));
    this.renewalTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ type: 'renew' }));
    }, renewIn);
    this.renewalTimer.unref();
  }

  private validateLease(frame: Record<string, unknown>): number {
    const leaseUntil = Date.parse(stringField(frame, 'leaseUntil'));
    if (!Number.isFinite(leaseUntil) || leaseUntil <= Date.now()) {
      this.clearAuthority('invalid or expired Uplink lease');
      this.socket?.close(1002, 'invalid lease');
      throw new Error('invalid or expired Uplink lease');
    }
    return leaseUntil;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.unansweredPings >= 3) {
        this.socket.close(4002, 'heartbeat timeout');
        return;
      }
      this.unansweredPings += 1;
      this.socket.ping();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private clearAuthority(reason: string, notify = true): void {
    this.features.clear();
    this.welcomed = false;
    this.controlReady = false;
    this.unansweredPings = 0;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.heartbeat = undefined;
    this.leaseTimer = undefined;
    this.renewalTimer = undefined;
    this.cancelPending(reason);
    if (notify) void this.disableFeaturesOnce(reason).catch(() => undefined);
  }

  private cancelPending(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.type === 'share.create') this.rememberAbandonedCreate(requestId);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private disableFeaturesOnce(reason: string): Promise<void> {
    this.cleanupRequired = true;
    if (this.authorityLossNotified) return this.cleanupTail;
    this.authorityLossNotified = true;
    this.cleanupTail = this.cleanupTail
      .catch(() => undefined)
      .then(() => this.options.onFeaturesDisabled?.(reason))
      .then(() => {
        this.cleanupRequired = false;
      })
      .catch((error: unknown) => {
        this.authorityLossNotified = false;
        this.options.log?.error({ error }, 'failed to disable paid Uplink features locally');
        throw error;
      });
    return this.cleanupTail;
  }

  private async awaitRequiredCleanup(): Promise<void> {
    if (this.cleanupRequired && !this.authorityLossNotified) {
      await this.disableFeaturesOnce('retrying required Uplink cleanup');
    } else if (this.cleanupRequired) {
      await this.cleanupTail;
    }
    this.authorityLossNotified = false;
  }

  private request(type: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Uplink offline'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (type === 'share.create') this.rememberAbandonedCreate(requestId);
        reject(new Error(`Uplink ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        type,
        expectedResponseTypes:
          type === 'share.create'
            ? new Set(['share.ready', 'share.error'])
            : new Set(['share.removed', 'remove.failed']),
        ...(type === 'share.remove' && typeof fields.shareId === 'string'
          ? { expectedShareId: fields.shareId }
          : {}),
        resolve,
        reject,
        timer,
        inlineResponse: this.processingMessage,
      });
      socket.send(JSON.stringify({ type, requestId, ...fields }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (type === 'share.create') this.rememberAbandonedCreate(requestId);
        reject(error);
      });
    });
  }

  private rememberAbandonedCreate(requestId: string): void {
    if (this.abandonedCreates.has(requestId)) return;
    while (this.abandonedCreates.size >= MAX_ABANDONED_CREATES) {
      const oldest = this.abandonedCreates.entries().next().value;
      if (!oldest) break;
      clearTimeout(oldest[1]);
      this.abandonedCreates.delete(oldest[0]);
    }
    const timer = setTimeout(
      () => this.abandonedCreates.delete(requestId),
      ABANDONED_REQUEST_TTL_MS,
    );
    timer.unref();
    this.abandonedCreates.set(requestId, timer);
  }

  private async flushOrphanShares(): Promise<void> {
    if (!this.isAvailable()) return;
    for (const shareId of [...this.orphanShareIds]) {
      try {
        await this.remove(shareId);
      } catch (error) {
        this.options.log?.warn({ error, shareId }, 'failed to revoke late Uplink share');
        return;
      }
    }
  }

  private async queueOrphanShare(shareId: string): Promise<void> {
    await this.options.store.addPendingUplinkShareRemoval(shareId);
    this.orphanShareIds.add(shareId);
    void this.flushOrphanShares();
  }

  private scheduleReconnect(delay = this.retryMs): void {
    if (this.stopped || this.retryTimer) return;
    const jitter = Math.floor(Math.random() * Math.max(1, delay / 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay + jitter);
    this.retryTimer.unref();
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
  }
}

function stringField(frame: Record<string, unknown>, key: string): string {
  const value = frame[key];
  if (typeof value !== 'string' || !value) throw new Error(`invalid Uplink ${key}`);
  return value;
}

function validatedBindingUrl(
  frame: Record<string, unknown>,
  key: string,
  protocol: 'https:' | 'wss:',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(stringField(frame, key));
  } catch {
    throw new Error(`invalid Uplink ${key}`);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`invalid Uplink ${key}`);
  }
  return parsed;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function validUplinkShareId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function rawDataText(value: WebSocket.RawData): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return Buffer.concat(value).toString('utf8');
  return Buffer.from(value).toString('utf8');
}
