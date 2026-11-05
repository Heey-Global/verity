import {
  createPushReplyPerformer,
  formatChoiceAnswer,
  inboxDismissedKeys,
  inboxItems,
  inboxSummary,
  type InboxAction,
  type InboxItem,
  type ProjectRecord,
  type PushReplyAction,
  type SessionSummary,
  type UpcomingMeeting,
  type VerityClient,
} from '@verity/mobile';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Button, Card, CardHead, StatusTag, Text } from '../ui';
import { tint } from '../ui/tint';
import { useTaskPreferences } from '../../lib/taskPreferences';
import { taskAccountScope } from '../../lib/tasksStore';
import { dispatchVerityShortcut } from '../../lib/voiceShortcut';

const MARK = require('../../assets/brand/verity-v-mark.png') as number;
// The mark's artwork is wider than tall.
const MARK_RATIO = 240 / 168;

/** The cached calendar list is cheap, but a watched calendar rarely changes. */
const MEETING_REFRESH_MS = 5 * 60_000;
/** Re-evaluates the meeting window and "in N min" without new data. */
const CLOCK_TICK_MS = 30_000;
/** What Resume sends: a crashed session continues by taking a new turn. */
export const RESUME_PROMPT = 'Continue where you stopped.';

const TAG_INTENT = { attention: 'needsSetup', success: 'ready', neutral: 'optional' } as const;

/**
 * Home: Verity's line and capture on top, then every item across all projects
 * that needs the operator, each with its answers in place
 * (docs/design-system.md § 5.8 "Home presence").
 *
 * Items come from {@link inboxItems}, so they follow the same rules as the
 * project list's markers; {@link useInboxFeed} answers and dismisses them.
 */
export function HomeInbox({
  client,
  sessions,
  projects,
  selectedSessionId,
  refreshing,
  onRefresh,
  onOpenSession,
  onOpenProject,
  onRepairProject,
  onCountChange,
  onOpenVerity,
}: {
  client: VerityClient;
  sessions: readonly SessionSummary[];
  projects: readonly ProjectRecord[];
  /** The session shown in the wide layout's right pane, drawn as selected. */
  selectedSessionId?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Where "Open" on a project item leads; the project route when omitted. */
  onOpenProject?: ((projectId: string) => void) | undefined;
  onRepairProject: (projectId: string) => void;
  /** How many items Home shows, for the tab bar's count. */
  onCountChange?: (count: number) => void;
  /** Opens Verity's page from her header. */
  onOpenVerity?: (() => void) | undefined;
}) {
  const meetings = useUpcomingMeetings(client);
  const now = useClock(CLOCK_TICK_MS);
  const all = useMemo(
    () => inboxItems({ sessions, projects, meetings, now }),
    [sessions, projects, meetings, now],
  );
  const serverHidden = useMemo(
    () => inboxDismissedKeys({ sessions, projects }),
    [sessions, projects],
  );
  const feed = useInboxFeed({
    client,
    all,
    serverHidden,
    onOpenSession,
    onOpenProject,
    onRepairProject,
  });
  useEffect(() => onCountChange?.(feed.items.length), [feed.items.length, onCountChange]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      testID="home-inbox"
    >
      <VerityHeader summary={inboxSummary(feed.items)} onOpen={onOpenVerity} />
      {feed.items.length > 0 ? (
        <Text variant="eyebrow" style={styles.section}>
          For you
        </Text>
      ) : null}
      <InboxFeedList feed={feed} selectedSessionId={selectedSessionId} />
    </ScrollView>
  );
}

export type InboxFeed = ReturnType<typeof useInboxFeed>;

/**
 * The state behind an inbox list, shared by Home and a project's page: which
 * items show, which wait dismissed, and what an answer or an X does.
 *
 * Answers reuse the push-reply performer: the same idempotent routes and the
 * same optimistic status updates a notification action uses. A tapped item
 * hides at once and stays hidden until its source stops reporting it, so a slow
 * poll cannot bring it back for a second tap.
 *
 * The X dismisses an item for the operator on all their devices (a meeting's X
 * is its Skip). It hides at once and is saved after; if saving fails the card
 * returns with a message. Dismissed items wait folded at the bottom to restore.
 */
