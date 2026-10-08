// Project settings, top level: where each part of the project's configuration
// lives. Built like the Verity settings index — every row is a destination, and
// the only control on the screen is the one that removes the project.
//
// Project-specific bindings are direct entries; account credentials and MCP
// connection definitions live in Verity settings.
import {
  githubRepositoryAccessReady,
  modelDisplayName,
  projectBadge,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import type { StatusPillIntent } from '../../../../components/StatusPill';
import { createVerityClient } from '../../../../lib/client';
import { useDeleteProject } from '../../../../lib/projectDelete';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectSettingsIndexScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Project settings"
      />
    );
  }
  return <ProjectSettingsIndexView client={client} projectId={projectId} />;
}

function ProjectSettingsIndexView({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const { theme } = useUnistyles();
  const { detail, loading, error, setError, load } = useProjectDetail(client, projectId);
  const [connectionRefresh, setConnectionRefresh] = useState(0);
  const [usage, setUsage] = useState({ google: 0, mcp: 0, matrix: 0 });
  const [available, setAvailable] = useState({
    github: false,
    doppler: false,
    drive: false,
    google: false,
    mcp: false,
    matrix: false,
  });
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.allSettled([
        Promise.resolve().then(() => client.getVeritySettings()),
        Promise.resolve().then(() => client.getGoogleDriveConnection()),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'gmail')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'calendar')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'contacts')),
        Promise.resolve().then(() => client.listHttpMcpConnections()),
        Promise.resolve().then(() => client.listIntegrations()),
        Promise.resolve().then(() => client.listProjectMcpBindings(projectId)),
      ]).then((results) => {
        if (!active) return;
        const [settings, drive, gmail, calendar, contacts, mcp, integrations, bindings] = results;
        setUsage({
          google: [gmail, calendar, contacts].filter(
            (item) => item.status === 'fulfilled' && item.value.enabled,
          ).length,
          mcp:
            bindings.status === 'fulfilled'
              ? bindings.value.filter((binding) => binding.enabled).length
              : 0,
          matrix:
            integrations.status === 'fulfilled'
              ? integrations.value.sources.filter((source) => source.projectId === projectId).length
              : 0,
        });
        setAvailable({
          github: settings.status === 'fulfilled' && githubRepositoryAccessReady(settings.value),
          doppler:
            settings.status === 'fulfilled' &&
            Boolean(settings.value?.dopplerServiceTokenConfigured),
          drive: drive.status === 'fulfilled' && drive.value.connected,
          google: [gmail, calendar, contacts].some(
            (item) => item.status === 'fulfilled' && item.value.connected,
          ),
          mcp: mcp.status === 'fulfilled' && mcp.value.length > 0,
          matrix:
            integrations.status === 'fulfilled' &&
            integrations.value.accounts.some((account) => account.provider === 'matrix'),
        });
      });
      return () => {
        active = false;
      };
    }, [client, connectionRefresh, projectId]),
  );
  const [deleting, remove] = useDeleteProject(client, setError);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }
  if (detail === undefined) {
    return (
      <SettingsMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        screenTitle="Project settings"
        onRetry={() => {
          load();
          setConnectionRefresh((value) => value + 1);
        }}
      />
    );
  }

  const { project } = detail;
  const defaultModel = detail.settings?.defaultModel ?? null;
  const badge = projectBadge(project);
  const sandboxIntent: StatusPillIntent = badge.pulsing
    ? 'transient'
    : badge.needsRepair
      ? 'needsSetup'
      : project.state === 'active'
        ? 'ready'
        : 'optional';
  const to = (
    pathname:
      | '/project/[id]/settings/github'
      | '/project/[id]/settings/sandbox'
      | '/project/[id]/settings/model',
  ) => router.push({ pathname, params: { id: projectId } });
  const toService = (section: 'doppler' | 'drive' | 'mcp' | 'matrix' | 'google') =>
    router.push({
      pathname: '/project/[id]/settings/services',
      params: { id: projectId, section },
    });

  return (
    <SettingsScaffold
      title="Project settings"
      state={{ error, saving: false }}
      onRetry={() => {
        load();
        setConnectionRefresh((value) => value + 1);
      }}
    >
      <SettingsGroup title="Connections">
        <SettingsListPanel>
          {project.kind === 'local' && available.github ? (
            <SettingsNavRow
              icon="github"
              title="Connect GitHub"
              subtitle="Link this local project to a repository"
              status={{ intent: 'optional', label: 'Not selected' }}
              onPress={() => to('/project/[id]/settings/github')}
            />
          ) : null}
          {project.kind === 'github' ? (
            <SettingsNavRow
              icon="github"
              title="GitHub repository"
              subtitle={`${project.owner}/${project.repo}`}
              status={{ intent: 'ready', label: 'Connected' }}
              onPress={() => to('/project/[id]/settings/github')}
            />
          ) : null}
          {available.doppler ? (
            <SettingsNavRow
              icon="key"
              title="Doppler"
              subtitle="Choose the environment for this project"
              status={{
                intent: detail.settings?.dopplerConfig ? 'ready' : 'optional',
                label: detail.settings?.dopplerConfig ?? 'Not selected',
              }}
              onPress={() => toService('doppler')}
            />
          ) : null}
          {available.drive ? (
            <SettingsNavRow
              icon="folder"
              title="Google Drive"
              subtitle="Choose the project folder"
              status={{
                intent: detail.settings?.googleDriveFolderId ? 'ready' : 'optional',
                label: detail.settings?.googleDriveFolderName ?? 'Not selected',
              }}
              onPress={() => toService('drive')}
            />
          ) : null}
          {available.google ? (
            <SettingsNavRow
              icon="link"
              title="Google services"
              subtitle="Gmail, Calendar, and Contacts access"
              status={{
                intent: usage.google > 0 ? 'ready' : 'optional',
                label: `${usage.google} enabled`,
              }}
              onPress={() => toService('google')}
            />
          ) : null}
          {available.mcp ? (
            <SettingsNavRow
              icon="tool"
              title="MCP"
              subtitle="Enable connections for this project"
              status={{
                intent: usage.mcp > 0 ? 'ready' : 'optional',
                label: `${usage.mcp} enabled`,
              }}
              onPress={() => toService('mcp')}
            />
          ) : null}
          {available.matrix ? (
            <SettingsNavRow
              icon="link"
              title="Matrix rooms"
              subtitle="Choose rooms for this project"
              status={{
                intent: usage.matrix > 0 ? 'ready' : 'optional',
                label: `${usage.matrix} connected`,
              }}
              onPress={() => toService('matrix')}
            />
          ) : null}
          <SettingsNavRow
            icon="plus"
            title="Add connection"
            subtitle="Discover services in Connections"
            onPress={() => router.push('/settings/services')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Sandbox">
        <SettingsListPanel>
          <SettingsNavRow
            icon="server"
            title="Sandbox"
            subtitle="Isolated container, updates, rebuild"
            status={{ intent: sandboxIntent, label: badge.label }}
            onPress={() => to('/project/[id]/settings/sandbox')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <SettingsListPanel>
          <SettingsNavRow
            icon="cpu"
            title="Default model"
            subtitle="New sessions start with it"
            value={defaultModel !== null ? modelDisplayName(defaultModel) : 'Server default'}
            onPress={() => to('/project/[id]/settings/model')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <View style={styles.settingsGroup}>
        <Pressable
          style={({ pressed }) => [
            styles.dangerButton,
            deleting ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => remove(project)}
          disabled={deleting}
          accessibilityRole="button"
          accessibilityLabel="Delete project"
        >
          <Text style={styles.dangerButtonLabel}>{deleting ? 'Deleting…' : 'Delete project'}</Text>
        </Pressable>
        <Text style={styles.footnote}>
          Removes the project from Verity, stops its secure workspace, and deletes the local clone
          and the project's sessions.
        </Text>
      </View>
    </SettingsScaffold>
  );
}
