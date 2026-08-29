// Onboarding step 2: master password (#320, PR 2a). The real set/unlock flow that
// arms the at-rest secret cipher — the wizard cannot proceed to the GitHub step
// until the store is UNLOCKED (the GitHub PEM must decrypt to validate).
//
// Three modes, driven off GET /secret/status → secretUiMode (reused from the
// Settings screen so the rules live in exactly one place):
//   - `set`   (uninitialized): password + confirm, min-length + match validation
//              → POST /secret/init → unlocked → reveal Next.
//   - `unlock`(sealed): password → POST /secret/unlock → unlocked → reveal Next;
//              a wrong password shows an inline error and stays.
//   - `ready` (unlocked, or `unmanaged` deployment): a "done" note + Next.
// Passwords live only in this component's local state — never logged, never
// hoisted, never sent anywhere but the two POST bodies.
import {
  VerityApiError,
  MIN_MASTER_PASSWORD_LENGTH,
  secretUiMode,
  validateMasterPassword,
  type VerityClient,
  type SecretStatus,
} from '@verity/mobile';
import { router, type Href, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
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

import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import {
  canUseBiometricUnlock,
  disableBiometricUnlock,
  enableBiometricUnlock,
  getAuthToken,
  isBiometricUnlockEnabled,
  refreshBiometricUnlockSecret,
  setAuthToken,
} from '../../lib/authToken';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';

const NEXT = { href: '/onboarding/github' } as const;
const BACK = '/onboarding/server-url';

export default function OnboardingMasterPassword() {
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const returnTo = useMemo(() => safeReturnTo(params.returnTo), [params.returnTo]);
  return <MasterPasswordRoute returnTo={returnTo} />;
}

export function MasterPasswordRoute({ returnTo }: { returnTo: Href | null }) {
  const next = returnTo ? ({ href: returnTo, label: 'Continue' } as const) : NEXT;
  const back = returnTo ?? BACK;
  const client = createVerityClient();
  // No server configured → nothing to arm; let the operator move on (mirrors the
  // gate's "let through when client is null" behaviour).
  if (client === null) {
    return (
      <OnboardingStepScaffold
        stepId="master-password"
        title="Master password"
        back={back}
        next={next}
      >
        <DoneNote message="No server is configured yet — you can set the master password later from Settings." />
      </OnboardingStepScaffold>
    );
  }
  return <MasterPasswordStep client={client} back={back} next={next} returnTo={returnTo} />;
}

function safeReturnTo(value: string | string[] | undefined): Href | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === '/') return '/';
  return null;
}

