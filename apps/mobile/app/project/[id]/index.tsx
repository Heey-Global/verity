// Project detail: the sessions bound to this repository plus the project
// operations — Dev Servers and Agent Loops — that live on the project itself.
// Configuration is one screen deeper: the gear opens the project settings routes
// under `project/[id]/settings/`, which mirror the Verity settings surface.
import {
  VerityApiError,
  canCreatePublicPreviewTarget,
  publishAgentLoopMutation,
  publishDevServerStatusMutation,
  subscribeAgentLoopMutations,
  subscribeDevServerStatusMutations,
  type VerityClient,
  type AgentLoop,
  type DevServer,
  type DevServerStatusMutation,
  type DevServerDetection,
  type DevServerSuggestion,
  type ProjectRecord,
  type ProjectRuntimeHealth,
  type ProjectRuntimeStarted,
  type PublicPreviewShare,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../../lib/client';
import { Icon } from '../../../components/Icon';
import { StatusPill } from '../../../components/StatusPill';
import { repairProject } from '../../../lib/projectRepair';
import { projectLifecycleState, projectSetupStatus } from '../../../lib/projectSetup';
import { projectIdParam, useProjectDetail } from '../../../lib/useProjectDetail';

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useMemo(() => createVerityClient(), []);
  const projectId = projectIdParam(id);

  if (!client || projectId.length === 0) {
    return (
      <CenteredMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
      />
    );
  }
  return <ProjectDetailView client={client} projectId={projectId} />;
}

