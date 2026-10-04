/**
 * Verity updating itself (ADR 0008 D4). Two things make this panel different
 * from every other one in Settings: the server it talks to is the thing being
 * replaced, so requests are expected to fail during activation; and the install
 * target is never chosen here — the button forwards the exact digest the server
 * reported, so the app cannot name an image of its own.
 */
import {
  VerityApiError,
  describeServerUpdate,
  publishServerUpdateStatusMutation,
  serverUpdatePollMs,
  showsServerUpdatePanel,
  type ServerUpdateStatus,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ServerUpdateChannel } from './ServerUpdateChannel';
import { ServerReleaseNotes } from './ServerReleaseNotes';
import { SettingsPanel } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

// Cadence for asking whether an unanswered install request started anything.
const UNANSWERED_POLL_MS = 2_000;
// How long an unchanged status may still be the Updater catching up with a
// request whose answer was lost. The server gives the Updater 15 s to journal
// the operation; a status read before that lands still shows the old one.
const UNANSWERED_GRACE_MS = 20_000;

export function ServerUpdateSection({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<ServerUpdateStatus | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [changingChannel, setChangingChannel] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // Key of an install request whose outcome is still unknown: it was not
  // answered, and no status since has shown whether it started — which is what
  // a server replacing itself, or an Updater still journaling, looks like.
  const [unanswered, setUnanswered] = useState<string | undefined>(undefined);
  const unansweredRef = useRef<{ key: string; deadline: number } | undefined>(undefined);
  const refreshGeneration = useRef(0);

  // Adopt what Verity reports after an install request that did not come back
  // cleanly. Only a panel that would send the very same request again means
  // nothing started: a new operation, a finished one, or "up to date" all
  // describe themselves, and keeping the stale "available" panel instead would
  // offer an install the server has already done — and then refuse with a 409.
  const settle = useCallback((current: ServerUpdateStatus, sentKey: string) => {
    refreshGeneration.current += 1;
    unansweredRef.current = undefined;
    setUnanswered(undefined);
    setStarting(false);
    setStatus(current);
    publishServerUpdateStatusMutation(current);
    if (describeServerUpdate(current).idempotencyKey === sentKey) {
      setActionError('Could not start the update.');
    }
  }, []);

  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    return (
      client
        .getServerUpdates()
        .then((next) => {
          if (generation !== refreshGeneration.current) return;
          const pending = unansweredRef.current;
          // An unchanged status is not yet proof that nothing started: the
          // request may still be on its way into the Updater's journal.
          if (
            pending !== undefined &&
            (describeServerUpdate(next).idempotencyKey !== pending.key ||
              Date.now() >= pending.deadline)
          ) {
            settle(next, pending.key);
            return;
          }
          setStatus(next);
          publishServerUpdateStatusMutation(next);
        })
        // A poll that fails mid-cutover is expected: the old server is gone and
        // the new one is not serving yet. Keep the last known operation on
        // screen rather than blanking the panel.
        .catch(() => undefined)
    );
  }, [client, settle]);

  // Expo Router can keep this route mounted after navigating away. Refresh on
  // every focus so a transient `unreachable` result does not remain on screen
  // forever (that idle state intentionally has no background polling).
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const operation = status?.operation ?? null;
  const pollMs =
    serverUpdatePollMs(operation) ?? (unanswered !== undefined ? UNANSWERED_POLL_MS : null);
  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const install = useCallback(
    (targetDigest: string, idempotencyKey: string) => {
      if (starting || changingChannel) return;
      setStarting(true);
      setActionError(undefined);
      // The key is derived by describeServerUpdate: stable for a retry after a
      // dropped response, distinct for a retry after a failed attempt.
      void client
        .requestServerUpdate({ idempotencyKey, targetDigest })
        .then((accepted) => {
          refreshGeneration.current += 1;
          setStarting(false);
          setStatus((current) => {
            if (current === undefined) return current;
            const next = { ...current, operation: accepted };
            publishServerUpdateStatusMutation(next);
            return next;
          });
        })
        .catch(async (caught) => {
          if (caught instanceof VerityApiError && caught.status === 403) {
            setStarting(false);
            setActionError('Set a master password before updating Verity.');
            return;
          }
          // Any other outcome is settled by asking Verity what it is doing now
          // rather than by the error itself: a 409 may mean the update already
          // went through. A refusal (4xx) is a closed answer, so one status read
          // settles it. Anything else — a 503 because the Server stopped waiting
          // for the Updater, a dropped connection — may belong to a request the
          // Updater accepted anyway, and a status read right away can still show
          // the previous operation. That one gets a grace period of polling.
          const refused =
            caught instanceof VerityApiError && caught.status >= 400 && caught.status < 500;
          const current = await client.getServerUpdates().catch(() => undefined);
          if (
            current !== undefined &&
            (refused || describeServerUpdate(current).idempotencyKey !== idempotencyKey)
          ) {
            settle(current, idempotencyKey);
            return;
          }
          // Keep the button busy and poll; a status that moves on — or the
          // grace period running out — decides.
          unansweredRef.current = {
            key: idempotencyKey,
            deadline: Date.now() + UNANSWERED_GRACE_MS,
          };
          setUnanswered(idempotencyKey);
        });
    },
    [client, settle, starting, changingChannel],
  );

  if (status === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }
  if (!showsServerUpdatePanel(status)) {
    return (
      <SettingsPanel>
        <Text style={styles.updateDetail}>
          This deployment was not installed by Verity, so it updates itself externally.
        </Text>
      </SettingsPanel>
    );
  }
  const view = describeServerUpdate(status);
  const target = view.targetDigest;
  const attempt = view.idempotencyKey;

  const publishedAt =
    'release' in status ? formatReleaseDate(status.release.publishedAt) : undefined;

  return (
    <SettingsPanel>
      <ServerUpdateChannel
        client={client}
        disabled={starting || unanswered !== undefined || view.busy}
        onChanged={refresh}
        onSavingChange={setChangingChannel}
      />
      <View style={styles.updateHeader}>
        <Text style={styles.updateTitle} accessibilityRole="header">
          {view.title}
        </Text>
        {publishedAt !== undefined ? (
          <Text style={styles.reproSubtitle}>Released {publishedAt}</Text>
        ) : null}
      </View>
      <Text style={styles.updateDetail}>{view.detail}</Text>
      {view.progress !== null ? (
        <View style={styles.updateProgressRow}>
          <ActivityIndicator size="small" color={theme.colors.setup.text} />
          <Text style={styles.reproStatus} accessibilityLiveRegion="polite">
            {`Step ${String(view.progress.step)} of ${String(view.progress.total)}`}
          </Text>
        </View>
      ) : null}
      {view.action !== null && target !== null && attempt !== null ? (
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            styles.updateButton,
            starting || changingChannel ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => install(target, attempt)}
          disabled={starting || changingChannel}
          accessibilityRole="button"
          accessibilityLabel={view.action}
        >
          {starting ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
          <Text style={styles.primaryButtonLabel}>{starting ? 'Starting…' : view.action}</Text>
        </Pressable>
      ) : null}
      {actionError !== undefined ? <Text style={styles.reproHint}>{actionError}</Text> : null}
      {status.state === 'available' ? (
        <ServerReleaseNotes client={client} version={status.release.version} />
      ) : null}
    </SettingsPanel>
  );
}

/** "12 Aug 2026" — a release is a day, not an instant. Unparseable → omitted. */
function formatReleaseDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