function MasterPasswordStep({
  client,
  back,
  next,
  returnTo,
}: {
  client: VerityClient;
  back: Href;
  next: { href: Href; label?: string };
  returnTo: Href | null;
}) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<SecretStatus | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [showBiometricConsent, setShowBiometricConsent] = useState(false);
  const [pendingBiometricPassword, setPendingBiometricPassword] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    setFetchFailed(false);
    void client
      .getSecretStatus()
      .then(setStatus)
      .catch(() => {
        // Surface a retry rather than an indefinite spinner: mid-wizard the operator
        // has no Settings escape, so a transient status-fetch failure must offer a
        // way forward. If a prior status is already loaded we keep it (a background
        // refresh failing shouldn't wipe the form).
        setFetchFailed(true);
      });
  }, [client]);

  useEffect(() => refreshStatus(), [refreshStatus]);

  const reset = () => {
    setPassword('');
    setConfirm('');
    setFieldError(undefined);
  };

  const advanceAfterUnlock = () => {
    reset();
    if (returnTo) {
      router.replace(returnTo);
      return;
    }
    router.push(NEXT.href);
  };

  const maybeAskBiometrics = (token: string | undefined, unlockedPassword: string) => {
    if (!token) {
      onUnlocked();
      return;
    }
    const baseUrl = getVerityBaseUrl();
    void Promise.all([isBiometricUnlockEnabled(baseUrl), canUseBiometricUnlock()])
      .then(([enabled, canUse]) => {
        if (!enabled && canUse) {
          setPendingBiometricPassword(unlockedPassword);
          reset();
          setShowBiometricConsent(true);
          return;
        }
        if (enabled) void refreshBiometricUnlockSecret(baseUrl, unlockedPassword);
        onUnlocked();
      })
      .catch(onUnlocked);
  };

  const onUnlocked = () => {
    reset();
    if (returnTo) {
      router.replace(returnTo);
      return;
    }
    // Re-read so the mode flips to `ready` and the Next control appears.
    refreshStatus();
  };

  const submitInit = () => {
    if (busy) return;
    const validation = validateMasterPassword(password, confirm);
    if (validation) {
      setFieldError(validation);
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    void client
      .initSecretPassword(password)
      .then((res) => {
        // Store this device's minted bearer token (audit C1) when the gate is
        // active; a gate-off deployment returns no token and this is a no-op.
        if (res?.token) void setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
        maybeAskBiometrics(res?.token, password);
      })
      .catch((caught) => {
        // 409 = the `set` form is stale (a key already exists — e.g. a concurrent
        // client, or a VERITY_SECRET_KEY-managed deploy). `onUnlocked` only
        // REFETCHES and lets `secretUiMode` decide the next mode (`unlock`/`ready`/
        // `hidden`) — it never assumes we're unlocked — so every 409 sub-case
        // resolves correctly rather than sticking on the stale form.
        if (caught instanceof VerityApiError && caught.status === 409) {
          onUnlocked();
          return;
        }
        setFieldError(
          caught instanceof VerityApiError ? caught.message : 'Could not set the password.',
        );
      })
      .finally(() => setBusy(false));
  };

  const submitUnlock = () => {
    if (busy) return;
    setFieldError(undefined);
    setBusy(true);
    void client
      .unlockSecret(password)
      .then((res) => {
        if (res?.token) void setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
        maybeAskBiometrics(res?.token, password);
      })
      .catch((caught) => {
        if (caught instanceof VerityApiError && caught.status === 401) {
          setFieldError('Incorrect password.');
          return;
        }
        setFieldError(caught instanceof VerityApiError ? caught.message : 'Could not unlock.');
      })
      .finally(() => setBusy(false));
  };

  const enableBiometrics = () => {
    if (busy) return;
    setBusy(true);
    void enableBiometricUnlock(getVerityBaseUrl(), pendingBiometricPassword ?? undefined)
      .then(() => advanceAfterUnlock())
      .finally(() => {
        setPendingBiometricPassword(null);
        setBusy(false);
      });
  };

  const skipBiometrics = () => {
    if (busy) return;
    setBusy(true);
    void disableBiometricUnlock(getVerityBaseUrl())
      .then(() => advanceAfterUnlock())
      .finally(() => {
        setPendingBiometricPassword(null);
        setBusy(false);
      });
  };

  // Pre-fetch → neutral spinner. Standalone unlock routes must not flash the
  // onboarding progress chrome while we determine whether the server is sealed.
  if (status === undefined) {
    const content = (
      <View style={styles.center}>
        {fetchFailed ? (
          <>
            <Text style={styles.fetchError}>Could not reach Verity. Check the connection.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry"
              onPress={refreshStatus}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={theme.colors.accent} />
        )}
      </View>
    );
    if (returnTo !== null)
      return <DeviceAuthorizationScaffold>{content}</DeviceAuthorizationScaffold>;
    return (
      <OnboardingStepScaffold stepId="master-password" title="Master password" back={back}>
        {content}
      </OnboardingStepScaffold>
    );
  }

  const baseUrl = getVerityBaseUrl();
  const needsDeviceAuthorization =
    returnTo !== null && status === 'unlocked' && getAuthToken(baseUrl) === null;
  const mode = needsDeviceAuthorization ? 'unlock' : secretUiMode(status);

  if (showBiometricConsent) {
    const consent = (
      <BiometricConsent busy={busy} onEnable={enableBiometrics} onSkip={skipBiometrics} />
    );
    if (needsDeviceAuthorization || returnTo !== null) {
      return <DeviceAuthorizationScaffold>{consent}</DeviceAuthorizationScaffold>;
    }
    return (
      <OnboardingStepScaffold stepId="master-password" title="Secure this device" back={back}>
        {consent}
      </OnboardingStepScaffold>
    );
  }

  // `ready`/`hidden` (unlocked or unmanaged) → done. Standalone unlock
  // routes still use the device authorization chrome, never the setup wizard chrome.
  if (mode === 'ready' || mode === 'hidden') {
    const note = (
      <DoneNote
        message={
          mode === 'hidden'
            ? 'This deployment manages secrets without a master password. Nothing to set here.'
            : 'Secrets are unlocked for this device.'
        }
      />
    );
    if (returnTo !== null) return <DeviceAuthorizationScaffold>{note}</DeviceAuthorizationScaffold>;
    return (
      <OnboardingStepScaffold
        stepId="master-password"
        title="Master password"
        back={back}
        next={next}
      >
        {note}
      </OnboardingStepScaffold>
    );
  }

  const submitLabel = mode === 'set' ? 'Set master password' : 'Unlock';
  // A distinct accessible name for the unlock action (the visible label is the
  // terse "Unlock"; screen readers get the fuller phrase — mirrors Settings).
  const submitA11yLabel = mode === 'set' ? 'Set master password' : 'Unlock secret store';
  const submitAction = mode === 'set' ? submitInit : submitUnlock;

  const form = (
    <View style={styles.card}>
      <Text style={styles.intro}>
        {needsDeviceAuthorization
          ? 'Enter the server master password to authorize this device for the selected Verity server.'
          : mode === 'set'
            ? 'This protects GitHub keys, signing keys, and service tokens stored on your Verity server. Choose a password you can keep safe; Verity cannot recover it.'
            : 'Enter the server master password to unlock encrypted secrets after a restart.'}
      </Text>

      {mode === 'set' ? (
        <Text style={styles.guidance}>
          Use at least {MIN_MASTER_PASSWORD_LENGTH} characters and at least 5 different characters.
        </Text>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Master password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={theme.colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType={mode === 'set' ? 'next' : 'done'}
          accessibilityLabel="Master password"
        />
      </View>

      {mode === 'set' ? (
        <View style={styles.field}>
          <Text style={styles.label}>Confirm password</Text>
          <TextInput
            style={styles.input}
            value={confirm}
            onChangeText={setConfirm}
            placeholder="••••••••"
            placeholderTextColor={theme.colors.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            accessibilityLabel="Confirm password"
          />
        </View>
      ) : null}

      {fieldError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {fieldError}
        </Text>
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.primaryButton,
          busy || password.length === 0 ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={submitAction}
        disabled={busy || password.length === 0}
        accessibilityRole="button"
        accessibilityLabel={submitA11yLabel}
      >
        {busy ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
        <Text style={styles.primaryButtonLabel}>{submitLabel}</Text>
      </Pressable>
    </View>
  );

  if (returnTo !== null) {
    return <DeviceAuthorizationScaffold>{form}</DeviceAuthorizationScaffold>;
  }

  return (
    // No `next` until unlocked — the Back control stays, but the operator must set
    // or unlock before proceeding.
    <OnboardingStepScaffold stepId="master-password" title="Master password" back={back}>
      {form}
    </OnboardingStepScaffold>
  );
}

function DeviceAuthorizationScaffold({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.authRoot}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={[styles.authContent, { paddingTop: insets.top + 32 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={styles.authEyebrow}>Device authorization</Text>
        <Text style={styles.title} accessibilityRole="header">
          Unlock Verity
        </Text>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function BiometricConsent({
  busy,
  onEnable,
  onSkip,
}: {
  busy: boolean;
  onEnable: () => void;
  onSkip: () => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Use Face ID or Touch ID?</Text>
      <Text style={styles.intro}>
        Verity can use this device's biometric unlock to load your local device token next time.
        Your master password still protects the server secrets.
      </Text>
      <Pressable
        style={({ pressed }) => [
          styles.primaryButton,
          busy ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={onEnable}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Use Face ID"
      >
        {busy ? <ActivityIndicator size="small" color="#05050a" /> : null}
        <Text style={styles.primaryButtonLabel}>Use Face ID</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.secondaryButton,
          busy ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={onSkip}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Not now"
      >
        <Text style={styles.secondaryButtonLabel}>Not now</Text>
      </Pressable>
    </View>
  );
}

function DoneNote({ message }: { message: string }) {
  return (
    <View style={styles.doneCard}>
      <Text style={styles.donePill}>Unlocked</Text>
      <Text style={styles.intro}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  authRoot: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  authContent: {
    flexGrow: 1,
    gap: theme.spacing.lg,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  authEyebrow: {
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
    gap: theme.spacing.md,
  },
  fetchError: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
  },
  retry: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  retryText: {
    color: theme.colors.text,
    fontWeight: '700',
  },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  doneCard: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  donePill: {
    alignSelf: 'flex-start',
    color: theme.colors.background,
    backgroundColor: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    overflow: 'hidden',
  },
  intro: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  guidance: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
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
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.62,
  },
}));
