// Preflight welcome. No server is selected yet, so this is deliberately not
// part of the numbered setup wizard.
import * as Application from 'expo-application';
import { useState } from 'react';
import { type Href, router } from 'expo-router';
import { Alert, Image, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { describeBuild, runningReleaseVersion } from '../../lib/buildInfo';
import { enterDemoMode } from '../../lib/demoMode';
import { Button } from '../../components/ui';

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
          <Button
            label="Try demo"
            accessibilityHint="Explore Verity with local sample data, without a server"
            variant="text"
            loading={startingDemo}
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
          />
          <Button label="Continue" disabled={startingDemo} onPress={() => router.push(NEXT)} />
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
    ...theme.typography.label,
    color: theme.colors.text,
  },
  version: {
    ...theme.typography.footnote,
    color: theme.colors.textMuted,
  },
  title: {
    ...theme.typography.display,
    color: theme.colors.text,
  },
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  lead: {
    ...theme.typography.body,
    color: theme.colors.text,
  },
  sectionTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  item: {
    ...theme.typography.subtitle,
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
}));
