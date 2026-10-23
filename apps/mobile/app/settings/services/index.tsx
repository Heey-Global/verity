import {
  codeHostFromConnection,
  forgejoConnection,
  githubRepositoryAccessReady,
  selectedOpenCodeModels,
  type ForgeConnectionList,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { CodeHostIcon } from '../../../components/CodeHostIcon';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { type IconName } from '../../../components/Icon';
import { type StatusIntent } from '../../../components/ui/Status';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';
import { githubActionNeeded, useGithubPermission } from '../../../lib/githubPermission';
import { useLoadVeritySettings, useVeritySettings } from '../../../lib/settingsStore';

type Usage = Awaited<ReturnType<VerityClient['getConnectionUsage']>>;

type Connection = {
  usageKey: Exclude<keyof Usage, 'forgejo'>;
  title: string;
  group: string;
  icon: IconName;
  subtitle: string;
  route: Href;
  connected: boolean;
  status?: string;
  statusIntent?: StatusIntent;
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

function usedIn(count: number): string {
  return `Used in ${count} ${count === 1 ? 'project' : 'projects'}`;
}

/**
 * GitHub and Forgejo as rows of the same kind, so neither reads as the primary
 * code host. All four setups render: GitHub only, Forgejo only, both, or neither
 * (both rows then offer "Connect").
 */
function CodeHostRows({
  githubConnected,
  githubStatus,
  forge,
  usage,
}: {
  githubConnected: boolean;
  githubStatus: { intent: StatusIntent; label: string } | undefined;
  forge: ForgeConnectionList | null;
  usage: Usage | null;
}) {
  const { theme } = useUnistyles();
  const mark = (provider: 'github' | 'forgejo') => ({
    element: <CodeHostIcon provider={provider} color={theme.colors.action} />,
  });
  const forgejo = forgejoConnection(forge);
  const forgejoHost = forgejo ? codeHostFromConnection(forgejo) : undefined;
  const githubSubtitle = 'Repository access, commit author, signing key';
  return (
    <SettingsListPanel>
      <SettingsNavRow
        icon={mark('github')}
        title="GitHub"
        subtitle={
          usage && githubConnected ? `${githubSubtitle} · ${usedIn(usage.github)}` : githubSubtitle
        }
        status={
          githubStatus ?? {
            intent: githubConnected ? 'ready' : 'optional',
            label: githubConnected ? 'Connected' : 'Connect',
          }
        }
        onPress={() => router.push('/settings/github')}
      />
      {forgejo && forgejoHost ? (
        <SettingsNavRow
          icon={mark('forgejo')}
          title={forgejoHost.title}
          subtitle={
            usage
              ? `${forgejoHost.host} · ${usedIn(usage.forgejo[forgejo.id] ?? 0)}`
              : forgejoHost.host
          }
          status={{ intent: 'ready', label: 'Connected' }}
          onPress={() =>
            router.push({ pathname: '/settings/forgejo/[id]', params: { id: forgejo.id } })
          }
        />
      ) : forge !== null ? (
        // Without /connections (older server, non-admin) Forgejo cannot be added.
        <SettingsNavRow
          icon={mark('forgejo')}
          title="Forgejo"
          subtitle="Self-hosted Git server"
          status={{ intent: 'optional', label: 'Connect' }}
          onPress={() => router.push('/settings/forgejo/new')}
        />
      ) : null}
    </SettingsListPanel>
  );
}

function ConnectionsView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const githubConnected = githubRepositoryAccessReady(settings);
  const githubPermission = useGithubPermission(client, githubConnected);
  const [matrix, setMatrix] = useState<{ connected: boolean; status?: string }>({
    connected: false,
  });
  const [mcpCount, setMcpCount] = useState(0);
  const [forge, setForge] = useState<ForgeConnectionList | null>(null);
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
        Promise.resolve().then(() => client.listConnections()),
      ]).then(([integrations, mcp, googleAccount, connectionUsage, forgeConnections]) => {
        if (!active) return;
        if (forgeConnections.status === 'fulfilled') setForge(forgeConnections.value);
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
      title: 'Claude',
      usageKey: 'claude',
      group: 'Agents',
      icon: 'terminal',
      subtitle: 'Use your Claude subscription',
      route: '/settings/services/claude',
      connected: settings?.claudeCodeOauthCredentialsConfigured === true,
      ...(settings?.claudeCodeOauthCredentialsConfigured &&
      settings.claudeCredentialStatus?.state === 'relogin_required'
        ? { status: 'Re-login needed', statusIntent: 'needsSetup' as const }
        : settings?.claudeCodeOauthCredentialsConfigured &&
            settings.claudeCredentialStatus?.state === 'refresh_failed'
          ? { status: 'Retrying', statusIntent: 'transient' as const }
          : {}),
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
      group: 'Communication',
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
  const renderRows = (items: Connection[], includeMeetings = false) => (
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
            intent:
              item.statusIntent ??
              (item.connected
                ? item.status && item.status !== 'online' && item.title === 'Matrix'
                  ? 'transient'
                  : 'ready'
                : 'optional'),
            label: item.status ?? (item.connected ? 'Connected' : 'Connect'),
          }}
          onPress={() => router.push(item.route)}
        />
      ))}
      {includeMeetings ? (
        <SettingsNavRow
          icon="mic"
          title="Attendee"
          subtitle="Online meeting bots and transcripts"
          onPress={() => router.push('/settings/services/attendee')}
        />
      ) : null}
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
      {['Agents', 'Code', 'Files & documents', 'Communication', 'Secrets', 'Advanced'].map(
        (group) => (
          <SettingsGroup key={group} title={group}>
            {group === 'Code' ? (
              <CodeHostRows
                githubConnected={githubConnected}
                githubStatus={
                  githubConnected && githubActionNeeded(githubPermission)
                    ? { intent: 'needsSetup', label: 'Action needed' }
                    : undefined
                }
                forge={forge}
                usage={usage}
              />
            ) : (
              renderRows(
                rows.filter((item) => item.group === group),
                group === 'Communication',
              )
            )}
          </SettingsGroup>
        ),
      )}
      {error ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>
            Some connection statuses could not be loaded. Open a connection to check its status.
          </Text>
        </SettingsPanel>
      ) : null}
    </SettingsScaffold>
  );
}
