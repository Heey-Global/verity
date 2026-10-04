// Preflight welcome. No server is selected yet, so this is deliberately not
// part of the numbered setup wizard.
import * as Application from 'expo-application';
import { useState } from 'react';
import { type Href, router } from 'expo-router';
import { Alert, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { describeBuild, runningReleaseVersion } from '../../lib/buildInfo';
import { enterDemoMode } from '../../lib/demoMode';

const NEXT = '/onboarding/server-url' as Href;
// The splash mark trimmed to its bounds, so it lines up with the text below.
const LOGO = require('../../assets/brand/verity-v-mark.png') as number;

export default function OnboardingWelcome() {
  const insets = useSafeAreaInsets();
  const version = runningReleaseVersion(Application.nativeApplicationVersion);
  const build = describeBuild();
  const [startingDemo, setStartingDemo] = useState(false);
  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Image
          source={LOGO}
          style={styles.logo}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          accessible={false}
        />
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
          <Pressable
            style={({ pressed }) => [styles.demoLink, pressed ? styles.pressed : null]}
            accessibilityRole="button"
            accessibilityLabel="Try demo"
            accessibilityHint="Explore Verity with local sample data, without a server"
            disabled={startingDemo}
            hitSlop={8}
            onPress={() => {
              setStartingDemo(true);
              void enterDemoMode()
                .then(() => router.replace('/'))
                .catch((error: unknown) => {
                  setStartingDemo(false);
                  Alert.alert(
                    'Could not start demo',
                    error instanceof Error ? error.message : 'Please try again.',
                  );
                });
            }}
          >
            <Text style={styles.demoLabel}>{startingDemo ? 'Starting demo…' : 'Try demo'}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.nextButton, pressed ? styles.pressed : null]}
            disabled={startingDemo}
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
  logo: {
    width: 64,
    height: 45,
    marginBottom: theme.spacing.sm,
  },
  eyebrow: {
    color: theme.colors.setup.text,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  version: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '600',
  },
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  lead: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  item: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
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
  demoLink: {
    minHeight: 44,
    justifyContent: 'center',
  },
  demoLabel: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    textDecorationLine: 'underline',
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
  nextLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.62,
  },
}));
