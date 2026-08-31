import { VerityApiError, type OnboardingStatus } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentLoginPanel } from '../../components/AgentLoginPanel';
import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import { createVerityClient } from '../../lib/client';

const NEXT_HREF = '/onboarding/first-project';
const BACK = '/onboarding/doppler';
const CURRENT_HREF = '/onboarding/ai-backends';

function unlockRoute(): string {
  return `/unlock-device?returnTo=${encodeURIComponent(CURRENT_HREF)}`;
}

type Phase = { kind: 'loading' } | { kind: 'editing' } | { kind: 'error'; message: string };

export default function OnboardingAiBackends() {
  const client = createVerityClient();
  if (client === null) {
    return (
      <OnboardingStepScaffold
        stepId="ai-backends"
        title="Agent logins"
        back={BACK}
        next={{ href: NEXT_HREF, label: 'Next', disabled: true }}
      >
        <View style={styles.card}>
          <Text style={styles.intro}>
            No server is configured yet. Connect a Verity server before choosing an agent login.
          </Text>
        </View>
      </OnboardingStepScaffold>
    );
  }
  return <AiBackendsStep client={client} />;
}

function AiBackendsStep({
  client,
}: {
  client: NonNullable<ReturnType<typeof createVerityClient>>;
}) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<
    Pick<OnboardingStatus, 'claudeConfigured' | 'codexConfigured'>
  >({
    claudeConfigured: false,
    codexConfigured: false,
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [activeLogin, setActiveLogin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client
      .fetchOnboardingStatus()
      .then((next) => {
        if (cancelled) return;
        if (next.masterPasswordSet && next.sealed) {
          router.replace(unlockRoute());
          return;
        }
        setStatus({
          claudeConfigured: next.claudeConfigured,
          codexConfigured: next.codexConfigured,
        });
        setPhase({ kind: 'editing' });
      })
      .catch((caught) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message:
            caught instanceof VerityApiError ? caught.message : 'Could not load AI backend status.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const configured = {
    claude: status.claudeConfigured,
    codex: status.codexConfigured,
  };
  return (
    <OnboardingStepScaffold
      stepId="ai-backends"
      title="Agent logins"
      back={activeLogin ? null : BACK}
      next={
        activeLogin
          ? null
          : {
              href: NEXT_HREF,
              label: 'Next',
              disabled: !status.claudeConfigured && !status.codexConfigured,
            }
      }
    >
      {phase.kind === 'loading' ? (
        <ActivityIndicator size="small" color={theme.colors.accent} />
      ) : null}

      {phase.kind === 'error' ? (
        <Text style={styles.error} accessibilityRole="alert">
          {phase.message}
        </Text>
      ) : null}

      {phase.kind === 'editing' ? (
        <AgentLoginPanel
          client={client}
          configured={configured}
          onActiveChange={setActiveLogin}
          onConfiguredChange={(provider, nextConfigured) => {
            setStatus((current) => ({
              ...current,
              ...(provider === 'claude'
                ? { claudeConfigured: nextConfigured }
                : { codexConfigured: nextConfigured }),
            }));
          }}
          onSealed={() => router.replace(unlockRoute())}
        />
      ) : null}
    </OnboardingStepScaffold>
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
  intro: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
}));
