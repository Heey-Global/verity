import {
  githubRepositoryAccessReady,
  selectedOpenCodeModels,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text } from 'react-native';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { type IconName } from '../../../components/Icon';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';
import { useLoadVeritySettings, useVeritySettings } from '../../../lib/settingsStore';

type Usage = Awaited<ReturnType<VerityClient['getConnectionUsage']>>;

type Connection = {
  usageKey: keyof Usage;
  title: string;
  group: string;
  icon: IconName;
  subtitle: string;
  route: Href;
  connected: boolean;
  status?: string;
};

export default function ConnectionsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <ConnectionsView client={client} />
  ) : (
    <SettingsMessage
      title="Not connected"
      subtitle="Connect to your Verity server first."
      screenTitle="Connections"
    />
  );
}

function ConnectionsView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const [matrix, setMatrix] = useState<{ connected: boolean; status?: string }>({
    connected: false,
  });
  const [mcpCount, setMcpCount] = useState(0);
  const [usage, setUsage] = useState<Awaited<
    ReturnType<VerityClient['getConnectionUsage']>
  > | null>(null);
  const [google, setGoogle] = useState<{ connected: boolean; accountEmail: string | null } | null>(
    null,
  );
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.allSettled([
        client.listIntegrations(),
        client.listHttpMcpConnections(),
        Promise.resolve().then(() => client.getGoogleConnection()),
        Promise.resolve().then(() => client.getConnectionUsage()),
      ]).then(([integrations, mcp, googleAccount, connectionUsage]) => {
        if (!active) return;
        setError(
          integrations.status === 'rejected' ||
            mcp.status === 'rejected' ||
            googleAccount.status === 'rejected',
        );
        if (connectionUsage.status === 'fulfilled') setUsage(connectionUsage.value);
        if (googleAccount.status === 'fulfilled')
          setGoogle({
            connected: googleAccount.value.connected,
            accountEmail: googleAccount.value.accountEmail,
          });
        if (integrations.status === 'fulfilled') {
          const account = integrations.value.accounts.find((item) => item.provider === 'matrix');
          setMatrix(account ? { connected: true, status: account.status } : { connected: false });
        }
        if (mcp.status === 'fulfilled') setMcpCount(mcp.value.length);
      });
      return () => {
        active = false;
      };
    }, [client, retry]),
  );
  const rows: Connection[] = [
    {
      title: 'GitHub',
      usageKey: 'github',
      group: 'Code',
      icon: 'github',
      subtitle: 'Repository access, commit author, signing key',
      route: '/settings/github',
      connected: githubRepositoryAccessReady(settings),
    },
    {
      title: 'Claude',
      usageKey: 'claude',
      group: 'Agents',
      icon: 'terminal',
      subtitle: 'Use your Claude subscription',
      route: '/settings/services/claude',
      connected: settings?.claudeCodeOauthCredentialsConfigured === true,
    },
    {
      title: 'Codex',
      usageKey: 'codex',
      group: 'Agents',
      icon: 'terminal',
      subtitle: 'Use your Codex subscription',
      route: '/settings/services/codex',
      connected: settings?.codexAuthJsonConfigured === true,
    },
    {
      title: 'OpenCode',
      usageKey: 'opencode',
      group: 'Agents',
      icon: 'terminal',
      subtitle: 'Custom providers and models',
      route: '/settings/services/opencode',
      connected:
        settings?.opencodeApiKeyConfigured === true &&
        Boolean(settings.opencodeBaseUrl?.trim()) &&
        selectedOpenCodeModels(settings).length > 0,
    },
    {
      title: 'Google',
      usageKey: 'google',
      group: 'Files & documents',
      icon: 'folder',
      subtitle: 'Drive, Docs, Sheets, Slides, mail and calendar',
      route: '/settings/google' as Href,
      connected: google?.connected ?? settings?.googleDriveConnected === true,
      ...(google?.accountEmail ? { status: google.accountEmail } : {}),
    },
    {
      title: 'Matrix',
      usageKey: 'matrix',
      group: 'Messaging',
      icon: 'message-circle',
      subtitle: 'Import room messages into project knowledge',
      route: '/settings/services/matrix',
      ...matrix,
    },
    {
      title: 'Doppler',
      usageKey: 'doppler',
      group: 'Secrets',
      icon: 'cloud',
      subtitle: 'Managed secrets for your projects',
      route: '/settings/services/doppler' as Href,
      connected: settings?.dopplerServiceTokenConfigured === true,
    },
    {
      title: 'MCP servers',
      usageKey: 'mcp',
      group: 'Advanced',
      icon: 'link',
      subtitle: 'Connect additional agent tools',
      route: '/settings/services/mcp',
      connected: mcpCount > 0,
      ...(mcpCount > 0 ? { status: `${mcpCount} configured` } : {}),
    },
  ];
  const renderRows = (items: Connection[]) => (
    <SettingsListPanel>
      {items.map((item) => (
        <SettingsNavRow
          key={item.title}
          icon={item.icon}
          title={item.title}
          subtitle={
            usage && item.connected
              ? `${item.subtitle} · Used in ${usage[item.usageKey]} ${usage[item.usageKey] === 1 ? 'project' : 'projects'}`
              : item.subtitle
          }
          status={{
            intent: item.connected
              ? item.status && item.status !== 'online' && item.title === 'Matrix'
                ? 'transient'
                : 'ready'
              : 'optional',
            label: item.status ?? (item.connected ? 'Connected' : 'Connect'),
          }}
          onPress={() => router.push(item.route)}
        />
      ))}
    </SettingsListPanel>
  );
  return (
    <SettingsScaffold
      title="Connections"
      detail
      onRetry={() => {
        reload();
        setRetry((value) => value + 1);
      }}
    >
      <SettingsGroup title="Connected" description="Manage the services you use.">
        {rows.some((item) => item.connected) ? (
          renderRows(rows.filter((item) => item.connected))
        ) : (
          <SettingsPanel>
            <Text style={styles.reproHint}>No connections yet. Add only what you need below.</Text>
          </SettingsPanel>
        )}
      </SettingsGroup>
      <SettingsGroup title="Meetings">
        <SettingsListPanel>
          <SettingsNavRow
            icon="mic"
            title="Attendee"
            subtitle="Online meeting bots and transcripts"
            onPress={() => router.push('/settings/services/attendee')}
          />
        </SettingsListPanel>
      </SettingsGroup>
      {error ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>
            Some connection statuses could not be loaded. Open a connection to check its status.
          </Text>
        </SettingsPanel>
      ) : null}
      {rows.some((item) => !item.connected) ? (
        <Text accessibilityRole="header" style={styles.disclosureTitle}>
          Available
        </Text>
      ) : null}
      {['Agents', 'Code', 'Files & documents', 'Messaging', 'Secrets', 'Advanced'].map((group) => {
        const available = rows.filter((item) => !item.connected && item.group === group);
        return available.length > 0 ? (
          <SettingsGroup
            key={group}
            title={group}
            description={
              group === 'Agents' ? 'Available connections — add only what you need.' : undefined
            }
          >
            {renderRows(available)}
          </SettingsGroup>
        ) : null;
      })}
    </SettingsScaffold>
  );
}
