import {
  inboxDismissedKeys,
  inboxItems,
  projectAgentMark,
  projectCardState,
  type ProjectCardState,
  type SessionAgentMark,
  type VerityClient,
} from '@verity/mobile';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { AGENT_MARK, AgentTileMark } from '../AgentMark';
import { Text } from '../ui';
import { tint } from '../ui/tint';
import {
  PROJECT_PICKUP_DELAY_MS,
  useProjectRowDrag,
  type ProjectReorderController,
} from '../useProjectReorder';
import type { SessionProjectGroup } from '../../lib/projectGroups';
import { moveProjectIdToIndex, projectSortableRange } from '../../lib/projectReorder';
import { projectInboxItems } from './ProjectPage';
import { isActive, ProjectWork } from './ProjectWork';

/** What a project card says instead of listing its sessions. */
export type ProjectCardFacts = {
  /** Things in this project waiting for the person, not dismissed. The
   *  project's own problems are left to its state note. */
  waiting: number;
  /** Sessions working or waiting on someone. */
  running: number;
  /** Idle sessions with activity the person has not opened yet. */
  fresh: number;
  /** The tile's colour and the note at the end of the subtitle. */
  state: ProjectCardState;
  /** The agents' mark on the tile's corner, as on a session row. */
  mark: SessionAgentMark | undefined;
};

/** Groups whose project the list cannot show: neither running nor broken. */
const UNKNOWN_PROJECT: ProjectCardState = { state: 'paused' };
/** Sessions outside any project run on the Server itself. */
const NO_PROJECT: ProjectCardState = { state: 'running' };

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
  // A broken sandbox or a stuck update is the state note's to say; counting it
  // here as well put "1 waiting for you" and "Needs repair" on the same line.
  const waiting = all.filter(
    (item) => item.kind !== 'project_health' && !dismissed.has(item.key),
  ).length;
  return {
    waiting,
    running: sessions.filter((session) => isActive(session) || session.status === 'awaiting_input')
      .length,
    // A working session's unread mark gives way to its working one, as in the
    // session rows, so only idle sessions count as new.
    fresh: sessions.filter((session) => !isActive(session) && unread.has(session.sessionId)).length,
    state: project
      ? projectCardState(project)
      : group.id.startsWith('orphan:')
        ? UNKNOWN_PROJECT
        : NO_PROJECT,
    mark: projectAgentMark({ sessions, unread, waiting: waiting > 0 }),
  };
}

/** The subtitle in its parts: what waits (in the attention colour), what runs,
 *  and the project's state note. */
function projectCardLineParts(
  group: SessionProjectGroup,
  facts: ProjectCardFacts,
): { waiting?: string; rest: string; note?: ProjectCardState['note'] } {
  const waiting = facts.waiting > 0 ? `${String(facts.waiting)} waiting for you` : undefined;
  const parts: string[] = [];
  if (facts.running > 0) parts.push(`${String(facts.running)} running`);
  if (facts.fresh > 0) parts.push(`${String(facts.fresh)} new`);
  const count = group.sessions.length;
  const note = facts.state.note;
  const rest =
    parts.length > 0 || waiting !== undefined
      ? parts.join(' · ')
      : count > 0
        ? count === 1
          ? '1 session'
          : `${String(count)} sessions`
        : // A state note says more than release metadata or "No sessions yet".
          note
          ? ''
          : group.subtitle || 'No sessions yet';
  return { ...(waiting ? { waiting } : {}), rest, ...(note ? { note } : {}) };
}

/** The line under the project's name: what waits and what runs, then its state. */
export function projectCardLine(group: SessionProjectGroup, facts: ProjectCardFacts): string {
  const { waiting, rest, note } = projectCardLineParts(group, facts);
  return [waiting, rest, note?.label].filter(Boolean).join(' · ');
}

const STATE_WORD: Record<ProjectCardState['state'], string> = {
  running: 'Running',
  paused: 'Not running',
  error: 'Error',
};

