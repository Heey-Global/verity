// The Face ID / Touch ID opt-in card. Shared by the two places that can hold a
// freshly minted device token: the master-password step, and the pairing flow
// that enrolls a second device without ever asking for that password.
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './ui';

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
      <Button label="Use Face ID" loading={busy} onPress={onEnable} fullWidth />
      <Button label="Not now" variant="text" disabled={busy} onPress={onSkip} />
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
    ...theme.typography.row,
    color: theme.colors.text,
  },
  intro: {
    ...theme.typography.body,
    color: theme.colors.text,
  },
}));
