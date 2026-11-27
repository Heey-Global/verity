import type { ProjectCardState, ProjectCardStateKind } from '@verity/mobile';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StatusTag, Text } from '../ui';
import { tint } from '../ui/tint';

/** The state as a word, for VoiceOver: the tile's colour must not carry it alone. */
export const PROJECT_STATE_WORD: Record<ProjectCardStateKind, string> = {
  running: 'Running',
  paused: 'Not running',
  error: 'Error',
};

/** The initial's colour role per state: the tile carries the project itself. */
const INITIAL_TONE = { running: 'action', paused: 'faint', error: 'attention' } as const;

/**
 * A project's initial on a tile coloured by its state, the same on its card in
 * the list and on its page, so opening a project never changes its colour.
 * `children` sit on the tile, such as the card's agent mark in its corner.
 */
export function ProjectStateTile({
  title,
  state,
  size,
  spoken = false,
  testID,
  children,
}: {
  title: string;
  state: ProjectCardStateKind;
  size: 'card' | 'hero';
  /** Reads the state aloud; the card says it in its own label instead. */
  spoken?: boolean;
  testID?: string;
  children?: ReactNode;
}) {
  return (
    <View
      style={[size === 'card' ? styles.card : styles.hero, styles[state]]}
      testID={testID}
      {...(spoken
        ? {
            accessible: true,
            accessibilityRole: 'image' as const,
            accessibilityLabel: PROJECT_STATE_WORD[state],
          }
        : {})}
    >
      <Text variant={size === 'card' ? 'row' : 'title'} tone={INITIAL_TONE[state]}>
        {(Array.from(title.trim())[0] ?? '?').toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

/**
 * The card's state note where a page has room beside the project's name: a
 * project on its way (Starting…, Waking…) with a spinner, a resting one
 * (asleep) as a quiet word. Notes that ask for something are left to the
 * page's Needs you rows, which say what to do.
 */
export function ProjectStateNote({ state }: { state: ProjectCardState }) {
  const note = state.note;
  if (state.state !== 'paused' || note === undefined || note.tone !== 'muted') return null;
  return (
    <View style={styles.note} testID="project-state-note">
      {note.transient ? (
        <StatusTag intent="transient" label={note.label} />
      ) : (
        <Text variant="subtitle" tone="muted" numberOfLines={1}>
          {note.label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The name gives way first; the state stays whole.
  note: { flexShrink: 0 },
  running: { backgroundColor: tint(theme.colors.action, 'fill') },
  paused: { backgroundColor: tint(theme.colors.text, 'neutral') },
  error: { backgroundColor: tint(theme.colors.attention, 'fill') },
}));
