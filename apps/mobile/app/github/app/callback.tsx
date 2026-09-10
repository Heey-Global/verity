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
  const handledCallbacks = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [retryUrl, setRetryUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const phase = one(params.phase);
    const state = one(params.state);
    const phaseValue = phase === 'created' ? one(params.code) : one(params.installation_id);
    const callbackKey = `${phase}:${state}:${phaseValue}`;
    if (handledCallbacks.current.has(callbackKey)) return;
    setError(null);
    setRetryUrl(null);
    const client = createVerityClient();
    const returnTo =
      one(params.returnTo) === '/onboarding/github' ? '/onboarding/github' : '/github-connect';
    if (client === null || state.length === 0 || phaseValue.length === 0) {
      setError('The GitHub callback is incomplete. Return to Verity and try again.');
      return;
    }
    handledCallbacks.current.add(callbackKey);

    const complete =
      phase === 'created'
        ? client.completeGithubManifest(phaseValue, state).then(async (installUrl) => {
            // The second GitHub step remains in the regular browser session.
            try {
              await Linking.openURL(installUrl);
            } catch {
              setRetryUrl(installUrl);
              setError('GitHub is ready. Try opening the installation page again.');
            }
          })
        : phase === 'installed'
          ? client
              .completeGithubManifestInstallation(phaseValue, state)
              .then(() => router.replace(returnTo))
          : Promise.reject(new Error('unknown callback phase'));

    void complete.catch((caught) => {
      handledCallbacks.current.delete(callbackKey);
      setError(
        caught instanceof VerityApiError
          ? caught.message
          : 'GitHub authorization could not be completed. Return to Verity and try again.',
      );
    });
  }, [params, retry]);

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
          <Pressable
            style={styles.button}
            onPress={() =>
              retryUrl === null ? setRetry((value) => value + 1) : void Linking.openURL(retryUrl)
            }
          >
            <Text style={styles.buttonLabel}>
              {retryUrl === null ? 'Try again' : 'Open GitHub'}
            </Text>
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
