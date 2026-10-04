import {
  type IntegrationAccount,
  type IntegrationSource,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
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
  const [error, setError] = useState<string | null>(null);
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
        () => setProjectError('Could not load projects. Return to this screen to retry.'),
      );
    }, [client, reload]),
  );

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
            title="Connected rooms"
            description="Room connections are managed in project settings."
          >
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
                    {item.projectId ? (
                      <SettingsNavRow
                        icon="chevron-right"
                        title="Manage in project"
                        onPress={() =>
                          router.push({
                            pathname: '/project/[id]/settings/services',
                            params: { id: item.projectId!, section: 'matrix' },
                          })
                        }
                      />
                    ) : null}
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
