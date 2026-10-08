import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The app's switch track and knob, drawn rather than native so it looks the same
 * on every platform: a hairline track, a muted knob when off, a primary knob on a
 * lit track when on. Purely visual; the caller owns the Pressable, its role and
 * its 44 pt touch area.
 */
export function Toggle({ value, disabled = false }: { value: boolean; disabled?: boolean }) {
  return (
    <View style={[styles.track, value ? styles.trackOn : null, disabled ? styles.disabled : null]}>
      <View style={[styles.knob, value ? styles.knobOn : null]} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    width: 46,
    height: 26,
    padding: 3,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.setup.surfaceAlt,
  },
  trackOn: {
    borderColor: theme.colors.setup.text,
    backgroundColor: `${theme.colors.setup.text}33`,
  },
  knob: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.setup.textMuted,
  },
  knobOn: {
    transform: [{ translateX: 20 }],
    backgroundColor: theme.colors.primary,
  },
  disabled: { opacity: 0.45 },
}));