/**
 * A project in the new design's project list (Settings › This app): its name,
 * what waits and what runs, and its health — never its sessions, which live on
 * the project page a tap opens. A held press picks the card up to reorder; while
 * a card moves, drag handles replace the chevrons of every card that can move.
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
  onMove,
  floating = false,
  reordering,
  movingProjects = false,
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
  onMove?: (order: readonly string[]) => void;
  floating?: boolean;
  /** Any drag in the list, project or session: taps and move actions pause. */
  reordering: boolean;
  /** A project card is being dragged: the cards show handles and read as movable. */
  movingProjects?: boolean;
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
    enabled: sortable,
    floating,
  });
  const index = renderedOrder.indexOf(group.id);
  const range = projectSortableRange(renderedOrder, sortableIds, group.id);
  // Screen readers cannot hold and drag; they move a card one slot at a time.
  const moveActions =
    sortable && !reordering
      ? [
          ...(index > range.min ? [{ name: 'moveUp', label: 'Move up' }] : []),
          ...(index < range.max ? [{ name: 'moveDown', label: 'Move down' }] : []),
        ]
      : [];
  const facts = projectCardFacts(group, now, unread);
  const line = projectCardLineParts(group, facts);
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
          ref={handleCallbackRef}
          collapsable={false}
          onLayout={onLayout}
          onPress={reordering ? undefined : (onOpen ?? onToggle)}
          // A hold belongs to the drag: releasing it, moved or not, must not
          // also open the card, which Pressable does without a long-press handler.
          onLongPress={moveActions.length > 0 ? () => {} : undefined}
          delayLongPress={PROJECT_PICKUP_DELAY_MS}
          accessibilityRole="button"
          accessibilityLabel={
            movingProjects && sortable
              ? `Move ${group.title}`
              : [
                  group.title,
                  STATE_WORD[facts.state.state],
                  facts.mark !== undefined ? AGENT_MARK[facts.mark].label : undefined,
                  projectCardLine(group, facts),
                ]
                  .filter(Boolean)
                  .join(', ')
          }
          accessibilityHint={
            movingProjects && sortable
              ? undefined
              : (inPlace ? 'Shows its sessions.' : 'Opens the project.') +
                (moveActions.length > 0 ? ' Hold to reorder, or use the move actions.' : '')
          }
          accessibilityActions={moveActions}
          onAccessibilityAction={({ nativeEvent }) => {
            if (reordering || !moveActions.some((action) => action.name === nativeEvent.actionName))
              return;
            const direction = nativeEvent.actionName === 'moveUp' ? -1 : 1;
            onMove?.(moveProjectIdToIndex(renderedOrder, group.id, index + direction));
          }}
          accessibilityState={{ disabled: reordering, ...(inPlace ? { expanded } : {}) }}
          style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
        >
          <View
            style={[styles.initial, styles[facts.state.state]]}
            testID={`project-card-tile-${group.id}`}
          >
            <Text variant="row" tone={INITIAL_TONE[facts.state.state]}>
              {(Array.from(group.title.trim())[0] ?? '?').toUpperCase()}
            </Text>
            {facts.mark !== undefined ? (
              <View style={styles.mark}>
                <AgentTileMark mark={facts.mark} testID={`project-card-mark-${group.id}`} />
              </View>
            ) : null}
          </View>
          <View style={styles.body}>
            <Text
              variant="row"
              numberOfLines={1}
              tone={facts.state.state === 'paused' ? 'muted' : undefined}
            >
              {group.title}
            </Text>
            <Text variant="subtitle" numberOfLines={1} testID={`project-card-line-${group.id}`}>
              {line.waiting !== undefined ? (
                <Text variant="subtitle" tone="attention">
                  {line.waiting}
                </Text>
              ) : null}
              {line.waiting !== undefined && line.rest ? ' · ' : ''}
              {line.rest}
              {line.note ? (
                <>
                  {line.waiting !== undefined || line.rest ? ' · ' : ''}
                  <Text
                    variant="subtitle"
                    tone={line.note.tone === 'attention' ? 'attention' : 'muted'}
                  >
                    {line.note.label}
                  </Text>
                </>
              ) : null}
            </Text>
          </View>
          {sortable && (movingProjects || floating) ? (
            // Same size as the chevron it replaces, so the head keeps its layout.
            <View testID={`project-card-handle-${group.id}`}>
              <Icon name="menu" size={18} color={theme.colors.textMuted} />
            </View>
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

/** The initial's colour role per state: the tile carries the project itself. */
const INITIAL_TONE = { running: 'action', paused: 'faint', error: 'attention' } as const;

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
  },
  mark: { position: 'absolute', top: -3, right: -3 },
  body: { flex: 1, minWidth: 0 },
  running: { backgroundColor: tint(theme.colors.action, 'fill') },
  paused: { backgroundColor: tint(theme.colors.text, 'neutral') },
  error: { backgroundColor: tint(theme.colors.attention, 'fill') },
  sessions: { padding: theme.spacing.md, paddingTop: 0 },
}));
