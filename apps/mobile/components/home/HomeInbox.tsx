import { ProjectInquiryCards } from '../project/ProjectInquiryCards';
import { ProjectWork } from '../project/ProjectWork';
import {
  inboxDismissedKeys,
  inboxItems,
  inboxSummary,
  type ProjectRecord,
  type SessionSummary,
  type UpcomingMeeting,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { VerityMark } from '../VerityMark';
import { FeedCard, useInboxFeed } from '../inbox/InboxFeed';
import { CaptureField, Text } from '../ui';
import { useTaskPreferences } from '../../lib/taskPreferences';
import { taskAccountScope } from '../../lib/tasksStore';
import { dispatchVerityShortcut } from '../../lib/voiceShortcut';
import { syncWatchInbox } from '../../lib/watchCapture';

// The inbox mechanics live with every work list; kept importable from Home.
export {
  InboxCard,
  RESUME_PROMPT,
  replyFor,
  useInboxFeed,
  type InboxFeed,
} from '../inbox/InboxFeed';

/** The cached calendar list is cheap, but a watched calendar rarely changes. */
const MEETING_REFRESH_MS = 5 * 60_000;
/** Re-evaluates the meeting window and "in N min" without new data. */
const CLOCK_TICK_MS = 30_000;
/**
 * Home: Verity's line and capture on top, then the same live work sections as
 * the project view, across all projects and with their context
 * (docs/design-system.md § 5.8 "Home presence").
 *
 * {@link ProjectWork} owns session placement and rows in both views;
 * {@link useInboxFeed} answers and dismisses the explicit inbox decisions.
 */
export function HomeInbox({
  client,
  sessions,
  projects,
  selectedSessionId,
  refreshing,
  layoutRevision = 0,
  onRefresh,
  onSessionChanged,
  onOpenSession,
  onOpenProject,
  onRepairProject,
  onCountChange,
  onOpenVerity,
  scrollRef,
}: {
  client: VerityClient;
  scrollRef?: Ref<ScrollView>;
  sessions: readonly SessionSummary[];
  projects: readonly ProjectRecord[];
  /** The session shown in the wide layout's right pane, drawn as selected. */
  selectedSessionId?: string | null;
  refreshing: boolean;
  /** Explicit refresh rebuilds the visit order and clears retained read results. */
  layoutRevision?: number;
  onRefresh: () => void;
  /** Reload after edits without resetting the visit order. */
  onSessionChanged?: (sessionId: string, deleted: boolean) => void;
  /** `mockups` opens the session with its mockup review in front. */
  onOpenSession: (sessionId: string, options?: { mockups?: boolean }) => void;
  /** Where "Open" on a project item leads; the project route when omitted. */
  onOpenProject?: ((projectId: string) => void) | undefined;
  onRepairProject: (projectId: string) => void;
  /** How many entries need the user, excluding running work and unread results. */
  onCountChange?: (count: number) => void;
  /** Opens Verity's page from her header. */
  onOpenVerity?: (() => void) | undefined;
}) {
  const meetings = useUpcomingMeetings(client);
  const now = useClock(CLOCK_TICK_MS);
  const workSessions = useMemo(() => {
    const archived = new Set(
      projects.filter((project) => project.archived === true).map((project) => project.id),
    );
    return sessions.filter(
      (session) => session.projectId == null || !archived.has(session.projectId),
    );
  }, [sessions, projects]);
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
  const [counts, setCounts] = useState({ needs: 0, active: 0, results: 0 });
  const onSectionsChange = useCallback((next: typeof counts) => {
    setCounts((current) =>
      current.needs === next.needs &&
      current.active === next.active &&
      current.results === next.results
        ? current
        : next,
    );
  }, []);
  useEffect(() => onCountChange?.(counts.needs), [counts.needs, onCountChange]);
  const changed = useCallback(
    (sessionId: string, deleted: boolean) => {
      if (onSessionChanged) onSessionChanged(sessionId, deleted);
      else onRefresh();
    },
    [onSessionChanged, onRefresh],
  );
  const summaryParts = [
    counts.needs === feed.items.length
      ? inboxSummary(feed.items)
      : counts.needs > 0
        ? `${String(counts.needs)} need you`
        : inboxSummary([]),
    ...(counts.active > 0 ? [`${String(counts.active)} in progress`] : []),
    ...(counts.results > 0 ? [`${String(counts.results)} new results`] : []),
  ];
  // The watch lists the same items under "Needs you" (targets/VerityWatch).
  // The account the items were read for: taken when their sources arrive, so a
  // list still from the previous account is never sent under the next one.
  const itemsScope = useMemo(() => taskAccountScope(), [sessions, projects, meetings]);
  // The clock tick resends an unchanged list now and then, so its time stays true.
  useEffect(() => {
    const signedIn = taskAccountScope();
    // Signed out, or switched before the new account's lists arrived: clear it.
    if (signedIn !== itemsScope) syncWatchInbox([], null);
    else syncWatchInbox(feed.items, itemsScope);
  }, [feed.items, itemsScope, now]);

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      testID="home-inbox"
    >
      <VerityHeader summary={summaryParts.join(' · ')} onOpen={onOpenVerity} />
      <ProjectInquiryCards client={client} />
      <ProjectWork
        client={client}
        sessions={workSessions}
        projects={projects}
        feed={feed}
        overview
        layoutRevision={layoutRevision}
        selectedSessionId={selectedSessionId}
        // Meetings belong to no project; everything else is the same list a
        // project's page draws, across all projects.
        leadingRows={feed.items
          .filter((item) => item.kind === 'meeting')
          .map((item) => (
            <FeedCard key={item.key} feed={feed} item={item} selected={false} />
          ))}
        onSectionsChange={onSectionsChange}
        onOpenSession={onOpenSession}
        onChanged={changed}
      />
    </ScrollView>
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
        <CaptureField
          placeholder="Tell Verity… an idea, a mail, an appointment"
          accessibilityLabel="Tell Verity"
          accessibilityHint="Opens Verity to listen: ask her or tell her an idea, a mail or an appointment"
          onOpen={() => dispatchVerityShortcut()}
        />
      ) : null}
    </View>
  );
}

/** Verity's mark on its halo, her name and one line; shared by Home and her page. */
export function VerityIdentity({ summary, testID }: { summary: string; testID?: string }) {
  return (
    <>
      <VerityMark />
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

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  header: { gap: theme.spacing.lg, paddingBottom: theme.spacing.lg },
  identity: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  // Verity's identity on Home (§ 5.8): the meeting's V mark on a signature halo.
  capturePressed: { opacity: 0.7 },
}));
