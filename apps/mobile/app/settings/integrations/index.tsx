import { projectDisplayName, type IntegrationSource, type VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';

export default function IntegrationsSettingsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server to manage integrations."
        screenTitle="Integrations"
      />
    );
  }
  return <IntegrationsView client={client} projectId={projectId ?? null} />;
}

function IntegrationsView({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string | null;
}) {
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [sources, setSources] = useState<IntegrationSource[]>([]);
  const [account, setAccount] = useState<{
    displayName: string;
    status: string;
    lastError: string | null;
  } | null>(null);
  const [projects, setProjects] = useState<Awaited<ReturnType<VerityClient['listProjects']>>>([]);
  const [selected, setSelected] = useState<IntegrationSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectName = (projectId: string | null): string => {
    const project = projects.find((item) => item.id === projectId);
    return project ? projectDisplayName(project) : (projectId ?? 'Unknown project');
  };

  const reload = useCallback(async () => {
    try {
      const [integrations, projectList] = await Promise.all([
        client.listIntegrations(),
        client.listProjects(),
      ]);
      setSources(integrations.sources);
      setAccount(integrations.accounts.find((item) => item.provider === 'matrix') ?? null);
      setProjects(projectList);
      if (projectId) {
        const config = await client.getProjectMatrixConfig(projectId);
        setEndpoint(config?.endpoint ?? '');
        setUsername(config?.username ?? '');
        setPasswordConfigured(config?.passwordConfigured ?? false);
      }
      setError(null);
    } catch {
      setError('Could not load integrations.');
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveAccount = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      await client.saveProjectMatrixConfig(projectId, {
        endpoint: endpoint.trim(),
        username: username.trim(),
        password,
      });
      setPassword('');
      await reload();
    } catch {
      setError('Could not save the Matrix account. Check the URL and account name.');
    } finally {
      setBusy(false);
    }
  };

  const bind = async (source: IntegrationSource, projectId: string) => {
    setBusy(true);
    try {
      await client.bindIntegrationSource(source.accountId, source.sourceId, projectId);
      setSelected(null);
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

  return (
    <SettingsScaffold title="Integrations" detail onRetry={() => void reload()}>
      <SettingsGroup
        title="Matrix"
        description="Import bridged WhatsApp and Signal conversations into project Knowledge."
      >
        <SettingsPanel>
          <Text style={styles.disclosureTitle}>{account?.displayName ?? 'Not connected'}</Text>
          <Text style={styles.reproSubtitle}>
            {account
              ? `Connector ${account.status}. Invite its Matrix account to a room, then choose a project below.`
              : 'Enter a dedicated Matrix account below to receive room invitations.'}
          </Text>
          {account?.lastError ? <Text style={styles.reproHint}>{account.lastError}</Text> : null}
          {projectId ? (
            <View>
              <TextInput
                accessibilityLabel="Matrix homeserver URL"
                value={endpoint}
                onChangeText={setEndpoint}
                placeholder="https://matrix.example.com"
                autoCapitalize="none"
                style={styles.input}
              />
              <TextInput
                accessibilityLabel="Matrix account ID"
                value={username}
                onChangeText={setUsername}
                placeholder="@verity:example.com"
                autoCapitalize="none"
                style={styles.input}
              />
              <TextInput
                accessibilityLabel="Matrix password"
                value={password}
                onChangeText={setPassword}
                placeholder={
                  passwordConfigured ? 'Password saved; enter a new one to replace it' : 'Password'
                }
                secureTextEntry
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                disabled={busy || !endpoint || !username || !password}
                onPress={() => void saveAccount()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonLabel}>Save Matrix account</Text>
              </Pressable>
              <Text style={styles.reproHint}>
                One Matrix account serves all projects. The password is stored encrypted on the
                server.
              </Text>
            </View>
          ) : null}
        </SettingsPanel>
      </SettingsGroup>

      {error ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>{error}</Text>
        </SettingsPanel>
      ) : null}
      {loading ? <ActivityIndicator /> : null}

      <SettingsGroup
        title="Invitations"
        description="A room is imported only after you connect it to a project."
      >
        <SettingsListPanel>
          {sources.filter((item) => item.status === 'pending').length === 0 ? (
            <SettingsPanel>
              <Text style={styles.reproSubtitle}>No pending rooms.</Text>
            </SettingsPanel>
          ) : (
            sources
              .filter((item) => item.status === 'pending')
              .map((item) => (
                <SettingsNavRow
                  key={`${item.accountId}:${item.sourceId}`}
                  icon="link"
                  title={item.displayName}
                  subtitle={item.inviter ? `Invited by ${item.inviter}` : item.sourceId}
                  onPress={() => setSelected(item)}
                />
              ))
          )}
        </SettingsListPanel>
      </SettingsGroup>

      {selected ? (
        <SettingsGroup title={`Connect ${selected.displayName} to a project`}>
          <SettingsListPanel>
            {projects.map((project) => (
              <SettingsNavRow
                key={project.id}
                icon="folder"
                title={projectDisplayName(project)}
                subtitle="Import new messages into this project"
                onPress={() => {
                  if (!busy) void bind(selected, project.id);
                }}
              />
            ))}
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Connected rooms"
        description="Pausing holds new messages until you resume importing."
      >
        {sources
          .filter((item) => item.projectId)
          .map((item) => (
            <SettingsPanel key={`${item.accountId}:${item.sourceId}`}>
              <Text style={styles.disclosureTitle}>{item.displayName}</Text>
              <Text style={styles.reproSubtitle}>
                {projectName(item.projectId)} · {item.status}
              </Text>
              <Text style={styles.reproHint}>
                {item.lastIngestedAt
                  ? `Last import: ${new Date(item.lastIngestedAt).toLocaleString()}`
                  : 'No messages imported yet.'}
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  onPress={() => void change(item, item.status === 'paused' ? 'resume' : 'pause')}
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
          ))}
      </SettingsGroup>
    </SettingsScaffold>
  );
}
