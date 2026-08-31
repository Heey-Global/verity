// Expo/React-Native adapter for push notifications (ADR 0008). The runtime-agnostic
// core — payload parsing, category specs, response routing, and the offline outbox —
// lives in `@verity/mobile` (unit-tested there). This module is the thin native
// edge: it translates the category specs into `expo-notifications` calls, mints and
// registers this device's Expo push token, and wires OS notification responses into
// the core outbox. Everything is fail-safe: a deployment with push disabled skips
// the permission prompt and degrades to today's in-app behaviour.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  VerityApiError,
  PUSH_NOTIFICATION_CATEGORIES,
  createPushOutbox,
  createPushReplyPerformer,
  parsePushPayload,
  parseServerUpdatePush,
  resolvePushResponse,
  type VerityClient,
  type PushCategorySpec,
  type PushOutbox,
  type PushOutboxEntry,
} from '@verity/mobile';
import { getAuthTokenId, getStoredAuthTokenId } from './authToken';

/** AsyncStorage key for the persistent reply outbox. */
const OUTBOX_STORAGE_KEY = 'verity.pushOutbox';

function normalizeServerKey(baseUrl: string | null): string {
  const raw = baseUrl?.trim() ?? '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** The outcome of a registration attempt. Only `registered` means the server can
 *  now fan out to this device; every other value is a benign, expected skip. */
export type PushRegistrationResult =
  'registered' | 'push-disabled' | 'permission-denied' | 'no-device' | 'unsupported-platform';

type ExpoActions = Parameters<typeof Notifications.setNotificationCategoryAsync>[1];

/** Translate a runtime-neutral category spec into expo's action shape. A
 *  destructive approval (`authenticationRequired`) both foregrounds the app and
 *  forces a device unlock so it can never be granted silently from the lock screen
 *  (ADR 0008 §11); every other action runs in the background without a prompt. */
function toExpoActions(spec: PushCategorySpec): ExpoActions {
  return spec.actions.map((action) => ({
    identifier: action.identifier,
    buttonTitle: action.buttonTitle,
    options: {
      opensAppToForeground: action.authenticationRequired === true,
      isAuthenticationRequired: action.authenticationRequired === true,
      isDestructive: action.destructive === true,
    },
    ...(action.textInput
      ? {
          textInput: {
            submitButtonTitle: action.textInput.submitButtonTitle,
            placeholder: action.textInput.placeholder,
          },
        }
      : {}),
  }));
}

/** Register the app's notification categories (ADR 0008 §5) so the OS renders the
 *  quick-reply buttons for a push that names their `categoryId`. Idempotent. */
export async function registerPushCategories(): Promise<void> {
  await Promise.all(
    PUSH_NOTIFICATION_CATEGORIES.map((spec) =>
      Notifications.setNotificationCategoryAsync(spec.identifier, toExpoActions(spec)),
    ),
  );
}

async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Register this device's Expo push token so the server can notify it (ADR 0008
 * §4.1). Best-effort and fail-safe:
 *
 * - iOS only for v1 — the server rejects any other platform, so we don't prompt.
 * - Push disabled server-side (`/healthz` `pushEnabled=false`, or a 503 from the
 *   endpoint) → skip silently; no permission prompt.
 * - Not yet paired/unlocked (no auth-token id) → nothing to key on yet.
 * - Permission denied → skip; the app keeps working in-app.
 *
 * Call at launch once the bearer is loaded and again on token rotation.
 */
export async function ensurePushRegistration(
  client: VerityClient,
  baseUrl: string | null,
): Promise<PushRegistrationResult> {
  if (Platform.OS !== 'ios') return 'unsupported-platform';

  let pushEnabled = false;
  try {
    pushEnabled = (await client.getHealth()).pushEnabled === true;
  } catch {
    return 'push-disabled';
  }
  if (!pushEnabled) return 'push-disabled';

  // This device's OWN auth-token id — the push endpoint's `:id`, matched against
  // the bearer server-side. Absent until the operator has unlocked.
  const deviceId = getAuthTokenId(baseUrl) ?? (await getStoredAuthTokenId(baseUrl));
  if (deviceId === null) return 'no-device';

  // Categories must exist before the first actionable push arrives; registering
  // them here (not gated on permission) keeps them current across app updates.
  await registerPushCategories();

  if (!(await ensureNotificationPermission())) return 'permission-denied';

  let expoToken: string;
  try {
    // projectId is auto-discovered from app.config `extra.eas.projectId`.
    expoToken = (await Notifications.getExpoPushTokenAsync()).data;
  } catch {
    // A missing APNs entitlement / simulator has no token — treat as unavailable.
    return 'permission-denied';
  }

  try {
    await client.registerPushToken(deviceId, { expoToken, platform: 'ios' });
  } catch (error) {
    if (error instanceof VerityApiError) {
      // The deployment turned push off between /healthz and here — degrade quietly.
      if (error.status === 503) return 'push-disabled';
      // The in-memory bearer isn't loaded yet (a biometric-unlock launch can mount
      // this before the token is rehydrated): report a benign skip so the caller
      // retries on the next foreground rather than treating it as a hard failure.
      if (error.status === 401 || error.status === 403) return 'no-device';
    }
    throw error;
  }
  return 'registered';
}

