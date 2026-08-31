// Onboarding step 5: Doppler Service Account token (#320). OPTIONAL — never gates
// completion. The operator can either connect a Doppler account-level Service
// Account token now, or Skip and add it later from Settings.
//
// Connect flow: paste the token → PATCH /settings (dopplerServiceToken) → live
// POST /doppler/validate. Next (Continue) appears only once validation returns
// `ok`; the token is cleared from local state after a successful save. Editing the
// token after a successful validation invalidates it (re-hide the success + gate).
//
// Skip flow: a clear "Skip — set up later" that advances to /onboarding/ai-backends
// WITHOUT a token. If a token IS entered, the primary action is Save & validate and
// advancing requires a successful validate.
//
// Requires the secret store UNLOCKED (the preceding master-password step guarantees
// this): the server must decrypt the stored token to validate it. A `locked` result
// routes the operator back to unlock.
import { VerityApiError, type VerityClient, type DopplerValidateResult } from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import { createVerityClient } from '../../lib/client';

const NEXT_HREF = '/onboarding/ai-backends';
const BACK = '/onboarding/github';
const DOPPLER_DASHBOARD_URL = 'https://dashboard.doppler.com';

export default function OnboardingDoppler() {
  const client = createVerityClient();
  if (client === null) {
    return (
      <OnboardingStepScaffold
        stepId="doppler"
        title="Doppler (optional)"
        back={BACK}
        next={{ href: NEXT_HREF, label: 'Skip / Next' }}
      >
        <View style={styles.card}>
          <Text style={styles.intro}>
            No server is configured yet — you can connect Doppler later from Settings.
          </Text>
        </View>
      </OnboardingStepScaffold>
    );
  }
  return <DopplerStep client={client} />;
}

type Phase =
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'validating' }
  | { kind: 'ok'; projectCount?: number }
  | { kind: 'error'; message: string };

function DopplerStep({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });

  const validated = phase.kind === 'ok';
  const busy = phase.kind === 'saving' || phase.kind === 'validating';

  // Editing the token after a successful validation invalidates it — the operator
  // must re-save + re-validate, and the Continue control disappears until they do.
  const onEditToken = (value: string) => {
    setToken(value);
    if (phase.kind === 'ok' || phase.kind === 'error') setPhase({ kind: 'editing' });
  };

  const mapError = (result: DopplerValidateResult): string => {
    switch (result.error) {
      case 'locked':
        return 'The secret store is locked. Go back and unlock it, then try again.';
      case 'not configured':
        return 'Save the Doppler token first.';
      default:
        // Pass through the server's message (e.g. "Doppler rejected the token").
        // Safe by contract: `validateDopplerToken` only ever returns fixed, redacted
        // strings and never echoes the Doppler body / token. The `??` covers the
        // schema-allowed ok:false-without-error edge with a generic line.
        return result.error ?? 'Doppler rejected the token.';
    }
  };

  const saveAndValidate = () => {
    if (busy) return;
    if (token.trim().length === 0) {
      setPhase({ kind: 'error', message: 'Paste a Doppler Service Account token first.' });
      return;
    }
    setPhase({ kind: 'saving' });
    // Write-only secret paste: the token is sent to the server (encrypted at rest),
    // validated, then cleared from local state on success.
    void client
      .updateVeritySettings({ dopplerServiceToken: token.trim() })
      .then(() => {
        setPhase({ kind: 'validating' });
        return client.validateDoppler();
      })
      .then((result) => {
        // `validateDoppler` never returns the token — only `ok` + a safe count.
        if (result.ok) {
          // Clear the token from local state once accepted — it lives encrypted on
          // the server now and must not linger in the component.
          setToken('');
          setPhase(
            result.projectCount !== undefined
              ? { kind: 'ok', projectCount: result.projectCount }
              : { kind: 'ok' },
          );
          return;
        }
        setPhase({ kind: 'error', message: mapError(result) });
      })
      .catch((caught) => {
        setPhase({
          kind: 'error',
          message:
            caught instanceof VerityApiError ? caught.message : 'Could not save or validate.',
        });
      });
  };

  const skip = () => {
    if (busy) return;
    router.push(NEXT_HREF);
  };

  return (
    // Next (Continue) appears ONLY once the token is validated. Until then, the
    // operator advances via the explicit Skip control (Doppler is optional). Hiding
    // scaffold `next` while unvalidated avoids a token-entered-but-unvalidated
    // advance; Skip covers the no-token path.
    <OnboardingStepScaffold
      stepId="doppler"
      title="Doppler (optional)"
      back={BACK}
      next={validated ? { href: NEXT_HREF, label: 'Continue' } : null}
    >
      <DopplerGuidance />

      <View style={styles.card}>
        <View style={styles.field}>
          <Text style={styles.label}>Doppler Service Account token</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={onEditToken}
            placeholder="dp.sa.…"
            placeholderTextColor={theme.colors.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="Doppler Service Account token"
          />
          <Text style={styles.footnote}>Stored encrypted; validated once, never shown again.</Text>
        </View>

        {phase.kind === 'error' ? (
          <Text style={styles.error} accessibilityRole="alert">
            {phase.message}
          </Text>
        ) : null}
        {phase.kind === 'ok' ? (
          <Text style={styles.success} accessibilityRole="text">
            Connected
            {phase.projectCount !== undefined
              ? ` (${String(phase.projectCount)} project${phase.projectCount === 1 ? '' : 's'})`
              : ''}
            . You can continue.
          </Text>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            busy ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={saveAndValidate}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Save and validate Doppler token"
        >
          {busy ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
          <Text style={styles.primaryButtonLabel}>
            {phase.kind === 'saving'
              ? 'Saving…'
              : phase.kind === 'validating'
                ? 'Validating…'
                : validated
                  ? 'Re-validate'
                  : 'Save & validate'}
          </Text>
        </Pressable>

        <Pressable
          onPress={skip}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Skip — set up later"
          style={({ pressed }) => [styles.skipButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.skipLabel}>Skip — set up later</Text>
        </Pressable>
      </View>
    </OnboardingStepScaffold>
  );
}

/** Hand-holding "how to create the Doppler Service Account token" copy + a deep link
 *  to the Doppler dashboard. Concise but accurate — names WHERE the token is created
 *  and the access it needs. */
function DopplerGuidance() {
  return (
    <View style={styles.guidance} accessibilityRole="summary">
      <Text style={styles.guidanceTitle} accessibilityRole="header">
        Connect Doppler (optional)
      </Text>
      <Text style={styles.guidanceStep}>
        Connect Doppler if your projects need managed secrets. Verity can use it to give each
        project only the secrets it needs. You can skip this and add it later from Settings.
      </Text>
      <Text style={styles.guidanceStep}>
        Create a Service Account in Doppler, generate an API token, and paste it below.
      </Text>
      <Text style={styles.guidanceStep}>
        Verity validates the token once and stores it encrypted.
      </Text>
      <Pressable
        onPress={() => void Linking.openURL(DOPPLER_DASHBOARD_URL)}
        accessibilityRole="link"
        accessibilityLabel="Open the Doppler dashboard"
        style={({ pressed }) => [styles.link, pressed ? styles.pressed : null]}
      >
        <Text style={styles.linkText}>Open dashboard.doppler.com</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  guidance: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  guidanceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
    marginBottom: theme.spacing.xs,
  },
  guidanceStep: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  link: {
    marginTop: theme.spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
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
  intro: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
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
  footnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  success: {
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
  skipButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.62,
  },
}));
