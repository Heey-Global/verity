import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, Text } from '../../components/ui';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../../components/ui/SessionBar';
import type { ReactNode } from 'react';

const ignore = () => undefined;

/**
 * A session waiting for mockup review. The mockups arrive as the agent's chat
 * message, large enough to read in place; a revision is a new message, so the
 * history keeps every round. Above the composer only a slim bar stays while the
 * build waits, because the message scrolls away as soon as the chat goes on.
 */
export function SessionChat({ gallery }: { gallery: ReactNode }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.transcript}>
        <View style={styles.message}>
          <Text variant="body">
            Here are the mockups for the three screens in the approved plan, built from the app's
            own components. Implementation waits until you approve them.
          </Text>
          {gallery}
        </View>
        <View style={styles.userMessage}>
          <Text variant="body">Does the desktop spec also work at tablet width?</Text>
        </View>
        <Text variant="body">
          Yes: below 900 px the spec switches to the phone layout you see in the second mockup.
        </Text>
      </ScrollView>
      <SessionBar trailing={<Button label="Review" size="compact" onPress={ignore} />}>
        <SessionBarTarget accessibilityLabel="Review mockups" onPress={ignore}>
          <SessionBarContent
            color={theme.colors.action}
            title="Mockups waiting for you"
            subtitle="1 of 3 approved · 1 comment"
          />
        </SessionBarTarget>
      </SessionBar>
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
        <Text variant="body" tone="faint">
          Message the agent…
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  transcript: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  message: { gap: theme.spacing.md },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composer: {
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
}));
