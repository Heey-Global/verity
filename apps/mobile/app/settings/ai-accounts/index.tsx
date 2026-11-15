// My AI accounts: the signed-in person's own Claude, Codex and OpenCode
// accounts. Their turns run only on these (ADR 0023 §3); no credential ever
// reaches this screen, only which providers are connected.
import type { ProviderConnectionKind, ProviderConnections, VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { AgentProviderIcon } from '../../../components/AgentProviderIcon';
import { SettingsMessage, SettingsScaffold } from '../../../components/settings/SettingsChrome';
import { Button, Group, Row, SectionHeader, StatusTag, useConfirm } from '../../../components/ui';
import { createVerityClient } from '../../../lib/client';

const PROVIDERS: { provider: ProviderConnectionKind; title: string; connect: string }[] = [
  { provider: 'claude', title: 'Claude', connect: 'Sign in with your Claude account' },
  { provider: 'codex', title: 'Codex', connect: 'Sign in with your ChatGPT account' },
  { provider: 'opencode', title: 'OpenCode', connect: 'Your own provider address and API key' },
];

export default function AiAccountsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup first."
        screenTitle="My AI accounts"
      />
    );
  }
  return <AiAccountsView client={client} />;
}

function ProviderMark({ provider }: { provider: ProviderConnectionKind }) {
  const { theme } = useUnistyles();
  return <AgentProviderIcon provider={provider} color={theme.colors.action} size={18} />;
}

export function AiAccountsView({ client }: { client: VerityClient }) {
  const [accounts, setAccounts] = useState<ProviderConnections | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirm, confirmSheet] = useConfirm();

  const load = useCallback(() => {
    setError(undefined);
    client
      .listProviderConnections()
      .then(setAccounts)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load your accounts'),
      );
  }, [client]);
  useFocusEffect(load);

  const connected = PROVIDERS.filter(({ provider }) =>
    accounts?.connections.some((connection) => connection.provider === provider),
  );
  const notConnected = PROVIDERS.filter((entry) => !connected.includes(entry));

  const disconnect = (provider: ProviderConnectionKind, title: string) =>
    confirm({
      title: `Disconnect ${title}?`,
      message: `Your turns can no longer use ${title} until you connect it again.`,
      confirmLabel: 'Disconnect',
      destructive: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          await client.disconnectProviderConnection(provider);
          load();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Could not disconnect');
        } finally {
          setBusy(false);
        }
      },
    });

  const open = (provider: ProviderConnectionKind) =>
    provider === 'opencode'
      ? router.push('/settings/ai-accounts/opencode')
      : router.push({ pathname: '/settings/ai-accounts/connect', params: { provider } });

  return (
    <SettingsScaffold title="My AI accounts" detail state={{ error, saving: busy }} onRetry={load}>
      {connected.length > 0 ? (
        <>
          <SectionHeader title="Connected" variant="eyebrow" />
          <Group>
            {connected.map(({ provider, title }) => (
              <Row
                key={provider}
                leading={{ element: <ProviderMark provider={provider} /> }}
                title={title}
                subtitle={
                  provider === 'opencode'
                    ? (accounts?.connections.find((c) => c.provider === 'opencode')?.baseUrl ??
                      undefined)
                    : undefined
                }
                trailing={<StatusTag intent="ready" label="Connected" />}
                navigates
                onPress={() => disconnect(provider, title)}
              />
            ))}
          </Group>
        </>
      ) : null}
      {accounts !== null && notConnected.length > 0 ? (
        <>
          <SectionHeader title="Not connected" variant="eyebrow" />
          <Group>
            {notConnected.map(({ provider, title, connect }) => (
              <Row
                key={provider}
                leading={{ element: <ProviderMark provider={provider} /> }}
                title={title}
                subtitle={connect}
                trailing={
                  <Button
                    label={provider === 'opencode' ? 'Set up' : 'Connect'}
                    size="small"
                    variant="secondary"
                    onPress={() => open(provider)}
                  />
                }
              />
            ))}
          </Group>
        </>
      ) : null}
      {confirmSheet}
    </SettingsScaffold>
  );
}
