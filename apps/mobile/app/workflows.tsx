import type { Workflow } from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createVerityClient } from '../lib/client';

export default function WorkflowsScreen() {
  const { theme } = useUnistyles();
  const client = useMemo(() => createVerityClient(), []);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    if (client === null) {
      setError('Verity is unavailable');
      setLoading(false);
      return;
    }
    setError(undefined);
    try {
      setWorkflows(await client.listWorkflows());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load workflows');
    } finally {
      setLoading(false);
    }
  }, [client]);
  const reportActionError = useCallback((caught: unknown) => {
    setError(caught instanceof Error ? caught.message : 'Workflow action failed');
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <ActivityIndicator style={styles.center} color={theme.colors.accent} />;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void reload()} />}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {workflows.length === 0 ? (
        <Text style={styles.empty}>No cross-project workflows yet.</Text>
      ) : (
        workflows.map((workflow) => (
          <View key={workflow.id} style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.title}>{workflow.objective}</Text>
              <Text style={styles.state}>{workflow.state.replaceAll('_', ' ')}</Text>
            </View>
            <Text style={styles.meta}>
              {workflow.serviceId} · {workflow.environment}
            </Text>
            <View style={styles.steps}>
              {workflow.steps.map((step) => (
                <View key={step.id} style={styles.step}>
                  <View
                    style={[styles.dot, step.state === 'completed' ? styles.dotComplete : null]}
                  />
                  <View style={styles.stepText}>
                    <Text style={styles.stepKind}>{step.kind}</Text>
                    <Text style={styles.stepState}>{step.state.replaceAll('_', ' ')}</Text>
                  </View>
                </View>
              ))}
            </View>
            {workflow.state === 'awaiting_authorization' ? (
              <Action
                label="Authorize workflow"
                onError={reportActionError}
                onPress={async () => {
                  await client?.authorizeWorkflow(workflow.id, workflow.version);
                  await reload();
                }}
              />
            ) : null}
            {workflow.state === 'running' &&
            workflow.steps.some((step) => step.state === 'ready') ? (
              <Action
                label="Dispatch ready step"
                onError={reportActionError}
                onPress={async () => {
                  const ready = workflow.steps.find((step) => step.state === 'ready');
                  if (ready === undefined) return;
                  await client?.dispatchWorkflowStep(workflow.id, ready.id, workflow.version);
                  await reload();
                }}
              />
            ) : null}
            {workflow.steps.some(
              (step) =>
                step.state === 'waiting_for_gate' && step.completionGate === 'user.decision',
            ) ? (
              <Action
                label="Approve merge transition"
                onError={reportActionError}
                onPress={async () => {
                  const decision = workflow.steps.find(
                    (step) =>
                      step.state === 'waiting_for_gate' && step.completionGate === 'user.decision',
                  );
                  if (decision === undefined) return;
                  await client?.approveWorkflowDecision(workflow.id, decision.id, workflow.version);
                  await reload();
                }}
              />
            ) : null}
            {workflow.steps.some(
              (step) =>
                step.state === 'waiting_for_gate' &&
                step.completionGate === 'oci.provenance_verified',
            ) ? (
              <ImageDigestAction
                workflowId={workflow.id}
                placeholderColor={theme.colors.textFaint}
                onError={reportActionError}
                onSubmit={async (digest) => {
                  await client?.recordWorkflowImage(workflow.id, digest, workflow.version);
                  await reload();
                }}
              />
            ) : null}
            {!['succeeded', 'failed', 'cancelled', 'rolled_back'].includes(workflow.state) ? (
              <Action
                label="Cancel"
                destructive
                onError={reportActionError}
                onPress={async () => {
                  await client?.cancelWorkflow(workflow.id);
                  await reload();
                }}
              />
            ) : null}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function ImageDigestAction({
  workflowId,
  placeholderColor,
  onSubmit,
  onError,
}: {
  workflowId: string;
  placeholderColor: string;
  onSubmit: (digest: string) => Promise<void>;
  onError: (caught: unknown) => void;
}) {
  const [imageDigest, setImageDigest] = useState('');
  return (
    <View key={workflowId} style={styles.digestRow}>
      <TextInput
        style={styles.digestInput}
        value={imageDigest}
        onChangeText={setImageDigest}
        placeholder="sha256:…"
        placeholderTextColor={placeholderColor}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Action
        label="Verify image"
        onError={onError}
        onPress={async () => {
          await onSubmit(imageDigest.trim());
          setImageDigest('');
        }}
      />
    </View>
  );
}

function Action({
  label,
  destructive = false,
  onPress,
  onError,
}: {
  label: string;
  destructive?: boolean;
  onPress: () => Promise<void>;
  onError: (caught: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      style={[styles.action, destructive ? styles.actionDestructive : null]}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        void onPress()
          .catch(onError)
          .finally(() => setBusy(false));
      }}
      accessibilityRole="button"
    >
      <Text style={styles.actionText}>{busy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1 },
  content: { padding: theme.spacing.md, gap: theme.spacing.md },
  error: { color: theme.colors.tone.danger },
  empty: { color: theme.colors.textMuted, textAlign: 'center', paddingTop: theme.spacing.xl },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  title: { color: theme.colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  state: { color: theme.colors.accent, fontSize: 12, textTransform: 'capitalize' },
  meta: { color: theme.colors.textMuted, fontSize: 12 },
  steps: { gap: 6, marginTop: theme.spacing.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.textFaint },
  dotComplete: { backgroundColor: theme.colors.tone.done },
  stepText: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  stepKind: { color: theme.colors.text, fontSize: 13 },
  stepState: { color: theme.colors.textMuted, fontSize: 12 },
  action: {
    backgroundColor: theme.colors.accent,
    borderRadius: 8,
    padding: theme.spacing.sm,
    alignItems: 'center',
  },
  actionDestructive: { backgroundColor: theme.colors.tone.danger },
  actionText: { color: theme.colors.background, fontWeight: '600' },
  digestRow: { gap: theme.spacing.sm },
  digestInput: {
    color: theme.colors.text,
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: theme.spacing.sm,
    fontFamily: 'monospace',
  },
}));
