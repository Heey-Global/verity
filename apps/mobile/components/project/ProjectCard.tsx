import { inboxDismissedKeys, inboxItems, type VerityClient } from '@verity/mobile';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { CountBadge, StatusTag, Text, TileMark } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { tint } from '../ui/tint';
import { ReorderHandle } from '../ui/ReorderHandle';
import { useProjectRowDrag, type ProjectReorderController } from '../useProjectReorder';
import { WorkingDot } from '../WorkingDot';
import type { SessionProjectGroup } from '../../lib/projectGroups';
import { moveProjectIdToIndex, projectSortableRange } from '../../lib/projectReorder';
import { projectInboxItems } from './ProjectPage';
import { isActive, ProjectWork } from './ProjectWork';

/** What a project card says instead of listing its sessions. */
export type ProjectCardFacts = {
  /** Inbox items in this project the person has not dismissed. */
  waiting: number;
  /** Sessions working or waiting on someone. */
  running: number;
  /** Whether any session is working right now: the card's pulsing mark. */
  working: boolean;
  /** Idle sessions with activity the person has not opened yet. */
  fresh: number;
  /** The project's own problem, if it reports one. */
  health?: { label: string; intent: StatusIntent } | undefined;
};

export function projectCardFacts(
  group: SessionProjectGroup,
  now: number,
  unread: ReadonlySet<string> = new Set(),
): ProjectCardFacts {
  const project = group.project;
  const sessions = group.sessions;
  // Sessions outside a project bring only their own items.
  const all = project
    ? projectInboxItems(project, sessions, now)
    : inboxItems({ sessions, projects: [], now });
  const dismissed = inboxDismissedKeys({ sessions, projects: project ? [project] : [] });
  // Findings are the page's Security row; the card keeps the project's own problems.
  const status = group.project ? group.health : group.status;
  return {
    waiting: all.filter((item) => !dismissed.has(item.key)).length,
    running: sessions.filter((session) => isActive(session) || session.status === 'awaiting_input')
      .length,
    working: sessions.some(isActive),
    // A working session's unread mark gives way to its working one, as in the
    // session rows, so only idle sessions count as new.
    fresh: sessions.filter((session) => !isActive(session) && unread.has(session.sessionId)).length,
    health:
      status === undefined
        ? undefined
        : {
            label: status.label,
            intent:
              status.tone === 'working'
                ? 'transient'
                : status.tone === 'attention' || status.tone === 'danger'
                  ? 'needsSetup'
                  : 'optional',
          },
  };
}

/** The line under the project's name: what waits and what runs, or its metadata. */
export function projectCardLine(group: SessionProjectGroup, facts: ProjectCardFacts): string {
  const parts: string[] = [];
  if (facts.waiting > 0) parts.push(`${String(facts.waiting)} waiting for you`);
  if (facts.running > 0) parts.push(`${String(facts.running)} running`);
  if (facts.fresh > 0) parts.push(`${String(facts.fresh)} new`);
  if (parts.length > 0) return parts.join(' · ');
  const count = group.sessions.length;
  if (count > 0) return count === 1 ? '1 session' : `${String(count)} sessions`;
  return group.subtitle || 'No sessions yet';
}

/**
 * The mark on the initial's corner, in the session rows' vocabulary: pulsing
 * signature while a session works, action for something new. A project waiting
 * for the person carries its count instead, which already says there is news.
 */
function cardMark(facts: ProjectCardFacts): 'working' | 'unread' | undefined {
  if (facts.working) return 'working';
  if (facts.fresh > 0 && facts.waiting === 0) return 'unread';
  return undefined;
}

/**
 * A project in the new design's project list (Settings › This app): its name,
 * what waits and what runs, and its health — never its sessions, which live on
 * the project page a tap opens. Sorting exposes a dedicated drag handle.
 *
 * Groups without a project page (sessions outside any project, Verity Control)
 * open in place instead and list their sessions as the page's work list does.
 */
