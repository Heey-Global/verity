// Project automations.
import {
  VerityApiError,
  publishAgentLoopMutation,
  subscribeAgentLoopMutations,
  type VerityClient,
  type AgentLoop,
  type ProjectRecord,
} from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Icon } from '../Icon';
import { StatusPill } from '../StatusPill';
import { projectLifecycleState, projectSetupStatus } from '../../lib/projectSetup';
import { projectIdParam, useProjectDetail } from '../../lib/useProjectDetail';

export function ProjectToolsScreen({ mode }: { mode: 'automations' }) {
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
  return <ProjectDetailView client={client} projectId={projectId} mode={mode} />;
}

function ProjectDetailView({
  client,
  projectId,
  mode,
}: {
  client: VerityClient;
  projectId: string;
  mode: 'automations';
}) {
  const insets = useSafeAreaInsets();
  const { detail, loading, error, setError, load } = useProjectDetail(client, projectId);
  const [creatingLoop, setCreatingLoop] = useState(false);

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
      <Stack.Screen options={{ title: 'Automations' }} />
      {error ? <StaleBanner message={error} onRetry={() => load()} /> : null}
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
        {mode === 'automations' ? (
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
