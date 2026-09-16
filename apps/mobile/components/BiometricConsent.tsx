// The Face ID / Touch ID opt-in card. Shared by the two places that can hold a
// freshly minted device token: the master-password step, and the pairing flow
// that enrolls a second device without ever asking for that password.
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export function BiometricConsent({
  busy,
  onEnable,
  onSkip,
}: {
  busy: boolean;
  onEnable: () => void;
  onSkip: () => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Use Face ID or Touch ID?</Text>
      <Text style={styles.intro}>
        Verity can use this device's biometric unlock to load your local device token next time.
        Your master password still protects the server secrets.
      </Text>
      <Pressable
        style={({ pressed }) => [
          styles.primaryButton,
          busy ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={onEnable}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Use Face ID"
      >
        {busy ? <ActivityIndicator size="small" color="#05050a" /> : null}
        <Text style={styles.primaryButtonLabel}>Use Face ID</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.secondaryButton,
          busy ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={onSkip}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Not now"
      >
        <Text style={styles.secondaryButtonLabel}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  intro: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.62,
  },
}));
