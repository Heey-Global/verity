import { Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, IconButton, StatusTag, Text } from '../../components/ui';
import { PageDots, SAMPLE_SCREENS } from './parts';

const ignore = () => undefined;

/**
 * Full-screen review, opened from Home, the chat or the session bar: one screen large,
 * swipe for the next, and two equal marks at the bottom. This screen was discarded:
 * its mark shows in the tag and the button, and the image is dimmed.
 */
export default function ViewerMockup() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const current = SAMPLE_SCREENS[1]!;
  const index = 1;
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text variant="row">{current.name}</Text>
          <Text variant="subtitle">
            Pricing page · {String(index + 1)} of {String(SAMPLE_SCREENS.length)}
          </Text>
        </View>
        <StatusTag intent="needsSetup" label="Discarded" />
        <IconButton icon="x" accessibilityLabel="Close review" onPress={ignore} />
      </View>
      <View style={styles.stage}>
        <Image
          source={current.image}
          resizeMode="contain"
          accessibilityLabel={`${current.name} mockup`}
          style={[styles.image, styles.dimmed]}
        />
      </View>
      <PageDots count={SAMPLE_SCREENS.length} index={index} />
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.md) }]}>
        <View style={styles.actions}>
          <View style={styles.mark}>
            <Button
              label="Discarded"
              icon="x"
              size="compact"
              variant="destructive"
              fullWidth
              onPress={ignore}
            />
          </View>
          <View style={styles.mark}>
            <Button
              label="Approve"
              icon="check"
              size="compact"
              variant="secondary"
              fullWidth
              onPress={ignore}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  stage: { flex: 1, paddingHorizontal: theme.spacing.lg },
  image: {
    flex: 1,
    width: '100%',
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bar: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.sm },
  mark: { width: 150 },
  dimmed: { opacity: 0.4 },
}));
