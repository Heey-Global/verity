import {
  createPushReplyPerformer,
  formatChoiceAnswer,
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
import { dispatchTaskVoiceShortcut } from '../../lib/voiceShortcut';

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
 * project list's markers. Answers reuse the push-reply performer: the same
 * idempotent routes and the same optimistic status updates a notification
 * action uses. A tapped item hides at once and stays hidden until its source
 * stops reporting it, so a slow poll cannot bring it back for a second tap.
 */
export function HomeInbox({
  client,
  sessions,
  projects,
  selectedSessionId,
  refreshing,
  onRefresh,
  onOpenSession,
  onRepairProject,
  onCountChange,
}: {
  client: VerityClient;
  sessions: readonly SessionSummary[];
  projects: readonly ProjectRecord[];
  /** The session shown in the wide layout's right pane, drawn as selected. */
  selectedSessionId?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSession: (sessionId: string) => void;
  onRepairProject: (projectId: string) => void;
  /** How many items Home shows, for the tab bar's count. */
  onCountChange?: (count: number) => void;
}) {
  const meetings = useUpcomingMeetings(client);
  const now = useClock(CLOCK_TICK_MS);
  const perform = useMemo(() => createPushReplyPerformer(client), [client]);
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);

  const all = useMemo(
    () => inboxItems({ sessions, projects, meetings, now }),
    [sessions, projects, meetings, now],
  );
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
  const items = useMemo(() => all.filter((item) => !settled.has(item.key)), [all, settled]);
  useEffect(() => onCountChange?.(items.length), [items.length, onCountChange]);

  const run = useCallback(
    async (item: InboxItem, action: InboxAction) => {
      if (action.kind === 'open_session') return onOpenSession(action.sessionId);
      if (action.kind === 'open_project') {
        router.push({ pathname: '/project/[id]', params: { id: action.projectId } });
        return;
      }
      if (action.kind === 'repair_project') return onRepairProject(action.projectId);
      const reply = replyFor(action);
      if (reply === null) return;
      setPending(item.key);
      try {
        const outcome = await perform(reply, randomUUID());
        if (outcome === 'retry') {
          Alert.alert('Not sent', 'Verity could not reach the server. Try again in a moment.');
          return;
        }
        // `stale` means someone answered first; either way the item is done.
        setSettled((current) => new Set(current).add(item.key));
      } finally {
        setPending(null);
      }
    },
    [onOpenSession, onRepairProject, perform],
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      testID="home-inbox"
    >
      <VerityHeader summary={inboxSummary(items)} />
      {items.length > 0 ? (
        <Text variant="eyebrow" style={styles.section}>
          For you
        </Text>
      ) : null}
      {items.map((item) => (
        <InboxCard
          key={item.key}
          item={item}
          selected={item.sessionId !== undefined && item.sessionId === selectedSessionId}
          pending={pending === item.key}
          disabled={pending !== null}
          onAction={(action) => {
            // `perform` reports failures as outcomes; anything it throws is
            // unexpected, but the operator still has to learn the answer was not sent.
            run(item, action).catch(() => {
              setPending(null);
              Alert.alert('Not sent', 'Something went wrong. Open the session and try again.');
            });
          }}
        />
      ))}
    </ScrollView>
  );
}

/** Verity's identity and capture on Home; exported for the design-system catalog. */
export function VerityHeader({ summary }: { summary: string }) {
  const { theme } = useUnistyles();
  // The field opens quick capture, which only listens while task capture is on
  // and an account is known; without them it would be a button that does nothing.
  const capture = useTaskPreferences().enabled && taskAccountScope() !== null;
  return (
    <View style={styles.header}>
      <View style={styles.identity}>
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
          <Text variant="subtitle" testID="home-summary">
            {summary}
          </Text>
        </View>
      </View>
      {capture ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Tell Verity"
          accessibilityHint="Records a note for Verity: an idea, a mail or an appointment"
          onPress={() => dispatchTaskVoiceShortcut({ target: 'assistant' })}
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

/** One inbox item with its answers; exported for the design-system catalog. */
export function InboxCard({
  item,
  selected,
  pending,
  disabled,
  onAction,
}: {
  item: InboxItem;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onAction: (action: InboxAction) => void;
}) {
  return (
    <View testID={`inbox-item-${item.kind}`}>
      <Card stacked selected={selected}>
        <CardHead
          title={item.title}
          subtitle={item.context}
          trailing={<StatusTag intent={TAG_INTENT[item.tone]} label={item.tag} />}
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
          {item.actions.map((action, index) => (
            <Button
              key={`${action.kind}:${action.label}`}
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
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  };
});
