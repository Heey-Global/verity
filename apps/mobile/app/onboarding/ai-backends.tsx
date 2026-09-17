import { VerityApiError, type OnboardingStatus } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentLoginPanel } from '../../components/AgentLoginPanel';
import { OpenCodeSetup } from '../../components/OpenCodeSetup';
import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import { createVerityClient } from '../../lib/client';

const NEXT_HREF = '/';
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
        title="AI providers"
        back={BACK}
        next={{ href: NEXT_HREF, label: 'Next', disabled: true }}
      >
        <View style={styles.card}>
          <Text style={styles.intro}>
            No server is configured yet. Connect a Verity server before choosing an AI provider.
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
    Pick<OnboardingStatus, 'claudeConfigured' | 'codexConfigured'> & {
      opencodeConfigured: boolean;
    }
  >({
    claudeConfigured: false,
    codexConfigured: false,
    opencodeConfigured: false,
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [activeLogin, setActiveLogin] = useState(false);
  const [activeOpenCode, setActiveOpenCode] = useState(false);
  const activeSetup = activeLogin || activeOpenCode;

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
          opencodeConfigured: false,
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
  const setOpenCodeConfigured = useCallback((opencodeConfigured: boolean) => {
    setStatus((current) => ({ ...current, opencodeConfigured }));
  }, []);
  return (
    <OnboardingStepScaffold
      stepId="ai-backends"
      title="AI providers"
      back={activeSetup ? null : BACK}
      next={
        activeSetup
          ? null
          : {
              href: NEXT_HREF,
              label: 'Open Verity',
              disabled:
                !status.claudeConfigured && !status.codexConfigured && !status.opencodeConfigured,
            }
      }
    >
      {phase.kind === 'loading' ? (
        <ActivityIndicator size="small" color={theme.colors.setup.text} />
      ) : null}

      {phase.kind === 'error' ? (
        <Text style={styles.error} accessibilityRole="alert">
          {phase.message}
        </Text>
      ) : null}

      {phase.kind === 'editing' ? (
        <>
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
          <OpenCodeSetup
            client={client}
            onConfiguredChange={setOpenCodeConfigured}
            onActiveChange={setActiveOpenCode}
            onSealed={() => router.replace(unlockRoute())}
          />
        </>
      ) : null}
    </OnboardingStepScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  intro: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
}));
