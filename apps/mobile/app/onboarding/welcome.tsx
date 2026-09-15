// Preflight welcome. No server is selected yet, so this is deliberately not
// part of the numbered setup wizard.
import * as Application from 'expo-application';
import { type Href, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { describeBuild, runningReleaseVersion } from '../../lib/buildInfo';

const NEXT = '/onboarding/server-url' as Href;

export default function OnboardingWelcome() {
  const insets = useSafeAreaInsets();
  const version = runningReleaseVersion(Application.nativeApplicationVersion);
  const build = describeBuild();
  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>Verity</Text>
        <Text
          style={styles.version}
          accessibilityLabel={`Version ${version}, bundle ${build.text}`}
        >
          Version {version} · Bundle {build.text}
        </Text>
        <Text style={styles.title} accessibilityRole="header">
          Secure development. Your choice of AI.
        </Text>

        <View style={styles.card}>
          <Text style={styles.lead}>
            Run Claude Code, Codex, and open-source models through OpenCode in isolated project
            sandboxes. Every session gets its own branch and worktree, while credentials stay
            outside agent runtimes and your history stays on your server.
          </Text>
          <Text style={styles.lead}>
            Switch AI providers without changing how you manage projects, review changes, or ship
            your work.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Get started</Text>
          <Text style={styles.item}>1. Install Verity on your Linux server with Docker.</Text>
          <Text style={styles.item}>
            2. Scan the installer QR code to pair this device securely.
          </Text>
          <Text style={styles.item}>3. Connect your preferred AI provider, then open Verity.</Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.footerInner}>
          <View style={styles.footerSpacer} />
          <Pressable
            style={({ pressed }) => [styles.nextButton, pressed ? styles.pressed : null]}
            onPress={() => router.push(NEXT)}
            accessibilityRole="button"
            accessibilityLabel="Continue"
          >
            <Text style={styles.nextLabel}>Continue</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.md,
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  version: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '800',
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  lead: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  item: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
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
  nextButton: {
    minHeight: 48,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  nextLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.62,
  },
}));
