// Older deep links keep working after optional services leave onboarding.
import { Redirect } from 'expo-router';

export default function LegacyOnboardingStep() {
  return <Redirect href="/settings/services/doppler" />;
}
