import { VerityApiError } from '@verity/mobile';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../../lib/client';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function GithubManifestCallback() {
  const params = useLocalSearchParams<{
    phase?: string;
    code?: string;
    state?: string;
    installation_id?: string;
    returnTo?: string;
  }>();
  const { theme } = useUnistyles();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const client = createVerityClient();
    const phase = one(params.phase);
    const state = one(params.state);
    const returnTo =
      one(params.returnTo) === '/onboarding/github' ? '/onboarding/github' : '/github-connect';
    if (client === null || state.length === 0) {
      setError('The GitHub callback is incomplete. Return to Verity and try again.');
      return;
    }

    const complete =
      phase === 'created'
        ? client.completeGithubManifest(one(params.code), state).then((installUrl) =>
            // The second GitHub step remains in the regular browser session.
            Linking.openURL(installUrl),
          )
        : phase === 'installed'
          ? client
              .completeGithubManifestInstallation(one(params.installation_id), state)
              .then(() => router.replace(returnTo))
          : Promise.reject(new Error('unknown callback phase'));

    void complete.catch((caught) => {
      setError(
        caught instanceof VerityApiError
          ? caught.message
          : 'GitHub authorization could not be completed. Return to Verity and try again.',
      );
    });
  }, [params]);

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: 'GitHub' }} />
      {error === null ? (
        <>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.title}>Finishing GitHub authorization…</Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>GitHub connection failed</Text>
          <Text style={styles.message} accessibilityRole="alert">
            {error}
          </Text>
          <Pressable style={styles.button} onPress={() => router.replace('/github-connect')}>
            <Text style={styles.buttonLabel}>Return to GitHub settings</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: { color: theme.colors.textMuted, fontSize: theme.text.md, textAlign: 'center' },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.primary,
  },
  buttonLabel: { color: theme.colors.onPrimary, fontWeight: '700' },
}));
