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
const JOIN = '/onboarding/join' as Href;
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
        <Text style={styles.title} accessibilityRole="header">
          Verity
        </Text>
        <Text style={styles.lead}>Build software with the AI of your choice.</Text>
        <Text
          style={styles.version}
          accessibilityLabel={`Version ${version}, bundle ${build.text}`}
        >
          Version {version} · Bundle {build.text}
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.footerInner}>
          <Button
            label="Set up my own server"
            disabled={startingDemo}
            onPress={() => router.push(NEXT)}
            fullWidth
          />
          <Button
            label="Join a shared project"
            variant="secondary"
            disabled={startingDemo}
            onPress={() => router.push(JOIN)}
            fullWidth
          />
          <Button
            label="Try demo"
            accessibilityHint="Explore Verity with local sample data, without a server"
            variant="text"
            fullWidth
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  logo: {
    width: 96,
    height: 68,
    marginBottom: theme.spacing.sm,
  },
  title: {
    ...theme.typography.display,
    color: theme.colors.text,
  },
  lead: {
    ...theme.typography.body,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  version: {
    ...theme.typography.footnote,
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
    gap: theme.spacing.sm,
  },
}));
