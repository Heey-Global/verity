// Shared frame for every onboarding step screen. Renders the step title, the
// <OnboardingProgress> indicator, an arbitrary body, and the Back/Next controls.
// Keeping the frame here means every step shares identical layout + accessible
// navigation controls.
import { type Href, router } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { type StepId, stepProgress } from '@verity/mobile';

import { OnboardingProgress } from './OnboardingProgress';
import { Button } from './ui';

export function OnboardingStepScaffold({
  stepId,
  title,
  children,
  back,
  next,
}: {
  stepId: StepId;
  title: string;
  children?: ReactNode;
  /** Target route for the Back control, or `null`/absent to hide it (first step). */
  back?: Href | null;
  /** Target route for the Next control + its label; absent hides it (last step). */
  next?: { href: Href; label?: string; disabled?: boolean } | null;
}) {
  const insets = useSafeAreaInsets();
  const { index, total } = stepProgress(stepId);
  return (
    // The Back/Next footer is pinned below the scroll view, so the frame — not
    // the scroll view — has to shrink: `padding` keeps Next reachable while a
    // step's field is being filled in. Unlike React Native's own
    // KeyboardAvoidingView this one follows the keyboard on Android too, where
    // `behavior` used to be left off entirely.
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top + 24 }]}>
        <View style={styles.headerInner}>
          <OnboardingProgress current={index} total={total} />
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.body}>{children}</View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.footerInner}>
          {back ? (
            <Button label="Back" variant="secondary" onPress={() => router.replace(back)} />
          ) : (
            <View style={styles.footerSpacer} />
          )}
          {next ? (
            <Button
              label={next.label ?? 'Next'}
              disabled={next.disabled === true}
              onPress={() => router.push(next.href)}
            />
          ) : (
            <View style={styles.footerSpacer} />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Lightweight note body for any future explanatory-only onboarding step. */
function OnboardingPlaceholderNote({ children }: { children: ReactNode }) {
  return (
    <View style={styles.note}>
      <Text style={styles.noteText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
    backgroundColor: theme.colors.background,
  },
  headerInner: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.md,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  title: {
    ...theme.typography.display,
    color: theme.colors.text,
  },
  body: {
    flex: 1,
    gap: theme.spacing.sm,
  },
  note: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  noteText: {
    ...theme.typography.body,
    color: theme.colors.text,
  },
  noteTag: {
    ...theme.typography.label,
    color: theme.colors.textMuted,
  },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  footerInner: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  footerSpacer: {
    minWidth: 88,
  },
}));
