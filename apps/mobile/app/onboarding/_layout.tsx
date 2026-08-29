// Onboarding wizard sub-stack (#320, PR 1: shell). A nested expo-router Stack for
// the onboarding step screens. Headers are hidden here — each step renders its own
// title + progress via <StepScaffold> — so the wizard reads as a focused flow
// rather than the app's normal navigation chrome. The root layout registers this
// `onboarding` group as a single Stack.Screen.
import { Stack } from 'expo-router';

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animationTypeForReplace: 'pop',
      }}
    />
  );
}
