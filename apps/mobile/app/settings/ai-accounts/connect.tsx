// Connecting Claude or Codex as the signed-in person's own account: the
// provider's own sign-in, with its device code, and — for Claude — the code the
// sign-in page hands back. The login belongs to this person alone.
import type { AgentLogin, AgentLoginProvider, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingsMessage, SettingsScaffold } from '../../../components/settings/SettingsChrome';
import { Button, Card, StepIntro, Text, TextField } from '../../../components/ui';
import { createVerityClient } from '../../../lib/client';

const POLL_MS = 2_000;
const NAMES: Record<AgentLoginProvider, { name: string; lead: string }> = {
  claude: { name: 'Claude', lead: 'Sign in with your Claude account.' },
  codex: { name: 'Codex', lead: 'Sign in with your ChatGPT account.' },
};

export default function ConnectProviderScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const { provider } = useLocalSearchParams<{ provider?: string }>();
  if (!client || (provider !== 'claude' && provider !== 'codex')) {
    return (
      <SettingsMessage
        title="Not available"
        subtitle="Open this from My AI accounts."
        screenTitle="Connect"
      />
    );
  }
  return <ConnectProviderView client={client} provider={provider} />;
}

/** Where the sign-in page lives, without the scheme, for the button label. */
function shortUri(uri: string): string {
  return uri.replace(/^https?:\/\//u, '');
}

export function ConnectProviderView({
  client,
  provider,
  onDone = () => router.back(),
}: {
  client: VerityClient;
  provider: AgentLoginProvider;
  onDone?: () => void;
}) {
  const { theme } = useUnistyles();
  const [login, setLogin] = useState<AgentLogin | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const attempt = useRef(0);

  const start = useCallback(() => {
    const generation = ++attempt.current;
    setError(undefined);
    setLogin(null);
    client
      .startProviderConnectionLogin(provider)
      .then((started) => {
        if (generation === attempt.current) setLogin(started);
      })
      .catch((caught: unknown) => {
        if (generation === attempt.current)
          setError(caught instanceof Error ? caught.message : 'Could not start the sign-in');
      });
  }, [client, provider]);
  useEffect(() => {
    start();
    return () => {
      attempt.current += 1;
    };
  }, [start]);

  const sessionId = login?.sessionId;
  const settled = login?.status === 'complete' || login?.status === 'failed';
  useEffect(() => {
    if (sessionId === undefined || settled) return;
    const generation = attempt.current;
    const timer = setInterval(() => {
      client
        .getProviderConnectionLogin(sessionId)
        .then((next) => {
          if (generation === attempt.current) setLogin(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, sessionId, settled]);

  useEffect(() => {
    if (login?.status === 'complete') onDone();
  }, [login?.status, onDone]);

  const submitCode = () => {
    if (sessionId === undefined || code.trim() === '') return;
    setSubmitting(true);
    client
      .submitProviderConnectionLoginCode(sessionId, code.trim())
      .then(setLogin)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'The code was not accepted'),
      )
      .finally(() => setSubmitting(false));
  };

  const { name, lead } = NAMES[provider];
  const failed = login?.status === 'failed';
  return (
    <SettingsScaffold
      title={`Connect ${name}`}
      detail
      state={{ error, saving: false }}
      onRetry={start}
      footer={<Button label="Cancel" variant="secondary" onPress={onDone} fullWidth />}
    >
      <StepIntro headline="Connect" accent={name} lead={lead} />
      {login?.verificationUri ? (
        <Card stacked>
          <Text variant="label" tone="muted">
            1 · Open the sign-in page
          </Text>
          <Button
            label={`Open ${shortUri(login.verificationUri)}`}
            onPress={() => void Linking.openURL(login.verificationUri ?? '')}
            fullWidth
          />
          {login.userCode ? (
            <>
              <Text variant="label" tone="muted">
                2 · Enter this code
              </Text>
              <Text variant="title">{login.userCode}</Text>
              <Button
                label={copied ? 'Copied' : 'Copy code'}
                size="small"
                variant="secondary"
                onPress={() => {
                  void Clipboard.setStringAsync(login.userCode ?? '').then(() => setCopied(true));
                }}
              />
            </>
          ) : null}
          {login.needsCode ? (
            <>
              <Text variant="label" tone="muted">
                2 · Paste the code the sign-in page shows
              </Text>
              <TextField label="Code" value={code} onChangeText={setCode} literal />
              <Button
                label="Continue"
                onPress={submitCode}
                disabled={submitting || code.trim() === ''}
                fullWidth
              />
            </>
          ) : null}
        </Card>
      ) : null}
      {failed ? (
        <Card stacked>
          <Text variant="bodySmall" tone="muted">
            {login?.message ?? 'The sign-in did not complete.'}
          </Text>
          <Button label="Try again" variant="secondary" onPress={start} />
        </Card>
      ) : (
        <View style={styles.waiting}>
          <ActivityIndicator color={theme.colors.action} />
          <Text variant="bodySmall" tone="muted">
            {login?.verificationUri
              ? 'Waiting for you to confirm on the sign-in page…'
              : 'Starting the sign-in…'}
          </Text>
        </View>
      )}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  waiting: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
}));
