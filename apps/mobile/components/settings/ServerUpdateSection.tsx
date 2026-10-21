import { subscribeLiveRefresh } from '../../lib/liveConnection';
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
  describeServerUpdatePanel,
  publishServerUpdateStatusMutation,
  showsServerUpdatePanel,
  type ServerUpdateCard,
  type ServerUpdateStatus,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { getVerityBaseUrl } from '../../lib/client';
import {
  isServerUpdateChannelWritePending,
  setServerUpdateChannelWritePending,
  useServerUpdateChannelWritePending,
} from '../../lib/serverUpdateChannelWrite';
import { ServerUpdateChannel } from './ServerUpdateChannel';
import { ServerReleaseNotes } from './ServerReleaseNotes';
import { SettingsGroup, SettingsPanel } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';
import { Button, Card, HintBox, Row, StatusTag, Text as UiText, type StatusIntent } from '../ui';

// Cadence for asking whether an unanswered install request started anything.
// How long an unchanged status may still be the Updater catching up with a
// request whose answer was lost. The server gives the Updater 15 s to journal
// the operation; a status read before that lands still shows the old one.
const UNANSWERED_GRACE_MS = 20_000;

export function ServerUpdateSection({
  client,
  mode = 'install',
}: {
  client: VerityClient;
  mode?: 'install' | 'channel';
}) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<ServerUpdateStatus | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const server = getVerityBaseUrl();
  const changingChannel = useServerUpdateChannelWritePending(server);
  const channelSavingChanged = useCallback(
    (value: boolean) => setServerUpdateChannelWritePending(value, server),
    [server],
  );
  const [channelNeedsRefresh, setChannelNeedsRefresh] = useState(false);
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

  const refresh = useCallback(
    (force = false) => {
      if (isServerUpdateChannelWritePending(server) && !force) return Promise.resolve();
      const generation = ++refreshGeneration.current;
      return (
        client
          .getServerUpdates()
          .then((next) => {
            if (
              generation !== refreshGeneration.current ||
              (isServerUpdateChannelWritePending(server) && !force)
            )
              return;
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
            if (next.state !== 'unreachable') setChannelNeedsRefresh(false);
            publishServerUpdateStatusMutation(next);
          })
          // A poll that fails mid-cutover is expected: the old server is gone and
          // the new one is not serving yet. Keep the last known operation on
          // screen rather than blanking the panel.
          .catch(() => undefined)
      );
    },
    [client, settle, server],
  );

  const invalidateChannel = useCallback(() => {
    refreshGeneration.current += 1;
    // Never leave the previous channel's install target in the panel or overview cache.
    const invalidated: ServerUpdateStatus = {
      state: 'unreachable',
      reason: 'Checking the selected update channel',
      operation: null,
    };
    setChannelNeedsRefresh(true);
    setStatus(invalidated);
    setActionError(undefined);
    publishServerUpdateStatusMutation(invalidated);
  }, []);
  const previousChannelWrite = useRef(false);
  useEffect(() => {
    if (changingChannel) invalidateChannel();
    else if (previousChannelWrite.current) void refresh();
    previousChannelWrite.current = changingChannel;
  }, [changingChannel, invalidateChannel, refresh]);

  const channelChanged = useCallback(async () => {
    invalidateChannel();
    await refresh(true);
  }, [invalidateChannel, refresh]);

  // Expo Router can keep this route mounted after navigating away. Refresh on
  // every focus so a transient `unreachable` result does not remain on screen
  // forever (that idle state intentionally has no background polling).
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(
    () =>
      subscribeLiveRefresh(
        client,
        () => refresh(),
        (path) => path.startsWith('/server/'),
      ),
    [client, refresh],
  );

  useEffect(() => {
    const pending = unansweredRef.current;
    if (unanswered === undefined || pending === undefined) return;
    // An unchanged live snapshot cannot announce that the local request's
    // grace period expired. Reconcile once at the deadline even without a hint.
    const timer = setTimeout(() => void refresh(), Math.max(0, pending.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [unanswered, refresh]);

  const install = useCallback(
    (targetDigest: string, idempotencyKey: string) => {
      if (starting || isServerUpdateChannelWritePending(server) || channelNeedsRefresh) return;
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
          // the previous operation. That one gets a grace period before reconciliation.
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
          // Keep the button busy; a status that moves on — or the
          // grace period running out — decides.
          unansweredRef.current = {
            key: idempotencyKey,
            deadline: Date.now() + UNANSWERED_GRACE_MS,
          };
          setUnanswered(idempotencyKey);
        });
    },
    [client, settle, starting, changingChannel, channelNeedsRefresh, server],
  );

  const [retrying, setRetrying] = useState<string | undefined>(undefined);
  const retry = useCallback(
    (updateId: string) => {
      if (retrying !== undefined) return;
      setRetrying(updateId);
      setActionError(undefined);
      void client
        .retryServerUpdate(updateId)
        .then(
          () => undefined,
          (caught: unknown) => {
            // A 409 means the operation moved on — finished, rolled back,
            // replaced, or moving again — and the fresh status below says which.
            // Anything else is a retry that may not have reached the Updater.
            if (!(caught instanceof VerityApiError && caught.status === 409))
              setActionError('Could not retry the update.');
          },
        )
        // Either way, show what the Updater is doing now rather than guessing.
        .then(() => refresh(true))
        .finally(() => setRetrying(undefined));
    },
    [client, refresh, retrying],
  );

  if (status === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
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
  if (mode === 'channel') {
    return (
      <>
        <ServerUpdateChannel
          client={client}
          disabled={starting || unanswered !== undefined || view.busy || channelNeedsRefresh}
          onChanged={channelChanged}
          onSavingChange={channelSavingChanged}
          onChanging={invalidateChannel}
        />
        {channelNeedsRefresh ? (
          <Text style={styles.updateDetail}>
            Checking the selected channel… Retrying if the server is unavailable.
          </Text>
        ) : null}
      </>
    );
  }

  if (channelNeedsRefresh) {
    return (
      <SettingsGroup title="Update">
        <SettingsPanel>
          <View style={styles.updateProgressRow}>
            <ActivityIndicator size="small" color={theme.colors.text} />
            <Text style={styles.updateDetail}>
              Checking the selected channel… Retrying if the server is unavailable.
            </Text>
          </View>
        </SettingsPanel>
      </SettingsGroup>
    );
  }

  const panel = describeServerUpdatePanel(status);
  return (
    <>
      {panel.installed !== null ? (
        <SettingsGroup title="Installed">
          <Card flush>
            <Row
              title="Verity Server"
              subtitle={
                panel.installed.generation === null
                  ? 'Running'
                  : `Generation ${String(panel.installed.generation)} · running`
              }
              trailing={<UiText variant="row">{panel.installed.version}</UiText>}
            />
          </Card>
        </SettingsGroup>
      ) : null}
      {panel.cards.map((card) => (
        <SettingsGroup key={card.key} title={card.section}>
          <UpdateCard
            card={card}
            client={client}
            busy={starting || retrying !== undefined}
            installing={starting}
            retrying={retrying}
            disabled={changingChannel}
            onInstall={install}
            onRetry={retry}
          />
        </SettingsGroup>
      ))}
      {actionError !== undefined ? <Text style={styles.reproHint}>{actionError}</Text> : null}
    </>
  );
}

const TAG_INTENT: Record<ServerUpdateCard['status']['tone'], StatusIntent> = {
  problem: 'needsSetup',
  done: 'ready',
  active: 'optional',
  idle: 'optional',
};

/** One operation or release: its state, what happened, and its single way forward. */
function UpdateCard({
  card,
  client,
  busy,
  installing,
  retrying,
  disabled,
  onInstall,
  onRetry,
}: {
  card: ServerUpdateCard;
  client: VerityClient;
  busy: boolean;
  installing: boolean;
  retrying: string | undefined;
  disabled: boolean;
  onInstall: (targetDigest: string, idempotencyKey: string) => void;
  onRetry: (updateId: string) => void;
}) {
  const { theme } = useUnistyles();
  const action = card.action;
  const releasedAt =
    card.release === null ? undefined : formatReleaseDate(card.release.publishedAt);
  return (
    <Card stacked attention={card.status.tone === 'problem'}>
      <View style={styles.updateHeader}>
        {card.progress !== null ? (
          <StatusTag intent="transient" label={card.status.label} />
        ) : (
          <StatusTag intent={TAG_INTENT[card.status.tone]} label={card.status.label} />
        )}
        <UiText variant="title" accessibilityRole="header">
          {card.title}
        </UiText>
        {releasedAt !== undefined ? (
          <UiText variant="subtitle">Released {releasedAt}</UiText>
        ) : null}
      </View>
      {card.progress !== null ? (
        <View style={styles.updateProgressRow}>
          <ActivityIndicator size="small" color={theme.colors.text} />
          <UiText variant="bodySmall">{card.progress.phase}</UiText>
          <UiText variant="bodySmall" tone="muted" accessibilityLiveRegion="polite">
            {`Step ${String(card.progress.step)} of ${String(card.progress.total)}`}
          </UiText>
        </View>
      ) : null}
      {card.stalled !== null ? (
        <View>
          <UiText variant="bodySmall">
            {`${card.stalled.phase} · step ${String(card.stalled.step)} of ${String(card.stalled.total)}`}
          </UiText>
          <UiText variant="bodySmall" tone="attention">
            {`No progress since ${formatStallSince(card.stalled.since)}`}
          </UiText>
        </View>
      ) : null}
      <UiText variant="bodySmall" tone="muted">
        {card.detail}
      </UiText>
      {card.error !== null ? <HintBox title="Last error" message={card.error} /> : null}
      {action?.kind === 'install' ? (
        <Button
          label={action.label}
          variant={action.primary ? 'primary' : 'secondary'}
          loading={installing}
          disabled={disabled || (busy && !installing)}
          onPress={() => onInstall(action.targetDigest, action.idempotencyKey)}
          fullWidth
        />
      ) : null}
      {action?.kind === 'retry' ? (
        <Button
          label={action.label}
          variant={action.primary ? 'primary' : 'secondary'}
          loading={retrying === action.updateId}
          disabled={disabled || (busy && retrying !== action.updateId)}
          onPress={() => onRetry(action.updateId)}
          fullWidth
          accessibilityHint="Resumes the stuck update where it stopped"
        />
      ) : null}
      {card.notesVersion !== null ? (
        <ServerReleaseNotes client={client} version={card.notesVersion} />
      ) : null}
    </Card>
  );
}

/** "20 Oct, 23:42 · 17 h" — when the operation last moved, and how long ago. */
function formatStallSince(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const when = date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const hours = Math.floor((Date.now() - date.getTime()) / 3_600_000);
  return hours >= 1 ? `${when} · ${String(hours)} h` : when;
}

/** "12 Aug 2026" — a release is a day, not an instant. Unparseable → omitted. */
function formatReleaseDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
