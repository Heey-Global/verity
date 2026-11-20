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
import { RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FeedCard, useInboxFeed } from '../inbox/InboxFeed';
import { Group, Row, Text } from '../ui';
import { taskAccountScope } from '../../lib/tasksStore';
import { syncWatchInbox } from '../../lib/watchCapture';

// The inbox mechanics live with every work list; kept importable from Home.
export { InboxCard, RESUME_PROMPT, replyFor, useInboxFeed } from '../inbox/InboxFeed';

type SectionCounts = { needs: number; active: number; results: number };

/** The cached calendar list is cheap, but a watched calendar rarely changes. */
const MEETING_REFRESH_MS = 5 * 60_000;
/** Re-evaluates the meeting window and "in N min" without new data. */
const CLOCK_TICK_MS = 30_000;
/**
 * Home: the same live work sections as the project view, across all projects
 * and with their context, then a quiet way to Shared knowledge. Verity herself
 * is reached through the floating V (docs/design-system.md § 5.8 "Home presence").
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
  onOpenSharedKnowledge,
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
  /** Opens Shared knowledge, the reference pages every project reads. */
  onOpenSharedKnowledge: () => void;
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
  // `null` until the sections first report, so the quiet line cannot flash
  // on mount before the work is placed.
  const [counts, setCounts] = useState<SectionCounts | null>(null);
  const onSectionsChange = useCallback((next: SectionCounts) => {
    setCounts((current) =>
      current !== null &&
      current.needs === next.needs &&
      current.active === next.active &&
      current.results === next.results
        ? current
        : next,
    );
  }, []);
  const needs = counts?.needs ?? 0;
  useEffect(() => onCountChange?.(needs), [needs, onCountChange]);
  const meetingItems = feed.items.filter((item) => item.kind === 'meeting');
  // Without a header, an empty Home would show nothing but the knowledge row.
  const quiet =
    counts !== null &&
    counts.needs + counts.active + counts.results === 0 &&
    meetingItems.length === 0;
  const changed = useCallback(
    (sessionId: string, deleted: boolean) => {
      if (onSessionChanged) onSessionChanged(sessionId, deleted);
      else onRefresh();
    },
    [onSessionChanged, onRefresh],
  );
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
        leadingRows={meetingItems.map((item) => (
          <FeedCard key={item.key} feed={feed} item={item} selected={false} />
        ))}
        onSectionsChange={onSectionsChange}
        onOpenSession={onOpenSession}
        onChanged={changed}
      />
      {quiet ? (
        <Text variant="body" tone="muted" testID="home-quiet">
          {inboxSummary([])}
        </Text>
      ) : null}
      {/* Last and quiet: rarely opened, but findable where the work is. */}
      <View style={styles.sharedKnowledge} testID="home-shared-knowledge">
        <Group>
          <Row
            title="Shared knowledge"
            subtitle="Reference pages every project reads"
            leading={{ icon: 'globe', quiet: true }}
            navigates
            onPress={onOpenSharedKnowledge}
          />
        </Group>
      </View>
    </ScrollView>
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
  // The room below lets the last row scroll clear of the floating V.
  content: {
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxxl * 2,
    gap: theme.spacing.sm,
  },
  sharedKnowledge: { paddingTop: theme.spacing.xl },
}));
