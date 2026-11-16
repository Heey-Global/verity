import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, IconButton, Row, Text } from '../../components/ui';
import { tint } from '../../components/ui/tint';
import { SessionComposer } from '../wiki/parts';

export const ignore = () => undefined;

/**
 * Who does what in the Wiki, as the empty Wiki and the "How the Wiki works"
 * sheet explain it: you bring sources and decide, Verity writes and maintains,
 * nothing changes without your confirmation.
 */
export function HowItWorks() {
  return (
    <Group>
      <Row
        leading={{ icon: 'paperclip' }}
        title="You bring sources and questions"
        subtitle="Meetings, finished sessions, merges, documents"
        wrap
      />
      <Row
        leading={{ icon: 'book-open' }}
        title="Verity writes and maintains"
        subtitle="Readable pages, every statement with its source"
        wrap
      />
      <Row
        leading={{ icon: 'check-circle' }}
        title="You confirm every change"
        subtitle="Proposals wait under To review until you accept"
        wrap
      />
    </Group>
  );
}

/** The ⓘ in the Wiki's header that opens "How the Wiki works". */
export function InfoHeader() {
  return (
    <Stack.Screen
      options={{
        headerRight: () => (
          <IconButton icon="info" accessibilityLabel="How the Wiki works" onPress={ignore} />
        ),
      }}
    />
  );
}

/**
 * The number of proposals waiting on a row, in the action tone.
 * Design-system gap: `StatusTag` has no count variant; the plan extends
 * components/ui/Status with one, which these values copy until then.
 */
export function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <View style={styles.badge} accessible accessibilityLabel={`${String(count)} ${label}`}>
      <Text variant="label" tone="action">
        {String(count)}
      </Text>
    </View>
  );
}

/** A message from Verity in a session transcript. */
export function VerityMessage({ children }: { children: ReactNode }) {
  return <View style={styles.verity}>{children}</View>;
}

/** A message from you, right-aligned as in the session. */
export function UserMessage({ children }: { children: string }) {
  return (
    <View style={styles.user}>
      <Text variant="body">{children}</Text>
    </View>
  );
}

/** A session: the transcript and the shared composer below it. */
export function Session({
  children,
  placeholder = 'Message Verity…',
}: {
  children: ReactNode;
  placeholder?: string;
}) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.transcript}>{children}</ScrollView>
      <View style={styles.composer}>
        <SessionComposer placeholder={placeholder} />
      </View>
    </View>
  );
}

/** "Before" and "after" of one change, the old text muted. */
export function BeforeAfter({ before, after }: { before?: string; after: string }) {
  return (
    <View style={styles.compare}>
      {before !== undefined ? (
        <>
          <Text variant="footnote" tone="muted">
            Before
          </Text>
          <Text variant="bodySmall" tone="muted">
            {before}
          </Text>
        </>
      ) : null}
      <Text variant="footnote" tone="muted">
        {before !== undefined ? 'After' : 'New'}
      </Text>
      <Text variant="bodySmall">{after}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  transcript: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  verity: { gap: theme.spacing.sm },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composer: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    backgroundColor: theme.colors.background,
  },
  badge: {
    minWidth: 24,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    alignItems: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  compare: { gap: theme.spacing.xs },
}));
