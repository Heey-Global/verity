import type { CollaborationEntry } from '@verity/mobile';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../Icon';
import { Text } from '../../ui';
import { tint } from '../../ui/tint';
import { CollaborationTile } from './CollaborationTile';
import { rowEntries, rowText } from './model';

/**
 * Says a new answer once. The row's text is also a polite live region, which
 * Android reads on change; iOS and the web need the explicit announcement.
 * Answers already there when the session opens are not news.
 */
function useAnswerAnnouncement(entries: readonly CollaborationEntry[]) {
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const answers = entries.filter((entry) => entry.state === 'answer');
    const previous = known.current;
    known.current = new Set(answers.map((entry) => entry.sessionId));
    if (previous === null) return;
    const fresh = answers.find((entry) => !previous.has(entry.sessionId));
    if (fresh) AccessibilityInfo.announceForAccessibility(`Answer from ${fresh.projectName}`);
  }, [entries]);
}

/**
 * The collaboration row under the session title. Absent while the session
 * works alone. One peer: its name, and a tap opens it. Several: up to three
 * project tiles, and a tap opens the list. A decision waiting for the person
 * turns the row to the attention tone.
 */
export function CollaborationRow({
  entries,
  onOpenEntry,
  onOpenList,
}: {
  entries: readonly CollaborationEntry[];
  onOpenEntry: (entry: CollaborationEntry) => void;
  onOpenList: () => void;
}) {
  const { theme } = useUnistyles();
  const shown = rowEntries(entries);
  useAnswerAnnouncement(shown);
  if (shown.length === 0) return null;
  const single = shown.length === 1;
  const urgent = shown.some((entry) => entry.state === 'waitingForYou');
  const { summary, detail } = rowText(shown);
  const spoken = detail === undefined ? summary : `${summary}, ${detail}`;
  return (
    <View style={styles.wrap}>
      <Pressable
        testID="collaboration-row"
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={
          single ? 'Opens this session' : 'Lists the sessions working with this one'
        }
        onPress={() => (single ? onOpenEntry(shown[0]!) : onOpenList())}
        style={({ pressed }) => [styles.row, urgent && styles.urgent, pressed && styles.pressed]}
      >
        <View style={styles.stack}>
          {shown.slice(0, 3).map((entry, index) => (
            <CollaborationTile
              key={entry.sessionId}
              projectName={entry.projectName}
              state={entry.state}
              stacked={index > 0}
            />
          ))}
          {shown.length > 3 ? (
            <View style={[styles.more, styles.moreStacked]}>
              <Text variant="caption" tone="muted">
                +{shown.length - 3}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.text} accessibilityLiveRegion="polite">
          <Text variant="footnote" numberOfLines={2}>
            <Text variant="footnote" style={styles.strong} tone={urgent ? 'attention' : 'default'}>
              {summary}
            </Text>
            {detail === undefined ? null : (
              <Text variant="footnote" tone="muted">
                {` · ${detail}`}
              </Text>
            )}
          </Text>
        </View>
        <Icon
          name={single ? 'chevron-right' : 'chevron-down'}
          size={18}
          color={urgent ? theme.colors.attention : theme.colors.textMuted}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
  // A minimum, not a height: the row grows with large system text.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
    paddingLeft: 4,
    paddingRight: theme.spacing.md,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  urgent: {
    backgroundColor: tint(theme.colors.attention, 'neutral'),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tint(theme.colors.attention, 'border'),
  },
  pressed: { opacity: 0.7 },
  stack: { flexDirection: 'row', alignItems: 'center' },
  more: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  moreStacked: { marginLeft: -8 },
  text: { flex: 1, minWidth: 0 },
  strong: { fontFamily: theme.fonts.semibold },
}));
