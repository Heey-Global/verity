import { ProjectGoogleDriveFolders } from '../../../../components/settings/ProjectGoogleDriveFolders';
import { ProjectDopplerBindings } from '../../../../components/doppler/ProjectDopplerBindings';
// Connected services, per project: which Doppler projects and configs, Google Drive
// folder and MCP connections this project may use. The credentials themselves
// live on the Verity-wide Connected services screen; this screen only binds the
// project to them, so nothing here ever holds a secret.
import {
  VerityApiError,
  type DopplerConfigSummary,
  type DopplerProjectSummary,
  type HttpMcpConnection,
  type ProjectMcpBinding,
  type ProjectSettings,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsDisclosure,
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { ProjectGoogleServices } from '../../../../components/settings/ProjectGoogleServices';
import { ProjectMatrixRooms } from '../../../../components/settings/ProjectMatrixRooms';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';
import { Button, Group, HintBox, Text as UiText, ToggleRow } from '../../../../components/ui';

export default function ProjectServicesScreen() {
  const { id, section } = useLocalSearchParams<{
    id: string | string[];
    section?: string | string[];
  }>();
  const projectId = projectIdParam(id);
  const requestedSection = Array.isArray(section) ? section[0] : section;
  const selectedSection =
    requestedSection === 'doppler' ||
    requestedSection === 'drive' ||
    requestedSection === 'mcp' ||
    requestedSection === 'matrix' ||
    requestedSection === 'google'
      ? requestedSection
      : undefined;
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Connectors"
      />
    );
  }
  return <ProjectServicesView client={client} projectId={projectId} section={selectedSection} />;
}

function ProjectServicesView({
  client,
  projectId,
  section,
}: {
  client: VerityClient;
  projectId: string;
  section?: 'doppler' | 'drive' | 'mcp' | 'matrix' | 'google';
}) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load, onSettingsSaved } = useProjectDetail(client, projectId);
  const title =
    section === 'doppler'
      ? 'Doppler'
      : section === 'drive'
        ? 'Google Drive'
        : section === 'mcp'
          ? 'MCP'
          : section === 'matrix'
            ? 'Matrix'
            : 'Connectors';

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
        screenTitle={title}
        onRetry={() => load()}
      />
    );
  }
  const { settings } = detail;
  return (
    <SettingsScaffold title={title} detail state={{ error, saving: false }} onRetry={() => load()}>
      {section === undefined || section === 'doppler' ? (
        <SettingsGroup
          title="Secrets"
          description="The Doppler projects and configs this project reads secrets from. Agents write NAME for the default and project/config/NAME for the others."
        >
          <ProjectDopplerBindings client={client} projectId={projectId} />
        </SettingsGroup>
      ) : null}

      {section === undefined || section === 'drive' ? (
        <SettingsGroup title="Files">
          <ProjectGoogleDriveFolders client={client} projectId={projectId} />
        </SettingsGroup>
      ) : null}

      {section === undefined || section === 'mcp' ? (
        <SettingsGroup
          title="Tools"
          description="Enable only the MCP connections this project may use. Authorization stays on the Verity server."
        >
          <ProjectMcpBindingsSection client={client} projectId={projectId} />
        </SettingsGroup>
      ) : null}
      {section === undefined || section === 'google' ? (
        <ProjectGoogleServices client={client} projectId={projectId} />
      ) : null}
      {section === undefined || section === 'matrix' ? (
        <ProjectMatrixRooms client={client} projectId={projectId} />
      ) : null}
    </SettingsScaffold>
  );
}

function ProjectMcpBindingsSection({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [connections, setConnections] = useState<HttpMcpConnection[]>([]);
  const [bindings, setBindings] = useState<ProjectMcpBinding[]>([]);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | undefined>();
  const [error, setError] = useState<{ title: string; message: string } | undefined>();
  const mutationInFlight = useRef(false);
  const loadGeneration = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    if (
      typeof (client as Partial<VerityClient>).listHttpMcpConnections !== 'function' ||
      typeof (client as Partial<VerityClient>).listProjectMcpBindings !== 'function'
    ) {
      return;
    }
    const generation = ++loadGeneration.current;
    setError(undefined);
    await Promise.all([client.listHttpMcpConnections(), client.listProjectMcpBindings(projectId)])
      .then(([nextConnections, nextBindings]) => {
        if (loadGeneration.current !== generation) return;
        setConnections(nextConnections.filter((connection) => connection.enabled));
        setBindings(nextBindings);
      })
      .catch(() => {
        if (loadGeneration.current === generation)
          setError({
            title: 'Connections unavailable',
            message: 'Could not load MCP connections.',
          });
      });
  }, [client, projectId]);
  // Reload on focus so globally configured connections appear here when this
  // project screen is opened again.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const enabled = useCallback(
    (connectionId: string) =>
      bindings.some((binding) => binding.connectionId === connectionId && binding.enabled),
    [bindings],
  );
  const toggle = useCallback(
    (connectionId: string) => {
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      setPendingConnectionId(connectionId);
      void client
        .setProjectMcpBinding(projectId, connectionId, !enabled(connectionId))
        .then(load)
        .catch(() =>
          setError({ title: 'Not updated', message: 'Could not update the MCP connection.' }),
        )
        .finally(() => {
          mutationInFlight.current = false;
          setPendingConnectionId(undefined);
        });
    },
    [client, enabled, load, projectId],
  );
  return (
    <>
      {connections.length === 0 ? (
        <UiText variant="subtitle">
          No MCP connections available. Add and authorize MCP servers in Verity settings; then
          return here to enable them for this project.
        </UiText>
      ) : (
        <Group>
          {connections.map((connection) => (
            <ToggleRow
              key={connection.id}
              title={connection.name}
              subtitle={connection.url}
              value={enabled(connection.id)}
              disabled={pendingConnectionId !== undefined}
              switching={pendingConnectionId === connection.id}
              onValueChange={() => toggle(connection.id)}
            />
          ))}
        </Group>
      )}
      {error ? <HintBox title={error.title} message={error.message} /> : null}
    </>
  );
}
