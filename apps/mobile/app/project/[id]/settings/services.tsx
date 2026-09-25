// Connected services, per project: which Doppler environment, Google Drive
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
  SettingsPanel,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectServicesScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Connected services"
      />
    );
  }
  return <ProjectServicesView client={client} projectId={projectId} />;
}

function ProjectServicesView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load, onSettingsSaved } = useProjectDetail(client, projectId);

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
        screenTitle="Connected services"
        onRetry={() => load()}
      />
    );
  }
  const { settings } = detail;
  return (
    <SettingsScaffold
      title="Connected services"
      detail
      state={{ error, saving: false }}
      onRetry={() => load()}
    >
      <SettingsGroup title="Credentials">
        <DopplerBindingSection
          client={client}
          projectId={projectId}
          settings={settings}
          onSaved={onSettingsSaved}
        />
      </SettingsGroup>

      <SettingsGroup title="Files">
        <GoogleDriveFolderSection
          client={client}
          projectId={projectId}
          settings={settings}
          onSaved={onSettingsSaved}
        />
      </SettingsGroup>

      <SettingsGroup title="Knowledge sources" description="Chats imported into project knowledge.">
        <SettingsListPanel>
          <SettingsNavRow
            icon="message-square"
            title="Matrix"
            subtitle="Manage project rooms and imports"
            onPress={() =>
              router.push({ pathname: '/settings/services/matrix', params: { projectId } })
            }
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup
        title="Tools"
        description="Enable only the MCP connections this project may use. Authorization stays on the Verity server."
      >
        <ProjectMcpBindingsSection client={client} projectId={projectId} />
      </SettingsGroup>
    </SettingsScaffold>
  );
}

// Broker-only binding picker: map a project to a Doppler project + config chosen
// from the account's trusted live list. Single-select matches the project mapping
// contract; credentials remain central and never enter this form.
//
// Flow: "Choose / Change" → fetch projects → pick one → fetch that project's
// configs → pick one → PATCH { dopplerProject, dopplerConfig } → onSaved refresh.
// This mapping is the only project-level Doppler setting.
type BindingPickerPhase = 'idle' | 'projects' | 'configs' | 'saving';

function DopplerBindingSection({
  client,
  projectId,
  settings,
  onSaved,
}: {
  client: VerityClient;
  projectId: string;
  settings: ProjectSettings | null;
  onSaved: (settings: ProjectSettings) => void;
}) {
  const [phase, setPhase] = useState<BindingPickerPhase>('idle');
  const [projects, setProjects] = useState<DopplerProjectSummary[]>([]);
  const [configs, setConfigs] = useState<DopplerConfigSummary[]>([]);
  const [pickedProject, setPickedProject] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Set when the server reports no account token — the picker can't list; hint the
  // operator to configure the Doppler account token in Verity settings first.
  const [notConfigured, setNotConfigured] = useState(false);

  const boundProject = settings?.dopplerProject ?? null;
  const boundConfig = settings?.dopplerConfig ?? null;
  const bound = boundProject !== null && boundProject.length > 0;
  const summary = bound
    ? `${boundProject}${boundConfig ? ` / ${boundConfig}` : ''}`
    : 'Not selected';

  const cancel = useCallback(() => {
    setPhase('idle');
    setProjects([]);
    setConfigs([]);
    setPickedProject(undefined);
    setLoading(false);
    setError(undefined);
    setNotConfigured(false);
  }, []);

  const start = useCallback(() => {
    setError(undefined);
    setNotConfigured(false);
    setPickedProject(undefined);
    setConfigs([]);
    setPhase('projects');
    setLoading(true);
    void client
      .listDopplerProjects()
      .then((result) => {
        if ('error' in result) {
          if (result.error === 'not configured') setNotConfigured(true);
          else setError(bindingErrorCopy(result.error));
          setPhase('idle');
          return;
        }
        setProjects(result.projects);
      })
      .catch(() => setError('Could not load Doppler projects'))
      .finally(() => setLoading(false));
  }, [client]);

  const pickProject = useCallback(
    (slug: string) => {
      setPickedProject(slug);
      setError(undefined);
      setPhase('configs');
      setLoading(true);
      void client
        .listDopplerConfigs(slug)
        .then((result) => {
          if ('error' in result) {
            if (result.error === 'not configured') setNotConfigured(true);
            else setError(bindingErrorCopy(result.error));
            setPhase('projects');
            return;
          }
          setConfigs(result.configs);
        })
        .catch(() => setError('Could not load Doppler configs'))
        .finally(() => setLoading(false));
    },
    [client],
  );

  const pickConfig = useCallback(
    (configName: string) => {
      if (pickedProject === undefined) return;
      setError(undefined);
      setPhase('saving');
      void client
        .updateProjectSettings(projectId, {
          dopplerProject: pickedProject,
          dopplerConfig: configName,
        })
        .then((saved) => {
          onSaved(saved);
          cancel();
        })
        .catch((caught) => {
          setError(
            caught instanceof VerityApiError
              ? caught.status === 503
                ? 'Unlock the secret store first.'
                : caught.message
              : 'Could not save the Doppler binding',
          );
          setPhase('configs');
        });
    },
    [cancel, client, onSaved, pickedProject, projectId],
  );

  return (
    <SettingsDisclosure title="Doppler" icon="cloud" summary={summary} onCollapse={cancel}>
      <Text style={styles.reproSubtitle}>
        The Doppler environment whose secrets this project may request. Verity resolves them in the
        central broker; no Doppler credential is stored in or injected into the project container.
      </Text>

      {phase === 'idle' ? (
        <Pressable
          style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel={bound ? 'Change Doppler binding' : 'Choose Doppler binding'}
        >
          <Text style={styles.reproButtonLabel}>{bound ? 'Change' : 'Choose'}</Text>
        </Pressable>
      ) : null}

      {loading ? <ActivityIndicator size="small" /> : null}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      {notConfigured ? (
        <Text style={styles.footnote}>
          Set the Doppler account token in Verity settings under Connected services first, then
          choose a binding here.
        </Text>
      ) : null}

      {phase === 'projects' && !loading && !notConfigured ? (
        <View style={styles.panelStack} accessibilityLabel="Doppler projects">
          {projects.length === 0 ? (
            <Text style={styles.footnote}>No Doppler projects found for this account.</Text>
          ) : (
            <SettingsListPanel>
              {projects.map((project) => (
                <PickRow
                  key={project.slug}
                  label={project.name}
                  accessibilityLabel={`Doppler project ${project.name}`}
                  onPress={() => pickProject(project.slug)}
                />
              ))}
            </SettingsListPanel>
          )}
          <BindingCancel onPress={cancel} />
        </View>
      ) : null}

      {phase === 'configs' && !loading && !notConfigured ? (
        <View style={styles.panelStack} accessibilityLabel="Doppler configs">
          {configs.length === 0 ? (
            <Text style={styles.footnote}>No configs found for this project.</Text>
          ) : (
            <SettingsListPanel>
              {configs.map((config) => (
                <PickRow
                  key={config.name}
                  label={config.name}
                  accessibilityLabel={`Doppler config ${config.name}`}
                  onPress={() => pickConfig(config.name)}
                />
              ))}
            </SettingsListPanel>
          )}
          <BindingCancel onPress={cancel} />
        </View>
      ) : null}

      {bound ? (
        <Text style={styles.footnote}>
          Changing the environment applies to future brokered secret requests.
        </Text>
      ) : null}
    </SettingsDisclosure>
  );
}

