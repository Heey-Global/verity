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
// Shortest round-trip we are willing to read as a human closing the sheet. A
// person cannot see, read and dismiss an authorization sheet inside this, so a
// faster `cancel`/`dismiss` means the sheet never presented at all.
const AUTH_SESSION_MIN_MS = 600;

type SessionOutcome =
  { kind: 'success'; url: string } | { kind: 'cancelled' } | { kind: 'failed'; message: string };

/**
 * Open one GitHub authorization session and classify the result.
 *
 * `openAuthSessionAsync` reports "the user closed the sheet" and "the sheet
 * never opened" with the SAME `cancel`/`dismiss` value, and reports a session
 * left over from an earlier attempt as `locked`. Only a real cancellation may
 * return the panel silently to idle; every startup failure has to say why.
 */
async function authSession(url: string): Promise<SessionOutcome> {
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>;
  try {
    result = await WebBrowser.openAuthSessionAsync(url, GITHUB_CALLBACK_URL, {
      preferUniversalLinks: true,
    });
  } catch {
    return {
      kind: 'failed',
      message: 'GitHub authorization could not open in the app.',
    };
  }
  if (result.type === 'success') return { kind: 'success', url: result.url };
  // `WebBrowserResultType` is a string enum; widen to compare without a cast.
  const type: string = result.type;
  if (type === 'locked') {
    // Recover the stale session only after iOS identifies it. Dismissing before
    // every open races the main-queue presentation and can cancel the new sheet.
    try {
      WebBrowser.dismissAuthSession();
    } catch {
      // The message below remains the useful recovery path if native cleanup
      // itself fails; restarting the app releases the retained session.
    }
    return {
      kind: 'failed',
      message:
        'A stale GitHub authorization window was detected. Try again, and restart Verity if it stays locked.',
    };
  }
  if (Date.now() - startedAt < AUTH_SESSION_MIN_MS) {
    // The iOS module attaches ASWebAuthenticationSession's error text to the
    // result without typing it — the only place the OS says WHY the sheet did
    // not present (invalid presentation anchor, unverified associated domain, …).
    // Single-lined and capped: it is an unbounded NSError description headed
    // for a one-alert layout.
    const detail = (result as { error?: unknown }).error;
    const reason =
      typeof detail === 'string' ? detail.replace(/\s+/gu, ' ').trim().slice(0, 200) : '';
    return {
      kind: 'failed',
      message:
        reason.length > 0
          ? `GitHub authorization could not open on this device: ${reason}`
          : 'GitHub authorization could not open on this device. Try again, and restart Verity if it keeps happening.',
    };
  }
  // Past the threshold the same value is a person closing the sheet. It arrives
  // with an error text too (`canceledLogin`), so the text's presence must not
  // reclassify a genuine cancel as a technical failure.
  return { kind: 'cancelled' };
}

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

/** A real cancellation returns to the button; anything else has to say why. */
function idleOrError(outcome: Exclude<SessionOutcome, { kind: 'success' }>): Phase {
  return outcome.kind === 'cancelled'
    ? { kind: 'idle' }
    : { kind: 'error', message: outcome.message };
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
        const createdSession = await authSession(startUrl);
        if (createdSession.kind !== 'success') {
          connectingRef.current = false;
          if (mountedRef.current) setPhase(idleOrError(createdSession));
          return;
        }
        const created = githubCallback(createdSession.url, 'created');
        const installUrl = await client.completeGithubManifest(created.phaseValue, created.state);
        const installedSession = await authSession(installUrl);
        if (installedSession.kind !== 'success') {
          connectingRef.current = false;
          if (mountedRef.current) setPhase(idleOrError(installedSession));
          return;
        }
        const installed = githubCallback(installedSession.url, 'installed');
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
