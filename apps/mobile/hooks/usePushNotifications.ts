import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { VerityClient } from '@verity/mobile';
import {
  createPushOutboxForClient,
  ensurePushRegistration,
  handlePushResponse,
} from '../lib/pushNotifications';
import { getAuthTokenId, getStoredAuthTokenId } from '../lib/authToken';
import { createPushRegistrationAttempt } from '../lib/pushRegistrationAttempt';

/**
 * Mount push notifications once from the root authenticated screen. Registers this
 * device's Expo token (fail-safe: a no-op when push is disabled server-side or the
 * device isn't unlocked yet), then routes OS notification responses — a plain tap
 * opens the session, a permission allow/deny or a text reply is queued in the
 * offline outbox and flushed on the spot and on every foreground.
 *
 * Everything is best-effort: a push failure must never disrupt the app, so each
 * async path swallows its error. The heavy lifting (payload parsing, routing, the
 * idempotent outbox) is the unit-tested `@verity/mobile` core; this hook is glue.
 */
export function usePushNotifications(client: VerityClient | null, baseUrl: string | null): void {
  useEffect(() => {
    if (client === null) return;
    let active = true;
    // A cold-start response can also arrive through the live listener on some Expo
    // versions; dedup by notification id so a reply is never enqueued twice (the
    // permission path is idempotent, but a future AGENT_QUESTION reply would post
    // twice without this guard).
    const handled = new Set<string>();
    const outbox = createPushOutboxForClient(client, baseUrl);
    const navigateToSession = (sessionId: string): void => {
      router.push({ pathname: '/session/[id]', params: { id: sessionId } });
    };
    // Where the update can actually be started — the same destination the header
    // dot points at, so the announcement and the chrome lead to one place.
    const navigateToSettings = (): void => {
      router.push('/settings');
    };

    // Retry until it sticks: a launch while offline (or a transient /healthz blip)
    // leaves the device unregistered, and re-running only when it hasn't yet
    // succeeded avoids re-prompting or re-POSTing on every foreground.
    const attemptRegistration = createPushRegistrationAttempt(() =>
      ensurePushRegistration(client, baseUrl),
    );

    const route = async (response: Notifications.NotificationResponse): Promise<void> => {
      const key = response.notification.request.identifier;
      if (key) {
        if (handled.has(key)) return;
        handled.add(key);
      }
      const deviceId = getAuthTokenId(baseUrl) ?? (await getStoredAuthTokenId(baseUrl));
      await handlePushResponse(response, outbox, navigateToSession, deviceId, navigateToSettings);
    };

    void attemptRegistration();
    void outbox.flush().catch(() => undefined);

    // A response that cold-launched the app (killed, not backgrounded) is delivered
    // here rather than through the live listener below.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => (active && response ? route(response) : undefined))
      .catch(() => undefined);

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      void route(response).catch(() => undefined);
    });

    // On return to the foreground, flush any lock-screen deny/reply queued while
    // backgrounded and re-attempt registration if it hasn't succeeded yet.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void attemptRegistration();
      void outbox.flush().catch(() => undefined);
    });

    return () => {
      active = false;
      responseSub.remove();
      appStateSub.remove();
    };
  }, [client, baseUrl]);
}
