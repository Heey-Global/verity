import { type Href, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from './Icon';
import { IconButton } from './ui';

/** The screen the update is started from — the banner and the push both lead here. */
export const SERVER_UPDATE_ROUTE = '/settings/server-update' as Href;

/**
 * A full-width strip under the overview header announcing a Server release.
 *
 * It replaces a dot on the settings button, which pointed at a screen two levels
 * above the one that can actually install the update. The strip is the target,
 * so the operator lands on the install screen in one tap.
 *
 * `onDismiss` puts it away until the next version. Without it there is no close
 * button: next to a failed or stuck update the banner is the way to the problem,
 * not an offer to decline.
 */
export function ServerUpdateBanner({
  version,
  problem = false,
  onDismiss,
}: {
  version: string;
  problem?: boolean;
  onDismiss?: () => void;
}) {
  const { theme } = useUnistyles();
  const subtitle = problem ? 'The last update did not finish' : "See what's new and install";
  return (
    <View style={styles.banner}>
      <Pressable
        // `navigate`, not `push`: the banner stays up until the update is installed,
        // so a second tap returns to the screen rather than stacking another copy.
        onPress={() => router.navigate(SERVER_UPDATE_ROUTE)}
        style={({ pressed }) => [styles.target, pressed ? styles.pressed : null]}
        accessibilityRole="button"
        accessibilityLabel={`Verity ${version} available. ${subtitle}. Open updates`}
      >
        <View style={styles.icon}>
          <Icon name="download" size={16} color={theme.colors.onAction} />
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>
            Verity {version} available
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={theme.colors.action} />
      </Pressable>
      {onDismiss !== undefined ? (
        <IconButton
          icon="x"
          onPress={onDismiss}
          accessibilityLabel={`Hide until the version after ${version}`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    minHeight: 52,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  target: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
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
    backgroundColor: theme.colors.action,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
}));
