import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { VerityApiError, type VerityClient } from '@verity/mobile';

type MoveInput = Parameters<VerityClient['moveSession']>[1];
// Keep ambiguous requests through dialog unmounts, scoped to the connected client.
const pendingMoves = new WeakMap<VerityClient, Map<string, MoveInput>>();

type MoveResult = Awaited<ReturnType<VerityClient['moveSession']>>;
export function MoveSessionDialog({
  sessionId,
  projects,
  client,
  onClose,
  onMoved,
}: {
  sessionId: string;
  projects: readonly { id: string; name: string }[];
  client: VerityClient;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { theme } = useUnistyles();
  const pending = pendingMoves.get(client) ?? new Map<string, MoveInput>();
  pendingMoves.set(client, pending);
  const previous = pending.get(sessionId);
  const [unresolved, setUnresolved] = useState(previous !== undefined);
  const [target, setTarget] = useState<string | undefined>(previous?.project);
  const [operationId, setOperationId] = useState(() => previous?.operationId ?? randomUUID());
  const [leaveCommits, setLeaveCommits] = useState(previous?.onCommits === 'leave');
  const [commitConfirmation, setCommitConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<MoveResult>();
  const move = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const input: MoveInput = {
        project: target,
        operationId,
        onCommits: leaveCommits ? 'leave' : 'block',
      };
      pending.set(sessionId, input);
      setUnresolved(true);
      const moved = await client.moveSession(sessionId, input);
      pending.delete(sessionId);
      setUnresolved(false);
      setResult(moved);
      onMoved();
    } catch (cause) {
      if (
        cause instanceof VerityApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408
      ) {
        pending.delete(sessionId);
        setUnresolved(false);
      }
      setError(
        cause instanceof Error ? cause.message : 'Move failed. Retry to reconcile the result.',
      );
      setCommitConfirmation(cause instanceof VerityApiError && cause.code === 'source_commits');
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{ padding: 12, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: theme.colors.text }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0008' }}>
        <ScrollView
          style={{ maxHeight: '80%', backgroundColor: theme.colors.background, borderRadius: 12 }}
          contentContainerStyle={{ padding: 16 }}
        >
          <Text style={{ color: theme.colors.text, fontSize: 20 }}>Move to project</Text>
          {result ? (
            <>
              <Text style={{ color: theme.colors.text }}>
                Session moved. Chat history is preserved. Source files and commits remain available
                at {result.retainedWorktree}.
              </Text>
              {result.skipped.length > 0 && (
                <Text style={{ color: theme.colors.text }}>
                  Not copied: {result.skipped.join(', ')}
                </Text>
              )}
              {button('Done', onClose)}
            </>
          ) : (
            <>
              <Text style={{ color: theme.colors.text }}>
                Your chat stays intact. Uncommitted work is copied and the agent continues with the
                usual history handoff.
              </Text>
              {projects.length === 0 && (
                <Text style={{ color: theme.colors.text }}>
                  Create another local project before moving this session.
                </Text>
              )}
              {projects.map((project) => (
                <View key={project.id}>
                  {button(
                    `${target === project.id ? '✓ ' : ''}${project.name}`,
                    () => {
                      setTarget(project.id);
                      setOperationId(randomUUID());
                      setLeaveCommits(false);
                      setCommitConfirmation(false);
                      setError(undefined);
                    },
                    busy || unresolved || target === project.id,
                  )}
                </View>
              ))}
              {unresolved && !busy && (
                <Text style={{ color: theme.colors.text }}>
                  Retry the pending move to confirm its result before choosing another project.
                </Text>
              )}
              {error && (
                <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>
                  {error}
                </Text>
              )}
              {commitConfirmation &&
                button(
                  'Leave commits in source project',
                  () => {
                    setLeaveCommits(true);
                    setCommitConfirmation(false);
                    setOperationId(randomUUID());
                    setError(undefined);
                  },
                  busy,
                )}
              {button(
                busy ? 'Moving…' : leaveCommits ? 'Move and leave commits' : 'Move',
                () => {
                  void move();
                },
                !target || busy || commitConfirmation,
              )}
              {button('Cancel', onClose, busy)}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
