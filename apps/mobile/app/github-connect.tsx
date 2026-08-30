// Standalone "Manage GitHub connection" screen. Reached from Settings, it reuses the
// same one-action authorization flow as onboarding (<GithubConnectPanel>) WITHOUT the
// onboarding wizard chrome and WITHOUT being forced through the rest of the wizard.
// The onboarding gate exempts this route (see useOnboardingGate) so disconnecting
// here does NOT bounce the operator into the wizard — they can disconnect and
// reconnect a different App in place, then return to Settings.
import {
  VerityApiError,
  type VerityClient,
  type VeritySettings,
  type OnboardingStatus,
} from '@verity/mobile';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GithubConnectPanel } from '../components/GithubConnectPanel';
import { createVerityClient } from '../lib/client';

export default function GithubConnectScreen() {
  const client = createVerityClient();
  if (client === null) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: 'GitHub' }} />
        <Text style={styles.centerTitle}>Not connected</Text>
        <Text style={styles.centerSubtitle}>
          Configure your Verity server address in setup before managing a GitHub connection.
        </Text>
      </View>
    );
  }
  return <GithubConnectView client={client} />;
}

// A usable GitHub App connection requires all three credentials. A stored PEM by
// itself can sign an App JWT but cannot address an App or installation, so showing
// it as connected strands the user on a summary whose API calls cannot work.
function isConnected(settings: VeritySettings | null): boolean {
  if (settings === null) return false;
  return (
    settings.githubAppPrivateKeyConfigured &&
    settings.githubAppId !== null &&
    settings.githubAppInstallationId !== null
  );
}

function GithubConnectView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<VeritySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [disconnecting, setDisconnecting] = useState(false);
  // Once the operator hits Disconnect we drop straight into the connect panel even
  // though a re-fetch of settings would also flip `isConnected` false — this keeps
  // the transition immediate and independent of the reload timing.
  const [reconnecting, setReconnecting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    void client
      .getVeritySettings()
      .then((next) => setSettings(next))
      .catch((caught) => {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load settings.');
      })
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const disconnect = useCallback(() => {
    setDisconnecting(true);
    setError(undefined);
    void client
      .disconnectGithub()
      .then(() => {
        setReconnecting(true);
        load();
      })
      .catch((caught) =>
        setError(
          caught instanceof VerityApiError ? caught.message : 'Could not disconnect GitHub.',
        ),
      )
      .finally(() => setDisconnecting(false));
  }, [client, load]);

  // A successful authorization returns the operator to Settings. We do NOT
  // navigate into onboarding — this screen is exempt from the wizard gate.
  const onConnected = useCallback((_status?: OnboardingStatus) => {
    router.back();
  }, []);

  if (loading) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: 'GitHub' }} />
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const connected = !reconnecting && isConnected(settings);

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'GitHub' }} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        {connected ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle} accessibilityRole="header">
              GitHub connected
            </Text>
            <Text style={styles.panelSubtitle}>
              This Verity server is connected to GitHub. Disconnect to authorize a different account
              or organization.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.disconnectButton,
                disconnecting ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={disconnect}
              disabled={disconnecting}
              accessibilityRole="button"
              accessibilityLabel="Disconnect GitHub"
            >
              {disconnecting ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : null}
              <Text style={styles.disconnectLabel}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect GitHub'}
              </Text>
            </Pressable>
          </View>
        ) : (
          <GithubConnectPanel client={client} onConnected={onConnected} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  centerTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  centerSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    textAlign: 'center',
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  panel: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  panelSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  disconnectButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
  },
  disconnectLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.62,
  },
}));
