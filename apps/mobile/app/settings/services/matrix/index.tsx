import { type IntegrationAccount, type IntegrationSource, type VerityClient } from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';

export default function MatrixRoomsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server to manage Matrix rooms."
        screenTitle="Matrix"
      />
    );
  }
  return <MatrixRoomsView client={client} projectId={projectId ?? null} />;
}

function MatrixRoomsView({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string | null;
}) {
  const [sources, setSources] = useState<IntegrationSource[]>([]);
  const [account, setAccount] = useState<IntegrationAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const integrations = await client.listIntegrations();
      setSources(integrations.sources);
      setAccount(integrations.accounts.find((item) => item.provider === 'matrix') ?? null);
      setError(null);
    } catch {
      setError(
        'Could not load integrations. Check that your Verity server is updated, then retry.',
      );
    } finally {
      setLoading(false);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const bind = async (source: IntegrationSource) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await client.bindIntegrationSource(source.accountId, source.sourceId, projectId);
      await reload();
    } catch {
      setError('Could not connect this room.');
    } finally {
      setBusy(false);
    }
  };

  const change = async (source: IntegrationSource, action: 'pause' | 'resume' | 'disconnect') => {
    setBusy(true);
    try {
      if (action === 'disconnect')
        await client.disconnectIntegrationSource(source.accountId, source.sourceId);
      else
        await client.pauseIntegrationSource(source.accountId, source.sourceId, action === 'pause');
      await reload();
    } catch {
      setError('Could not update this room.');
    } finally {
      setBusy(false);
    }
  };

  const pending = sources.filter((item) => item.status === 'pending');
  const connected = sources.filter(
    (item) => item.projectId && (!projectId || item.projectId === projectId),
  );

  return (
    <SettingsScaffold
      title={projectId ? 'Project rooms' : 'Matrix'}
      detail
      onRetry={() => void reload()}
    >
      {!projectId ? (
        <SettingsGroup title="Account" description="One Matrix account serves all projects.">
          <SettingsListPanel>
            <SettingsNavRow
              icon="user"
              title="Matrix account"
              subtitle="Homeserver, account ID, and password"
              status={
                account
                  ? {
                      intent: account.status === 'online' ? 'ready' : 'transient',
                      label: account.status,
                    }
                  : undefined
              }
              onPress={() => router.push('/settings/services/matrix/account')}
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
      {error ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>{error}</Text>
        </SettingsPanel>
      ) : null}
      {loading ? <ActivityIndicator /> : null}
      {!loading && !error ? (
        <>
          <SettingsGroup
            title="Invitations"
            description={
              projectId
                ? 'Tap a room to import its new messages into this project.'
                : 'Connect invited rooms from the Integrations section of a project.'
            }
          >
            {pending.length === 0 ? (
              <SettingsPanel>
                <Text style={styles.reproSubtitle}>No pending rooms.</Text>
              </SettingsPanel>
            ) : (
              <SettingsListPanel>
                {pending.map((item) =>
                  projectId ? (
                    <SettingsNavRow
                      key={`${item.accountId}:${item.sourceId}`}
                      icon="link"
                      title={item.displayName}
                      subtitle={item.inviter ? `Invited by ${item.inviter}` : item.sourceId}
                      onPress={() => {
                        if (!busy) void bind(item);
                      }}
                    />
                  ) : (
                    <SettingsPanel key={`${item.accountId}:${item.sourceId}`}>
                      <Text style={styles.disclosureTitle}>{item.displayName}</Text>
                      <Text style={styles.reproSubtitle}>
                        {item.inviter ? `Invited by ${item.inviter}` : item.sourceId}
                      </Text>
                    </SettingsPanel>
                  ),
                )}
              </SettingsListPanel>
            )}
          </SettingsGroup>
          <SettingsGroup
            title="Connected rooms"
            description={
              projectId
                ? 'Pausing holds new messages until you resume importing.'
                : 'Each room belongs to one project.'
            }
          >
            {connected.length === 0 ? (
              <SettingsPanel>
                <Text style={styles.reproSubtitle}>No connected rooms.</Text>
              </SettingsPanel>
            ) : (
              connected.map((item) =>
                projectId ? (
                  <SettingsPanel key={`${item.accountId}:${item.sourceId}`}>
                    <Text style={styles.disclosureTitle}>{item.displayName}</Text>
                    <Text style={styles.reproSubtitle}>{item.status}</Text>
                    <Text style={styles.reproHint}>
                      {item.lastIngestedAt
                        ? `Last import: ${new Date(item.lastIngestedAt).toLocaleString()}`
                        : 'No messages imported yet.'}
                    </Text>
                    <View style={styles.actionRow}>
                      <Pressable
                        disabled={busy}
                        accessibilityRole="button"
                        onPress={() =>
                          void change(item, item.status === 'paused' ? 'resume' : 'pause')
                        }
                        style={styles.primaryButton}
                      >
                        <Text style={styles.primaryButtonLabel}>
                          {item.status === 'paused' ? 'Resume' : 'Pause'}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={busy}
                        accessibilityRole="button"
                        onPress={() =>
                          Alert.alert(
                            'Disconnect room?',
                            'Existing Knowledge stays in the project. Invite the Matrix account again to reconnect.',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Disconnect',
                                style: 'destructive',
                                onPress: () => void change(item, 'disconnect'),
                              },
                            ],
                          )
                        }
                        style={styles.dangerButton}
                      >
                        <Text style={styles.dangerButtonLabel}>Disconnect</Text>
                      </Pressable>
                    </View>
                  </SettingsPanel>
                ) : (
                  <SettingsListPanel key={`${item.accountId}:${item.sourceId}`}>
                    <SettingsNavRow
                      icon="link"
                      title={item.displayName}
                      subtitle={`Project ${item.projectId} · ${item.status}`}
                      onPress={() =>
                        router.push({
                          pathname: '/settings/services/matrix',
                          params: { projectId: item.projectId! },
                        })
                      }
                    />
                  </SettingsListPanel>
                ),
              )
            )}
          </SettingsGroup>
        </>
      ) : null}
    </SettingsScaffold>
  );
}
