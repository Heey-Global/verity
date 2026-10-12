import { ActivityIndicator, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// The knob is white in both themes, so what sits on it is a fixed dark ink
// rather than a theme role that turns light in one of them.
const KNOB = '#ffffff';
const KNOB_INK = '#03141a';

/**
 * The switch visual (docs/design-system.md § 5.5): a filled track — `textFaint`
 * when off, `action` when on — with a white knob outlined in `background`, so
 * the state reads from the track alone and the knob stays visible on either.
 * Purely visual: the row around it owns the press, the `switch` role and the
 * 44 pt touch area. `switching` shows a spinner in the knob until the server
 * confirms the new value.
 */
export function Toggle({
  value,
  disabled = false,
  switching = false,
}: {
  value: boolean;
  disabled?: boolean;
  switching?: boolean;
}) {
  return (
    <View
      style={[styles.track, value ? styles.trackOn : null, disabled ? styles.disabled : null]}
      testID="toggle-track"
    >
      <View style={[styles.knob, value ? styles.knobOn : null]}>
        {switching ? (
          <ActivityIndicator size="small" color={KNOB_INK} style={styles.spinner} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    width: 46,
    height: 28,
    padding: 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.textFaint,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: theme.colors.action },
  knob: {
    width: 24,
    height: 24,
    borderRadius: theme.radius.pill,
    backgroundColor: KNOB,
    borderWidth: 1,
    borderColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  knobOn: { transform: [{ translateX: 18 }] },
  spinner: { transform: [{ scale: 0.6 }] },
  disabled: { opacity: 0.4 },
}));
