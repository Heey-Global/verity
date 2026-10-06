import type { LiveAlert } from '@verity/events';
import type { DevicePushTokenRecord } from '@verity/store';
import type { PushLogger, PushNotification, PushSendResult, PushSender } from './push-sender.js';

/** How long an actionable alert shown on a foreground device waits for an answer
 * before the user's other devices are told as well. The foreground device may
 * be lying on a desk; a request that blocks the agent must not wait for it. */
export const DEFAULT_ESCALATION_MS = 60_000;

/** What the router needs to know about open live connections. */
export interface PushPresence {
  isViewing(userId: string, sessionId: string): boolean;
  foregroundDevices(userId: string): Set<string>;
  deliverAlert(userId: string, alert: LiveAlert): Set<string>;
}

export interface PushRouterStore {
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  listProjectUserIds(projectId: string, permission: 'execute'): Promise<string[]>;
  listActiveAdministratorIds(): Promise<string[]>;
  listDevicePushTokensForUsers(
    userIds: readonly string[],
  ): Promise<(DevicePushTokenRecord & { userId: string })[]>;
}

export interface SessionNotification {
  /** Identifies the notification for {@link PushRouter.cancel}. */
  key: string;
  sessionId: string;
  /** The user the turn runs for. Without one, the users who could have run it
   * (execute permission on the session's project) are notified. */
  initiatorUserId?: string | undefined;
  notification: PushNotification;
  /** Present for notifications the user has to act on. A foreground device
   * shows it in-app instead of receiving a push. Informational notifications
   * (no alert) are not shown on a foreground device at all — the app's lists
   * already reflect them — and are not pushed to the user's other devices. */
  alert?: LiveAlert | undefined;
}

/** `delivered`: a push was accepted or an alert shown. `suppressed`: the user
 * already sees it (viewing the session, or in the app for an informational
 * notification). `undelivered`: nothing reached anyone — no registered device,
 * or every ticket failed — so a caller that de-duplicates may try again later. */
export type PushRouteOutcome = 'delivered' | 'suppressed' | 'undelivered';

export interface PushRouter {
  notify(input: SessionNotification): Promise<PushRouteOutcome>;
  /** The request was answered or superseded: drop its pending escalation. */
  cancel(key: string): void;
  close(): void;
}

export interface PushRouterOptions {
  sender: PushSender;
  presence: PushPresence;
  store: PushRouterStore;
  logger?: PushLogger | undefined;
  escalationMs?: number | undefined;
}

/**
 * Decide, per user, where a session notification goes (ADR 0023: notifications
 * belong to users, and to the turn's initiator):
 *
 * - the user is looking at the session on some device → nothing;
 * - one of the user's devices is in the foreground → an in-app alert there, and a
 *   push to the user's other devices only if the request is still open after
 *   {@link DEFAULT_ESCALATION_MS};
 * - otherwise → a push to all of the user's devices.
 *
 * Another user's activity never suppresses or redirects a notification.
 */
