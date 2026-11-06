import { inboxDismissedKeys, inboxItems, type VerityClient } from '@verity/mobile';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { StatusTag, Text } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { tint } from '../ui/tint';
import { useProjectRowDrag, type ProjectReorderController } from '../useProjectReorder';
import type { SessionProjectGroup } from '../../lib/projectGroups';
import { projectInboxItems } from './ProjectPage';
import { ProjectWork, workFilter } from './ProjectWork';

/** What a project card says instead of listing its sessions. */
export type ProjectCardFacts = {
  /** Inbox items in this project the person has not dismissed. */
  waiting: number;
  /** Sessions working or waiting on someone. */
  running: number;
  /** The project's own problem, if it reports one. */
  health?: { label: string; intent: StatusIntent } | undefined;
};

export function projectCardFacts(group: SessionProjectGroup, now: number): ProjectCardFacts {
  const project = group.project;
  const sessions = group.sessions;
  // Sessions outside a project bring only their own items.
  const all = project
    ? projectInboxItems(project, sessions, now)
    : inboxItems({ sessions, projects: [], now });
  const dismissed = inboxDismissedKeys({ sessions, projects: project ? [project] : [] });
  // Findings are the page's Security card; the card keeps the project's own problems.
  const status = group.project ? group.health : group.status;
  return {
    waiting: all.filter((item) => !dismissed.has(item.key)).length,
    running: sessions.filter((session) => workFilter(session, 'running')).length,
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
  if (parts.length > 0) return parts.join(' · ');
  const count = group.sessions.length;
  if (count > 0) return count === 1 ? '1 session' : `${String(count)} sessions`;
  return group.subtitle || 'No sessions yet';
}

/**
 * A project in the new design's project list (Settings › This app): its name,
 * what waits and what runs, and its health — never its sessions, which live on
 * the project page a tap opens. A held press picks the card up to reorder, the
 * same gesture as the classic list.
 *
 * Groups without a project page (sessions outside any project, Verity Control)
 * open in place instead and list their sessions as the page's Work tab does.
 */
export function ProjectCard({
  group,
  client,
  now,
  reorder,
  renderedOrder,
  sortable,
  floating = false,
  reordering,
  expanded,
  onOpen,
  onToggle,
  onOpenSession,
  onSessionChanged,
}: {
  group: SessionProjectGroup;
  client: VerityClient;
  now: number;
  reorder: ProjectReorderController;
  renderedOrder: readonly string[];
  sortable: boolean;
  floating?: boolean;
  reordering: boolean;
  /** For a group that opens in place: whether its sessions show. */
  expanded: boolean;
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
  const facts = projectCardFacts(group, now);
  const inPlace = onOpen === undefined;
  const onLayout = (event: LayoutChangeEvent) => {
    // The pitch the drag moves rows by: the folded card (its head plus the
    // card's top and bottom border) and the list's separator below it.
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
          accessibilityRole="button"
          accessibilityLabel={
            reordering ? `Move ${group.title}` : `${group.title}, ${projectCardLine(group, facts)}`
          }
          accessibilityHint={
            inPlace ? 'Shows its sessions. Hold to reorder.' : 'Opens the project. Hold to reorder.'
          }
          accessibilityState={inPlace ? { expanded } : {}}
          style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
        >
          <View style={styles.initial}>
            <Text variant="row" tone="action">
              {(Array.from(group.title.trim())[0] ?? '?').toUpperCase()}
            </Text>
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
              <StatusTag intent={facts.health.intent} label={facts.health.label} />
            </View>
          ) : null}
          <Icon
            name={inPlace ? (expanded ? 'chevron-down' : 'chevron-right') : 'chevron-right'}
            size={18}
            color={theme.colors.textMuted}
          />
        </Pressable>
        {inPlace && expanded && !floating ? (
          <View style={styles.sessions}>
            <ProjectWork
              client={client}
              projectId={group.project?.id}
              sessions={group.sessions}
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
    marginHorizontal: theme.spacing.md,
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
  body: { flex: 1, minWidth: 0 },
  health: { maxWidth: '45%' },
  sessions: { padding: theme.spacing.md, paddingTop: 0 },
}));
