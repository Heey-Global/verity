import { type VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { SettingsGroup, SettingsNavRow, SettingsPanel, SettingsToggleRow } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

const services = ['gmail', 'calendar', 'contacts'] as const;
type Service = (typeof services)[number];
type Connection = {
  enabled: boolean;
  connected: boolean;
  accountEmail?: string | null;
  legacySessionCount?: number;
};
const labels = { gmail: 'Gmail', calendar: 'Calendar', contacts: 'Contacts' };

export function ProjectGoogleServices({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [connections, setConnections] = useState<Partial<Record<Service, Connection>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const result = await Promise.all(
        services.map(
          async (service) =>
            [service, await client.getProjectGoogleConnection(projectId, service)] as const,
        ),
      );
      setConnections(Object.fromEntries(result));
      setError(null);
    } catch {
      setError('Could not load Google access. Try again.');
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const toggle = async (service: Service, enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) await client.enableProjectGoogleConnection(projectId, service);
      else await client.disableProjectGoogleConnection(projectId, service);
      await reload();
    } catch {
      setError('Could not change Google access. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup
      title="Google services"
      description="Access applies to every session in this project. Enable only the services this project needs."
    >
      {loading ? <ActivityIndicator /> : null}
      {error ? (
        <SettingsNavRow icon="refresh-cw" title={error} onPress={() => void reload()} />
      ) : null}
      {services.map((service) => {
        const connection = connections[service];
        if (!connection) return null;
        return connection.connected ? (
          <SettingsPanel key={service}>
            <SettingsToggleRow
              label={labels[service]}
              value={connection.enabled}
              disabled={busy}
              onValueChange={(enabled) => void toggle(service, enabled)}
            />
            {(connection.legacySessionCount ?? 0) > 0 ? (
              <>
                <Text style={styles.reproSubtitle}>
                  {connection.legacySessionCount} existing chats have separate access.
                </Text>
                <SettingsNavRow
                  icon="x"
                  title={`Revoke all ${labels[service]} access`}
                  subtitle="Remove access from this project and its existing chats"
                  onPress={() => void toggle(service, false)}
                />
              </>
            ) : null}
          </SettingsPanel>
        ) : (
          <SettingsNavRow
            key={service}
            icon="link"
            title={`Connect ${labels[service]}`}
            subtitle="Add account access in Connections first"
            onPress={() => router.push('/settings/google')}
          />
        );
      })}
      {!loading && Object.keys(connections).length === 0 ? (
        <Text style={styles.reproSubtitle}>Google access unavailable.</Text>
      ) : null}
    </SettingsGroup>
  );
}
