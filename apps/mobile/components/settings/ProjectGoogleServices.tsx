import { useGoogleAccountPicker, googleAccountSupports } from './GoogleAccountPicker';
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
  const [chooseAccount, accountSheet] = useGoogleAccountPicker();
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
      if (enabled) {
        const accounts = (await client.listGoogleAccounts()).filter((account) =>
          googleAccountSupports(account, service),
        );
        const choice = await chooseAccount({ accounts });
        if (!choice) return;
        if (choice.kind === 'add') {
          router.push('/settings/google');
          return;
        }
        if (choice.kind !== 'account') return;
        await client.enableProjectGoogleConnection(projectId, service, choice.accountId);
      } else await client.disableProjectGoogleConnection(projectId, service);
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
      {accountSheet}
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
            {connection.enabled ? (
              <SettingsNavRow
                icon="user"
                title={connection.accountEmail ?? 'Choose account'}
                subtitle="Change project default"
                onPress={() => void toggle(service, true)}
              />
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
