// Final onboarding step. The Next control returns to the app home; once setup is
// complete the first-run gate no longer redirects here.
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';

export default function OnboardingDone() {
  return (
    <OnboardingStepScaffold
      stepId="done"
      title="All set"
      back="/onboarding/first-project"
      next={{ href: '/', label: 'Open Verity' }}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Verity is ready</Text>
        <Text style={styles.body}>
          Your first project is set up. You can start an agent session, review changes, and open PRs
          from Verity.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Next</Text>
        <Text style={styles.body}>
          Optional services such as Doppler, Claude, and Codex can still be changed later in
          Settings.
        </Text>
      </View>
    </OnboardingStepScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  body: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
}));
