import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * Layout for a card pinned above the composer, outside the scrolling
 * transcript (an approval waiting for a decision). Such a card grows with its
 * content, and nothing scrolls it: an email preview or a long briefing would
 * otherwise push the card's own Allow button below the screen edge, where it
 * cannot be reached. It takes at most this share of the session column, and
 * `flexShrink` lets it give way further when the keyboard narrows the column.
 *
 * The bound alone would clip the buttons; the card puts its variable-length
 * content in a `PinnedScroll` and keeps its head and buttons outside it.
 */
export const pinnedCardLayout = {
  maxHeight: '60%',
  flexShrink: 1,
  minHeight: 0,
} as const;

/** The scrolling middle of a pinned card: shrinks to the space its head and buttons leave. */
export function PinnedScroll({
  children,
  gap = 'md',
  testID,
}: {
  children: ReactNode;
  /** The card's own gap between blocks, so the scrolling part spaces them the same. */
  gap?: 'xs' | 'sm' | 'md';
  testID?: string;
}) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles[gap]}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flexGrow: 0, flexShrink: 1 },
  xs: { gap: theme.spacing.xs },
  sm: { gap: theme.spacing.sm },
  md: { gap: theme.spacing.md },
}));