/** Build the reply outbox for a client, backed by AsyncStorage so a lock-screen
 *  reply survives an app kill and flushes when the app next foregrounds. */
export function createPushOutboxForClient(
  client: VerityClient,
  baseUrl: string | null,
): PushOutbox {
  const initialDeviceId = getAuthTokenId(baseUrl);
  let resolvedStorageKey: Promise<string> | undefined;
  const storageKey = async (): Promise<string> => {
    resolvedStorageKey ??= (async () => {
      const deviceId = initialDeviceId ?? (await getStoredAuthTokenId(baseUrl));
      return `${OUTBOX_STORAGE_KEY}:${encodeURIComponent(normalizeServerKey(baseUrl))}:${deviceId ?? 'unpaired'}`;
    })();
    return resolvedStorageKey;
  };
  return createPushOutbox({
    storage: {
      load: async () => {
        try {
          const raw = await AsyncStorage.getItem(await storageKey());
          if (raw === null) return [];
          const parsed: unknown = JSON.parse(raw);
          return Array.isArray(parsed) ? (parsed as PushOutboxEntry[]) : [];
        } catch {
          return [];
        }
      },
      save: async (entries) => {
        try {
          const key = await storageKey();
          if (entries.length === 0) await AsyncStorage.removeItem(key);
          else await AsyncStorage.setItem(key, JSON.stringify(entries));
        } catch {
          // Best effort — an unpersisted reply is still retried from memory.
        }
      },
    },
    perform: createPushReplyPerformer(client),
    // The entry's dedup/identity key (non-crypto is fine — it authorizes nothing).
    // The outbox threads it to `perform` as the server-side `clientReplyId` a
    // re-flushed reply is deduped on (ADR 0008).
    newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    now: () => Date.now(),
  });
}

/**
 * Route a fired notification response: parse the (defensively validated) payload,
 * resolve it to an action, and either navigate (a plain tap) or enqueue the reply
 * into the outbox. Handles both a warm foreground response and a cold-start
 * `getLastNotificationResponseAsync`, since {@link resolvePushResponse} is pure.
 */
export async function handlePushResponse(
  response: Notifications.NotificationResponse,
  outbox: PushOutbox,
  navigateToSession: (sessionId: string) => void,
  expectedDeviceId?: string | null,
  navigateToSettings?: () => void,
): Promise<void> {
  const data: unknown = response.notification.request.content.data;
  // Handled before the session parser, and never through it: this push carries no
  // `sessionId`, so `parsePushPayload` rejects it by design. Without this branch a
  // tap on "Verity update available" would fall out at the null check below and the
  // notification would open the app on whatever screen it was already showing —
  // an announcement that names an action and then does not lead to it.
  const serverUpdate = parseServerUpdatePush(data);
  if (serverUpdate !== null) {
    // Same pairing check the merge action gets: a notification left in the tray by
    // a server this app has since re-paired away from would otherwise open settings
    // for the current one, presenting an update that has nothing to do with it.
    if (serverUpdate.deviceId !== expectedDeviceId) return;
    navigateToSettings?.();
    return;
  }
  const payload = parsePushPayload(data);
  if (payload === null) return;
  if (payload.kind === 'pull_request_ready' && payload.deviceId !== expectedDeviceId) return;
  const action = resolvePushResponse({
    actionIdentifier: response.actionIdentifier,
    payload,
    userText: response.userText,
  });
  if (action === null) return;
  if (action.type === 'open-session') {
    navigateToSession(action.sessionId);
    return;
  }
  if (action.type === 'merge-pull-request') {
    // Persist first, then navigate without waiting for the network request. The
    // foreground flush below (or the next app activation) completes the merge.
    await outbox.queue(action);
    navigateToSession(action.sessionId);
    void outbox.flush().catch(() => undefined);
    return;
  }
  await outbox.enqueue(action);
}
