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

import { SettingsDisclosure } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

// Cadence for asking whether an unanswered install request started anything.
const UNANSWERED_POLL_MS = 2_000;

export function ServerUpdateSection({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<ServerUpdateStatus | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // Key of an install request that neither Verity nor the follow-up status
  // check answered — exactly what a server replacing itself looks like. Until a
  // status arrives, its outcome is unknown rather than failed.
  const [unanswered, setUnanswered] = useState<string | undefined>(undefined);
  const unansweredRef = useRef<string | undefined>(undefined);
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
          const sentKey = unansweredRef.current;
          if (sentKey !== undefined) {
            settle(next, sentKey);
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
      if (starting) return;
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
          // A refused request is final. Anything else — a dropped response, or
          // a 409 because the update already went through — is settled by
          // asking Verity what it is doing now rather than by the error itself.
          if (caught instanceof VerityApiError && caught.status === 403) {
            setStarting(false);
            setActionError('Set a master password before updating Verity.');
            return;
          }
          const current = await client.getServerUpdates().catch(() => undefined);
          if (current !== undefined) {
            settle(current, idempotencyKey);
            return;
          }
          // No answer at all: keep the button busy and poll until Verity is
          // back, then let that status decide.
          unansweredRef.current = idempotencyKey;
          setUnanswered(idempotencyKey);
        });
    },
    [client, settle, starting],
  );

  if (status === undefined || !showsServerUpdatePanel(status)) return null;
  const view = describeServerUpdate(status);
  const target = view.targetDigest;
  const attempt = view.idempotencyKey;

  return (
    <SettingsDisclosure
      title="Server update"
      icon="download"
      summary={view.title}
      attention={starting || view.progress !== null || actionError !== undefined}
    >
      <Text style={styles.reproSubtitle}>{view.detail}</Text>
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
            styles.reproButton,
            starting ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => install(target, attempt)}
          disabled={starting}
          accessibilityRole="button"
          accessibilityLabel={view.action}
        >
          {starting ? <ActivityIndicator size="small" color={theme.colors.setup.text} /> : null}
          <Text style={styles.reproButtonLabel}>{starting ? 'Starting…' : view.action}</Text>
        </Pressable>
      ) : null}
      {actionError !== undefined ? <Text style={styles.reproHint}>{actionError}</Text> : null}
    </SettingsDisclosure>
  );
}
