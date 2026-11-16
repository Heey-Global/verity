// Create a project, then manage runtime and integrations on its project page.
//
// A project always starts with a name. Repositories from any connected code
// host — GitHub, Forgejo, both or neither — are optional; without one, Verity
// keeps the project's code on this server.
import {
  VerityApiError,
  preferredCodeHost,
  type CodeHost,
  type CreateProjectRequest,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from '../components/CodeHostIcon';
import { AddRepositorySheet } from '../components/RepositoryPicker';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../components/settings/settingsStyles';
import { Button, Group, IconButton, Row, Text, TextField } from '../components/ui';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { loadCodeHosts, readLastCodeHost, rememberCodeHost } from '../lib/codeHosts';
import { repositoryModuleName } from '../lib/projectRepositories';

export default function NewProjectScreen() {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const resumeProjectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const client = createVerityClient();
  useEffect(() => {
    if (resumeProjectId)
      router.replace({ pathname: '/new', params: { projectId: resumeProjectId } });
  }, [resumeProjectId]);
  if (!client || !getVerityBaseUrl()) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to add a project."
        screenTitle="New project"
      />
    );
  }
  if (resumeProjectId)
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  return <NewProject client={client} />;
}

/** A repository chosen for the new project, with the code host it comes from. */
type ChosenRepository = { host: CodeHost; repository: string };

function NewProject({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [hosts, setHosts] = useState<CodeHost[] | null>(null);
  const [githubRepositories, setGithubRepositories] = useState<ProjectRecord[]>([]);
  const [name, setName] = useState('');
  // Until the person types a name, the first repository chosen suggests one.
  const nameTyped = useRef(false);
  const [repositories, setRepositories] = useState<ChosenRepository[]>([]);
  const [adding, setAdding] = useState(false);
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.all([
        loadCodeHosts(client, { forProjects: true }).catch(() => ({
          hosts: [],
          githubRepositories: [],
        })),
        readLastCodeHost(),
      ]).then(([loaded, remembered]) => {
        if (!active) return;
        // The host used last time is offered first.
        const preferred = preferredCodeHost(loaded.hosts, remembered);
        setHosts(
          preferred
            ? [preferred, ...loaded.hosts.filter((host) => host.id !== preferred.id)]
            : loaded.hosts,
        );
        setGithubRepositories(loaded.githubRepositories);
      });
      return () => {
        active = false;
      };
    }, [client]),
  );

  const canCreate = !creating && name.trim().length > 0;

  const addRepository = (host: CodeHost, repository: string) => {
    setAdding(false);
    setError(undefined);
    setRepositories((current) =>
      current.some((item) => item.host.id === host.id && item.repository === repository)
        ? current
        : [...current, { host, repository }],
    );
    if (!nameTyped.current && name.trim() === '') setName(repository.split('/')[1] ?? repository);
  };

  const onCreate = useCallback(() => {
    if (!canCreate) return;
    const projectName = name.trim();
    const [first, ...more] = repositories;
    const body: CreateProjectRequest =
      first === undefined
        ? { kind: 'local', name: projectName }
        : first.host.provider === 'forgejo'
          ? {
              repo: first.repository,
              kind: 'forgejo',
              connectionId: first.host.id,
              name: projectName,
            }
          : { repo: first.repository, name: projectName };
    setCreating(true);
    setError(undefined);
    void client
      .createProject(body)
      .then(async (project) => {
        if (first !== undefined) rememberCodeHost(first.host.id);
        // The first repository is the project's own; the others join it as
        // they would on its page. One that fails does not undo the project.
        const taken = [project.repo];
        const failed: string[] = [];
        for (const { host, repository } of more) {
          const [owner, repo] = repository.split('/');
          if (!owner || !repo) continue;
          const moduleName = repositoryModuleName(taken, owner, repo);
          try {
            await client.addProjectRepository(project.id, {
              name: moduleName,
              kind: host.provider,
              owner,
              repo,
              ...(host.provider === 'forgejo' ? { forgeConnectionId: host.id } : {}),
            });
            taken.push(moduleName);
          } catch {
            failed.push(repository);
          }
        }
        if (failed.length > 0)
          Alert.alert(
            'Some repositories were not connected',
            `${failed.join(', ')} could not be connected. Add them again on the project page.`,
          );
        // Setup progress is lifecycle state; optional integrations do not gate access.
        setCreatedProject(project);
        void client.setProjectSetupStatus(project.id, 'complete').catch(() => {
          // The project page retries migration of pending setup status.
        });
        prepareProject(client, project.id);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not add project');
        setCreating(false);
      });
  }, [canCreate, client, name, repositories]);

  if (createdProject) return <ProjectConnections client={client} project={createdProject} />;
  if (hosts === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
      </View>
    );
  }

  return (
    <SettingsScaffold
      title="New project"
      state={{ error: undefined, saving: false }}
      footer={
        <Button
          label="Create project"
          onPress={onCreate}
          loading={creating}
          disabled={!canCreate}
          fullWidth
        />
      }
    >
      <SettingsGroup title="Project">
        <TextField
          label="Project name"
          value={name}
          onChangeText={(next) => {
            nameTyped.current = true;
            setName(next);
          }}
          placeholder="My project"
          maxLength={100}
          disabled={creating}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Repositories"
        description="Optional. You can connect more later on the project page."
      >
        <Group>
          {repositories.map(({ host, repository }) => (
            <Row
              key={`${host.id}:${repository}`}
              leading={{
                element: <CodeHostIcon provider={host.provider} color={theme.colors.action} />,
              }}
              title={repository}
              subtitle={host.title}
              trailing={
                <IconButton
                  icon="x"
                  accessibilityLabel={`Remove ${repository}`}
                  disabled={creating}
                  onPress={() =>
                    setRepositories((current) =>
                      current.filter(
                        (item) => !(item.host.id === host.id && item.repository === repository),
                      ),
                    )
                  }
                />
              }
            />
          ))}
          {hosts.length > 0 ? (
            <Row
              leading={{ icon: 'plus' }}
              title="Add repository"
              subtitle={hosts.map((host) => host.title).join(' or ')}
              navigates
              disabled={creating}
              onPress={() => setAdding(true)}
            />
          ) : (
            <Row
              leading={{ icon: 'link' }}
              title="Connect a code host"
              subtitle="To work with GitHub or Forgejo repositories"
              navigates
              onPress={() => router.push('/settings/services')}
            />
          )}
        </Group>
      </SettingsGroup>
      {repositories.length === 0 ? (
        <Text variant="footnote" tone="faint">
          Without a repository, Verity keeps the project&apos;s code in a Git repository on this
          server.
        </Text>
      ) : null}
      {error ? (
        <Text variant="bodySmall" tone="attention">
          {error}
        </Text>
      ) : null}
      <AddRepositorySheet
        client={client}
        visible={adding}
        hosts={hosts}
        githubRepositories={githubRepositories}
        exclude={(host) =>
          repositories.filter((item) => item.host.id === host.id).map((item) => item.repository)
        }
        disabled={creating}
        onAdd={addRepository}
        onClose={() => setAdding(false)}
      />
    </SettingsScaffold>
  );
}

