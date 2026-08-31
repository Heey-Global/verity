import {
  type AgentLoop,
  type AgentLoopRun,
  type VerityClient,
  VerityApiError,
} from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusPill } from './StatusPill';

type Props = {
  client: VerityClient;
  loop: AgentLoop;
  visible: boolean;
  onClose: () => void;
  onEdit: () => void;
  onLoopChanged: (loop: AgentLoop) => void;
  sessionBusy: boolean;
};

export function AgentLoopCockpit({
  client,
  loop,
  visible,
  onClose,
  onEdit,
  onLoopChanged,
  sessionBusy,
}: Props) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [runs, setRuns] = useState<AgentLoopRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<'run' | 'status' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [freshLoop, freshRuns] = await Promise.all([
        client.getAgentLoop(loop.id),
        client.listAgentLoopRuns(loop.id),
      ]);
      onLoopChanged(freshLoop);
      setRuns(freshRuns);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load run history'));
    } finally {
      setLoading(false);
    }
  }, [client, loop.id, onLoopChanged]);

  useEffect(() => {
    if (visible) void loadRuns();
  }, [loadRuns, visible]);

  const runNow = useCallback(async () => {
    setWorking('run');
    setError(null);
    try {
      const response = await client.runAgentLoop(loop.id);
      onLoopChanged(response.loop);
      setRuns((current) => [response.run, ...current.filter((run) => run.id !== response.run.id)]);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not run Agent Loop'));
    } finally {
      setWorking(null);
    }
  }, [client, loop.id, onLoopChanged]);

  const changeStatus = useCallback(async () => {
    setWorking('status');
    setError(null);
    try {
      const updated = await client.updateAgentLoop(loop.id, {
        status: loop.status === 'enabled' ? 'paused' : 'enabled',
      });
      onLoopChanged(updated);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not update Agent Loop'));
    } finally {
      setWorking(null);
    }
  }, [client, loop.id, loop.status, onLoopChanged]);

  const status = useMemo(() => loopStatus(loop), [loop]);
  const tested = loop.testedScriptFingerprint !== null;
  const canToggle = loop.status !== 'draft' && tested;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.screen,
          { paddingTop: Math.max(insets.top, theme.spacing.lg), paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>AGENT LOOP</Text>
            <Text style={styles.title} numberOfLines={1}>
              {loop.name}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close Loop cockpit"
            style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.closeButtonText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <StatusPill intent={status.intent} label={status.label} />
              <Text style={styles.schedule}>{scheduleLabel(loop)}</Text>
            </View>
            <View style={styles.metrics}>
              <Metric label="Next run" value={dateLabel(loop.nextRunAt, 'Not scheduled')} />
              <Metric label="Last run" value={dateLabel(loop.lastRunAt, 'Never')} />
              <Metric label="Last result" value={outcomeLabel(loop.lastOutcome)} />
            </View>
            {loop.consecutiveErrorCount > 0 ? (
              <View style={styles.warning}>
                <Text style={styles.warningText}>
                  ! {loop.consecutiveErrorCount}/5 consecutive failures. The loop pauses
                  automatically at 5.
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.actions}>
            <ActionButton
              label={working === 'run' ? 'Running…' : 'Run now'}
              primary
              disabled={!tested || loading || working !== null}
              loading={working === 'run'}
              onPress={() => void runNow()}
            />
            <ActionButton
              label={loop.status === 'enabled' ? 'Pause' : 'Resume'}
              disabled={!canToggle || loading || working !== null}
              loading={working === 'status'}
              onPress={() => void changeStatus()}
            />
            <ActionButton
              label="Edit"
              disabled={loading || working !== null || sessionBusy}
              onPress={() => {
                onClose();
                onEdit();
              }}
            />
          </View>
          {!tested ? (
            <Text style={styles.hint}>Confirm and test the current config before running it.</Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.historyHeader}>
            <Text style={styles.sectionTitle}>Run history</Text>
            <Pressable
              onPress={() => void loadRuns()}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Refresh Agent Loop run history"
            >
              <Text style={styles.refresh}>{loading ? 'Refreshing…' : 'Refresh'}</Text>
            </Pressable>
          </View>
          {loading && runs.length === 0 ? <ActivityIndicator /> : null}
          {!loading && runs.length === 0 ? <Text style={styles.empty}>No runs yet.</Text> : null}
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  primary,
  disabled,
  loading,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.action,
        primary ? styles.actionPrimary : null,
        disabled ? styles.actionDisabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {loading ? <ActivityIndicator size="small" /> : null}
      <Text style={primary ? styles.actionPrimaryText : styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function RunRow({ run }: { run: AgentLoopRun }) {
  const duration = run.finishedAt
    ? Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
    : null;
  return (
    <View style={styles.runRow}>
      <View style={styles.runTopRow}>
        <View style={styles.runIdentity}>
          <Text style={styles.runOutcome}>
            {run.finishedAt ? outcomeLabel(run.outcome) : 'Running'}
          </Text>
          {run.isTest ? <Text style={styles.testLabel}>TEST</Text> : null}
        </View>
        <Text style={styles.runTime}>{dateLabel(run.startedAt, '')}</Text>
      </View>
      <Text style={styles.runMeta}>
        {duration === null ? 'Running' : durationLabel(duration)}
        {run.exitCode === null ? '' : ` · Exit ${String(run.exitCode)}`}
      </Text>
      {run.detail ? <Text style={styles.runDetail}>{run.detail}</Text> : null}
    </View>
  );
}

function loopStatus(loop: AgentLoop): {
  label: string;
  intent: 'ready' | 'needsSetup' | 'optional';
} {
  if (loop.status === 'enabled') return { label: 'Active', intent: 'ready' };
  if (loop.status === 'draft') return { label: 'Needs setup', intent: 'needsSetup' };
  return { label: 'Paused', intent: 'optional' };
}

function scheduleLabel(loop: AgentLoop): string {
  if (!loop.schedule) return 'Schedule not set';
  if (loop.schedule.kind === 'interval') {
    return `Every ${String(loop.schedule.everyMinutes)} minutes`;
  }
  const time = `${String(loop.schedule.hour).padStart(2, '0')}:${String(loop.schedule.minute).padStart(2, '0')}`;
  if (loop.schedule.kind === 'daily') return `Daily at ${time}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[loop.schedule.weekday] ?? 'Weekly'} at ${time}`;
}

function outcomeLabel(outcome: AgentLoop['lastOutcome']): string {
  if (outcome === 'acted') return 'Agent started';
  if (outcome === 'ok') return 'No action';
  if (outcome === 'error') return 'Failed';
  if (outcome === 'skipped') return 'Skipped';
  return '—';
}

function dateLabel(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function durationLabel(ms: number): string {
  if (ms < 1_000) return `${String(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof VerityApiError || error instanceof Error ? error.message : fallback;
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerText: { flex: 1 },
  eyebrow: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '800' },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '800' },
  closeButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.md },
  closeButtonText: { color: theme.colors.primary, fontSize: theme.text.md, fontWeight: '700' },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  summaryCard: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  schedule: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  metrics: { flexDirection: 'row', gap: theme.spacing.sm },
  metric: { flex: 1, gap: theme.spacing.xs },
  metricLabel: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '700' },
  metricValue: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  warning: {
    borderRadius: theme.radius.md,
    backgroundColor: `${theme.colors.tone.danger}1f`,
    padding: theme.spacing.md,
  },
  warningText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  action: {
    minHeight: 46,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionPrimary: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  actionDisabled: { opacity: 0.45 },
  actionText: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  actionPrimaryText: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '800' },
  hint: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  historyHeader: {
    marginTop: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '800' },
  refresh: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  empty: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  runRow: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  runTopRow: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md },
  runIdentity: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  runOutcome: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '800' },
  testLabel: { color: theme.colors.primary, fontSize: theme.text.micro, fontWeight: '900' },
  runTime: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  runMeta: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  runDetail: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  pressed: { opacity: 0.7 },
}));
