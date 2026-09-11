// GitHub authorization entry point shared by onboarding and Settings. The user
// sees one action; the GitHub App manifest remains an implementation detail on
// the server. After the browser round-trip, the caller replaces this panel with
// the connected-state UI (commit author + verified commits).
import { type VerityClient, type OnboardingStatus } from '@verity/mobile';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getVerityBaseUrl } from '../lib/client';

const POLL_INTERVAL_MS = 3000;
const PREPARE_TIMEOUT_MS = 15000;
const GITHUB_CALLBACK_URL = 'https://verity.build/github/app/callback';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting' }
  | { kind: 'error'; message: string };

function githubCallback(
  value: string,
  expectedPhase: 'created' | 'installed',
): { state: string; phaseValue: string } {
  const url = new URL(value);
  const phaseValue = url.searchParams.get(expectedPhase === 'created' ? 'code' : 'installation_id');
  const state = url.searchParams.get('state');
  if (
    url.origin !== 'https://verity.build' ||
    url.pathname !== '/github/app/callback' ||
    url.searchParams.get('phase') !== expectedPhase ||
    state === null ||
    state.length === 0 ||
    phaseValue === null ||
    phaseValue.length === 0
  ) {
    throw new Error('GitHub returned an invalid callback');
  }
  return { state, phaseValue };
}

export function GithubConnectPanel({
  client,
  onConnected,
  returnTo = '/github-connect',
}: {
  client: VerityClient;
  onConnected: (status?: OnboardingStatus) => void;
  returnTo?: '/github-connect' | '/onboarding/github';
}) {
  const { theme } = useUnistyles();
  const [organization, setOrganization] = useState('');
  const [showOrganization, setShowOrganization] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
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
    if (connectingRef.current) return;
    const base = getVerityBaseUrl();
    if (base === null) {
      setPhase({ kind: 'error', message: 'Set the server address first, then try again.' });
      return;
    }
    connectingRef.current = true;
    setPhase({ kind: 'starting' });

    void (async () => {
      const owner = organization.trim();
      const nativeCallback = Platform.OS === 'ios';
      let startUrl = `${base}/github/app/manifest/start?base=${encodeURIComponent(base)}`;
      if (owner.length > 0) startUrl += `&owner=${encodeURIComponent(owner)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS);
      try {
        const prepared = await client.prepareGithubManifest(
          base,
          owner || undefined,
          returnTo,
          nativeCallback,
          controller.signal,
        );
        if (nativeCallback) {
          if (prepared.state === undefined || prepared.manifest === undefined)
            throw new Error('the server returned no native GitHub manifest flow');
          const payload = encodeURIComponent(
            JSON.stringify({
              state: prepared.state,
              manifest: prepared.manifest,
              ...(owner.length > 0 ? { owner } : {}),
            }),
          );
          startUrl = `https://verity.build/github/app/#${payload}`;
        } else if (prepared.startToken !== undefined) {
          startUrl += `&ott=${encodeURIComponent(prepared.startToken)}`;
        } else {
          throw new Error('the server returned no compatible GitHub manifest flow');
        }
      } catch {
        connectingRef.current = false;
        if (mountedRef.current)
          setPhase({
            kind: 'error',
            message: 'Could not start GitHub authorization. Check the connection and try again.',
          });
        return;
      } finally {
        clearTimeout(timeout);
      }
      try {
        if (!nativeCallback) {
          await Linking.openURL(startUrl);
          if (mountedRef.current) setPhase({ kind: 'waiting' });
          return;
        }
        if (mountedRef.current) setPhase({ kind: 'waiting' });
        const createdResult = await WebBrowser.openAuthSessionAsync(startUrl, GITHUB_CALLBACK_URL, {
          preferUniversalLinks: true,
        });
        if (createdResult.type !== 'success') {
          connectingRef.current = false;
          if (mountedRef.current) setPhase({ kind: 'idle' });
          return;
        }
        const created = githubCallback(createdResult.url, 'created');
        const installUrl = await client.completeGithubManifest(created.phaseValue, created.state);
        const installedResult = await WebBrowser.openAuthSessionAsync(
          installUrl,
          GITHUB_CALLBACK_URL,
          { preferUniversalLinks: true },
        );
        if (installedResult.type !== 'success') {
          connectingRef.current = false;
          if (mountedRef.current) setPhase({ kind: 'idle' });
          return;
        }
        const installed = githubCallback(installedResult.url, 'installed');
        await client.completeGithubManifestInstallation(installed.phaseValue, installed.state);
        const status = await client.fetchOnboardingStatus();
        finish(status);
      } catch {
        connectingRef.current = false;
        if (mountedRef.current) {
          setPhase({
            kind: 'error',
            message: 'Could not open GitHub authorization. Check this device and try again.',
          });
        }
      }
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

      {phase.kind === 'starting' ? (
        <View style={styles.waiting} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <View style={styles.waitingCopy}>
            <Text style={styles.waitingTitle}>Opening GitHub…</Text>
            <Text style={styles.hint}>Preparing a secure authorization request.</Text>
          </View>
        </View>
      ) : waiting ? (
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