export function useInboxFeed({
  client,
  all,
  serverHidden,
  onOpenSession,
  onOpenProject,
  onRepairProject,
  onSaved,
}: {
  client: VerityClient;
  /** Every item in inbox order, dismissed ones included. */
  all: readonly InboxItem[];
  /** The keys the server reports dismissed for this person; memoised by the caller. */
  serverHidden: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onOpenProject?: ((projectId: string) => void) | undefined;
  onRepairProject: (projectId: string) => void;
  /** After an answer or a dismissal is saved, for a screen that does not poll. */
  onSaved?: (() => void) | undefined;
}) {
  const perform = useMemo(() => createPushReplyPerformer(client), [client]);
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  // One reply id per item until it is delivered: a second tap after a `retry`
  // (whose first request may have landed) reuses it, so the server's idempotency
  // key turns it into the same reply instead of a second prompt.
  const replyIds = useRef(new Map<string, string>());
  // State re-renders too late to stop a fast double tap; the ref does not.
  const running = useRef(false);

  // A dismissal or restore shows before it is saved: `true` hides, `false` shows,
  // until the synced lists agree or the item is gone.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    setOverrides((current) => {
      if (current.size === 0) return current;
      const live = new Set(all.map((item) => item.key));
      const next = new Map(
        [...current].filter(([key, hidden]) => live.has(key) && serverHidden.has(key) !== hidden),
      );
      return next.size === current.size ? current : next;
    });
  }, [all, serverHidden]);
  // Forget a settled key once its source no longer reports it, so the same kind
  // of item can come back later (a new permission reuses nothing).
  useEffect(() => {
    setSettled((current) => {
      if (current.size === 0) return current;
      const live = new Set(all.map((item) => item.key));
      const next = new Set([...current].filter((key) => live.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [all]);
  const isHidden = useCallback(
    (item: InboxItem) => overrides.get(item.key) ?? serverHidden.has(item.key),
    [overrides, serverHidden],
  );
  // Both lists keep the inbox order, so a restored item returns to its place.
  const ordered = useMemo(() => all.filter((item) => !settled.has(item.key)), [all, settled]);
  const items = useMemo(() => ordered.filter((item) => !isHidden(item)), [ordered, isHidden]);
  const hidden = useMemo(() => ordered.filter(isHidden), [ordered, isHidden]);
  // Fold the list again once it empties, so the next dismissal starts folded.
  useEffect(() => {
    if (hidden.length === 0) setShowHidden(false);
  }, [hidden.length]);

  const setDismissed = useCallback(
    (item: InboxItem, dismissed: boolean) => {
      const save =
        item.dismiss === 'session' && item.sessionId !== undefined
          ? () => client.setSessionInboxDismissed(item.sessionId!, item.key, dismissed)
          : item.dismiss === 'project' && item.projectId !== undefined
            ? () => client.setProjectInboxDismissed(item.projectId!, item.key, dismissed)
            : undefined;
      if (save === undefined) return;
      setOverrides((current) => new Map(current).set(item.key, dismissed));
      void Promise.resolve()
        .then(save)
        .then(
          // Outside the failure branch: the save landed whatever the follow-up does.
          () => onSaved?.(),
          () => {
            setOverrides((current) => {
              const next = new Map(current);
              next.delete(item.key);
              return next;
            });
            Alert.alert(
              dismissed ? 'Not hidden' : 'Not restored',
              'Verity could not save this. Try again in a moment.',
            );
          },
        );
    },
    [client, onSaved],
  );

  const run = useCallback(
    async (item: InboxItem, action: InboxAction) => {
      if (action.kind === 'open_session') return onOpenSession(action.sessionId);
      if (action.kind === 'open_project') {
        if (onOpenProject) onOpenProject(action.projectId);
        else router.push({ pathname: '/project/[id]', params: { id: action.projectId } });
        return;
      }
      if (action.kind === 'repair_project') return onRepairProject(action.projectId);
      const reply = replyFor(action);
      if (reply === null) return;
      if (running.current) return;
      running.current = true;
      setPending(item.key);
      const replyKey = `${item.key}:${action.kind}:${action.label}`;
      const replyId = replyIds.current.get(replyKey) ?? randomUUID();
      replyIds.current.set(replyKey, replyId);
      try {
        const outcome = await perform(reply, replyId);
        if (outcome === 'retry') {
          Alert.alert('Not sent', 'Verity could not reach the server. Try again in a moment.');
          return;
        }
        // `stale` means someone answered first; either way the item is done.
        replyIds.current.delete(replyKey);
        setSettled((current) => new Set(current).add(item.key));
        onSaved?.();
      } finally {
        running.current = false;
        setPending(null);
      }
    },
    [onOpenSession, onOpenProject, onRepairProject, onSaved, perform],
  );
  const dismiss = useCallback(
    (item: InboxItem) => {
      if (item.dismiss === 'meeting') {
        const skip = item.actions.find((action) => action.kind === 'skip_meeting');
        if (skip)
          run(item, skip).catch(() => {
            setPending(null);
            Alert.alert('Not sent', 'Something went wrong. Try again in a moment.');
          });
        return;
      }
      setDismissed(item, true);
    },
    [run, setDismissed],
  );

  return {
    items,
    hidden,
    pending,
    showHidden,
    toggleHidden: useCallback(() => setShowHidden((shown) => !shown), []),
    run,
    dismiss,
    restore: useCallback((item: InboxItem) => setDismissed(item, false), [setDismissed]),
  };
}

/** The cards of an inbox feed, then the fold of the dismissed ones. */
export function InboxFeedList({
  feed,
  selectedSessionId,
}: {
  feed: InboxFeed;
  selectedSessionId?: string | null | undefined;
}) {
  const { items, hidden, pending, showHidden, toggleHidden, run, dismiss, restore } = feed;
  return (
    <>
      {items.map((item) => (
        <InboxCard
          key={item.key}
          item={item}
          selected={item.sessionId !== undefined && item.sessionId === selectedSessionId}
          pending={pending === item.key}
          disabled={pending !== null}
          onDismiss={item.dismiss !== undefined ? () => dismiss(item) : undefined}
          onAction={(action) => {
            // `perform` reports failures as outcomes; anything it throws is
            // unexpected, but the operator still has to learn the answer was not sent.
            run(item, action).catch(() => {
              Alert.alert('Not sent', 'Something went wrong. Open the session and try again.');
            });
          }}
        />
      ))}
      {hidden.length > 0 ? (
        <View style={styles.hiddenToggle}>
          <Button
            label={`${String(hidden.length)} hidden`}
            variant="text"
            size="compact"
            onPress={toggleHidden}
          />
        </View>
      ) : null}
      {showHidden
        ? hidden.map((item) => (
            <InboxCard
              key={item.key}
              item={item}
              selected={false}
              pending={false}
              disabled={false}
              onRestore={() => restore(item)}
              onAction={() => undefined}
            />
          ))
        : null}
    </>
  );
}

/** Verity's identity and capture on Home; exported for the design-system catalog. */
export function VerityHeader({
  summary,
  onOpen,
}: {
  summary: string;
  /** Opens Verity's page (the new design); without it the identity is not a control. */
  onOpen?: (() => void) | undefined;
}) {
  const { theme } = useUnistyles();
  // The field opens quick capture, which only listens while task capture is on
  // and an account is known; without them it would be a button that does nothing.
  const capture = useTaskPreferences().enabled && taskAccountScope() !== null;
  return (
    <View style={styles.header}>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Verity, ${summary}`}
          accessibilityHint="Opens Verity's page with your instructions, memory and shared knowledge"
          onPress={onOpen}
          testID="home-verity"
          style={({ pressed }) => [styles.identity, pressed ? styles.capturePressed : null]}
        >
          <VerityIdentity summary={summary} testID="home-summary" />
          <Icon name="chevron-right" size={20} color={theme.colors.textMuted} />
        </Pressable>
      ) : (
        <View style={styles.identity}>
          <VerityIdentity summary={summary} testID="home-summary" />
        </View>
      )}
      {capture ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Tell Verity"
          accessibilityHint="Opens Verity to listen: ask her or tell her an idea, a mail or an appointment"
          onPress={() => dispatchVerityShortcut()}
          style={({ pressed }) => [styles.capture, pressed ? styles.capturePressed : null]}
        >
          <Text variant="body" tone="faint" style={styles.flex}>
            Tell Verity… an idea, a mail, an appointment
          </Text>
          <View style={styles.mic}>
            <Icon name="mic" size={20} color={theme.colors.action} />
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Verity's mark on its halo, her name and one line; shared by Home and her page. */
export function VerityIdentity({ summary, testID }: { summary: string; testID?: string }) {
  return (
    <>
      <View style={styles.markHalo}>
        <Image
          source={MARK}
          accessibilityIgnoresInvertColors
          style={{ width: 32, height: 32 / MARK_RATIO }}
        />
      </View>
      <View style={styles.flex}>
        <Text variant="title" accessibilityRole="header">
          Verity
        </Text>
        <Text variant="subtitle" testID={testID}>
          {summary}
        </Text>
      </View>
    </>
  );
}

/** One inbox item with its answers; exported for the design-system catalog. */
export function InboxCard({
  item,
  selected,
  pending,
  disabled,
  onAction,
  onDismiss,
  onRestore,
}: {
  item: InboxItem;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onAction: (action: InboxAction) => void;
  /** Shows the X that sets the item aside. */
  onDismiss?: (() => void) | undefined;
  /** Draws a dismissed item: muted, with Restore as its only answer. */
  onRestore?: (() => void) | undefined;
}) {
  const restoring = onRestore !== undefined;
  return (
    <View testID={restoring ? `inbox-hidden-${item.kind}` : `inbox-item-${item.kind}`}>
      <Card stacked selected={selected} muted={restoring}>
        <CardHead
          title={item.title}
          subtitle={item.context}
          trailing={<StatusTag intent={TAG_INTENT[item.tone]} label={item.tag} />}
          onDismiss={restoring || disabled ? undefined : onDismiss}
        />
        {item.message ? (
          <Text variant="bodySmall" tone="muted" numberOfLines={3}>
            {item.message}
          </Text>
        ) : null}
        {item.request !== undefined ? (
          // Allow is decided from exactly what the tool receives, so the input is
          // shown whole; a clipped summary could hide the part that matters.
          <Text variant="code" testID="inbox-request" selectable>
            {item.request}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {restoring ? (
            <Button label="Restore" size="compact" variant="secondary" onPress={onRestore} />
          ) : null}
          {(restoring ? [] : item.actions).map((action, index) => (
            <Button
              key={`${String(index)}:${action.kind}:${action.label}`}
              label={action.label}
              size="compact"
              variant={index === 0 ? 'primary' : 'secondary'}
              loading={pending && index === 0}
              disabled={disabled}
              onPress={() => onAction(action)}
            />
          ))}
        </View>
      </Card>
    </View>
  );
}

/** The network reply an answer becomes; navigation actions have none. */
export function replyFor(action: InboxAction): PushReplyAction | null {
  switch (action.kind) {
    case 'allow':
    case 'deny':
      return {
        type: 'decide-permission',
        sessionId: action.sessionId,
        toolUseId: action.toolUseId,
        decision: { behavior: action.kind },
      };
    case 'answer':
      return {
        type: 'send-turn',
        sessionId: action.sessionId,
        prompt: formatChoiceAnswer([action.answer]),
      };
    case 'resume':
      return { type: 'send-turn', sessionId: action.sessionId, prompt: RESUME_PROMPT };
    case 'merge':
      return {
        type: 'merge-pull-request',
        sessionId: action.sessionId,
        pullRequestNumber: action.number,
      };
    case 'join_meeting':
      return { type: 'join-calendar-meeting', eventKey: action.eventKey };
    case 'skip_meeting':
      return { type: 'skip-calendar-meeting', eventKey: action.eventKey };
    default:
      return null;
  }
}

/**
 * Online calendar meetings for the next hours, from the server's cached list. A
 * failure only hides meeting items; it never turns Home into an error screen.
 */
function useUpcomingMeetings(client: VerityClient): UpcomingMeeting[] {
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  const loadedAt = useRef(0);
  // Bound to the component, not to a focus pass: a read still in flight when
  // the screen loses focus must land, or the next focus within the refresh
  // window would neither show it nor read again.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(
    (force: boolean) => {
      if (!force && Date.now() - loadedAt.current < MEETING_REFRESH_MS) return;
      loadedAt.current = Date.now();
      void Promise.resolve()
        .then(() => client.getUpcomingMeetings())
        .then((list) => {
          if (mounted.current) setMeetings(list);
        })
        .catch(() => {
          if (mounted.current) setMeetings([]);
        });
    },
    [client],
  );
  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load]),
  );
  useEffect(() => {
    const timer = setInterval(() => load(true), MEETING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return meetings;
}

function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const styles = StyleSheet.create((theme) => {
  const colors = theme.colors;
  return {
    flex: { flex: 1 },
    content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
    header: { gap: theme.spacing.lg, paddingBottom: theme.spacing.lg },
    identity: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
    // Verity's identity on Home (§ 5.8): the meeting's V mark on a signature halo.
    markHalo: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.signature, 'neutral'),
      shadowColor: colors.signature,
      ...theme.elevation.glow,
    },
    capture: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.radius.control,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    capturePressed: { opacity: 0.7 },
    mic: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.control,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.action, 'fill'),
      borderWidth: 1,
      borderColor: tint(colors.action, 'border'),
    },
    section: { marginTop: theme.spacing.sm, marginBottom: theme.spacing.xs },
    hiddenToggle: { alignItems: 'center', marginTop: theme.spacing.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  };
});