export function ProjectCard({
  group,
  client,
  now,
  unread,
  reorder,
  renderedOrder,
  sortable,
  sortableIds = renderedOrder,
  sorting = false,
  onMove,
  floating = false,
  reordering,
  expanded,
  onOpen,
  onToggle,
  onOpenSession,
  onSessionChanged,
  layoutRevision,
}: {
  group: SessionProjectGroup;
  client: VerityClient;
  now: number;
  /** Session ids with activity the person has not opened yet. */
  unread: ReadonlySet<string>;
  reorder: ProjectReorderController;
  renderedOrder: readonly string[];
  sortable: boolean;
  sortableIds?: readonly string[];
  sorting?: boolean;
  onMove?: (order: readonly string[]) => void;
  floating?: boolean;
  reordering: boolean;
  /** For a group that opens in place: whether its sessions show. */
  expanded: boolean;
  layoutRevision?: number;
  /** Opens the project page; absent for a group without one. */
  onOpen?: (() => void) | undefined;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
  onSessionChanged: (sessionId: string, deleted: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const { slotRef, rowRef, handleCallbackRef, style } = useProjectRowDrag({
    id: group.id,
    reorder,
    renderedOrder,
    enabled: sortable && sorting,
    floating,
  });
  const index = renderedOrder.indexOf(group.id);
  const range = projectSortableRange(renderedOrder, sortableIds, group.id);
  const facts = projectCardFacts(group, now, unread);
  const mark = cardMark(facts);
  const inPlace = onOpen === undefined;
  const onLayout = (event: LayoutChangeEvent) => {
    // Include the card borders and list separator in the distance between slots.
    if (!floating)
      reorder.reportCompactHeight(
        group.id,
        event.nativeEvent.layout.height + 2 * CARD_BORDER + theme.spacing.md,
      );
  };
  return (
    <Reanimated.View ref={slotRef} collapsable={false}>
      <Reanimated.View
        ref={rowRef}
        collapsable={false}
        style={[styles.card, style]}
        testID={`project-card-${group.id}`}
      >
        <Pressable
          collapsable={false}
          onLayout={onLayout}
          onPress={reordering || sorting ? undefined : (onOpen ?? onToggle)}
          accessible={!sorting}
          accessibilityRole="button"
          accessibilityLabel={
            reordering ? `Move ${group.title}` : `${group.title}, ${projectCardLine(group, facts)}`
          }
          accessibilityHint={
            sorting
              ? 'Use the handle to reorder.'
              : inPlace
                ? 'Shows its sessions.'
                : 'Opens the project.'
          }
          accessibilityState={inPlace ? { expanded } : {}}
          style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
        >
          <View style={styles.initial}>
            <Text variant="row" tone="action">
              {(Array.from(group.title.trim())[0] ?? '?').toUpperCase()}
            </Text>
            {mark !== undefined ? (
              <View
                style={styles.mark}
                testID={`project-card-mark-${group.id}`}
                accessibilityRole="image"
                accessibilityLabel={mark === 'working' ? 'Agent is working' : 'Unread messages'}
              >
                {mark === 'working' ? (
                  <TileMark tone="signature" pulsing />
                ) : (
                  <TileMark tone="action" />
                )}
              </View>
            ) : null}
          </View>
          <View style={styles.body}>
            <Text variant="row" numberOfLines={1}>
              {group.title}
            </Text>
            <Text variant="subtitle" numberOfLines={1} testID={`project-card-line-${group.id}`}>
              {projectCardLine(group, facts)}
            </Text>
          </View>
          {facts.health ? (
            <View style={styles.health}>
              {facts.health.intent === 'transient' ? (
                // The project's own work in progress (updating, rebuilding) in
                // the same pulsing signature as a working session.
                <View style={styles.working}>
                  <WorkingDot size={8} label={facts.health.label} />
                  <Text variant="bodySmall" tone="muted" numberOfLines={1} style={styles.shrink}>
                    {facts.health.label}
                  </Text>
                </View>
              ) : (
                <StatusTag intent={facts.health.intent} label={facts.health.label} />
              )}
            </View>
          ) : null}
          {facts.waiting > 0 ? (
            <CountBadge
              count={facts.waiting}
              label="waiting for you"
              testID={`project-card-waiting-${group.id}`}
            />
          ) : null}
          {sorting ? (
            sortable ? (
              <ReorderHandle
                ref={handleCallbackRef}
                label={`Move ${group.title}`}
                canMoveUp={index > range.min}
                canMoveDown={index < range.max}
                disabled={reordering}
                onMove={(direction) =>
                  onMove?.(moveProjectIdToIndex(renderedOrder, group.id, index + direction))
                }
              />
            ) : null
          ) : (
            <Icon
              name={inPlace ? (expanded ? 'chevron-down' : 'chevron-right') : 'chevron-right'}
              size={18}
              color={theme.colors.textMuted}
            />
          )}
        </Pressable>
        {inPlace && expanded && !floating ? (
          <View style={styles.sessions}>
            <ProjectWork
              client={client}
              projectId={group.project?.id}
              sessions={group.sessions}
              layoutRevision={layoutRevision}
              // The card's head already says what waits and runs; opened, it
              // shows every session rather than a Now without in-place answers.
              initialFilter="all"
              onOpenSession={onOpenSession}
              onChanged={onSessionChanged}
            />
          </View>
        ) : null}
      </Reanimated.View>
    </Reanimated.View>
  );
}

const CARD_BORDER = 1;

const styles = StyleSheet.create((theme) => ({
  card: {
    borderRadius: theme.radius.card,
    borderWidth: CARD_BORDER,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 64,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  initial: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  mark: { position: 'absolute', top: -3, right: -3 },
  body: { flex: 1, minWidth: 0 },
  health: { maxWidth: '45%' },
  working: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  shrink: { flexShrink: 1, minWidth: 0 },
  sessions: { padding: theme.spacing.md, paddingTop: 0 },
}));