/** Start the sandbox in the background; a warning that needs consent is asked here. */
function prepareProject(client: VerityClient, projectId: string) {
  void client.repairProject(projectId, { confirmWarnings: false }).catch((caught: unknown) => {
    if (
      caught instanceof VerityApiError &&
      caught.requiresConfirmation &&
      caught.warnings.length > 0
    ) {
      Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            void client
              .repairProject(projectId, { confirmWarnings: true })
              .catch((retryError: unknown) => {
                Alert.alert(
                  'Could not prepare project',
                  retryError instanceof VerityApiError
                    ? retryError.message
                    : 'Try again from the project page.',
                );
              });
          },
        },
      ]);
      return;
    }
    Alert.alert(
      'Could not prepare project',
      caught instanceof VerityApiError ? caught.message : 'Try again from the project page.',
    );
  });
}

/** After creation: offer the connected services this project could use. */
function ProjectConnections({ client, project }: { client: VerityClient; project: ProjectRecord }) {
  const [connections, setConnections] = useState<{ label: string; section: string }[]>([]);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.allSettled([
        Promise.resolve().then(() => client.getGoogleDriveConnection()),
        Promise.resolve().then(() => client.getProjectGoogleConnection(project.id, 'gmail')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(project.id, 'calendar')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(project.id, 'contacts')),
        Promise.resolve().then(() => client.listIntegrations()),
        Promise.resolve().then(() => client.listHttpMcpConnections()),
        Promise.resolve().then(() => client.getVeritySettings()),
      ]).then(([drive, gmail, calendar, contacts, integrations, mcp, settings]) => {
        const choices: { label: string; section: string }[] = [];
        if (drive.status === 'fulfilled' && drive.value.connected)
          choices.push({ label: 'Google Drive folder', section: 'drive' });
        if (
          [gmail, calendar, contacts].some(
            (item) => item.status === 'fulfilled' && item.value.connected,
          )
        )
          choices.push({ label: 'Google services', section: 'google' });
        if (
          integrations.status === 'fulfilled' &&
          integrations.value.accounts.some((account) => account.provider === 'matrix')
        )
          choices.push({ label: 'Matrix rooms', section: 'matrix' });
        if (mcp.status === 'fulfilled' && mcp.value.length > 0)
          choices.push({ label: 'MCP tools', section: 'mcp' });
        if (settings.status === 'fulfilled' && settings.value?.dopplerServiceTokenConfigured)
          choices.push({ label: 'Doppler environment', section: 'doppler' });
        if (active) setConnections(choices);
      });
      return () => {
        active = false;
      };
    }, [client, project.id]),
  );
  return (
    <SettingsScaffold
      title="Project connections"
      state={{ error: undefined, saving: false }}
      footer={
        <Button
          label="Open project"
          fullWidth
          onPress={() => router.replace({ pathname: '/new', params: { projectId: project.id } })}
        />
      }
    >
      <Text variant="title">What does this project need?</Text>
      <Text variant="bodySmall" tone="muted">
        Optional. Choose a folder, rooms, or tools to share with this project. Nothing is enabled
        automatically.
      </Text>
      {connections.length > 0 ? (
        <Group>
          {connections.map((connection) => (
            <Row
              key={connection.section}
              title={connection.label}
              subtitle="Choose access for this project"
              navigates
              onPress={() =>
                router.push({
                  pathname: '/project/[id]/settings/services',
                  params: { id: project.id, section: connection.section },
                })
              }
            />
          ))}
        </Group>
      ) : null}
      <View style={styles.selfStart}>
        <Button
          label="Discover more connections"
          variant="text"
          size="compact"
          onPress={() => router.push('/settings/services')}
        />
      </View>
      <Text variant="footnote" tone="faint">
        You can skip connections and add them later in project settings.
      </Text>
    </SettingsScaffold>
  );
}
