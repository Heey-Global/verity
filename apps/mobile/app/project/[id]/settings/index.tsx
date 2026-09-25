// Project settings, top level: where each part of the project's configuration
// lives. Built like the Verity settings index — every row is a destination, and
// the only control on the screen is the one that removes the project.
//
// Project-specific bindings are direct entries; account credentials and MCP
// connection definitions live in Verity settings.
import { modelDisplayName, projectBadge, type VerityClient } from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
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
        onRetry={() => load()}
      />
    );
  }

  const { project } = detail;
  const defaultModel = detail.settings?.defaultModel ?? null;
  const badge = projectBadge(project);
  const environmentIntent: StatusPillIntent = badge.pulsing
    ? 'transient'
    : badge.needsRepair
      ? 'needsSetup'
      : project.state === 'active'
        ? 'ready'
        : 'optional';
  const to = (
    pathname:
      | '/project/[id]/settings/github'
      | '/project/[id]/settings/environment'
      | '/project/[id]/settings/model'
      | '/project/[id]/dev-server'
      | '/project/[id]/automations',
  ) => router.push({ pathname, params: { id: projectId } });
  const toService = (section: 'doppler' | 'drive' | 'mcp') =>
    router.push({
      pathname: '/project/[id]/settings/services',
      params: { id: projectId, section },
    });

  return (
    <SettingsScaffold
      title="Project settings"
      state={{ error, saving: false }}
      onRetry={() => load()}
    >
      <SettingsGroup title="Setup">
        <SettingsListPanel>
          {project.kind === 'local' ? (
            <SettingsNavRow
              icon="github"
              title="Connect GitHub"
              subtitle="Link this local project to a repository"
              onPress={() => to('/project/[id]/settings/github')}
            />
          ) : null}
          <SettingsNavRow
            icon="key"
            title="Doppler"
            subtitle="Choose the environment for this project"
            onPress={() => toService('doppler')}
          />
          <SettingsNavRow
            icon="folder"
            title="Google Drive"
            subtitle="Choose the project folder"
            onPress={() => toService('drive')}
          />
          <SettingsNavRow
            icon="tool"
            title="MCP"
            subtitle="Enable connections for this project"
            onPress={() => toService('mcp')}
          />
          <SettingsNavRow
            icon="server"
            title="Environment"
            subtitle="Secure workspace, updates, rebuild"
            status={{ intent: environmentIntent, label: badge.label }}
            onPress={() => to('/project/[id]/settings/environment')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Project tools">
        <SettingsListPanel>
          <SettingsNavRow
            icon="monitor"
            title="Dev Server"
            subtitle="Local previews for this project"
            onPress={() => to('/project/[id]/dev-server')}
          />
          <SettingsNavRow
            icon="repeat"
            title="Automations"
            subtitle="Agent Loops and schedules"
            onPress={() => to('/project/[id]/automations')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <SettingsListPanel>
          <SettingsNavRow
            icon="cpu"
            title="Default model"
            subtitle="New sessions and Agent Loops start with it"
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
