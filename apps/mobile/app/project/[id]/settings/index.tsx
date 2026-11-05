// Project settings, top level: where each part of the project's configuration
// lives. Built like the Verity settings index — every row is a destination, and
// the only control on the screen is the one that removes the project.
//
// Project-specific bindings are direct entries; account credentials and MCP
// connection definitions live in Verity settings.
import {
  allowedAgentsSummary,
  codeHostForProject,
  providerName,
  modelDisplayName,
  projectBadge,
  type VerityClient,
} from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { CodeHostIcon } from '../../../../components/CodeHostIcon';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import type { StatusPillIntent } from '../../../../components/StatusPill';
import { createVerityClient } from '../../../../lib/client';
import { useDeleteProject } from '../../../../lib/projectDelete';
import { useNewDesign } from '../../../../lib/homePreferences';
import { useProjectConnections } from '../../../../lib/useProjectConnections';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';
import { Button } from '../../../../components/ui';

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
  // The new design shows project knowledge on the project page instead.
  const newDesign = useNewDesign();
  const {
    available,
    usage,
    driveFolderNames,
    forgeConnections,
    refresh: refreshConnections,
  } = useProjectConnections(client, projectId);
  const [deleting, remove] = useDeleteProject(client, setError);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
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
          refreshConnections();
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
      | '/project/[id]/settings/repository'
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
        refreshConnections();
      }}
    >
      {newDesign ? null : (
        <SettingsGroup title="Knowledge">
          <SettingsListPanel>
            <SettingsNavRow
              icon="book-open"
              title="Project knowledge"
              subtitle="Decisions, Wiki and Raw Sources"
              onPress={() =>
                router.push({ pathname: '/project/[id]/knowledge', params: { id: projectId } })
              }
            />
          </SettingsListPanel>
        </SettingsGroup>
      )}
      <SettingsGroup title="Context">
        <SettingsListPanel>
          <SettingsNavRow
            icon="file-text"
            title="Instructions"
            subtitle="Project rules outside the code repository"
            onPress={() =>
              router.push({
                pathname: '/project/[id]/settings/context',
                params: { id: projectId, kind: 'instructions' },
              })
            }
          />
          <SettingsNavRow
            icon="book-open"
            title="Memory"
            subtitle="Review and edit project facts"
            onPress={() =>
              router.push({
                pathname: '/project/[id]/settings/context',
                params: { id: projectId, kind: 'memory' },
              })
            }
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Connectors">
        <SettingsListPanel>
          {project.kind === 'local' && (available.github || available.forgejo) ? (
            <SettingsNavRow
              icon="link"
              title="Connect repository"
              subtitle={
                available.github && available.forgejo
                  ? 'GitHub or Forgejo'
                  : available.github
                    ? 'GitHub'
                    : 'Forgejo'
              }
              status={{ intent: 'optional', label: 'Not selected' }}
              onPress={() => to('/project/[id]/settings/repository')}
            />
          ) : null}
          {project.kind === 'github' || project.kind === 'forgejo' ? (
            <SettingsNavRow
              icon={{
                element: <CodeHostIcon provider={project.kind} color={theme.colors.action} />,
              }}
              title={`${providerName(project.kind)} repository`}
              subtitle={[
                `${project.owner}/${project.repo}`,
                codeHostForProject(project, forgeConnections)?.host,
              ]
                .filter((part) => part !== undefined && part !== 'github.com')
                .join(' · ')}
              status={{ intent: 'ready', label: 'Connected' }}
              onPress={() => to('/project/[id]/settings/repository')}
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
              subtitle="Choose the project folders"
              status={{
                intent: (
                  driveFolderNames
                    ? driveFolderNames.length > 0
                    : detail.settings?.googleDriveFolderId
                )
                  ? 'ready'
                  : 'optional',
                label: driveFolderNames
                  ? driveFolderNames.length
                    ? driveFolderNames.join(', ')
                    : 'Not selected'
                  : (detail.settings?.googleDriveFolderName ?? 'Not selected'),
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
            subtitle="Discover services in Connectors"
            onPress={() => router.push('/settings/services')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      {project.kind === 'github' || project.kind === 'forgejo' ? (
        <SettingsGroup title="Security">
          <SettingsListPanel>
            <SettingsNavRow
              icon="shield"
              title="Vulnerability scan"
              subtitle="Main branch and session findings"
              onPress={() =>
                router.push({
                  pathname: '/project/[id]/vulnerability-scan',
                  params: { id: projectId },
                })
              }
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
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
            title="Agents"
            subtitle={allowedAgentsSummary(detail.settings?.allowedAgents)}
            value={defaultModel !== null ? modelDisplayName(defaultModel) : 'Automatic'}
            onPress={() => to('/project/[id]/settings/model')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <View style={styles.settingsGroup}>
        <View style={styles.selfStart}>
          <Button
            label="Delete project"
            variant="destructive"
            loading={deleting}
            onPress={() => remove(project)}
          />
        </View>
        <Text style={styles.footnote}>
          Removes the project from Verity, stops its secure workspace, and deletes the local clone
          and the project's sessions.
        </Text>
      </View>
    </SettingsScaffold>
  );
}
