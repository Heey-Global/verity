// Project detail: local Verity project metadata plus the sessions bound to this
// repository. Project operations such as dev servers and Agent Loops live here so
// the screen stays the stable management surface for per-repo automation.
import {
  VerityApiError,
  PROJECT_IMAGE_REBUILDING_WARNING,
  canCreatePublicPreviewTarget,
  projectBadge,
  projectDisplayName,
  publishProjectStatusMutation,
  publishAgentLoopMutation,
  publishDevServerStatusMutation,
  subscribeAgentLoopMutations,
  subscribeDevServerStatusMutations,
  subscribeProjectStatusMutations,
  projectRepoRef,
  projectSettingsDraft,
  projectSettingsPatchFromDraft,
  sameProjectSettingsDraft,
  isSecuritySandboxUpdate,
  sandboxUpdateSummary,
  usesDevcontainerImage,
  type VerityClient,
  type AgentLoop,
  type DevServer,
  type DevServerStatusMutation,
  type DevServerDetection,
  type DevServerSuggestion,
  type ProjectDetail,
  type ProjectRecord,
  type ProjectRuntimeHealth,
  type ProjectRuntimeStarted,
  type PublicPreviewShare,
  type DopplerProjectSummary,
  type DopplerConfigSummary,
  type ProjectSettings,
  type ProjectSettingsDraft,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Icon } from '../../components/Icon';
import { StatusPill, type StatusPillIntent } from '../../components/StatusPill';
import { repairProject } from '../../lib/projectRepair';
import { projectSetupStatus, toolkitDriftNotice } from '../../lib/projectSetup';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Matches the overview's project poll (`PROJECTS_POLL_MS` in app/index.tsx) so the
 *  container state ages the same wherever the operator is looking. */
