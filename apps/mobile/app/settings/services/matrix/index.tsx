import {
  type IntegrationAccount,
  type IntegrationSource,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../../../components/Icon';
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
  return <MatrixRoomsView client={client} />;
}

function MatrixRoomsView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [sources, setSources] = useState<IntegrationSource[]>([]);
  const [account, setAccount] = useState<IntegrationAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState<{ sourceId: string; projectName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<IntegrationSource | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

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
      void client.listProjects().then(
        (items) => setProjects(items),
        () => setProjectError('Could not load projects. Tap a room to retry.'),
      );
    }, [client, reload]),
  );

  const chooseRoom = async (source: IntegrationSource) => {
    setSelectedRoom(source);
    setProjectError(null);
    try {
      setProjects(await client.listProjects());
    } catch {
      setProjectError('Could not load projects. Tap the room to retry.');
    }
  };

  const bind = async (source: IntegrationSource, targetProjectId: string) => {
    const project = projects?.find((item) => item.id === targetProjectId);
    setBinding({
      sourceId: source.sourceId,
      projectName: project ? projectName(project) : 'project',
    });
    setBusy(true);
    try {
      await client.bindIntegrationSource(source.accountId, source.sourceId, targetProjectId);
      setSelectedRoom(null);
      await reload();
    } catch {
      setProjectError('Could not connect this room. Choose a project to retry.');
    } finally {
      setBinding(null);
      setBusy(false);
    }
  };

  const disconnect = async (source: IntegrationSource) => {
    setBusy(true);
    try {
      await client.disconnectIntegrationSource(source.accountId, source.sourceId);
      await reload();
    } catch {
      setError('Could not update this room.');
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async (source: IntegrationSource) => {
    setBusy(true);
    try {
      await client.pauseIntegrationSource(
        source.accountId,
        source.sourceId,
        source.status === 'paused' ? false : true,
      );
      await reload();
    } catch {
      setError('Could not update this room.');
    } finally {
      setBusy(false);
    }
  };

  const pending = sources.filter((item) => item.status === 'pending');
  const connected = sources.filter((item) => item.projectId);

  return (
    <SettingsScaffold title="Matrix" detail onRetry={() => void reload()}>
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
            description="Choose a room, then select the project that should receive its new messages."
          >
            {pending.length === 0 ? (
              <SettingsPanel>
                <Text style={styles.reproSubtitle}>No pending rooms.</Text>
              </SettingsPanel>
            ) : (
              <SettingsListPanel>
                {pending.map((item) => (
                  <View key={`${item.accountId}:${item.sourceId}`}>
                    <SettingsNavRow
                      icon="link"
                      title={item.displayName}
                      subtitle={item.inviter ? `Invited by ${item.inviter}` : item.sourceId}
                      onPress={() => {
                        if (!busy) void chooseRoom(item);
                      }}
                    />
                    {selectedRoom?.sourceId === item.sourceId ? (
                      <SettingsPanel>
                        <Text style={styles.disclosureTitle}>Choose a project</Text>
                        {binding?.sourceId === item.sourceId ? (
                          <View style={styles.actionRow}>
                            <ActivityIndicator />
                            <Text style={styles.reproHint}>
                              Connecting to {binding.projectName}…
                            </Text>
                          </View>
                        ) : null}
                        {projectError ? <Text style={styles.reproHint}>{projectError}</Text> : null}
                        {projects === null && !projectError ? <ActivityIndicator /> : null}
                        {projects?.filter((project) => !project.archived).length === 0 ? (
                          <Text style={styles.reproSubtitle}>No projects available.</Text>
                        ) : null}
                        {!binding &&
                          projects
                            ?.filter((project) => !project.archived)
                            .map((project) => (
                              <SettingsNavRow
                                key={project.id}
                                icon="folder"
                                title={projectName(project)}
                                onPress={() => {
                                  if (!busy) void bind(item, project.id);
                                }}
                              />
                            ))}
                      </SettingsPanel>
                    ) : null}
                  </View>
                ))}
              </SettingsListPanel>
            )}
          </SettingsGroup>
          <SettingsGroup title="Connected rooms" description="Each room belongs to one project.">
            {connected.length === 0 ? (
              <SettingsPanel>
                <Text style={styles.reproSubtitle}>No connected rooms.</Text>
              </SettingsPanel>
            ) : (
              connected.map((item) => (
                <SettingsListPanel key={`${item.accountId}:${item.sourceId}`}>
                  <View style={styles.navRow}>
                    <View style={styles.navRowIcon}>
                      <Icon name="link" size={18} color={theme.colors.primary} />
                    </View>
                    <View style={styles.navRowBody}>
                      <Text style={styles.navRowTitle}>{item.displayName}</Text>
                      <Text style={styles.navRowSubtitle}>
                        {projectLabel(projects, item.projectId, projectError !== null)} ·{' '}
                        {item.status}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${item.status === 'paused' ? 'Resume' : 'Pause'} ${item.displayName}`}
                      disabled={busy}
                      hitSlop={8}
                      style={{ padding: 12 }}
                      onPress={() => void togglePause(item)}
                    >
                      <Icon
                        name={item.status === 'paused' ? 'play' : 'pause'}
                        size={18}
                        color={theme.colors.textFaint}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Disconnect ${item.displayName}`}
                      disabled={busy}
                      hitSlop={8}
                      style={{ padding: 12 }}
                      onPress={() =>
                        Alert.alert(
                          'Disconnect room?',
                          'Existing Knowledge stays in the project. Invite the Matrix account again to reconnect.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Disconnect',
                              style: 'destructive',
                              onPress: () => void disconnect(item),
                            },
                          ],
                        )
                      }
                    >
                      <Icon name="trash-2" size={18} color={theme.colors.textFaint} />
                    </Pressable>
                  </View>
                </SettingsListPanel>
              ))
            )}
          </SettingsGroup>
        </>
      ) : null}
    </SettingsScaffold>
  );
}

function projectName(project: ProjectRecord): string {
  return project.kind === 'local' ? project.repo : `${project.owner}/${project.repo}`;
}

function projectLabel(
  projects: ProjectRecord[] | null,
  id: string | null,
  failed: boolean,
): string {
  if (!projects) return failed ? 'Project unavailable' : 'Loading project…';
  const project = projects.find((item) => item.id === id);
  return project ? projectName(project) : 'Project unavailable';
}
