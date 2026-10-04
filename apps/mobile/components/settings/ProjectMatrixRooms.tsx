import { type IntegrationSource, type VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Text } from 'react-native';
import { SettingsGroup, SettingsListPanel, SettingsNavRow, SettingsPanel } from './SettingsChrome';
import { projectMatrixRooms } from '../../lib/projectMatrixRooms';
import { settingsStyles as styles } from './settingsStyles';

export function ProjectMatrixRooms({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [sources, setSources] = useState<IntegrationSource[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const result = await client.listIntegrations();
      setConnected(result.accounts.some((account) => account.provider === 'matrix'));
      setSources(result.sources);
      setError(null);
    } catch {
      setError('Could not load Matrix rooms. Try again.');
    } finally {
      setLoading(false);
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const change = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await reload();
    } catch {
      setError('Could not update the room. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const rooms = projectMatrixRooms(sources, projectId);
  return (
    <SettingsGroup
      title="Matrix rooms"
      description="Choose which rooms send messages to this project. Each room belongs to one project."
    >
      {loading ? <ActivityIndicator /> : null}
      {error ? (
        <SettingsNavRow icon="refresh-cw" title={error} onPress={() => void reload()} />
      ) : null}
      {!loading && !connected ? (
        <SettingsListPanel>
          <SettingsNavRow
            icon="link"
            title="Connect Matrix"
            subtitle="Connect an account before choosing rooms."
            onPress={() => router.push('/settings/services/matrix')}
          />
        </SettingsListPanel>
      ) : null}
      {rooms.connected.map((source) => (
        <SettingsListPanel key={`${source.accountId}:${source.sourceId}`}>
          <SettingsNavRow
            icon="link"
            title={source.displayName}
            subtitle={source.status}
            onPress={() => {
              if (busy) return;
              Alert.alert(source.displayName, 'Manage this project’s room connection.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: source.status === 'paused' ? 'Resume' : 'Pause',
                  onPress: () =>
                    void change(() =>
                      client.pauseIntegrationSource(
                        source.accountId,
                        source.sourceId,
                        source.status !== 'paused',
                      ),
                    ),
                },
                {
                  text: 'Disconnect',
                  style: 'destructive',
                  onPress: () =>
                    Alert.alert(
                      'Disconnect room?',
                      'Existing Knowledge stays in this project. Invite the Matrix account again to reconnect.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Disconnect',
                          style: 'destructive',
                          onPress: () =>
                            void change(() =>
                              client.disconnectIntegrationSource(source.accountId, source.sourceId),
                            ),
                        },
                      ],
                    ),
                },
              ]);
            }}
          />
        </SettingsListPanel>
      ))}
      {rooms.invitations.map((source) => (
        <SettingsListPanel key={`${source.accountId}:${source.sourceId}`}>
          <SettingsNavRow
            icon="plus"
            title={source.displayName}
            subtitle="Invitation · Connect to this project"
            onPress={() => {
              if (!busy)
                Alert.alert(
                  'Connect room?',
                  `${source.displayName} will send new messages to this project.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Connect',
                      onPress: () =>
                        void change(() =>
                          client.bindIntegrationSource(
                            source.accountId,
                            source.sourceId,
                            projectId,
                          ),
                        ),
                    },
                  ],
                );
            }}
          />
        </SettingsListPanel>
      ))}
      {!loading &&
      connected &&
      !error &&
      rooms.connected.length + rooms.invitations.length === 0 ? (
        <SettingsPanel>
          <Text style={styles.reproSubtitle}>
            No rooms connected. Invite your Matrix account to a room to connect it here.
          </Text>
        </SettingsPanel>
      ) : null}
      {busy ? <ActivityIndicator /> : null}
    </SettingsGroup>
  );
}
