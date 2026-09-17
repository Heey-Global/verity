// Shared frame for every onboarding step screen. Renders the step title, the
// <OnboardingProgress> indicator, an arbitrary body, and the Back/Next controls.
// Keeping the frame here means every step shares identical layout + accessible
// navigation controls.
import { type Href, router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { type StepId, stepProgress } from '@verity/mobile';

import { OnboardingProgress } from './OnboardingProgress';

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
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
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
            <Pressable
              style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
              onPress={() => {
                router.replace(back);
              }}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Text style={styles.backLabel}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.footerSpacer} />
          )}
          {next ? (
            <Pressable
              style={({ pressed }) => [
                styles.nextButton,
                next.disabled ? styles.nextButtonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => {
                if (!next.disabled) router.push(next.href);
              }}
              disabled={next.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: next.disabled === true }}
              accessibilityLabel={next.label ?? 'Next'}
            >
              <Text style={styles.nextLabel}>{next.label ?? 'Next'}</Text>
            </Pressable>
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
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    gap: theme.spacing.sm,
  },
  note: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  noteText: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  noteTag: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
    backgroundColor: theme.colors.setup.surface,
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
  backButton: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.sm,
  },
  backLabel: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  nextButton: {
    minHeight: 44,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  nextButtonDisabled: {
    opacity: 0.45,
  },
  nextLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.62,
  },
}));
