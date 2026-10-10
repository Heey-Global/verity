// Last onboarding stop: open the welcome session in the server's starter project.
// A fresh server provisions that project while the operator is still pairing and
// signing in, so the first request usually answers `ready` and this screen only
// flashes. When the sandbox is still being set up, it polls the same idempotent
// request and offers to skip to the home screen. Anything else, including an
// older server without the endpoint, goes straight home.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';

const POLL_MS = 2_000;
/** Past this, the sandbox setup is stuck rather than slow; the home screen shows it. */
const GIVE_UP_MS = 10 * 60_000;

export default function OnboardingStarter() {
  const { replay: replayParam } = useLocalSearchParams<{ replay?: string }>();
  const replay = replayParam === '1';
  const [attemptNumber, setAttemptNumber] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    setError(null);
    setPreparing(false);
    const client = createVerityClient();
    if (!client) {
      router.replace('/');
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let firstRequest = true;
    const attempt = async (): Promise<void> => {
      try {
        const welcome = await client.openWelcomeSession(
          replay ? { replay: true, retry: firstRequest } : undefined,
        );
        firstRequest = false;
        if (!active) return;
        if (welcome.state === 'ready' && welcome.sessionId !== null) {
          router.replace({ pathname: '/session/[id]', params: { id: welcome.sessionId } });
          return;
        }
        if (welcome.state === 'preparing' && Date.now() - started < GIVE_UP_MS) {
          setPreparing(true);
          timer = setTimeout(() => void attempt(), POLL_MS);
          return;
        }
        if (replay) {
          setError('The welcome tour could not be prepared. Try again or return home.');
          return;
        }
      } catch {
        // An older server without the endpoint, or a transient failure: the home
        // screen is where the operator would have landed before this existed.
      }
      if (active && replay) {
        setError('Could not open the welcome tour. Check your connection and try again.');
        return;
      }
      if (active) router.replace('/');
    };
    void attempt();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [replay, attemptNumber]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.center}>
        {!error ? <ActivityIndicator size="large" color={theme.colors.setup.text} /> : null}
        <Text style={styles.title} accessibilityRole="header">
          {error
            ? 'Could not open welcome tour'
            : preparing
              ? 'Preparing your starter project…'
              : 'Opening Verity…'}
        </Text>
        {error ? (
          <>
            <Text style={styles.lead}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setAttemptNumber((value) => value + 1)}
            >
              <Text style={styles.skipLabel}>Try again</Text>
            </Pressable>
          </>
        ) : null}
        {preparing && !error ? (
          <Text style={styles.lead}>
            {replay
              ? 'Verity is preparing a sandbox for your starter project.'
              : 'Verity is setting up a sandbox for your first project. This only takes this long the first time.'}
          </Text>
        ) : null}
      </View>
      {preparing || replay ? (
        <Pressable
          style={({ pressed }) => [styles.skip, pressed ? styles.pressed : null]}
          accessibilityRole="button"
          accessibilityLabel="Skip"
          accessibilityHint="Go to the home screen; the starter project keeps preparing"
          hitSlop={8}
          onPress={() => router.replace('/')}
        >
          <Text style={styles.skipLabel}>Skip</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
  },
  center: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  lead: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
    textAlign: 'center',
  },
  skip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  skipLabel: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.62,
  },
}));