function PickRow({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.navRow, pressed ? styles.pressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.navRowTitle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// A shared "Cancel" affordance for the picker's project/config lists — returns to
// the idle (current-binding) view without changing anything.
function BindingCancel({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Cancel Doppler binding"
    >
      <Text style={styles.reproButtonLabel}>Cancel</Text>
    </Pressable>
  );
}

// Map a redacted server error string to operator-facing copy. The server sends
// fixed, non-secret messages ('locked', 'Doppler rejected the token', etc.); we
// keep them but special-case the sealed case for a clearer instruction.
function bindingErrorCopy(error: string): string {
  if (error === 'locked') return 'Unlock the secret store first.';
  return error;
}

function GoogleDriveFolderSection({
  client,
  projectId,
  settings,
  onSaved,
}: {
  client: VerityClient;
  projectId: string;
  settings: ProjectSettings | null;
  onSaved: (settings: ProjectSettings) => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const folderName = settings?.googleDriveFolderName ?? null;
  const choose = useCallback(() => {
    router.push({
      pathname: '/google-drive/[sessionId]',
      params: { sessionId: projectId, purpose: 'folder' },
    });
  }, [projectId]);
  const disconnect = useCallback(() => {
    if (disconnecting) return;
    Alert.alert(
      'Disconnect Google Drive folder?',
      'The files stay in Google Drive. Verity will no longer access them from this project.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            setDisconnecting(true);
            void client
              .disconnectProjectGoogleDriveFolder(projectId)
              .then(() => {
                if (settings === null) return;
                onSaved({ ...settings, googleDriveFolderId: null, googleDriveFolderName: null });
              })
              .catch(() => Alert.alert('Could not disconnect folder'))
              .finally(() => setDisconnecting(false));
          },
        },
      ],
    );
  }, [client, disconnecting, onSaved, projectId, settings]);

  return (
    <SettingsDisclosure
      title="Google Drive folder"
      icon="folder"
      summary={folderName ?? 'Not connected'}
    >
      <Text style={styles.reproSubtitle}>
        Verity can read, create, and edit files in the connected folder from this project's
        sessions.
      </Text>
      <View style={styles.actionRow}>
        {folderName ? (
          <Pressable
            style={({ pressed }) => [
              styles.reproButton,
              disconnecting ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={disconnect}
            disabled={disconnecting}
            accessibilityRole="button"
            accessibilityLabel="Disconnect Google Drive folder"
          >
            <Text style={styles.reproButtonLabel}>
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
          onPress={choose}
          accessibilityRole="button"
          accessibilityLabel={
            folderName ? 'Change Google Drive folder' : 'Connect Google Drive folder'
          }
        >
          <Text style={styles.reproButtonLabel}>{folderName ? 'Change' : 'Connect folder'}</Text>
        </Pressable>
      </View>
    </SettingsDisclosure>
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
  const [error, setError] = useState<string | undefined>();
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
        if (loadGeneration.current === generation) setError('Could not load MCP connections.');
      });
  }, [client, projectId]);
  // On focus, not on mount: the empty state links to the Verity MCP screen, and
  // a connection added there has to be here when the operator comes back.
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
        .catch(() => setError('Could not update the MCP connection.'))
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
        <SettingsListPanel>
          <SettingsNavRow
            icon="link"
            title="MCP connections"
            subtitle="No connections yet. Add one in Verity settings first."
            onPress={() => router.push('/settings/services/mcp')}
          />
        </SettingsListPanel>
      ) : (
        <SettingsPanel>
          {connections.map((connection) => (
            <SettingsToggleRow
              key={connection.id}
              label={connection.name}
              value={enabled(connection.id)}
              disabled={pendingConnectionId !== undefined}
              onValueChange={() => toggle(connection.id)}
            />
          ))}
        </SettingsPanel>
      )}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </>
  );
}
