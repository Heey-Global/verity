// Onboarding step 0: server URL (#320). The FIRST step — a distributable Verity
// build ships without a hardcoded server, so the operator enters the control-plane
// address here (a LAN IP or Tailscale name). The address is validated with a live
// GET /onboarding/status, persisted on the device, and only THEN does the wizard
// advance — the app can't do anything useful without a reachable server.
//
// Advance is gated on a successful connection test: a bad address must not be
// persisted and must not let the operator move on to a dead flow.
import {
  VerityClient,
  normalizeServerUrl,
  resumeStep,
  type OnboardingStatus,
} from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAuthToken } from '../../lib/authToken';
import { getVerityBaseUrl, setVerityBaseUrl } from '../../lib/client';

function onboardingRoute(status: OnboardingStatus): string {
  return status.complete ? '/' : `/onboarding/${resumeStep(status)}`;
}

function unlockRoute(returnTo: string): string {
  return `/unlock-device?returnTo=${encodeURIComponent(returnTo)}`;
}

type TestState =
  { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string };

export default function OnboardingServerUrl() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  // `reconfigure` = launched from Settings to fix/change an already-saved address
  // (the recovery path for a wrong/unreachable URL), NOT the first-run wizard step.
  // On success we return home instead of advancing into the wizard, and we offer a
  // Cancel so an accidental entry isn't a trap.
  const { reconfigure } = useLocalSearchParams<{ reconfigure?: string }>();
  const isReconfigure = reconfigure === '1';
  // Prefill with the current base URL (env default or a previously-set value) so a
  // reconfigure starts from the existing address rather than a blank field.
  const [url, setUrl] = useState(getVerityBaseUrl() ?? '');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const canSubmit = url.trim().length > 0 && test.kind !== 'testing';

  const runTest = () => {
    if (!canSubmit) return;
    // Normalize via the single shared normalizer (scheme default + trailing-slash
    // strip) so the probe hits exactly what will be persisted. `null` only for an
    // empty input, already excluded by `canSubmit`.
    const probeUrl = normalizeServerUrl(url);
    if (probeUrl === null) return;
    setTest({ kind: 'testing' });
    // A throwaway client on the candidate URL — we don't persist until it answers.
    const probe = new VerityClient({ baseUrl: probeUrl });
    void probe
      .fetchOnboardingStatus()
      .then((status) => {
        // Reachable AND it parsed as a Verity onboarding-status payload → persist
        // the normalized URL, then advance. (`setVerityBaseUrl` re-normalizes; same
        // input → same result.)
        return setVerityBaseUrl(probeUrl).then(() => status);
      })
      .then((status) => {
        setTest({ kind: 'ok' });
        // Reconfigure (from Settings) → back home. First-run/preflight → route
        // from the server's actual setup state, so an interrupted onboarding flow
        // resumes at the first incomplete step instead of falling through to home.
        const target = onboardingRoute(status);
        if (isReconfigure) {
          router.replace('/');
        } else if (status.masterPasswordSet && getAuthToken(probeUrl) === null) {
          router.replace(unlockRoute(target));
        } else {
          router.replace(target);
        }
      })
      .catch((caught: unknown) => {
        // Distinguish "couldn't reach it at all" from "reached something that isn't
        // a Verity server" (a non-2xx or a schema-parse failure lands here too).
        const message =
          caught instanceof TypeError
            ? 'Could not reach that address. Check the URL and that the server is running.'
            : 'Reached the address, but it does not look like a Verity API server. Use the API port, not the Metro port.';
        setTest({ kind: 'error', message });
      });
  };

  const testing = test.kind === 'testing';

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>Verity connection</Text>
        <Text style={styles.title} accessibilityRole="header">
          Connect your server
        </Text>
        <Text style={styles.lead}>
          Enter the Verity server this device should control. If it is already set up, you will
          unlock this device next. If it is fresh, setup starts after the connection succeeds.
        </Text>

        <View style={styles.card}>
          <View style={styles.field}>
            <Text style={styles.label}>Verity server address</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={(next) => {
                setUrl(next);
                // Editing invalidates a prior test result.
                if (test.kind !== 'idle') setTest({ kind: 'idle' });
              }}
              placeholder="verity.tailnet.ts.net:8082"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="go"
              onSubmitEditing={runTest}
              accessibilityLabel="Server address"
            />
          </View>

          {test.kind === 'error' ? (
            <Text style={styles.error} accessibilityRole="alert">
              {test.message}
            </Text>
          ) : null}

          {test.kind === 'ok' ? (
            <Text style={styles.connected} accessibilityRole="alert">
              Connected
            </Text>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              !canSubmit ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={runTest}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Test connection"
          >
            {testing ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
            <Text style={styles.primaryButtonLabel}>
              {testing ? 'Testing…' : 'Test connection'}
            </Text>
          </Pressable>

          {isReconfigure ? (
            <Pressable
              style={({ pressed }) => [styles.cancel, pressed ? styles.pressed : null]}
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    gap: theme.spacing.lg,
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 160,
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '800',
  },
  lead: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  input: {
    minHeight: 48,
    color: theme.colors.text,
    fontSize: theme.text.md,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  connected: {
    color: theme.colors.tone.done,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  cancel: {
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  cancelLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.62,
  },
}));