const PROJECT_DETAIL_POLL_MS = 15_000;

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useMemo(() => createVerityClient(), []);
  const projectId = param(id);

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
  const [detail, setDetail] = useState<ProjectDetail | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [creatingLoop, setCreatingLoop] = useState(false);
  const [activeTab, setActiveTab] = useState<ProjectTab>('dev-server');
  const loadGeneration = useRef(0);
  const publishedProjectRef = useRef<ProjectRecord | undefined>(undefined);
  const pendingProjectMutationRef = useRef<ProjectRecord | undefined>(undefined);
  const onProjectUpdated = useCallback((next: ProjectRecord) => {
    // A poll already in flight carries pre-action state and must not win later.
    loadGeneration.current += 1;
    setLoading(false);
    pendingProjectMutationRef.current = undefined;
    publishedProjectRef.current = next;
    setDetail((current) => (current ? { ...current, project: next } : current));
    publishProjectStatusMutation(next);
  }, []);
  const onSettingsSaved = useCallback((next: ProjectSettings) => {
    setDetail((current) => (current ? { ...current, settings: next } : current));
  }, []);
  // One settings form drives fields spread across the Dev Server, Memory, and
  // Settings tabs (see useProjectSettingsForm). Lifted here — above the loading/
  // error early-returns — so the shared draft/autosave survive tab switches and
  // obey the Rules of Hooks. Tolerates a null settings during the initial load.
  const settingsForm = useProjectSettingsForm(
    client,
    projectId,
    detail?.settings ?? null,
    onSettingsSaved,
  );

  const load = useCallback(
    async (silent = false): Promise<void> => {
      const generation = ++loadGeneration.current;
      if (!silent) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const next = await client.getProject(projectId);
        if (generation === loadGeneration.current) {
          const project = pendingProjectMutationRef.current ?? next.project;
          pendingProjectMutationRef.current = undefined;
          publishedProjectRef.current = project;
          setDetail({ ...next, project });
          publishProjectStatusMutation(project);
        }
      } catch (caught) {
        if (!silent && generation === loadGeneration.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not load project');
        }
      } finally {
        if (!silent && generation === loadGeneration.current) setLoading(false);
      }
    },
    [client, projectId],
  );

  const detailLoaded = detail !== undefined;
  useEffect(
    () =>
      subscribeProjectStatusMutations((next) => {
        if (next.id !== projectId) return;
        if (publishedProjectRef.current === next) return;
        pendingProjectMutationRef.current = next;
        setDetail((current) => (current ? { ...current, project: next } : current));
      }),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the container state live while the screen is open. `GET /projects/:id`
  // reconciles the project against Docker, so this is what turns a sandbox that
  // died under the operator into a visible "Needs repair" plus the Repair action,
  // instead of a stale "Running" with a Pause button. Silent: a failing poll must
  // not replace the rendered project with an error banner. Same cadence as the
  // overview poll. Native timers resume after the app returns to the foreground.
  useEffect(() => {
    // The initial request owns the loading gate. Starting a silent generation
    // before it settles could supersede it without any request clearing loading.
    if (!detailLoaded) return;
    const refresh = (): void => void load(true);
    const timer = setInterval(refresh, PROJECT_DETAIL_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [detailLoaded, load]);

  useEffect(() => {
    if (detail?.project.setupStatus !== 'pending') return;
    router.replace({ pathname: '/new-project', params: { projectId } });
  }, [detail?.project.setupStatus, projectId]);

  useEffect(() => {
    const state = detail?.project.state;
    if (state !== 'cloning' && state !== 'container_starting') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      await load(true);
      if (!cancelled) timer = setTimeout(() => void poll(), 2_000);
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detail?.project.state, load]);

  const deleteProject = useCallback(() => {
    if (detail === undefined || deleting) return;
    const target = detail.project;
    Alert.alert(
      'Delete project?',
      `This removes ${projectDisplayName(target)} from Verity, stops its container, and deletes the local clone along with the project's sessions and their history. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setDeleting(true);
            setError(undefined);
            void client
              .deleteProject(target.id)
              // `dismissTo`, not `replace`: this screen was pushed on top of the
              // home the operator came from, so replacing it with `/` leaves TWO
              // home screens stacked — and the second one renders a back button
              // to the first, the nonsensical "‹ Verity" on the overview. Popping
              // returns to the home already below (which refetches on focus, so
              // the deleted project is gone from it either way). Same reasoning as
              // the split-screen redirect in `session/[id].tsx`; with no home
              // below — a cold deep link straight into a project — it falls back
              // to replacing this route, exactly as before.
              .then(() => router.dismissTo('/'))
              .catch((caught) => {
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not delete project',
                );
              })
              .finally(() => setDeleting(false));
          },
        },
      ],
    );
  }, [client, deleting, detail]);

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
  }, [client, creatingLoop, detail]);

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
        onRetry={load}
      />
    );
  }

  if (detail.project.setupStatus === 'pending') {
    return (
      <View style={styles.centered} accessibilityLabel="Opening project setup">
        <Stack.Screen options={{ title: detail.project.repo }} />
        <ActivityIndicator />
        <Text style={styles.operationsTitle}>Opening project setup…</Text>
        <Text style={styles.operationsSubtitle}>
          Setup, Dev Server detection, and secrets are kept together in one guided flow.
        </Text>
      </View>
    );
  }

  const { project, settings } = detail;
  const title = project.repo;
  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title }} />
      {error ? <StaleBanner message={error} onRetry={load} /> : null}
      <ProjectTabs
        active={activeTab}
        creating={creatingLoop}
        onCreate={createAgentLoop}
        onChange={setActiveTab}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {project.state !== 'active' && project.state !== 'absent' ? (
          <View style={styles.runtimePanel} accessibilityLabel="Project setup progress">
            <Text style={styles.operationsTitle}>{projectSetupStatus(project).label}</Text>
            {project.provisionError ? (
              <Text style={styles.settingsError}>{project.provisionError}</Text>
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
        {activeTab === 'memory' ? <MemorySection form={settingsForm} /> : null}
        {activeTab === 'automations' ? (
          <AgentLoopsSection
            client={client}
            project={project}
            onCreateAgentLoop={createAgentLoop}
          />
        ) : null}
        {activeTab === 'settings' ? (
          <>
            <View style={styles.section} accessibilityLabel="Project settings overview">
              <Text style={styles.sectionHeader}>Project setup</Text>
              <Text style={styles.settingsGroupDescription}>
                Manage whether this project is running and which secrets it can access. Dev Server
                commands and ports stay in the Dev Server tab.
              </Text>
            </View>
            <EnvironmentSection
              client={client}
              project={project}
              onUpdated={onProjectUpdated}
              onReload={load}
            />
            <ProjectSettingsSection
              client={client}
              projectId={project.id}
              settings={settings}
              onSaved={onSettingsSaved}
            />
            {project.kind === 'local' ? (
              <LinkGitHubSection client={client} project={project} onUpdated={onProjectUpdated} />
            ) : null}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>Project information</Text>
              <ProjectFields project={project} />
            </View>
            <DangerSection project={project} deleting={deleting} onDelete={deleteProject} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

type ProjectTab = 'dev-server' | 'memory' | 'automations' | 'settings';

function ProjectTabs({
  active,
  creating,
  onCreate,
  onChange,
}: {
  active: ProjectTab;
  creating: boolean;
  onCreate: () => void;
  onChange: (tab: ProjectTab) => void;
}) {
  const { theme } = useUnistyles();
  const tabs: { key: ProjectTab; label: string }[] = [
    { key: 'dev-server', label: 'Dev Server' },
    { key: 'memory', label: 'Memory' },
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
      <Pressable
        style={[
          styles.projectSettingsTab,
          active === 'settings' ? styles.projectTabSelected : null,
        ]}
        onPress={() => onChange('settings')}
        accessibilityRole="tab"
        accessibilityLabel="Project settings"
        accessibilityState={{ selected: active === 'settings' }}
      >
        <Icon
          name="settings"
          size={19}
          color={active === 'settings' ? theme.colors.text : theme.colors.textMuted}
        />
      </Pressable>
    </View>
  );
}

function DangerSection({
  project,
  deleting,
  onDelete,
}: {
  project: ProjectRecord;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>Danger zone</Text>
      <View style={styles.dangerPanel}>
        <View style={styles.runtimeMetaRow}>
          <Text style={styles.runtimeMetaLabel}>Project</Text>
          <Text style={styles.runtimeMetaValue} numberOfLines={1}>
            {projectDisplayName(project)}
          </Text>
          <Text style={styles.runtimeMetaValueMuted}>
            Delete the Verity project record, stop its container, and remove the local clone.
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.deleteProjectButton,
            deleting ? styles.lifecycleButtonDisabled : null,
            pressed ? styles.rowPressed : null,
          ]}
          onPress={onDelete}
          disabled={deleting}
          accessibilityRole="button"
          accessibilityLabel="Delete project"
        >
          {deleting ? <ActivityIndicator size="small" /> : null}
          <Text style={[styles.lifecycleButtonLabel, { color: theme.colors.tone.danger }]}>
            {deleting ? 'Deleting...' : 'Delete project'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function sandboxRefLabel(
  ref: string | null | undefined,
  version?: string | null,
  revision?: string | null,
): string | null {
  const normalizedVersion = normalizeImageVersion(version);
  const shortRevision = shortSha(revision);
  if (normalizedVersion && shortRevision) return `${normalizedVersion} · ${shortRevision}`;
  if (normalizedVersion) return normalizedVersion;
  if (shortRevision) return shortRevision;
  if (!ref) return null;
  if (ref.includes('/dev-base')) return 'Legacy base';
  const tag = ref.match(/:([0-9]+(?:\.[0-9]+){1,3}(?:[-.][A-Za-z0-9]+)*)$/)?.[1];
  if (tag !== undefined) return `v${tag}`;
  const digest = shortDigest(ref);
  if (digest) return digest;
  if (ref.endsWith(':latest')) return 'Unpinned sandbox';
  return ref;
}

function normalizeImageVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function shortSha(revision: string | null | undefined): string | null {
  if (!revision) return null;
  const trimmed = revision.trim();
  return /^[0-9a-f]{7,}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed || null;
}

function shortDigest(ref: string): string | null {
  const match = ref.match(/(?:@|^)sha256:([0-9a-f]{12,})/i);
  return match ? `sha256:${match[1].slice(0, 12)}` : null;
}

// Environment — the project's runtime: run state + one state-driven lifecycle
// action, plus a slim update affordance when the sandbox image has one. Replaces
// the old separate Container + Sandbox sections. No raw container/Docker jargon;
// destructive removal lives in the Danger zone, not here.
function EnvironmentSection({
  client,
  project,
  onUpdated,
  onReload,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
  onReload: () => void;
}) {
  const [working, setWorking] = useState<'start' | 'pause' | 'update' | 'rebuild' | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const recoveryGeneration = useRef(0);
  const awaitingDurableCompletion = useRef(false);
  // Whether the server understands `forceRebuild`. Asked once when the panel
  // mounts — the answer only changes when the server is redeployed, and a stale
  // `false` costs a hidden button rather than a rebuild that silently did
  // nothing (see `healthSchema.imageRebuildSupported`).
  const [rebuildSupported, setRebuildSupported] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .getHealth()
      .then((health) => {
        if (active) setRebuildSupported(health.imageRebuildSupported === true);
      })
      .catch(() => {
        if (active) setRebuildSupported(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(
    () => () => {
      recoveryGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (
      awaitingDurableCompletion.current &&
      project.state !== 'cloning' &&
      project.state !== 'container_starting' &&
      project.provisionWarning !== PROJECT_IMAGE_REBUILDING_WARNING
    ) {
      awaitingDurableCompletion.current = false;
      setWorking(undefined);
    }
  }, [project.provisionWarning, project.state]);

  const running = project.state === 'active';
  const stopped = project.state === 'absent';
  const failed = project.state === 'failed';
  const starting = project.state === 'container_starting';
  const update = project.sandboxUpdate;
  // Null exactly when there is no pending update, so it gates the update row as
  // well as labelling it — one source of truth instead of a boolean that has to
  // stay in agreement with the summary next to it.
  const updateSummary = sandboxUpdateSummary(update);
  const driftNotice = toolkitDriftNotice(project);

  // Same descriptor the overview dot uses, so both surfaces name the container
  // state identically — and so the pill never leaks a raw state id like
  // `container_starting`, which it did for every transitional state.
  const badge = projectBadge(project);
  const rebuilding =
    working === 'rebuild' ||
    (project.provisionWarning != null &&
      project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING);
  const statusLabel = rebuilding ? 'Rebuilding…' : badge.label;
  const statusIntent: StatusPillIntent = rebuilding
    ? 'transient'
    : running
      ? 'ready'
      : badge.needsRepair
        ? 'needsSetup'
        : 'optional';

  // Start / Repair: (re)provision the environment. Preserves the sealed-secret
  // redirect and the server-warning confirmation from the old Reprovision path.
  const start = useCallback(() => {
    if (working !== undefined) return;
    setWorking('start');
    setError(undefined);
    void repairProject({
      client,
      projectId: project.id,
      returnTo: `/project/${project.id}`,
      onUpdated,
      onError: setError,
    }).finally(() => setWorking(undefined));
  }, [client, onUpdated, project.id, working]);

  // Pause: stop and remove the environment but keep the local clone for next start.
  const pause = useCallback(() => {
    if (working !== undefined) return;
    Alert.alert(
      'Pause project?',
      'This stops the project environment. Your local files stay, so you can start it again anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pause',
          onPress: () => {
            setWorking('pause');
            setError(undefined);
            void client
              .deprovisionProject(project.id, { purge: false })
              .then(onUpdated)
              .catch((caught) => {
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not pause project',
                );
              })
              .finally(() => setWorking(undefined));
          },
        },
      ],
    );
  }, [client, onUpdated, project.id, working]);

  // Both container-replacing actions run the same request and differ only in
  // whether the image is rebuilt, so they share one driver — including the
  // dropped-request recovery, which a rebuild needs MORE than an update does:
  // a `--no-cache` build is minutes long and the more likely of the two to
  // outlive the request that started it.
  const recreate = useCallback(
    (forceRebuild: boolean, failureMessage: string) => {
      const generation = ++recoveryGeneration.current;
      let keepWorkingAfterRecovery = false;
      setWorking(forceRebuild ? 'rebuild' : 'update');
      setError(undefined);
      void client
        .recreateProjectContainer(project.id, { confirmWarnings: true, forceRebuild })
        .then(() => {
          if (recoveryGeneration.current === generation) onReload();
        })
        .catch(async (caught) => {
          if (!(caught instanceof VerityApiError)) {
            try {
              // A cacheless build can outlive the HTTP request. Keep the action
              // disabled while the server still reports its transitional state,
              // then surface the actual completed/failed project record.
              let sawTransitionalState = false;
              const recoveryAttempts = forceRebuild ? 450 : 150;
              for (let attempt = 0; attempt < recoveryAttempts; attempt += 1) {
                if (recoveryGeneration.current !== generation) return;
                const next = await client.getProject(project.id);
                onUpdated(next.project);
                const transitional =
                  next.project.state === 'cloning' ||
                  next.project.state === 'container_starting' ||
                  next.project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING;
                if (transitional) sawTransitionalState = true;
                const terminalChanged =
                  (next.project.stateChangedAt !== undefined &&
                    next.project.stateChangedAt !== project.stateChangedAt) ||
                  next.project.provisionError !== project.provisionError ||
                  next.project.provisionWarning !== project.provisionWarning;
                if ((sawTransitionalState || terminalChanged) && !transitional) {
                  if (next.project.provisionWarning !== project.provisionWarning) {
                    setError(next.project.provisionWarning ?? failureMessage);
                  } else if (next.project.provisionError) {
                    setError(next.project.provisionError);
                  }
                  onReload();
                  return;
                }
                // A request that never reached the server leaves the original
                // terminal state untouched. Do not turn that into a false
                // success; allow a short window for the server's state write,
                // then surface the original transport error.
                if (!sawTransitionalState && attempt >= (forceRebuild ? 449 : 59)) break;
                await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
              }
              if (!sawTransitionalState) throw new Error('request did not reach the server');
              awaitingDurableCompletion.current = true;
              keepWorkingAfterRecovery = true;
              setError(
                `${forceRebuild ? 'Rebuild' : 'Update'} is still running. Status updates will continue automatically.`,
              );
              return;
            } catch {
              // Fall through to the visible error below only when the recheck
              // also fails; a dropped long-running request can still complete
              // server-side.
            }
          }
          if (recoveryGeneration.current === generation) {
            setError(caught instanceof VerityApiError ? caught.message : failureMessage);
          }
        })
        .finally(() => {
          if (recoveryGeneration.current === generation && !keepWorkingAfterRecovery) {
            setWorking(undefined);
          }
        });
    },
    [
      client,
      onReload,
      onUpdated,
      project.id,
      project.provisionError,
      project.provisionWarning,
      project.stateChangedAt,
    ],
  );

  const runUpdate = useCallback(() => {
    if (!updateSummary || working !== undefined) return;
    Alert.alert(
      'Update project?',
      isSecuritySandboxUpdate(update)
        ? 'This recreates the project environment and applies the pending security update.'
        : 'This recreates the project environment and applies the pending update.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Update', onPress: () => recreate(false, 'Could not update project') },
      ],
    );
  }, [recreate, update, updateSummary, working]);

  // Rebuild image: the escape hatch for a devcontainer change the image cache
  // cannot see. Verity caches the built image under a content hash over the
  // `.devcontainer/` directory, so a change to a Dockerfile or build context
  // OUTSIDE it — or to anything a build step fetches at build time — leaves the
  // hash, and therefore the cached image, exactly as it was. Update and Repair
  // both reuse it; this discards it.
  const rebuild = useCallback(() => {
    if (working !== undefined) return;
    Alert.alert(
      'Rebuild image?',
      'This rebuilds the project image from the repository devcontainer without the build cache, then recreates the environment. It can take several minutes.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rebuild', onPress: () => recreate(true, 'Could not rebuild project image') },
      ],
    );
  }, [recreate, working]);

  // Only a project on a BUILT image has a build to redo, and the server rejects
  // a recreate for a paused or mid-provision project — so the button is absent
  // rather than present-and-failing in those states.
  //
  // `imageRef` names the image of the last SUCCESSFUL provision and is left
  // untouched when one fails, so a project that built once and now fails — the
  // canonical reason to want `--no-cache` — still shows the action. A project
  // that has never provisioned successfully has no `imageRef` and no cached
  // derived image either, so its ordinary Repair already rebuilds.
  const canRebuild =
    rebuildSupported && usesDevcontainerImage(project.imageRef) && (running || failed);

  // One primary action, chosen by run state. Unknown/transient states disable it.
  const primary = running
    ? {
        label: 'Pause',
        busyLabel: 'Pausing…',
        run: pause,
        busy: working === 'pause',
        enabled: true,
      }
    : failed || starting
      ? {
          label: 'Repair',
          busyLabel: 'Repairing…',
          run: start,
          busy: working === 'start',
          enabled: true,
        }
      : {
          label: 'Start',
          busyLabel: 'Starting…',
          run: start,
          busy: working === 'start',
          enabled: stopped,
        };

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Environment</Text>
        <StatusPill intent={statusIntent} label={statusLabel} />
        {working && !rebuilding ? <ActivityIndicator size="small" /> : null}
      </View>
      <View style={styles.lifecyclePanel}>
        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            !primary.enabled || working ? styles.saveButtonDisabled : null,
            pressed ? styles.rowPressed : null,
          ]}
          onPress={primary.run}
          disabled={!primary.enabled || working !== undefined}
          accessibilityRole="button"
          accessibilityLabel={`${primary.label} project`}
        >
          <Text style={styles.saveButtonLabel}>
            {primary.busy ? primary.busyLabel : primary.label}
          </Text>
        </Pressable>
        {updateSummary ? (
          <>
            <View style={styles.runtimeMetaRow}>
              <Text style={styles.runtimeMetaLabel}>{updateSummary}</Text>
              <Text style={styles.runtimeMetaValue}>
                {sandboxRefLabel(update?.target, update?.targetVersion, update?.targetRevision) ??
                  'available'}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.lifecycleButton,
                working ? styles.lifecycleButtonDisabled : null,
                pressed ? styles.rowPressed : null,
              ]}
              onPress={runUpdate}
              disabled={working !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Update project environment"
            >
              <Text style={styles.lifecycleButtonLabel}>
                {working === 'update' ? 'Updating…' : 'Update'}
              </Text>
            </Pressable>
          </>
        ) : null}
        {canRebuild ? (
          <Pressable
            style={({ pressed }) => [
              styles.lifecycleButton,
              working ? styles.lifecycleButtonDisabled : null,
              pressed ? styles.rowPressed : null,
            ]}
            onPress={rebuild}
            disabled={working !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Rebuild project image"
          >
            <Text style={styles.lifecycleButtonLabel}>
              {working === 'rebuild' ? 'Rebuilding…' : 'Rebuild image'}
            </Text>
          </Pressable>
        ) : null}
        {/* Both notices live beside Start/Repair/Update rather than in the
            Project information list at the bottom: they describe the environment,
            and the actions that answer them are right here. */}
        {project.provisionWarning ? (
          <Text style={styles.runtimeNotice}>{project.provisionWarning}</Text>
        ) : null}
        {driftNotice ? <Text style={styles.runtimeNotice}>{driftNotice}</Text> : null}
        {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      </View>
    </View>
  );
}

/** The "connect later" bridge for a project created without GitHub. Verity does
 *  not create repositories, so the operator picks one the GitHub App installation
 *  already sees; the server pushes this project's history into it and rewrites the
 *  project's identity. The repository must be EMPTY — the server's plain
 *  (non-forced) push is what enforces that, so nothing here can overwrite history
 *  someone else pushed. */
function LinkGitHubSection({
  client,
  project,
  onUpdated,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
}) {
  const [repositories, setRepositories] = useState<ProjectRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void client
      .listAvailableRepositories()
      .then((next) => {
        if (cancelled) return;
        setRepositories(next);
        setSelectedId((current) => current ?? next[0]?.id ?? null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load repositories');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const sorted = useMemo(
    () =>
      [...repositories].sort((a, b) =>
        `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
      ),
    [repositories],
  );
  const selected = sorted.find((candidate) => candidate.id === selectedId) ?? sorted[0] ?? null;

  const link = useCallback(() => {
    if (selected === null || linking) return;
    const repo = `${selected.owner}/${selected.repo}`;
    Alert.alert(
      'Connect to GitHub',
      `Verity publishes this project's history to ${repo} and rebuilds its container. ` +
        'An empty repository receives it directly; one that already has history gets a ' +
        'pull request for you to merge. Any running session in this project restarts.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Connect',
          style: 'destructive',
          onPress: () => {
            setLinking(true);
            setError(undefined);
            void client
              .linkProjectToGitHub(project.id, repo)
              .then((linked) => {
                onUpdated(linked.project);
                // The history landed on a branch, not on the default branch — say so,
                // or the operator reads "connected" and never merges the pull request.
                if (linked.pullRequest !== undefined) {
                  Alert.alert(
                    'Pull request opened',
                    `${repo} already had history, so this project's files arrived on ` +
                      `${linked.importBranch ?? 'an import branch'}. Merge pull request #` +
                      `${String(linked.pullRequest.number)} to publish them.`,
                  );
                } else if (linked.importBranch !== undefined) {
                  Alert.alert(
                    'History pushed to a branch',
                    `This project's files are on ${linked.importBranch}, but the pull request ` +
                      `could not be opened${
                        linked.pullRequestError === undefined ? '' : `: ${linked.pullRequestError}`
                      }. Open it on GitHub to publish them.`,
                  );
                }
              })
              .catch((caught) =>
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not connect to GitHub',
                ),
              )
              .finally(() => setLinking(false));
          },
        },
      ],
    );
  }, [client, linking, onUpdated, project.id, selected]);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>GitHub</Text>
      <Text style={styles.settingsGroupDescription}>
        This project has no GitHub repository. Connect it to an existing repository to combine its
        history with this project and get pull requests, issues and CI status.
      </Text>
      <View style={styles.lifecyclePanel}>
        <Pressable
          style={({ pressed }) => [
            styles.lifecycleButton,
            loading || linking || sorted.length === 0 ? styles.lifecycleButtonDisabled : null,
            pressed ? styles.rowPressed : null,
          ]}
          onPress={() => setPickerOpen((open) => !open)}
          disabled={loading || linking || sorted.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Repository to connect"
        >
          <Text style={styles.lifecycleButtonLabel}>
            {loading
              ? 'Loading repositories…'
              : selected
                ? `${selected.owner}/${selected.repo}`
                : 'No repositories available'}
          </Text>
        </Pressable>
        {pickerOpen
          ? sorted.map((repository) => (
              <Pressable
                key={repository.id}
                style={({ pressed }) => [
                  styles.lifecycleButton,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={() => {
                  setSelectedId(repository.id);
                  setPickerOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${repository.owner}/${repository.repo}`}
              >
                <Text style={styles.lifecycleButtonLabel}>
                  {repository.owner}/{repository.repo}
                </Text>
              </Pressable>
            ))
          : null}
        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            selected === null || linking ? styles.saveButtonDisabled : null,
            pressed ? styles.rowPressed : null,
          ]}
          onPress={link}
          disabled={selected === null || linking}
          accessibilityRole="button"
          accessibilityLabel="Connect project to GitHub"
        >
          <Text style={styles.saveButtonLabel}>
            {linking ? 'Connecting…' : 'Connect to GitHub'}
          </Text>
        </Pressable>
        {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      </View>
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
      void (async () => {
        let projectWasRestarted = false;
        if (needsContainerRestart) {
          const stopped = await client.deprovisionProject(project.id, { purge: false });
          onUpdated(stopped);
          projectWasRestarted = true;
        } else if (
          editing !== 'new' &&
          editing.running &&
          (editing.command !== body.command || editing.workdir !== body.workdir)
        ) {
          await client.stopDevServer(editing.id);
        }
        const server =
          editing === 'new'
            ? await client.createDevServer(project.id, { ...body, autoStart: true })
            : await client.updateDevServer(editing.id, body);
        if (projectWasRestarted) {
          const queued = await client.repairProject(project.id);
          onUpdated(queued);
        } else if (
          editing !== 'new' &&
          editing.running &&
          (editing.command !== body.command || editing.workdir !== body.workdir)
        ) {
          await client.startDevServer(editing.id);
        }
        setServers((current) => {
          const found = current.some((candidate) => candidate.id === server.id);
          return found
            ? current.map((candidate) => (candidate.id === server.id ? server : candidate))
            : [...current, server];
        });
        setEditing(null);
      })()
        .catch((caught) =>
          setError(caught instanceof VerityApiError ? caught.message : 'Could not save Dev Server'),
        )
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
        <View style={styles.modalOverlay}>
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
        </View>
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

type ProjectSettingsForm = {
  draft: ProjectSettingsDraft;
  setField: (key: keyof ProjectSettingsDraft, value: string) => void;
  save: () => void;
  saving: boolean;
  dirty: boolean;
  error: string | undefined;
  settings: ProjectSettings | null;
};

// One draft + one autosave for the remaining project settings. Dev Servers use
// their own CRUD model above; this form retains the in-flight merge that protects
// text typed while an earlier save is airborne (notably the multiline Memory field).
function useProjectSettingsForm(
  client: VerityClient,
  projectId: string,
  settings: ProjectSettings | null,
  onSaved: (settings: ProjectSettings) => void,
): ProjectSettingsForm {
  const [draft, setDraft] = useState(() => projectSettingsDraft(settings));
  const [saving, setSaving] = useState(false);
  const [saveQueued, setSaveQueued] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const lastSettings = useRef(settings);
  const dirty = !sameProjectSettingsDraft(settings, draft);

  useEffect(() => {
    if (saving || lastSettings.current === settings) return;
    // This form is lifted above the screen's loading gate, so `settings` starts
    // null and becomes real once the project loads. On that first null→real
    // transition there can be no user edits yet (the fields are still behind the
    // spinner), so seed the draft unconditionally — the `dirty` guard below only
    // applies to later background refreshes, where an empty-vs-real diff would
    // otherwise read as "dirty" and leave every configured field blank.
    const hadSettings = lastSettings.current !== null;
    lastSettings.current = settings;
    // A background refresh or Doppler binding update must not overwrite text
    // currently being edited. The successful save path below reseeds the draft
    // from the server response once those edits have landed.
    if (hadSettings && dirty) return;
    setDraft((current) =>
      sameProjectSettingsDraft(settings, current) ? current : projectSettingsDraft(settings),
    );
  }, [dirty, saving, settings]);

  const setField = useCallback((key: keyof ProjectSettingsDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(() => {
    if (!dirty) return;
    if (saving) {
      setSaveQueued(true);
      return;
    }
    // `projectSettingsPatchFromDraft` omits empty write-only fields so a save never
    // clears a value the operator left untouched.
    const submittedDraft = draft;
    const patch = projectSettingsPatchFromDraft(submittedDraft);
    setSaving(true);
    setError(undefined);
    void client
      .updateProjectSettings(projectId, patch)
      .then((next) => {
        const savedDraft = projectSettingsDraft(next);
        setDraft((current) => {
          const merged = { ...savedDraft };
          for (const key of Object.keys(submittedDraft) as Array<keyof ProjectSettingsDraft>) {
            // A response only acknowledges the snapshot that was submitted. Keep
            // anything typed while that request was in flight so a slow save can
            // never roll back a newer edit (notably the multiline Memory field).
            if (current[key] !== submittedDraft[key]) merged[key] = current[key];
          }
          return merged;
        });
        lastSettings.current = next;
        onSaved(next);
      })
      .catch((caught) => {
        // Defensive: a 503 means the at-rest secret store is sealed. No field on
        // this form currently writes an at-rest secret (the manual Doppler token
        // was removed), so this is a general fallback rather than a reachable path.
        setError(
          caught instanceof VerityApiError
            ? caught.status === 503
              ? 'Unlock the secret store first.'
              : caught.message
            : 'Could not save settings',
        );
      })
      .finally(() => setSaving(false));
  }, [client, dirty, draft, onSaved, projectId, saving]);

  useEffect(() => {
    if (!saving && saveQueued) {
      setSaveQueued(false);
      save();
    }
  }, [save, saveQueued, saving]);

  return { draft, setField, save, saving, dirty, error, settings };
}

// Shared autosave status line rendered under each editable group. All groups read
// the same form, so whichever tab is visible reflects the single save state.
function SettingsSaveHint({ form }: { form: ProjectSettingsForm }) {
  return (
    <>
      {form.error ? <Text style={styles.settingsError}>{form.error}</Text> : null}
      <Text style={styles.settingsHint}>
        {form.saving
          ? 'Saving changes…'
          : form.dirty
            ? 'Changes save when you leave the field.'
            : form.settings?.updatedAt
              ? `All changes saved · ${formatDate(form.settings.updatedAt)}`
              : 'All changes save automatically.'}
      </Text>
    </>
  );
}

// Memory tab — the agent-memory notes box, promoted out of Settings to its own
// top-level destination.
function MemorySection({ form }: { form: ProjectSettingsForm }) {
  const { draft, setField, save, saving } = form;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Agent memory</Text>
        {saving ? <ActivityIndicator size="small" /> : null}
      </View>
      <Text style={styles.settingsGroupDescription}>
        Notes injected into every new session of this project.
      </Text>
      <View style={styles.settingsFormGroup}>
        <SettingsInput
          label="Memory"
          value={draft.memory}
          onChangeText={(value) => setField('memory', value)}
          placeholder="Project-specific guidance for agents"
          multiline
          hint="Agents can append through verity-memory; edit or clear the notes anytime."
          onBlur={save}
        />
      </View>
      <SettingsSaveHint form={form} />
    </View>
  );
}

// Settings tab — the broker-owned Doppler mapping. There is no per-project
// credential or token state. Binding writes are handled by
// DopplerBindingSection's own save, so this section carries no shared-form field.
function ProjectSettingsSection({
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
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Secrets</Text>
      </View>

      <Text style={styles.settingsGroupDescription}>
        Optionally map this project to one Doppler environment. Secret access always runs through
        the central Verity broker.
      </Text>
      <DopplerBindingSection
        client={client}
        projectId={projectId}
        settings={settings}
        onSaved={onSaved}
      />
      <Text style={styles.settingsHint}>
        Verity resolves approved secrets in the central broker. No Doppler credential is stored in
        or injected into the project container.
      </Text>
    </View>
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
  // operator to configure the Doppler account token in onboarding/settings first.
  const [notConfigured, setNotConfigured] = useState(false);

  const boundProject = settings?.dopplerProject ?? null;
  const boundConfig = settings?.dopplerConfig ?? null;
  const bound = boundProject !== null && boundProject.length > 0;

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
    <View style={styles.bindingSection} accessibilityLabel="Doppler binding">
      <View style={styles.settingsLabelRow}>
        <Text style={styles.fieldLabel}>Doppler binding</Text>
        {bound ? <StatusPill intent="ready" label="Mapped" /> : null}
      </View>
      <Text style={styles.bindingCurrent}>
        {bound
          ? `${boundProject}${boundConfig ? ` / ${boundConfig}` : ''}`
          : 'No Doppler environment selected.'}
      </Text>

      {phase === 'idle' ? (
        <Pressable
          style={({ pressed }) => [styles.bindingButton, pressed ? styles.rowPressed : null]}
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel={bound ? 'Change Doppler binding' : 'Choose Doppler binding'}
        >
          <Text style={styles.bindingButtonLabel}>{bound ? 'Change' : 'Choose'}</Text>
        </Pressable>
      ) : null}

      {loading ? <ActivityIndicator size="small" /> : null}
      {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      {notConfigured ? (
        <Text style={styles.bindingHint}>
          Set the Doppler account token in onboarding or global settings first, then choose a
          binding here.
        </Text>
      ) : null}

      {phase === 'projects' && !loading && !notConfigured ? (
        <View style={styles.bindingList} accessibilityLabel="Doppler projects">
          {projects.length === 0 ? (
            <Text style={styles.bindingHint}>No Doppler projects found for this account.</Text>
          ) : (
            projects.map((project) => (
              <Pressable
                key={project.slug}
                style={({ pressed }) => [styles.bindingRow, pressed ? styles.rowPressed : null]}
                onPress={() => pickProject(project.slug)}
                accessibilityRole="button"
                accessibilityLabel={`Doppler project ${project.name}`}
              >
                <Text style={styles.bindingRowText} numberOfLines={1}>
                  {project.name}
                </Text>
              </Pressable>
            ))
          )}
          <BindingCancel onPress={cancel} />
        </View>
      ) : null}

      {phase === 'configs' && !loading && !notConfigured ? (
        <View style={styles.bindingList} accessibilityLabel="Doppler configs">
          {configs.length === 0 ? (
            <Text style={styles.bindingHint}>No configs found for this project.</Text>
          ) : (
            configs.map((config) => (
              <Pressable
                key={config.name}
                style={({ pressed }) => [styles.bindingRow, pressed ? styles.rowPressed : null]}
                onPress={() => pickConfig(config.name)}
                accessibilityRole="button"
                accessibilityLabel={`Doppler config ${config.name}`}
              >
                <Text style={styles.bindingRowText} numberOfLines={1}>
                  {config.name}
                </Text>
              </Pressable>
            ))
          )}
          <BindingCancel onPress={cancel} />
        </View>
      ) : null}

      {bound ? (
        <Text style={styles.bindingHint}>
          Changing the environment applies to future brokered secret requests.
        </Text>
      ) : null}
    </View>
  );
}

// A shared "Cancel" affordance for the picker's project/config lists — returns to
// the idle (current-binding) view without changing anything.
function BindingCancel({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.bindingCancel, pressed ? styles.rowPressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Cancel Doppler binding"
    >
      <Text style={styles.bindingCancelLabel}>Cancel</Text>
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

function ProjectFields({ project }: { project: ProjectRecord }) {
  return (
    <View style={styles.projectFactsPanel}>
      <Field
        label="Repository"
        value={projectRepoRef(project) ?? 'Not connected to a GitHub repository'}
      />
      <Field label="Latest release" value={project.latestReleaseTag ?? 'No published release'} />
      <Field label="Created" value={formatDate(project.createdAt)} />
      <Field label="Updated" value={formatDate(project.updatedAt)} />
      {project.provisionError ? (
        <Field label="Provision error" value={project.provisionError} danger />
      ) : null}
      {/* `provisionWarning` deliberately does NOT appear here. It is rendered in
          the Environment panel above, beside the Start/Repair/Update actions
          that answer it — repeating it in this facts list put the same sentence
          on screen twice and moved it no closer to a remedy. */}
    </View>
  );
}

function Field({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <View style={styles.projectFactRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text
        style={danger ? styles.projectFactValueDanger : styles.projectFactValue}
        numberOfLines={3}
      >
        {value}
      </Text>
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  stateDot: {
    width: 12,
    height: 12,
    borderRadius: theme.radius.pill,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  ownerRepo: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  stateLabel: {
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
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
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  fieldLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  projectFactsPanel: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  projectFactRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  projectFactValue: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    textAlign: 'right',
  },
  projectFactValueDanger: {
    flex: 1,
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    textAlign: 'right',
  },
  settingsInputRow: {
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  settingsGroupHeader: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: theme.spacing.sm,
  },
  settingsGroupDescription: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  settingsFormGroup: {
    overflow: 'hidden',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
  bindingSection: {
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bindingCurrent: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  bindingButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  bindingButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  bindingList: {
    gap: theme.spacing.xs,
  },
  bindingRow: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  bindingRowText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  bindingCancel: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  bindingCancelLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  bindingHint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
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
  lifecyclePanel: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
  dangerPanel: {
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
  },
  deleteProjectButton: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
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
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  runtimeEmptyState: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  runtimeActionButton: {
    flex: 1,
  },
  runtimeHeaderActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
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
  runtimeNotice: {
    color: theme.colors.tone.attention,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  runtimeMetaValueMuted: {
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  runtimeLink: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
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
  runtimeTextButtonDisabled: {
    color: theme.colors.textFaint,
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
