// GitHub authorization entry point shared by onboarding and Settings. The user
// sees one action; the GitHub App manifest remains an implementation detail on
// the server. After the browser round-trip, the caller replaces this panel with
// the connected-state UI (commit author + verified commits).
import { VerityApiError, type VerityClient, type OnboardingStatus } from '@verity/mobile';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getVerityBaseUrl } from '../lib/client';

const POLL_INTERVAL_MS = 3000;

type Phase = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'error'; message: string };

export function GithubConnectPanel({
  client,
  onConnected,
}: {
  client: VerityClient;
  onConnected: (status?: OnboardingStatus) => void;
}) {
  const { theme } = useUnistyles();
  const [organization, setOrganization] = useState('');
  const [showOrganization, setShowOrganization] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const connectedRef = useRef(false);
  const mountedRef = useRef(true);
  const waiting = phase.kind === 'waiting';

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const finish = (status: OnboardingStatus) => {
    if (connectedRef.current || !mountedRef.current) return;
    connectedRef.current = true;
    onConnected(status);
  };

  const check = () => {
    void client
      .fetchOnboardingStatus()
      .then((status) => {
        if (status.githubAppConfigured) finish(status);
      })
      .catch(() => {
        // A browser round-trip can race server persistence. Keep the waiting
        // state and let the next automatic/manual check recover.
      });
  };

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // `check` only closes over stable client/refs and intentionally should not
    // restart the interval on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, client]);

  const connect = () => {
    const base = getVerityBaseUrl();
    if (base === null) {
      setPhase({ kind: 'error', message: 'Set the server address first, then try again.' });
      return;
    }

    void (async () => {
      let startUrl = `${base}/github/app/manifest/start?base=${encodeURIComponent(base)}`;
      const owner = organization.trim();
      if (owner.length > 0) startUrl += `&owner=${encodeURIComponent(owner)}`;
      try {
        const token = await client.prepareGithubManifest();
        startUrl += `&ott=${encodeURIComponent(token)}`;
      } catch (caught) {
        // Older servers predate the single-use token. Only their 404 is safe to
        // fall through; all other failures would open a dead authorization page.
        if (!(caught instanceof VerityApiError && caught.status === 404)) {
          setPhase({
            kind: 'error',
            message: 'Could not start GitHub authorization. Check the connection and try again.',
          });
          return;
        }
      }
      await Linking.openURL(startUrl);
      if (mountedRef.current) setPhase({ kind: 'waiting' });
    })();
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Connect GitHub</Text>
      <Text style={styles.description}>
        Authorize Verity to access the repositories you choose. You will finish on GitHub and then
        return here automatically.
      </Text>

      {showOrganization ? (
        <View style={styles.field}>
          <Text style={styles.label}>Organization</Text>
          <TextInput
            style={styles.input}
            value={organization}
            onChangeText={setOrganization}
            placeholder="GitHub organization slug"
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="GitHub organization"
          />
          <Text style={styles.hint}>Leave empty to connect your personal account.</Text>
        </View>
      ) : (
        <Pressable
          onPress={() => setShowOrganization(true)}
          accessibilityRole="button"
          accessibilityLabel="Connect a GitHub organization"
        >
          <Text style={styles.linkText}>Connecting an organization?</Text>
        </Pressable>
      )}

      {phase.kind === 'error' ? (
        <Text style={styles.error} accessibilityRole="alert">
          {phase.message}
        </Text>
      ) : null}

      {waiting ? (
        <View style={styles.waiting} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <View style={styles.waitingCopy}>
            <Text style={styles.waitingTitle}>Waiting for GitHub…</Text>
            <Text style={styles.hint}>Return to Verity after authorization is complete.</Text>
          </View>
          <Pressable onPress={check} accessibilityRole="button" accessibilityLabel="Check now">
            <Text style={styles.linkText}>Check now</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
          onPress={connect}
          accessibilityRole="button"
          accessibilityLabel="Connect to GitHub"
        >
          <Text style={styles.primaryButtonLabel}>Connect to GitHub</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '800',
  },
  description: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  field: { gap: theme.spacing.xs },
  label: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  input: {
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    backgroundColor: theme.colors.background,
    fontSize: theme.text.md,
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  linkText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  waiting: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  waitingCopy: { flex: 1, gap: 2 },
  waitingTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: { opacity: 0.78 },
}));
