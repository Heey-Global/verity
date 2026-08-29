// One-page GitHub onboarding: connect in the browser, resolve the commit author,
// generate the server-side signing key, and register its public key on GitHub.
import { type VerityClient } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GithubCommitSetup } from '../../components/GithubCommitSetup';
import { GithubConnectPanel } from '../../components/GithubConnectPanel';
import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import { createVerityClient } from '../../lib/client';

const NEXT = { href: '/onboarding/doppler' } as const;
const BACK = '/onboarding/master-password';

export default function OnboardingGithub() {
  const client = createVerityClient();
  if (client === null) {
    return (
      <OnboardingStepScaffold stepId="github" title="GitHub" back={BACK} next={NEXT}>
        <View style={styles.card}>
          <Text style={styles.intro}>
            No server is configured yet — you can connect GitHub later from Settings.
          </Text>
        </View>
      </OnboardingStepScaffold>
    );
  }
  return <GithubStep client={client} />;
}

function GithubStep({ client }: { client: VerityClient }) {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client
      .fetchOnboardingStatus()
      .then((status) => {
        if (!cancelled && status.githubAppConfigured) setConnected(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <OnboardingStepScaffold stepId="github" title="GitHub" back={BACK} next={ready ? NEXT : null}>
      {connected ? (
        <GithubCommitSetup client={client} onCompletionChange={setReady} />
      ) : (
        <GithubConnectPanel client={client} onConnected={() => setConnected(true)} />
      )}
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
  intro: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 * theme.fontScale },
}));
