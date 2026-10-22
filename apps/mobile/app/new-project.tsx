// Create a project, then manage runtime and integrations on its project page.
//
// "Start from" offers every connected code host — GitHub, Forgejo, both or
// neither — with equal weight, plus a local project that lives only on this
// Verity server.
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

import { CodeHostOption, RepositoryPicker } from '../components/RepositoryPicker';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../components/settings/settingsStyles';
import { Button, Group, Row, Text, TextField } from '../components/ui';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { loadCodeHosts, readLastCodeHost, rememberCodeHost } from '../lib/codeHosts';

const LOCAL = 'local';

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

function NewProject({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [hosts, setHosts] = useState<CodeHost[] | null>(null);
  const [githubRepositories, setGithubRepositories] = useState<ProjectRecord[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const choiceMade = useRef(false);
  const [selectedRepository, setSelectedRepository] = useState<string | null>(null);
  const [localName, setLocalName] = useState('');
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadCodeHosts(client, { forProjects: true }).catch(() => ({
        hosts: [],
        githubRepositories: [],
      })),
      readLastCodeHost(),
    ]).then(([loaded, remembered]) => {
      if (!active) return;
      setHosts(loaded.hosts);
      setGithubRepositories(loaded.githubRepositories);
      if (!choiceMade.current) setChoice(preferredCodeHost(loaded.hosts, remembered)?.id ?? LOCAL);
    });
    return () => {
      active = false;
    };
  }, [client]);

  const host = hosts?.find((candidate) => candidate.id === choice);

  const canCreate =
    !creating &&
    choice !== null &&
    (choice === LOCAL
      ? localName.trim().length > 0
      : host !== undefined && selectedRepository !== null);

  const onCreate = useCallback(() => {
    if (!canCreate) return;
    const body: CreateProjectRequest =
      choice === LOCAL || host === undefined
        ? { kind: 'local', name: localName.trim() }
        : host.provider === 'forgejo'
          ? { repo: selectedRepository!, kind: 'forgejo', connectionId: host.id }
          : { repo: selectedRepository! };
    setCreating(true);
    setError(undefined);
    void client
      .createProject(body)
      .then((project) => {
        if (host !== undefined && choice !== LOCAL) rememberCodeHost(host.id);
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
  }, [canCreate, choice, client, host, localName, selectedRepository]);

  if (createdProject) return <ProjectConnections client={client} project={createdProject} />;
  if (hosts === null || choice === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
      </View>
    );
  }

  const choose = (next: string) => {
    choiceMade.current = true;
    if (next !== choice) setSelectedRepository(null);
    setChoice(next);
    setError(undefined);
  };
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
      <SettingsGroup title="Start from">
        <Group>
          {hosts.map((candidate) => (
            <CodeHostOption
              key={candidate.id}
              host={candidate}
              selected={choice === candidate.id}
              disabled={creating}
              onPress={() => choose(candidate.id)}
            />
          ))}
          <Row
            leading={{ icon: 'hard-drive' }}
            title="Local project"
            subtitle="Only on this Verity server"
            selected={choice === LOCAL}
            disabled={creating}
            onPress={() => choose(LOCAL)}
          />
        </Group>
      </SettingsGroup>
      {choice === LOCAL || host === undefined ? (
        <SettingsGroup title="Project name">
          <TextField
            label="Project name"
            value={localName}
            onChangeText={setLocalName}
            placeholder="my-project"
            literal
            maxLength={100}
            disabled={creating}
          />
          <Text variant="footnote" tone="faint">
            Verity creates a Git repository on this server.
          </Text>
          {hosts.length === 0 ? (
            <View style={styles.selfStart}>
              <Button
                label="Connect a code host"
                variant="text"
                size="compact"
                icon="link"
                onPress={() => router.push('/settings/services')}
              />
            </View>
          ) : null}
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Repository">
          <RepositoryPicker
            client={client}
            host={host}
            initialGithubRepositories={githubRepositories}
            selected={selectedRepository}
            onSelect={setSelectedRepository}
            disabled={creating}
          />
        </SettingsGroup>
      )}
      {error ? (
        <Text variant="bodySmall" tone="attention">
          {error}
        </Text>
      ) : null}
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