function ProjectDetailView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const insets = useSafeAreaInsets();
  const { detail, loading, error, setError, load, onProjectUpdated } = useProjectDetail(
    client,
    projectId,
  );
  const [creatingLoop, setCreatingLoop] = useState(false);
  const [activeTab, setActiveTab] = useState<ProjectTab>('dev-server');

  const createAgentLoop = useCallback(() => {
    if (!detail || creatingLoop) return;
    Alert.alert('Create in this project', undefined, [
      {
        text: 'Session',
        onPress: () =>
          router.push({
            pathname: '/new',
            params: { project: `${detail.project.owner}/${detail.project.repo}` },
          }),
      },
      {
        text: 'Agent Loop',
        onPress: () => {
          setCreatingLoop(true);
          setError(undefined);
          void client
            .createAgentLoop(detail.project.id, { name: 'New Agent Loop' })
            .then((loop) => {
              if (!loop.sessionId) throw new Error('Agent Loop session was not created');
              router.push({ pathname: '/session/[id]', params: { id: loop.sessionId } });
            })
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : 'Could not create Agent Loop');
            })
            .finally(() => setCreatingLoop(false));
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [client, creatingLoop, detail, setError]);

  const openSettings = useCallback(() => {
    router.push({ pathname: '/project/[id]/settings', params: { id: projectId } });
  }, [projectId]);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: 'Project' }} />
        <ActivityIndicator />
      </View>
    );
  }

  if (detail === undefined) {
    return (
      <CenteredMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        onRetry={() => load()}
      />
    );
  }

  const { project } = detail;
  const lifecycleState = projectLifecycleState(project);
  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: project.repo }} />
      {error ? <StaleBanner message={error} onRetry={() => load()} /> : null}
      <ProjectTabs
        active={activeTab}
        creating={creatingLoop}
        onCreate={createAgentLoop}
        onChange={setActiveTab}
        onOpenSettings={openSettings}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {lifecycleState !== 'active' && lifecycleState !== 'absent' ? (
          <View style={styles.runtimePanel} accessibilityLabel="Project setup progress">
            <Text style={styles.operationsTitle}>{projectSetupStatus(project).label}</Text>
            {lifecycleState === 'failed' && project.provisionError ? (
              <Text style={styles.settingsError}>{project.provisionError}</Text>
            ) : lifecycleState === 'sleeping' ? (
              <Text style={styles.operationsSubtitle}>The secure workspace is stopped.</Text>
            ) : lifecycleState === 'sleeping_starting' ? (
              <Text style={styles.operationsSubtitle}>The workspace is stopping safely.</Text>
            ) : lifecycleState === 'waking' ? (
              <Text style={styles.operationsSubtitle}>The secure workspace is starting.</Text>
            ) : (
              <Text style={styles.operationsSubtitle}>
                Setup continues in the background if you leave this screen.
              </Text>
            )}
          </View>
        ) : null}
        {activeTab === 'dev-server' ? (
          <DevServersSection client={client} project={project} onUpdated={onProjectUpdated} />
        ) : null}
        {activeTab === 'automations' ? (
          <AgentLoopsSection
            client={client}
            project={project}
            onCreateAgentLoop={createAgentLoop}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

type ProjectTab = 'dev-server' | 'automations';

function ProjectTabs({
  active,
  creating,
  onCreate,
  onChange,
  onOpenSettings,
}: {
  active: ProjectTab;
  creating: boolean;
  onCreate: () => void;
  onChange: (tab: ProjectTab) => void;
  onOpenSettings: () => void;
}) {
  const { theme } = useUnistyles();
  const tabs: { key: ProjectTab; label: string }[] = [
    { key: 'dev-server', label: 'Dev Server' },
    { key: 'automations', label: 'Automations' },
  ];
  return (
    <View style={styles.projectTabs} accessibilityRole="tablist">
      <ScrollView
        style={styles.projectTabsScroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.projectTabsContent}
      >
        {tabs.map((tab) => {
          const selected = active === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={[styles.projectTab, selected ? styles.projectTabSelected : null]}
              onPress={() => onChange(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
            >
              <Text
                style={[styles.projectTabText, selected ? styles.projectTabTextSelected : null]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        style={styles.projectSettingsTab}
        onPress={onCreate}
        disabled={creating}
        accessibilityRole="button"
        accessibilityLabel="Create session or Agent Loop"
        accessibilityState={{ disabled: creating }}
      >
        {creating ? (
          <ActivityIndicator size="small" />
        ) : (
          <Icon name="plus" size={20} color={theme.colors.text} />
        )}
      </Pressable>
      {/* A destination, not a tab: settings is its own route stack, like the
          gear on the home header that opens Verity settings. */}
      <Pressable
        style={styles.projectSettingsTab}
        onPress={onOpenSettings}
        accessibilityRole="button"
        accessibilityLabel="Project settings"
      >
        <Icon name="settings" size={19} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}

function AgentLoopsSection({
  client,
  project,
  onCreateAgentLoop,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onCreateAgentLoop?: () => void;
}) {
  const [agentLoops, setAgentLoops] = useState<AgentLoop[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadGeneration = useRef(0);
  const pendingLoopMutations = useRef(new Map<string, { loop: AgentLoop; generation: number }>());

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(undefined);
    void client
      .listAgentLoops(project.id)
      .then((loops) => {
        if (generation !== loadGeneration.current) return;
        const pending = new Map(
          [...pendingLoopMutations.current]
            .filter(([, entry]) => entry.generation >= generation)
            .map(([id, entry]) => [id, entry.loop]),
        );
        const seen = new Set(loops.map((loop) => loop.id));
        setAgentLoops([
          ...loops.map((loop) => pending.get(loop.id) ?? loop),
          ...[...pending.values()].filter((loop) => !seen.has(loop.id)),
        ]);
        pendingLoopMutations.current.clear();
      })
      .catch((caught) => {
        if (generation === loadGeneration.current) {
          setError(caught instanceof Error ? caught.message : 'Could not load Agent Loops');
        }
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
  }, [client, project.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      subscribeAgentLoopMutations((updated) => {
        if (updated.projectId !== project.id) return;
        pendingLoopMutations.current.set(updated.id, {
          loop: updated,
          generation: loadGeneration.current,
        });
        setAgentLoops((current) => {
          const found = current.some((candidate) => candidate.id === updated.id);
          return found
            ? current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
            : [...current, updated];
        });
      }),
    [project.id],
  );

  const setStatus = useCallback(
    (loop: AgentLoop, status: 'enabled' | 'paused') => {
      if (updatingId) return;
      setUpdatingId(loop.id);
      setError(undefined);
      void client
        .updateAgentLoop(loop.id, { status })
        .then((updated) => {
          setAgentLoops((current) =>
            current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
          );
          publishAgentLoopMutation(updated);
        })
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : 'Could not update Agent Loop'),
        )
        .finally(() => setUpdatingId(null));
    },
    [client, updatingId],
  );

  const open = useCallback(
    (loop: AgentLoop) => {
      if (updatingId) return;
      if (loop.sessionId) {
        router.push({ pathname: '/session/[id]', params: { id: loop.sessionId } });
        return;
      }
      setUpdatingId(loop.id);
      setError(undefined);
      void client
        .ensureAgentLoopSession(loop.id)
        .then((updated) => {
          setAgentLoops((current) =>
            current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
          );
          if (!updated.sessionId) throw new Error('Agent Loop session was not created');
          router.push({ pathname: '/session/[id]', params: { id: updated.sessionId } });
        })
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : 'Could not open Agent Loop'),
        )
        .finally(() => setUpdatingId(null));
    },
    [client, updatingId],
  );

  return (
    <View style={styles.section}>
      <View style={styles.agentLoopPanel}>
        <View style={styles.agentLoopTitleRow}>
          <View style={styles.agentLoopText}>
            <Text style={styles.operationsTitle}>Agent Loops</Text>
            <Text style={styles.operationsSubtitle}>
              Scripts that run on a schedule and wake an agent only when needed.
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.agentLoopAddButton, pressed ? styles.rowPressed : null]}
            onPress={onCreateAgentLoop}
            accessibilityRole="button"
            accessibilityLabel="Create Agent Loop"
          >
            <Text style={styles.agentLoopAddButtonText}>New loop</Text>
          </Pressable>
        </View>
        {loading ? <ActivityIndicator /> : null}
        {error ? (
          <Pressable onPress={load} accessibilityRole="button">
            <Text style={styles.settingsError}>{error} · Retry</Text>
          </Pressable>
        ) : null}
        {!loading && !error && agentLoops.length === 0 ? (
          <Text style={styles.runtimeMetaValueMuted}>
            No Agent Loops yet. Create one and the setup agent will guide you in its session.
          </Text>
        ) : null}
        {agentLoops.map((loop) => (
          <View key={loop.id} style={styles.agentLoopCard}>
            <Pressable
              onPress={() => open(loop)}
              disabled={updatingId !== null}
              style={({ pressed }) => (pressed ? styles.rowPressed : null)}
              accessibilityRole="button"
              accessibilityLabel={`Open Agent Loop ${loop.name}`}
              accessibilityState={{ disabled: updatingId !== null }}
            >
              <View style={styles.agentLoopCardRow}>
                <View style={styles.agentLoopText}>
                  <Text style={styles.runtimeMetaValue}>{loop.name}</Text>
                  <Text style={styles.runtimeMetaValueMuted}>{agentLoopScheduleLabel(loop)}</Text>
                </View>
                {updatingId === loop.id ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <StatusPill
                    intent={
                      loop.status === 'enabled'
                        ? 'ready'
                        : loop.status === 'draft'
                          ? 'needsSetup'
                          : 'optional'
                    }
                    label={
                      loop.status === 'enabled'
                        ? 'Active'
                        : loop.status === 'draft'
                          ? 'Setup'
                          : 'Paused'
                    }
                  />
                )}
              </View>
              {loop.lastOutcome ? (
                <Text style={styles.runtimeMetaValueMuted}>Last run: {loop.lastOutcome}</Text>
              ) : null}
            </Pressable>
            {loop.status === 'enabled' || loop.status === 'paused' ? (
              <Pressable
                onPress={() => setStatus(loop, loop.status === 'enabled' ? 'paused' : 'enabled')}
                disabled={updatingId !== null}
                accessibilityRole="button"
                accessibilityLabel={
                  loop.status === 'enabled'
                    ? `Pause Agent Loop ${loop.name}`
                    : `Resume Agent Loop ${loop.name}`
                }
                accessibilityState={{ disabled: updatingId !== null }}
                style={({ pressed }) => [
                  styles.agentLoopStatusButton,
                  pressed ? styles.rowPressed : null,
                ]}
              >
                {updatingId === loop.id ? <ActivityIndicator size="small" /> : null}
                <Text style={styles.agentLoopStatusButtonText}>
                  {loop.status === 'enabled' ? 'Pause' : 'Resume'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
function agentLoopScheduleLabel(loop: AgentLoop): string {
  if (!loop.schedule) return 'Schedule not set';
  if (loop.schedule.kind === 'interval') {
    return `Every ${String(loop.schedule.everyMinutes)} minutes`;
  }
  const time = `${String(loop.schedule.hour).padStart(2, '0')}:${String(loop.schedule.minute).padStart(2, '0')}`;
  if (loop.schedule.kind === 'daily') return `Daily at ${time}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[loop.schedule.weekday] ?? 'Weekly'} at ${time}`;
}

type DevServerDraft = {
  name: string;
  command: string;
  url: string;
  workdir: string;
  containerPort: string;
};

const emptyDevServerDraft = (): DevServerDraft => ({
  name: '',
  command: '',
  url: '',
  workdir: '',
  containerPort: '',
});

const detectedDevServerDraft = (suggestion: DevServerSuggestion): DevServerDraft => ({
  name: suggestion.name,
  command: suggestion.command,
  url: '',
  workdir: suggestion.workdir ?? '',
  containerPort: suggestion.containerPort ?? '',
});

function DevServersSection({
  client,
  project,
  onUpdated,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
}) {
  const { theme } = useUnistyles();
  const [servers, setServers] = useState<DevServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [publicPreviewsEnabled, setPublicPreviewsEnabled] = useState(false);
  const [publicShares, setPublicShares] = useState<PublicPreviewShare[]>([]);
  const [editing, setEditing] = useState<DevServer | 'new' | null>(null);
  const [draft, setDraft] = useState<DevServerDraft>(emptyDevServerDraft);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [automaticDetection, setAutomaticDetection] = useState<DevServerDetection | null>(null);
  const detectionGeneration = useRef(0);
  const serverLoadGeneration = useRef(0);
  const pendingServerMutations = useRef(
    new Map<string, { mutation: DevServerStatusMutation; generation: number }>(),
  );
  const manualDetectionInFlight = useRef(false);
  const [suggestions, setSuggestions] = useState<DevServerSuggestion[] | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<string, DevServerDraft>>({});
  const paused = project.state === 'absent';
  const running = project.state === 'active';

  const load = useCallback(() => {
    const generation = ++serverLoadGeneration.current;
    setLoading(true);
    setError(undefined);
    void client
      .listDevServers(project.id)
      .then((next) => {
        if (generation !== serverLoadGeneration.current) return;
        const pending = new Map(
          [...pendingServerMutations.current]
            .filter(([, entry]) => entry.generation >= generation)
            .map(([id, entry]) => [id, entry.mutation]),
        );
        const seen = new Set(next.map((server) => server.id));
        setServers([
          ...next.map((server) => {
            const mutation = pending.get(server.id);
            return (
              mutation?.devServer ??
              (mutation
                ? {
                    ...server,
                    ...(mutation.running === undefined ? {} : { running: mutation.running }),
                    ...(mutation.previewSessionId === undefined
                      ? {}
                      : { previewSessionId: mutation.previewSessionId }),
                  }
                : server)
            );
          }),
          ...[...pending.values()].flatMap((mutation) =>
            !seen.has(mutation.id) && mutation.devServer ? [mutation.devServer] : [],
          ),
        ]);
        pendingServerMutations.current.clear();
      })
      .catch((caught) => {
        if (generation === serverLoadGeneration.current) {
          setError(
            caught instanceof VerityApiError ? caught.message : 'Could not load Dev Servers',
          );
        }
      })
      .finally(() => {
        if (generation === serverLoadGeneration.current) setLoading(false);
      });
  }, [client, project.id]);

  useEffect(() => load(), [load]);

  useEffect(
    () =>
      subscribeDevServerStatusMutations((mutation) => {
        if (mutation.projectId !== project.id) return;
        pendingServerMutations.current.set(mutation.id, {
          mutation,
          generation: serverLoadGeneration.current,
        });
        setServers((current) => {
          const found = current.some((server) => server.id === mutation.id);
          if (!found && mutation.devServer === undefined) return current;
          return found
            ? current.map((server) =>
                server.id === mutation.id
                  ? (mutation.devServer ?? {
                      ...server,
                      ...(mutation.running === undefined ? {} : { running: mutation.running }),
                      ...(mutation.previewSessionId === undefined
                        ? {}
                        : { previewSessionId: mutation.previewSessionId }),
                    })
                  : server,
              )
            : [...current, mutation.devServer!];
        });
      }),
    [project.id],
  );

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void client
        .getHealth()
        .then((health) => {
          if (active) setPublicPreviewsEnabled(health.publicPreviewsEnabled === true);
        })
        .catch(() => {
          if (active) setPublicPreviewsEnabled(false);
        });
    };
    refresh();
    const timer = setInterval(refresh, 15_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      active = false;
      clearInterval(timer);
      subscription?.remove();
    };
  }, [client]);

  useEffect(() => {
    if (!publicPreviewsEnabled) {
      setPublicShares([]);
      return;
    }
    let active = true;
    const refresh = () => {
      void client
        .listPublicPreviewShares(project.id)
        .then((shares) => {
          if (active) setPublicShares(shares);
        })
        .catch(() => {
          // Keep the last known state during transient refresh failures.
        });
    };
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, project.id, publicPreviewsEnabled]);

  useEffect(() => {
    if (project.state === 'cloning' || project.state === 'container_starting') return;
    let active = true;
    const refresh = (): void => {
      if (manualDetectionInFlight.current) return;
      const generation = ++detectionGeneration.current;
      void client
        .getDevServerDetection(project.id)
        .then((result) => {
          if (active && generation === detectionGeneration.current) {
            setAutomaticDetection(result);
          }
        })
        // Automatic detection is advisory. A manual Review retries and surfaces
        // the error; opening the tab itself must remain usable while offline.
        .catch(() => undefined);
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [client, project.id, project.state]);

  const openEditor = useCallback((server: DevServer | 'new') => {
    setEditing(server);
    setDraft(
      server === 'new'
        ? emptyDevServerDraft()
        : {
            name: server.name,
            command: server.command ?? '',
            url: server.url ?? '',
            workdir: server.workdir ?? '',
            containerPort: server.containerPort ?? '',
          },
    );
  }, []);

  const addServer = useCallback(() => {
    openEditor('new');
  }, [openEditor]);

  const editServer = useCallback(
    (server: DevServer) => {
      openEditor(server);
    },
    [openEditor],
  );

  const save = useCallback(() => {
    if (!editing || saving) return;
    const body = {
      name: draft.name.trim() || 'Dev server',
      command: draft.command.trim() || null,
      url: draft.url.trim() || null,
      workdir: draft.workdir.trim() || null,
      containerPort: draft.containerPort.trim() || null,
    };
    const needsContainerRestart =
      running && (editing === 'new' || editing.containerPort !== body.containerPort);
    const run = (): void => {
      setSaving(true);
      setError(undefined);
      let projectWasStopped = false;
      let serverWasStopped = false;
      void (async () => {
        if (needsContainerRestart) {
          const stopped = await client.deprovisionProject(project.id, { purge: false });
          onUpdated(stopped);
          projectWasStopped = true;
        } else if (
          editing !== 'new' &&
          editing.running &&
          (editing.command !== body.command || editing.workdir !== body.workdir)
        ) {
          await client.stopDevServer(editing.id);
          serverWasStopped = true;
        }
        const server =
          editing === 'new'
            ? await client.createDevServer(project.id, { ...body, autoStart: true })
            : await client.updateDevServer(editing.id, body);
        if (projectWasStopped) {
          const queued = await client.repairProject(project.id);
          onUpdated(queued);
          projectWasStopped = false;
        } else if (
          editing !== 'new' &&
          editing.running &&
          (editing.command !== body.command || editing.workdir !== body.workdir)
        ) {
          await client.startDevServer(editing.id);
          serverWasStopped = false;
        }
        setServers((current) => {
          const found = current.some((candidate) => candidate.id === server.id);
          return found
            ? current.map((candidate) => (candidate.id === server.id ? server : candidate))
            : [...current, server];
        });
        setEditing(null);
      })()
        .catch(async (caught) => {
          // Restore the prior running state when a later mutation fails. Recovery
          // is best-effort and deliberately precedes surfacing the original error.
          try {
            if (projectWasStopped) onUpdated(await client.repairProject(project.id));
            else if (serverWasStopped && editing !== 'new') await client.startDevServer(editing.id);
          } catch {
            // The next refresh exposes the still-stopped state; retain the primary
            // save failure because it is the actionable cause.
          }
          setError(caught instanceof VerityApiError ? caught.message : 'Could not save Dev Server');
        })
        .finally(() => setSaving(false));
    };
    if (needsContainerRestart) {
      Alert.alert(
        'Restart project environment?',
        'The published port changes at container startup. Verity will restart the environment and restore enabled Dev Servers automatically.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Restart & save', onPress: run },
        ],
      );
    } else {
      run();
    }
  }, [client, draft, editing, onUpdated, project.id, running, saving]);

  const remove = useCallback(
    (server: DevServer) => {
      Alert.alert('Delete Dev Server?', `${server.name} will be stopped and its port released.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setError(undefined);
            void client
              .deleteDevServer(server.id)
              .then(() => setServers((current) => current.filter(({ id }) => id !== server.id)))
              .catch((caught) =>
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not delete Dev Server',
                ),
              );
          },
        },
      ]);
    },
    [client],
  );

  const detect = useCallback(() => {
    if (detecting) return;
    setDetecting(true);
    manualDetectionInFlight.current = true;
    setError(undefined);
    ++detectionGeneration.current;
    void client
      .getDevServerDetection(project.id)
      .then((result) => {
        const next = result.suggestions;
        setAutomaticDetection(result);
        setSuggestions(next);
        setSuggestionDrafts(
          Object.fromEntries(
            next.map((suggestion) => [suggestion.key, detectedDevServerDraft(suggestion)]),
          ),
        );
        setSelectedSuggestions(
          new Set(
            next
              .filter(({ status, alreadyConfigured }) => status === 'changed' || !alreadyConfigured)
              .map(({ key }) => key),
          ),
        );
      })
      .catch((caught) =>
        setError(
          caught instanceof VerityApiError ? caught.message : 'Could not detect Dev Servers',
        ),
      )
      .finally(() => {
        manualDetectionInFlight.current = false;
        setDetecting(false);
      });
  }, [client, detecting, project.id]);

  const toggleSuggestion = useCallback((key: string) => {
    setSelectedSuggestions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const closeSuggestions = useCallback(() => {
    setSuggestions(null);
    setSelectedSuggestions(new Set());
    setSuggestionDrafts({});
  }, []);

  const updateSuggestionDraft = useCallback((key: string, patch: Partial<DevServerDraft>) => {
    setSuggestionDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? emptyDevServerDraft()), ...patch },
    }));
  }, []);

  const configureSuggestions = useCallback(
    (selected: DevServerSuggestion[], confirmWarnings = false) => {
      if (!automaticDetection?.fingerprint || saving || selected.length === 0) return;
      setSaving(true);
      setError(undefined);
      void client
        .setupDetectedDevServers(project.id, {
          fingerprint: automaticDetection.fingerprint,
          confirmWarnings,
          devServers: selected.map((suggestion) => {
            const suggestionDraft =
              suggestionDrafts[suggestion.key] ?? detectedDevServerDraft(suggestion);
            return {
              sourceKey: suggestion.key,
              name: suggestionDraft.name.trim() || 'Dev server',
              command: suggestionDraft.command.trim(),
              workdir: suggestionDraft.workdir.trim() || null,
              containerPort: suggestionDraft.containerPort.trim() || null,
            };
          }),
        })
        .then((nextProject) => {
          onUpdated(nextProject);
          setAutomaticDetection((current) =>
            current ? { ...current, reviewedFingerprint: current.fingerprint } : current,
          );
          closeSuggestions();
          load();
        })
        .catch((caught) => {
          if (
            caught instanceof VerityApiError &&
            caught.requiresConfirmation &&
            caught.warnings.length > 0
          ) {
            Alert.alert('Restart project environment?', caught.warnings.join('\n\n'), [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Restart & start',
                onPress: () => configureSuggestions(selected, true),
              },
            ]);
            return;
          }
          setError(
            caught instanceof VerityApiError ? caught.message : 'Could not start Dev Server',
          );
        })
        .finally(() => setSaving(false));
    },
    [
      automaticDetection?.fingerprint,
      client,
      closeSuggestions,
      load,
      onUpdated,
      project.id,
      saving,
      suggestionDrafts,
    ],
  );

  const createSuggestions = useCallback(() => {
    if (!suggestions || saving) return;
    const selected = suggestions.filter(
      ({ key, status, alreadyConfigured }) =>
        selectedSuggestions.has(key) && (status === 'changed' || !alreadyConfigured),
    );
    if (selected.length === 0) return;
    configureSuggestions(selected);
  }, [configureSuggestions, saving, selectedSuggestions, suggestions]);

  const pendingSuggestions = useMemo(() => {
    if (
      !automaticDetection ||
      automaticDetection.fingerprint === automaticDetection.reviewedFingerprint
    )
      return [];
    return automaticDetection.suggestions.filter(
      ({ status, alreadyConfigured }) =>
        status === 'changed' || (status === 'new' && !alreadyConfigured),
    );
  }, [automaticDetection]);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={styles.runtimeInlineHeader}>
          <Icon name="monitor" size={18} color={theme.colors.textMuted} />
          <View>
            <Text style={styles.sectionHeader}>Dev Servers</Text>
            <Text style={styles.operationsSubtitle}>Local previews for this project.</Text>
          </View>
        </View>
        <Pressable
          onPress={addServer}
          accessibilityRole="button"
          accessibilityLabel="Manual Dev Server setup"
        >
          <Text style={styles.runtimeTextButton}>Manual setup</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      {loading ? <ActivityIndicator /> : null}
      {!loading && pendingSuggestions.length > 0 ? (
        <View style={styles.runtimePanel}>
          <View style={styles.operationsSubsectionHeader}>
            <View style={styles.runtimeInlineHeader}>
              <Icon name="monitor" size={18} color={theme.colors.primary} />
              <View style={styles.agentLoopText}>
                <Text style={styles.operationsTitle}>
                  {pendingSuggestions.length === 1
                    ? 'Dev Server found'
                    : `${String(pendingSuggestions.length)} Dev Servers found`}
                </Text>
                <Text style={styles.operationsSubtitle} numberOfLines={2}>
                  {pendingSuggestions.length === 1
                    ? pendingSuggestions[0]!.command
                    : 'Choose which previews Verity should run.'}
                </Text>
              </View>
            </View>
          </View>
          <Pressable
            style={[styles.runtimeActionButton, styles.saveButton]}
            onPress={() =>
              pendingSuggestions.length === 1 ? configureSuggestions(pendingSuggestions) : detect()
            }
            disabled={saving || detecting}
            accessibilityRole="button"
          >
            {saving || detecting ? <ActivityIndicator size="small" /> : null}
            <Text style={styles.saveButtonLabel}>
              {pendingSuggestions.length === 1 ? 'Start' : 'Choose'}
            </Text>
          </Pressable>
          <Text style={styles.settingsHint}>
            Verity will restart the project environment only if the published port requires it.
          </Text>
        </View>
      ) : null}
      {!loading && servers.length === 0 && pendingSuggestions.length === 0 ? (
        <View style={styles.runtimeEmptyState}>
          <Text style={styles.operationsTitle}>No Dev Server found</Text>
          <Text style={styles.operationsSubtitle}>
            Verity checks the repository automatically. You can still configure one manually.
          </Text>
        </View>
      ) : null}
      {servers.length === 0 && publicPreviewsEnabled && project.state === 'active' ? (
        <PublicPreviewShareControls
          client={client}
          server={{
            id: '',
            projectId: project.id,
            sourceKey: null,
            name: 'Static folder',
            command: null,
            url: null,
            workdir: null,
            hostPort: null,
            containerPort: null,
            previewSessionId: null,
            autoStart: false,
            running: false,
            sortOrder: 0,
            createdAt: '',
            updatedAt: '',
          }}
          canCreateDevServer={false}
          canCreateStatic
          staticOnly
          shares={publicShares.filter(({ targetKind }) => targetKind === 'static-folder')}
          onShareChanged={(share) =>
            setPublicShares((current) => [share, ...current.filter(({ id }) => id !== share.id)])
          }
        />
      ) : null}
      {servers.map((server, index) => (
        <DevServerCard
          key={server.id}
          client={client}
          server={server}
          projectState={project.state}
          canEdit={paused || running}
          configurationBusy={false}
          pausingToEdit={false}
          publicPreviewsEnabled={publicPreviewsEnabled}
          publicShares={publicShares.filter(
            ({ devServerId, targetKind }) =>
              devServerId === server.id || (index === 0 && targetKind === 'static-folder'),
          )}
          onPublicShareChanged={(share) =>
            setPublicShares((current) => [share, ...current.filter(({ id }) => id !== share.id)])
          }
          onEdit={() => editServer(server)}
          onDelete={() => remove(server)}
        />
      ))}
      <Modal
        visible={suggestions !== null}
        transparent
        animationType="fade"
        onRequestClose={closeSuggestions}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.sectionHeader}>Detected Dev Servers</Text>
            <Text style={styles.settingsHint}>
              Review the repository suggestions. Nothing is created until you confirm.
            </Text>
            {error ? <Text style={styles.settingsError}>{error}</Text> : null}
            <ScrollView style={styles.devServerEditorScroll}>
              {suggestions?.length === 0 ? (
                <Text style={styles.runtimeMetaValueMuted}>No supported dev scripts found.</Text>
              ) : null}
              {suggestions?.map((suggestion) => {
                const selected = selectedSuggestions.has(suggestion.key);
                const actionable = suggestion.status === 'changed' || !suggestion.alreadyConfigured;
                const suggestionDraft =
                  suggestionDrafts[suggestion.key] ?? detectedDevServerDraft(suggestion);
                return (
                  <View key={suggestion.key} style={styles.agentLoopCard}>
                    <View style={styles.agentLoopCardRow}>
                      <View style={styles.agentLoopText}>
                        <Text style={styles.runtimeMetaValue}>{suggestionDraft.name}</Text>
                        <Text style={styles.settingsHint}>{suggestion.evidence}</Text>
                      </View>
                      <Pressable
                        style={({ pressed }) => [
                          styles.detectedSuggestionToggle,
                          pressed ? styles.rowPressed : null,
                        ]}
                        onPress={() => toggleSuggestion(suggestion.key)}
                        disabled={!actionable}
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Select detected Dev Server ${suggestion.name}`}
                        accessibilityState={{
                          checked: !actionable || selected,
                          disabled: !actionable,
                        }}
                      >
                        <Text style={styles.runtimeMetaValue}>
                          {!actionable ? 'Added' : selected ? '✓' : '○'}
                        </Text>
                      </Pressable>
                    </View>
                    {selected && actionable ? (
                      <View>
                        <SettingsInput
                          label="Name"
                          accessibilityLabel={`Name for detected Dev Server ${suggestion.name}`}
                          value={suggestionDraft.name}
                          onChangeText={(name) => updateSuggestionDraft(suggestion.key, { name })}
                        />
                        <SettingsInput
                          label="Command"
                          accessibilityLabel={`Command for detected Dev Server ${suggestion.name}`}
                          value={suggestionDraft.command}
                          onChangeText={(command) =>
                            updateSuggestionDraft(suggestion.key, { command })
                          }
                          autoCapitalize="none"
                        />
                        <SettingsInput
                          label="Working directory"
                          accessibilityLabel={`Working directory for detected Dev Server ${suggestion.name}`}
                          value={suggestionDraft.workdir}
                          onChangeText={(workdir) =>
                            updateSuggestionDraft(suggestion.key, { workdir })
                          }
                          autoCapitalize="none"
                          placeholder="Project root"
                        />
                        <SettingsInput
                          label="Container port"
                          accessibilityLabel={`Container port for detected Dev Server ${suggestion.name}`}
                          value={suggestionDraft.containerPort}
                          onChangeText={(containerPort) =>
                            updateSuggestionDraft(suggestion.key, { containerPort })
                          }
                          autoCapitalize="none"
                          placeholder="Detect at runtime"
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
            <View style={styles.lifecycleActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.lifecycleButton,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={closeSuggestions}
                accessibilityRole="button"
              >
                <Text style={styles.lifecycleButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.runtimeActionButton,
                  styles.saveButton,
                  selectedSuggestions.size === 0 || saving ? styles.saveButtonDisabled : null,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={createSuggestions}
                disabled={selectedSuggestions.size === 0 || saving}
                accessibilityRole="button"
                accessibilityLabel="Create selected Dev Servers"
              >
                <Text style={styles.saveButtonLabel}>
                  {saving ? 'Starting…' : 'Start selected'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        {/*
          Four text fields in a dialog that is vertically centred: with the
          keyboard up, the lower half of the card — Preview URL, port, and both
          buttons — sits behind it. Padding the overlay re-centres the card in
          what is left. The controller's KeyboardAvoidingView works in here,
          where React Native's does not: a Modal is its own host view, and only
          React context reaches across it.
        */}
        <KeyboardAvoidingView style={styles.modalOverlay} behavior="padding" automaticOffset>
          <View style={styles.modalCard}>
            <Text style={styles.sectionHeader}>
              {editing === 'new' ? 'Add Dev Server' : 'Edit Dev Server'}
            </Text>
            <ScrollView style={styles.devServerEditorScroll} keyboardShouldPersistTaps="handled">
              <SettingsInput
                label="Name"
                value={draft.name}
                onChangeText={(name) => setDraft((current) => ({ ...current, name }))}
              />
              <SettingsInput
                label="Command"
                value={draft.command}
                onChangeText={(command) => setDraft((current) => ({ ...current, command }))}
                autoCapitalize="none"
              />
              <SettingsInput
                label="Preview URL"
                value={draft.url}
                onChangeText={(url) => setDraft((current) => ({ ...current, url }))}
                autoCapitalize="none"
                keyboardType="url"
              />
              <SettingsInput
                label="Working directory"
                value={draft.workdir}
                onChangeText={(workdir) => setDraft((current) => ({ ...current, workdir }))}
                autoCapitalize="none"
              />
              <SettingsInput
                label="Container port"
                value={draft.containerPort}
                onChangeText={(containerPort) =>
                  setDraft((current) => ({ ...current, containerPort }))
                }
                autoCapitalize="none"
                keyboardType="default"
              />
            </ScrollView>
            <Text style={styles.settingsHint}>The host port is assigned automatically.</Text>
            <View style={styles.lifecycleActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.lifecycleButton,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={() => setEditing(null)}
                accessibilityRole="button"
              >
                <Text style={styles.lifecycleButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.runtimeActionButton,
                  styles.saveButton,
                  saving ? styles.saveButtonDisabled : null,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={save}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Save Dev Server"
              >
                <Text style={styles.saveButtonLabel}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function DevServerCard({
  client,
  server,
  projectState,
  canEdit,
  configurationBusy,
  pausingToEdit,
  publicPreviewsEnabled,
  publicShares,
  onPublicShareChanged,
  onEdit,
  onDelete,
}: {
  client: VerityClient;
  server: DevServer;
  projectState: ProjectRecord['state'];
  canEdit: boolean;
  configurationBusy: boolean;
  pausingToEdit: boolean;
  publicPreviewsEnabled: boolean;
  publicShares: PublicPreviewShare[];
  onPublicShareChanged: (share: PublicPreviewShare) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  const [runtime, setRuntime] = useState<ProjectRuntimeStarted>();
  const [health, setHealth] = useState<ProjectRuntimeHealth>();
  const [logs, setLogs] = useState<string>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previewSessionId, setPreviewSessionId] = useState(server.previewSessionId);
  const [previewSessionName, setPreviewSessionName] = useState<string>();
  const refreshGeneration = useRef(0);
  const active = projectState === 'active';
  const configured = Boolean(server.command?.trim());

  useEffect(() => setPreviewSessionId(server.previewSessionId), [server.previewSessionId]);

  useEffect(
    () =>
      subscribeDevServerStatusMutations((mutation) => {
        if (mutation.id !== server.id) return;
        // A mutation from another surface supersedes a background refresh. During
        // this row's own action, keep its generation alive so `finally` clears busy.
        if (!busy) refreshGeneration.current += 1;
        if (mutation.previewSessionId !== undefined) {
          setPreviewSessionId(mutation.previewSessionId);
        }
        if (mutation.running !== undefined) {
          const running = mutation.running;
          setRuntime((current) => ({
            projectId: server.projectId,
            url: server.url,
            pid: running ? (current?.pid ?? null) : null,
            running,
          }));
        }
      }),
    [busy, server.id, server.projectId, server.url],
  );

  useEffect(() => {
    if (!previewSessionId) {
      setPreviewSessionName(undefined);
      return;
    }
    let cancelled = false;
    void client
      .getSession(previewSessionId)
      .then((session) => {
        if (!cancelled) setPreviewSessionName(session.name ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, previewSessionId]);

  const resetPreview = useCallback(() => {
    if (busy) return;
    const generation = ++refreshGeneration.current;
    setBusy(true);
    setError(undefined);
    void client
      .setDevServerPreviewSession(server.id, null)
      .then(({ devServer, runtime: nextRuntime }) => {
        if (refreshGeneration.current !== generation) return;
        setPreviewSessionId(devServer.previewSessionId);
        if (nextRuntime) setRuntime(nextRuntime);
        publishDevServerStatusMutation({
          id: devServer.id,
          projectId: devServer.projectId,
          devServer,
          previewSessionId: devServer.previewSessionId,
          ...(nextRuntime ? { running: nextRuntime.running } : {}),
        });
      })
      .catch((caught) => {
        if (refreshGeneration.current !== generation) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not reset preview');
      })
      .finally(() => {
        if (refreshGeneration.current === generation) setBusy(false);
      });
  }, [busy, client, server.id]);

  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    if (!active || !configured) {
      setRuntime({ projectId: server.projectId, url: server.url, running: false, pid: null });
      setHealth(undefined);
      setError(undefined);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    void Promise.all([
      client.getDevServerStatus(server.id),
      server.url ? client.getDevServerHealth(server.id) : Promise.resolve(undefined),
    ])
      .then(([nextRuntime, nextHealth]) => {
        if (refreshGeneration.current !== generation) return;
        setRuntime(nextRuntime);
        setHealth(nextHealth);
      })
      .catch((caught) => {
        if (refreshGeneration.current !== generation) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not refresh server');
      })
      .finally(() => {
        if (refreshGeneration.current === generation) setBusy(false);
      });
  }, [active, client, configured, server.id, server.projectId, server.url]);

  useEffect(() => {
    refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  const toggle = useCallback(() => {
    if (!active || !configured || busy) return;
    const generation = ++refreshGeneration.current;
    setBusy(true);
    setError(undefined);
    const action = runtime?.running
      ? client.stopDevServer(server.id)
      : client.startDevServer(server.id);
    void action
      .then((nextRuntime) => {
        if (refreshGeneration.current === generation) {
          setRuntime(nextRuntime);
          publishDevServerStatusMutation({
            id: server.id,
            projectId: server.projectId,
            running: nextRuntime.running,
          });
        }
      })
      .catch((caught) => {
        if (refreshGeneration.current !== generation) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Runtime action failed');
      })
      .finally(() => {
        if (refreshGeneration.current === generation) setBusy(false);
      });
  }, [active, busy, client, configured, runtime?.running, server.id]);

  const showLogs = useCallback(() => {
    const nextOpen = !logsOpen;
    setLogsOpen(nextOpen);
    if (!nextOpen || logs !== undefined || !active) return;
    void client
      .getDevServerLogs(server.id)
      .then((result) => setLogs(result.logs))
      .catch((caught) =>
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load logs'),
      );
  }, [active, client, logs, logsOpen, server.id]);

  const inactiveStatus =
    projectState === 'absent'
      ? 'Paused'
      : projectState === 'failed'
        ? 'Environment failed'
        : projectState === 'cloning'
          ? 'Cloning project'
          : 'Starting environment';
  const status = busy
    ? 'Working'
    : runtime?.running
      ? 'Running'
      : !active
        ? inactiveStatus
        : configured
          ? 'Ready'
          : 'Not configured';

  return (
    <View style={styles.runtimePanel}>
      <View style={styles.operationsSubsectionHeader}>
        <View style={styles.runtimeInlineHeader}>
          <Icon
            name="monitor"
            size={18}
            color={runtime?.running ? theme.colors.primary : theme.colors.textMuted}
          />
          <View style={styles.agentLoopText}>
            <Text style={styles.operationsTitle}>{server.name}</Text>
            <Text style={styles.operationsSubtitle} numberOfLines={2}>
              {previewSessionId
                ? `Previewing ${previewSessionName ?? `session ${previewSessionId.slice(0, 8)}`}`
                : 'Main checkout'}
            </Text>
          </View>
        </View>
        <StatusPill
          label={status}
          intent={
            runtime?.running ? 'ready' : error ? 'needsSetup' : busy ? 'transient' : 'optional'
          }
        />
      </View>
      {detailsOpen ? (
        <>
          <View style={styles.runtimeMetaRow}>
            <Text style={styles.runtimeMetaLabel}>URL</Text>
            {server.url ? (
              <Pressable onPress={() => void Linking.openURL(server.url!)} accessibilityRole="link">
                <Text style={[styles.runtimeUrl, { color: theme.colors.primary }]}>
                  {server.url}
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.runtimeMetaValueMuted}>Unset</Text>
            )}
          </View>
          <View style={styles.runtimeMetaRow}>
            <Text style={styles.runtimeMetaLabel}>Port</Text>
            <Text style={server.hostPort ? styles.runtimeMetaValue : styles.runtimeMetaValueMuted}>
              {server.hostPort ? `${server.hostPort}:${server.containerPort ?? '-'}` : 'Unassigned'}
            </Text>
          </View>
          <View style={styles.runtimeMetaRow}>
            <Text style={styles.runtimeMetaLabel}>Health</Text>
            <Text
              style={health?.reachable ? styles.runtimeMetaValue : styles.runtimeMetaValueMuted}
            >
              {health?.reachable
                ? `Healthy${health.status ? ` (${health.status})` : ''}`
                : 'Not checked'}
            </Text>
          </View>
          {previewSessionId ? (
            <View style={styles.runtimeMetaRow}>
              <Text style={styles.runtimeMetaLabel}>Preview</Text>
              <Text
                style={[styles.runtimeMetaValue, { color: theme.colors.primary, flexShrink: 1 }]}
                numberOfLines={1}
              >
                {previewSessionName ?? `Session ${previewSessionId.slice(0, 8)}`}
              </Text>
              <Pressable
                onPress={resetPreview}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Point ${server.name} back at the main checkout`}
              >
                <Text style={styles.runtimeTextButton}>Back to main</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
      {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      <View style={styles.lifecycleActions}>
        <Pressable
          style={({ pressed }) => [
            styles.runtimeActionButton,
            styles.saveButton,
            !active || !configured || busy || configurationBusy ? styles.saveButtonDisabled : null,
            pressed ? styles.rowPressed : null,
          ]}
          onPress={toggle}
          disabled={!active || !configured || busy || configurationBusy}
          accessibilityRole="button"
          accessibilityLabel={`${runtime?.running ? 'Stop' : 'Start'} ${server.name}`}
        >
          <Text style={styles.saveButtonLabel}>{runtime?.running ? 'Stop' : 'Start'}</Text>
        </Pressable>
        {runtime?.running && server.url ? (
          <Pressable
            style={({ pressed }) => [styles.lifecycleButton, pressed ? styles.rowPressed : null]}
            onPress={() => void Linking.openURL(server.url!)}
            accessibilityRole="link"
          >
            <Text style={styles.lifecycleButtonLabel}>Open</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.lifecycleButton, pressed ? styles.rowPressed : null]}
          onPress={() => setDetailsOpen((current) => !current)}
          accessibilityRole="button"
          accessibilityState={{ expanded: detailsOpen }}
        >
          <Text style={styles.lifecycleButtonLabel}>
            {detailsOpen ? 'Hide details' : 'Details'}
          </Text>
        </Pressable>
        {detailsOpen ? (
          <>
            <Pressable
              style={({ pressed }) => [
                styles.lifecycleButton,
                !canEdit || pausingToEdit ? styles.lifecycleButtonDisabled : null,
                pressed ? styles.rowPressed : null,
              ]}
              onPress={onEdit}
              disabled={!canEdit || pausingToEdit}
              accessibilityRole="button"
              accessibilityLabel={`Advanced settings for ${server.name}`}
            >
              {pausingToEdit ? <ActivityIndicator size="small" /> : null}
              <Text style={styles.lifecycleButtonLabel}>Advanced</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.lifecycleButtonDanger,
                busy || configurationBusy ? styles.lifecycleButtonDisabled : null,
                pressed ? styles.rowPressed : null,
              ]}
              onPress={onDelete}
              disabled={busy || configurationBusy}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${server.name}`}
            >
              <Text style={[styles.lifecycleButtonLabel, { color: theme.colors.tone.danger }]}>
                Delete
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {publicPreviewsEnabled ? (
        <PublicPreviewShareControls
          client={client}
          server={server}
          canCreateDevServer={Boolean(runtime?.running)}
          canCreateStatic={active}
          shares={publicShares}
          onShareChanged={onPublicShareChanged}
        />
      ) : null}
      {detailsOpen ? (
        <>
          <Pressable
            style={styles.runtimeLogsHeader}
            onPress={showLogs}
            accessibilityRole="button"
            accessibilityState={{ expanded: logsOpen }}
          >
            <Text style={styles.runtimeMetaLabel}>Logs</Text>
            <Text style={styles.runtimeTextButton}>{logsOpen ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {logsOpen ? (
            <ScrollView style={styles.runtimeLogsBox} nestedScrollEnabled>
              <Text style={logs ? styles.runtimeLogsText : styles.runtimeLogsEmpty}>
                {logs ?? (active ? 'Loading…' : 'Project is paused.')}
              </Text>
            </ScrollView>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const PUBLIC_SHARE_TTLS = [
  { label: '15 min', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '2 hours', seconds: 2 * 60 * 60 },
  { label: '4 hours', seconds: 4 * 60 * 60 },
  { label: '8 hours', seconds: 8 * 60 * 60 },
] as const;

function PublicPreviewShareControls({
  client,
  server,
  canCreateDevServer,
  canCreateStatic,
  shares,
  onShareChanged,
  staticOnly = false,
}: {
  client: VerityClient;
  server: DevServer;
  canCreateDevServer: boolean;
  canCreateStatic: boolean;
  shares: PublicPreviewShare[];
  onShareChanged: (share: PublicPreviewShare) => void;
  staticOnly?: boolean;
}) {
  const { theme } = useUnistyles();
  const [modalOpen, setModalOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [targetKind, setTargetKind] = useState<'dev-server' | 'static-folder'>(
    staticOnly ? 'static-folder' : 'dev-server',
  );
  const [staticPath, setStaticPath] = useState('dist');
  const [ttlSeconds, setTtlSeconds] = useState(60 * 60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
  const canCreate = canCreatePublicPreviewTarget(targetKind, {
    devServerRunning: canCreateDevServer,
    projectActive: canCreateStatic,
  });
  const canOpen = canCreateDevServer || canCreateStatic;

  const create = useCallback(() => {
    if (busy || !canCreate || !/^\d{6,12}$/.test(pin)) return;
    setBusy(true);
    setError(undefined);
    const request =
      targetKind === 'static-folder'
        ? client.createStaticPublicPreviewShare(server.projectId, { pin, ttlSeconds, staticPath })
        : client.createPublicPreviewShare(server.id, { pin, ttlSeconds });
    void request
      .then((share) => {
        onShareChanged(share);
        setPin('');
        setModalOpen(false);
      })
      .catch((caught) =>
        setError(
          caught instanceof VerityApiError ? caught.message : 'Could not create public share',
        ),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    canCreate,
    client,
    onShareChanged,
    pin,
    server.id,
    server.projectId,
    staticPath,
    targetKind,
    ttlSeconds,
  ]);

  const stop = useCallback(
    (share: PublicPreviewShare) => {
      if (busy) return;
      Alert.alert('Stop public share?', 'The external link will stop working immediately.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop sharing',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(undefined);
            void client
              .stopPublicPreviewShare(share.id)
              .then(() => onShareChanged({ ...share, state: 'revoked' }))
              .catch((caught) =>
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not stop public share',
                ),
              )
              .finally(() => setBusy(false));
          },
        },
      ]);
    },
    [busy, client, onShareChanged],
  );

  const copy = useCallback((share: PublicPreviewShare) => {
    if (!share.publicOrigin) return;
    setError(undefined);
    void Clipboard.setStringAsync(share.publicOrigin)
      .then(() => setCopiedId(share.id))
      .catch(() => setError('Could not copy public share link'));
  }, []);

  const liveShares = shares.filter(
    ({ state }) => !['revoked', 'expired', 'failed'].includes(state),
  );
  const pinValid = /^\d{6,12}$/.test(pin);

  return (
    <View style={styles.publicShareSection}>
      <View style={styles.runtimeMetaRow}>
        <Text style={styles.runtimeMetaLabel}>External sharing</Text>
        <Pressable
          onPress={() => setModalOpen(true)}
          disabled={!canOpen || busy}
          accessibilityRole="button"
          accessibilityLabel={`Share ${server.name} externally`}
          style={!canOpen || busy ? styles.lifecycleButtonDisabled : undefined}
        >
          <Text style={styles.runtimeTextButton}>Create link</Text>
        </Pressable>
      </View>
      {!canOpen ? (
        <Text style={styles.settingsHint}>Start the project before sharing it.</Text>
      ) : null}
      <Text style={styles.settingsHint}>
        Public traffic reaches this project sandbox. A compromised dev server can use the
        sandbox&apos;s project-scoped broker and gateway permissions.
      </Text>
      {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      {liveShares.map((share) => (
        <View key={share.id} style={styles.publicShareCard}>
          <View style={styles.operationsSubsectionHeader}>
            <View style={styles.agentLoopText}>
              <Text style={styles.runtimeMetaValue}>
                {share.state === 'active' ? 'Public link active' : `Share ${share.state}`}
              </Text>
              <Text style={styles.settingsHint}>
                Expires {new Date(share.expiresAt).toLocaleString()}
              </Text>
            </View>
            <StatusPill
              label={share.state}
              intent={
                share.state === 'active' ? 'ready' : share.failure ? 'needsSetup' : 'transient'
              }
            />
          </View>
          {share.publicOrigin ? (
            <Pressable
              onPress={() => void Linking.openURL(share.publicOrigin!)}
              accessibilityRole="link"
            >
              <Text style={[styles.runtimeUrl, { color: theme.colors.primary }]} numberOfLines={1}>
                {share.publicOrigin}
              </Text>
            </Pressable>
          ) : null}
          {share.failure ? <Text style={styles.settingsError}>{share.failure}</Text> : null}
          <View style={styles.lifecycleActions}>
            {share.publicOrigin ? (
              <>
                <Pressable
                  style={styles.lifecycleButton}
                  onPress={() => copy(share)}
                  accessibilityRole="button"
                >
                  <Text style={styles.lifecycleButtonLabel}>
                    {copiedId === share.id ? 'Copied' : 'Copy link'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.lifecycleButton}
                  onPress={() => void Linking.openURL(share.publicOrigin!)}
                  accessibilityRole="link"
                >
                  <Text style={styles.lifecycleButtonLabel}>Open</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              style={styles.lifecycleButtonDanger}
              onPress={() => stop(share)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Stop public share"
            >
              <Text style={[styles.lifecycleButtonLabel, { color: theme.colors.tone.danger }]}>
                Stop
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.sectionHeader}>Share externally</Text>
            <Text style={styles.settingsHint}>
              Anyone with the link and PIN can access the selected target until the link expires.
            </Text>
            {!staticOnly ? <Text style={styles.fieldLabel}>Target</Text> : null}
            {!staticOnly ? (
              <View style={styles.publicShareTtlRow}>
                {(['dev-server', 'static-folder'] as const).map((kind) => (
                  <Pressable
                    key={kind}
                    onPress={() => setTargetKind(kind)}
                    disabled={kind === 'dev-server' && !canCreateDevServer}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: targetKind === kind,
                      disabled: kind === 'dev-server' && !canCreateDevServer,
                    }}
                    style={[
                      styles.publicShareTtl,
                      targetKind === kind ? styles.publicShareTtlSelected : null,
                      kind === 'dev-server' && !canCreateDevServer
                        ? styles.lifecycleButtonDisabled
                        : null,
                    ]}
                  >
                    <Text style={styles.lifecycleButtonLabel}>
                      {kind === 'dev-server' ? server.name : 'Static folder'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {targetKind === 'static-folder' ? (
              <SettingsInput
                label="Project-relative folder"
                value={staticPath}
                onChangeText={setStaticPath}
                autoCapitalize="none"
                accessibilityLabel="Static preview folder"
              />
            ) : null}
            <SettingsInput
              label="PIN (6–12 digits)"
              value={pin}
              onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 12))}
              keyboardType="number-pad"
              autoCapitalize="none"
              accessibilityLabel="Public share PIN"
            />
            <Text style={styles.fieldLabel}>Expires after</Text>
            <View style={styles.publicShareTtlRow}>
              {PUBLIC_SHARE_TTLS.map((option) => (
                <Pressable
                  key={option.seconds}
                  onPress={() => setTtlSeconds(option.seconds)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: ttlSeconds === option.seconds }}
                  style={[
                    styles.publicShareTtl,
                    ttlSeconds === option.seconds ? styles.publicShareTtlSelected : null,
                  ]}
                >
                  <Text style={styles.lifecycleButtonLabel}>{option.label}</Text>
                </Pressable>
              ))}
            </View>
            {!pinValid && pin.length > 0 ? (
              <Text style={styles.settingsError}>Enter 6 to 12 digits.</Text>
            ) : null}
            {error ? <Text style={styles.settingsError}>{error}</Text> : null}
            <View style={styles.lifecycleActions}>
              <Pressable
                style={styles.lifecycleButton}
                onPress={() => setModalOpen(false)}
                accessibilityRole="button"
              >
                <Text style={styles.lifecycleButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.runtimeActionButton,
                  styles.saveButton,
                  !pinValid || !canCreate || busy ? styles.saveButtonDisabled : null,
                ]}
                onPress={create}
                disabled={!pinValid || !canCreate || busy}
                accessibilityRole="button"
                accessibilityLabel="Create public share"
              >
                <Text style={styles.saveButtonLabel}>{busy ? 'Creating…' : 'Create link'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SettingsInput({
  label,
  accessibilityLabel = label,
  value,
  onChangeText,
  autoCapitalize = 'sentences',
  keyboardType = 'default',
  placeholder = 'Unset',
  secureTextEntry = false,
  configured,
  onBlur,
  multiline = false,
  hint,
}: {
  label: string;
  accessibilityLabel?: string;
  value: string;
  onChangeText: (value: string) => void;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'url' | 'number-pad';
  placeholder?: string;
  secureTextEntry?: boolean;
  onBlur?: () => void;
  // When set, renders a "Configured" status or optional "Not configured" detail.
  configured?: boolean;
  // Multi-line free text (the agent-memory notes area) — taller box, no
  // done-key submit so newlines are typable.
  multiline?: boolean;
  // Optional helper line under the field.
  hint?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.settingsInputRow}>
      <View style={styles.settingsLabelRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {configured !== undefined ? (
          <StatusPill
            intent={configured ? 'ready' : 'optional'}
            label={configured ? 'Configured' : 'Not configured'}
          />
        ) : null}
      </View>
      <TextInput
        style={[styles.settingsInput, multiline ? styles.settingsInputMultiline : null]}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        onBlur={onBlur}
        multiline={multiline}
        returnKeyType={multiline ? undefined : 'done'}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        accessibilityLabel={accessibilityLabel}
      />
      {hint ? <Text style={styles.settingsHint}>{hint}</Text> : null}
    </View>
  );
}

function StaleBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={1}>
        Couldn't refresh — {message}
      </Text>
      <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.bannerRetry}>Retry</Text>
      </Pressable>
    </View>
  );
}

function CenteredMessage({
  title,
  subtitle,
  onRetry,
}: {
  title: string;
  subtitle: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: 'Project' }} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {onRetry ? (
        <Pressable style={styles.retry} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1, backgroundColor: theme.colors.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
  projectTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  projectTabsScroller: {
    flex: 1,
  },
  projectTabsContent: {
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  projectTab: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
  },
  projectTabSelected: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  projectTabText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  projectTabTextSelected: {
    color: theme.colors.text,
  },
  projectSettingsTab: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
    borderRadius: theme.radius.pill,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  bannerText: {
    flex: 1,
    color: theme.colors.tone.attention,
    fontSize: theme.text.xs,
  },
  bannerRetry: {
    color: theme.colors.primary,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  sectionHeader: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  fieldLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  settingsInputRow: {
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  settingsLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  settingsInput: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    padding: 0,
  },
  settingsInputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  settingsError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  saveButton: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  saveButtonDisabled: {
    backgroundColor: theme.colors.border,
  },
  saveButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  settingsHint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.lg,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  modalCard: {
    maxHeight: '88%',
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  devServerEditorScroll: {
    flexGrow: 0,
  },
  lifecycleActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  lifecycleButton: {
    flex: 1,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  lifecycleButtonDanger: {
    flex: 1,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
  },
  lifecycleButtonDisabled: {
    opacity: 0.45,
  },
  lifecycleButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  publicShareSection: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  publicShareCard: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  publicShareTtlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
  },
  publicShareTtl: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  publicShareTtlSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  operationsSubsectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  operationsTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  operationsSubtitle: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  runtimePanel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  runtimeEmptyState: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  runtimeActionButton: {
    flex: 1,
  },
  runtimeMetaRow: {
    gap: 2,
  },
  runtimeInlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  runtimeMetaLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  runtimeMetaValue: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  // Attention rather than danger: these describe an environment that is running
  // but needs looking at, and `settingsError` beneath them is what a genuine
  // failure uses. Wraps freely — the drift text names its own remedy, and
  // truncating it would cut off the half that says what to do.
  runtimeMetaValueMuted: {
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  runtimeUrl: {
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  runtimeLogsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  runtimeTextButton: {
    color: theme.colors.primary,
    fontSize: theme.text.xs,
    fontWeight: '700',
  },
  runtimeLogsBox: {
    maxHeight: 180,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  runtimeLogsText: {
    color: theme.colors.text,
    fontFamily: 'monospace',
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
    padding: theme.spacing.md,
  },
  runtimeLogsEmpty: {
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    padding: theme.spacing.md,
  },
  agentLoopPanel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  agentLoopTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  agentLoopText: {
    flex: 1,
    gap: 2,
  },
  agentLoopAddButton: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  agentLoopAddButtonText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  agentLoopCard: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  agentLoopCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  detectedSuggestionToggle: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentLoopStatusButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  agentLoopStatusButtonText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  rowPressed: {
    opacity: 0.6,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 20 * theme.fontScale,
  },
  retry: {
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  retryLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
}));
