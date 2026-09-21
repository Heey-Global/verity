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
/** Exported so the guards can derive their timings from the schedule rather
 * than restating it. */
export const RECONNECT_MAX_MS = 30_000;
/** Back-off for a refusal that is about the service's capacity rather than this
 * installation's standing. Dialling every 30s only adds load to whatever is
 * already full, but giving up entirely would mean an operator freeing capacity
 * never gets noticed. */
export const RECONNECT_CAPACITY_MS = 5 * 60_000;
const ABANDONED_REQUEST_TTL_MS = 9 * 60 * 60_000;
const MAX_ABANDONED_CREATES = 1_024;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_REFUSAL_REASON_CHARS = 200;
/** Hard WebSocket limit on a close reason; `ws` throws above it. */
const MAX_CLOSE_REASON_BYTES = 123;
export const UPLINK_CONTROL_URL = 'wss://uplink.verity.build/control';

/** Refusals that are about who this installation is: dialling again with the
 * same key cannot change the answer, so the client stops and reports the reason.
 * Everything else — a named capacity limit, a version mismatch, or a reason this
 * client has never heard of — is treated as temporary and retried on the slower
 * schedule. That default direction is the safe one: retrying a permanent refusal
 * wastes a connection every few minutes, while giving up on a temporary one
 * leaves sharing dead until someone restarts the server.
 *
 * `protocol_unsupported` belongs on the temporary side despite naming something
 * this installation cannot change: a mixed-version fleet or a rolled-back
 * deployment resolves it without anyone touching the installation, and the fix
 * that *is* the installation's — upgrading it — restarts the process anyway, so
 * treating it as permanent would buy nothing and cost the self-healing case. */
const IDENTITY_REJECTS: ReadonlySet<string> = new Set(['unknown_key', 'revoked', 'expired']);

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
  private retryCeilingMs = RECONNECT_MAX_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private renewalTimer: NodeJS.Timeout | undefined;
  private features = new Set<string>();
  private pending = new Map<string, Pending>();
  private abandonedCreates = new Map<string, NodeJS.Timeout>();
  private orphanShareIds = new Set<string>();
  /** The key an identity-class rejection named, with the reason, so the reason
   * reaches the app instead of a guess about which one it was. */
  private lastReject: { key: string; reason: string } | undefined;
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
    // A stop/start cycle inside one process is a fresh attempt, not a
    // continuation of whatever back-off the previous one ended on.
    this.retryMs = 1_000;
    this.retryCeilingMs = RECONNECT_MAX_MS;
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
    this.retryMs = 1_000;
    this.retryCeilingMs = RECONNECT_MAX_MS;
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
    if (this.lastReject?.key === key) {
      // A stranded installation used to log its refusal once and then go quiet
      // while looping every 30s, which reads exactly like a healthy server. Say
      // so on every decline instead, on the slower schedule so that saying so
      // stays affordable: one line every five minutes is what makes the state
      // findable in a log nobody was watching at the time.
      this.options.log?.warn(
        { reason: this.lastReject.reason, identity: true },
        'not dialling the Uplink: this key was refused',
      );
      this.clearAuthority(this.lastReject.reason);
      this.scheduleReconnect(RECONNECT_CAPACITY_MS);
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
      // Which half of the handshake fell over is only reconstructable later if
      // the start of it was recorded too.
      this.options.log?.info(
        {
          protocolVersion: PROTOCOL_VERSION,
          identified: Boolean(settings?.uplinkInstallationId),
        },
        'Uplink control handshake started',
      );
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
    socket.once('close', (code: number, reason: Buffer) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Without the code and reason a refusal that closes before `reject` is
      // indistinguishable from a network drop, and both just look like silence.
      // A shutdown this side asked for is not a warning, though: making every
      // graceful stop yellow is how a log stops being read.
      const expected = this.stopped && code === 1000;
      const record = { code, reason: reason.toString(), welcomed: this.welcomed };
      if (expected) this.options.log?.info(record, 'Uplink control connection closed');
      else this.options.log?.warn(record, 'Uplink control connection closed');
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
      this.retryCeilingMs = RECONNECT_MAX_MS;
      this.validateLease(frame);
      this.controlReady = true;
      await this.awaitRequiredCleanup();
      this.applyLease(frame);
      const settings = await this.options.store.getVeritySettings();
      // A first-ever admission, a re-admission under the same id, and an
      // admission that silently replaced the stored id look identical in the
      // logs otherwise, and they mean very different things when the service is
      // counting installations against a cap. The third is the one that
      // exhausts it: an id that rotates on every admission consumes a slot each
      // time while this side believes it is the same installation throughout.
      const previousInstallationId = settings?.uplinkInstallationId ?? undefined;
      const firstEver = !previousInstallationId;
      const idChanged = !firstEver && previousInstallationId !== installationId;
      if (previousInstallationId !== installationId) {
        await this.options.store.updateVeritySettings({ uplinkInstallationId: installationId });
      }
      this.options.log?.info(
        {
          installationId,
          previousInstallationId,
          firstEver,
          idChanged,
          features: [...this.features],
        },
        'Uplink admitted this installation',
      );
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
      const reason = refusalReason(frame.reason, 'subscription revoked');
      this.lastReject = { key, reason };
      this.options.log?.warn({ frameType: 'revoke', reason }, 'Uplink withdrew this installation');
      this.clearAuthority(reason);
      this.socket?.close(4003, 'revoked');
      return;
    }
    if (frame.type === 'reject') {
      const reason = refusalReason(frame.reason, 'rejected');
      const identity = IDENTITY_REJECTS.has(reason);
      if (identity) {
        this.lastReject = { key, reason };
      } else {
        this.retryCeilingMs = RECONNECT_CAPACITY_MS;
        this.retryMs = RECONNECT_CAPACITY_MS;
      }
      this.options.log?.warn(
        { frameType: 'reject', reason, identity },
        'Uplink refused the control handshake',
      );
      this.clearAuthority(reason);
      this.socket?.close(4003, closeReason(reason, 'rejected'));
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
    this.retryMs = Math.min(this.retryCeilingMs, this.retryMs * 2);
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

/** A refusal reason is a protocol token, but it arrives as free text bounded
 * only by the frame limit, and an identity-class one is then pinned into the
 * message the app shows until the credentials change. Cap it at the point it
 * enters that state rather than trusting the far end to be terse. */
function refusalReason(value: unknown, fallback: string): string {
  const reason = optionalString(value, fallback);
  return reason.length <= MAX_REFUSAL_REASON_CHARS
    ? reason
    : `${reason.slice(0, MAX_REFUSAL_REASON_CHARS)}…`;
}

/** `ws` throws a RangeError on a close reason over 123 bytes. Thrown from here
 * it would land in the frame handler's catch, which reports a refusal we
 * understood perfectly as an unparseable frame and closes with 1002 instead of
 * 4003 — turning the one log line that names the cause into a misleading one.
 * The far end already knows why it refused us, so echoing anything at all is a
 * courtesy; drop back to the fallback token rather than truncating into a
 * split UTF-8 sequence. */
function closeReason(reason: string, fallback: string): string {
  return Buffer.byteLength(reason) <= MAX_CLOSE_REASON_BYTES ? reason : fallback;
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
