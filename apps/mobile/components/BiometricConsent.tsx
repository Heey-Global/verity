// The Face ID / Touch ID opt-in card. Shared by the two places that can hold a
// freshly minted device token: the master-password step, and the pairing flow
// that enrolls a second device without ever asking for that password.
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export function BiometricConsent({
  busy,
  onEnable,
  onSkip,
}: {
  busy: boolean;
  onEnable: () => void;
  onSkip: () => void;
}) {
  const { theme } = useUnistyles();
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
        {busy ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
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
    backgroundColor: theme.colors.setup.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  intro: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  primaryButton: {
    minHeight: 44,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  secondaryButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.62,
  },
}));
