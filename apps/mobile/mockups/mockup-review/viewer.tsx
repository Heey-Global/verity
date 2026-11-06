import { Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, StatusTag, Text } from '../../components/ui';
import { PageDots, SAMPLE_SCREENS } from './parts';

const ignore = () => undefined;

/**
 * Full-screen review, opened from Home, the chat or the session bar: one screen large,
 * swipe for the next, Comment and Approve side by side at the bottom.
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
        <StatusTag intent="optional" label="Commented" />
      </View>
      <View style={styles.stage}>
        <Image
          source={current.image}
          resizeMode="contain"
          accessibilityLabel={`${current.name} mockup`}
          style={styles.image}
        />
      </View>
      <PageDots count={SAMPLE_SCREENS.length} index={index} />
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.md) }]}>
        {current.state.kind === 'comment' ? (
          <Text variant="bodySmall" tone="muted">
            Your comment: “{current.state.text}”
          </Text>
        ) : null}
        <View style={styles.actions}>
          <View style={styles.flex}>
            <Button label="Edit comment" variant="secondary" fullWidth onPress={ignore} />
          </View>
          <View style={styles.flex}>
            <Button label="Approve" fullWidth onPress={ignore} />
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
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
}));