export function createPushRouter(options: PushRouterOptions): PushRouter {
  const escalationMs = options.escalationMs ?? DEFAULT_ESCALATION_MS;
  const escalations = new Map<string, NodeJS.Timeout[]>();
  type Delivery = { cancelled: boolean; pending: number };
  const deliveries = new Map<string, Set<Delivery>>();
  const release = (key: string, delivery: Delivery): void => {
    delivery.pending -= 1;
    if (delivery.pending > 0) return;
    const active = deliveries.get(key);
    active?.delete(delivery);
    if (active?.size === 0) deliveries.delete(key);
  };
  let closed = false;

  const recipients = async (input: SessionNotification): Promise<string[]> => {
    const session = await options.store.getSession(input.sessionId);
    if (session === undefined) return [];
    const authorized = await (session.projectId === null
      ? options.store.listActiveAdministratorIds()
      : options.store.listProjectUserIds(session.projectId, 'execute'));
    return input.initiatorUserId === undefined
      ? authorized
      : authorized.filter((userId) => userId === input.initiatorUserId);
  };

  const push = async (
    notification: PushNotification,
    userIds: readonly string[],
    delivery: Delivery,
    exclude: ReadonlySet<string> = new Set(),
  ): Promise<PushSendResult | undefined> => {
    const tokens = (await options.store.listDevicePushTokensForUsers(userIds)).filter(
      (token) => !exclude.has(token.authTokenId),
    );
    if (closed || delivery.cancelled || tokens.length === 0) return undefined;
    return options.sender.send(notification, tokens);
  };

  const remember = (key: string, timer: NodeJS.Timeout): void => {
    const timers = escalations.get(key) ?? [];
    timers.push(timer);
    escalations.set(key, timers);
  };

  const notifyUser = async (
    input: SessionNotification,
    userId: string,
    delivery: Delivery,
  ): Promise<PushRouteOutcome> => {
    if (closed || delivery.cancelled) return 'suppressed';
    if (options.presence.isViewing(userId, input.sessionId)) return 'suppressed';
    const foreground = options.presence.foregroundDevices(userId);
    if (foreground.size > 0) {
      if (input.alert === undefined) return 'suppressed';
      const reached = options.presence.deliverAlert(userId, input.alert);
      if (reached.size > 0) {
        delivery.pending += 1;
        const timer = setTimeout(() => {
          const timers = escalations.get(input.key)?.filter((entry) => entry !== timer) ?? [];
          if (timers.length > 0) escalations.set(input.key, timers);
          else escalations.delete(input.key);
          if (closed || delivery.cancelled || options.presence.isViewing(userId, input.sessionId)) {
            release(input.key, delivery);
            return;
          }
          void recipients(input)
            .then((authorized) =>
              authorized.includes(userId)
                ? push(input.notification, [userId], delivery, reached)
                : undefined,
            )
            .catch(() => {
              options.logger?.warn(
                { component: 'push', kind: 'escalation' },
                'verity: escalation push failed',
              );
            })
            .finally(() => release(input.key, delivery));
        }, escalationMs);
        timer.unref?.();
        remember(input.key, timer);
        return 'delivered';
      }
    }
    const result = await push(input.notification, [userId], delivery);
    return result !== undefined && result.ticketsAccepted > 0 ? 'delivered' : 'undelivered';
  };

  return {
    async notify(input) {
      if (closed) return 'undelivered';
      const delivery: Delivery = { cancelled: false, pending: 1 };
      const active = deliveries.get(input.key) ?? new Set<Delivery>();
      active.add(delivery);
      deliveries.set(input.key, active);
      try {
        const userIds = await recipients(input);
        if (delivery.cancelled || closed) return 'suppressed';
        const outcomes = await Promise.all(
          userIds.map((userId) =>
            notifyUser(input, userId, delivery).catch((): PushRouteOutcome => {
              options.logger?.warn(
                { component: 'push', kind: input.notification.data['kind'] },
                'verity: push routing failed',
              );
              return 'undelivered';
            }),
          ),
        );
        if (outcomes.includes('delivered')) return 'delivered';
        if (outcomes.length > 0 && outcomes.every((outcome) => outcome === 'suppressed')) {
          return 'suppressed';
        }
        return 'undelivered';
      } finally {
        release(input.key, delivery);
      }
    },
    cancel(key) {
      for (const delivery of deliveries.get(key) ?? []) delivery.cancelled = true;
      deliveries.delete(key);
      for (const timer of escalations.get(key) ?? []) clearTimeout(timer);
      escalations.delete(key);
    },
    close() {
      closed = true;
      for (const active of deliveries.values())
        for (const delivery of active) delivery.cancelled = true;
      deliveries.clear();
      for (const timers of escalations.values()) for (const timer of timers) clearTimeout(timer);
      escalations.clear();
    },
  };
}
