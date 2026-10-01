import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SERVER_UPDATE_ROUTE } from '../lib/serverUpdateRoute';
import { Icon } from './Icon';

/**
 * A full-width strip under the overview header announcing a Server release.
 *
 * It replaces a dot on the settings button, which pointed at a screen two levels
 * above the one that can actually install the update. The whole strip is the
 * target, so the operator lands on the install screen in one tap.
 */
export function ServerUpdateBanner({ version }: { version: string }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      // `navigate`, not `push`: the banner stays up until the update is installed,
      // so a second tap returns to the screen rather than stacking another copy.
      onPress={() => router.navigate(SERVER_UPDATE_ROUTE)}
      style={({ pressed }) => [styles.banner, pressed ? styles.pressed : null]}
      accessibilityRole="button"
      accessibilityLabel={`Verity ${version} available. Open server update`}
    >
      <View style={styles.icon}>
        <Icon name="download" size={16} color={theme.colors.onPrimary} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          Verity {version} available
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          See what&apos;s new and install
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={theme.colors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 52,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
  },
}));
