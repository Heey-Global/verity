import { useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  useWindowDimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Icon } from './Icon';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { VerityApiError, type VerityClient } from '@verity/mobile';

type MoveInput = Parameters<VerityClient['moveSession']>[1];
// Keep ambiguous requests through dialog unmounts, scoped to the connected client.
const pendingMoves = new WeakMap<VerityClient, Map<string, MoveInput>>();

type MoveResult = Awaited<ReturnType<VerityClient['moveSession']>>;
export function SessionSettingsDialog({
  sessionId,
  sessionName,
  displayName,
  projectId,
  projectName,
  canMove,
  moveDisabledReason,
  projects,
  client,
  onClose,
  onChanged,
  onDelete,
}: {
  sessionId: string;
  sessionName: string | null;
  displayName: string;
  projectId: string | null;
  projectName: string;
  canMove: boolean;
  moveDisabledReason?: string;
  projects: readonly { id: string; name: string }[];
  client: VerityClient;
  onClose: () => void;
  onChanged: (moved: boolean) => void;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  const styles = createStyles(theme);
  const compact = useWindowDimensions().width < 480 || theme.fontScale > 1.2;
  const [draftName, setDraftName] = useState(sessionName ?? '');
  const [savedName, setSavedName] = useState(sessionName);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = pendingMoves.get(client) ?? new Map<string, MoveInput>();
  pendingMoves.set(client, pending);
  const previous = pending.get(sessionId);
  const [unresolved, setUnresolved] = useState(previous !== undefined);
  const [target, setTarget] = useState<string | null>(previous?.project ?? projectId);
  const [operationId, setOperationId] = useState(() => previous?.operationId ?? randomUUID());
  const [leaveCommits, setLeaveCommits] = useState(previous?.onCommits === 'leave');
  const [commitConfirmation, setCommitConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<MoveResult>();
  const willMove = unresolved || (target !== null && target !== projectId);
  const canSave =
    !busy && (!willMove || (canMove && !!target && (!commitConfirmation || leaveCommits)));
  const save = async () => {
    if (!canSave) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(undefined);
    let step: 'rename' | 'move' = 'rename';
    try {
      const name = draftName.trim() || null;
      if (name !== savedName) {
        await client.renameSession(sessionId, name);
        setSavedName(name);
        onChanged(false);
      }
      if (!willMove || !target) {
        onClose();
        return;
      }
      step = 'move';
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
      onChanged(true);
    } catch (cause) {
      if (
        cause instanceof VerityApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408 &&
        cause.code !== 'busy'
      ) {
        pending.delete(sessionId);
        setUnresolved(false);
      }
      setError(
        step === 'move'
          ? moveErrorMessage(cause)
          : 'The session name could not be saved. Please try again.',
      );
      setCommitConfirmation(cause instanceof VerityApiError && cause.code === 'source_commits');
    } finally {
      setBusy(false);
    }
  };
  const targetName =
    target === projectId
      ? projectName
      : (projects.find((project) => project.id === target)?.name ?? target);
  const close = () => {
    if (!busy) onClose();
  };
  const deleteButton = !result && (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Delete session"
      disabled={busy || unresolved}
      onPress={onDelete}
      style={[styles.button, styles.deleteButton, (busy || unresolved) && styles.disabled]}
    >
      <Text style={styles.deleteText}>Delete</Text>
    </Pressable>
  );
  const cancelButton = !result && (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={close}
      style={[styles.button, busy && styles.disabled]}
    >
      <Text style={styles.cancelText}>Cancel</Text>
    </Pressable>
  );
  const primaryButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        result ? 'Done' : unresolved ? 'Retry move' : willMove ? 'Save and move' : 'Save'
      }
      disabled={!result && !canSave}
      onPress={
        result
          ? close
          : () => {
              void save();
            }
      }
      style={[styles.button, styles.primary, !result && !canSave && styles.disabled]}
    >
      {busy && <ActivityIndicator size="small" color={theme.colors.accent} />}
      <Text style={styles.primaryText}>
        {result
          ? 'Done'
          : busy
            ? 'Saving…'
            : unresolved
              ? 'Retry move'
              : willMove
                ? 'Save and move'
                : 'Save'}
      </Text>
    </Pressable>
  );

  return (
    <Modal transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityLabel="Dismiss session settings"
        >
          <Pressable style={styles.card} onPress={() => undefined} testID="session-settings-card">
            <View style={styles.header}>
              <View style={styles.heading}>
                <Text style={styles.title}>{result ? 'Session moved' : 'Session settings'}</Text>
                {displayName ? (
                  <Text style={styles.subtitle} numberOfLines={2}>
                    {displayName}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close session settings"
                disabled={busy}
                onPress={close}
                style={styles.close}
              >
                <Icon name="x" size={20} color={theme.colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
            >
              {result ? (
                <>
                  <Text style={styles.description}>
                    Moved to {targetName}. Your conversation is ready to continue there.
                  </Text>
                  <Text style={styles.hint}>
                    The original workspace is kept in the source project for recovery.
                  </Text>
                  {result.skipped.length > 0 && (
                    <Text style={styles.hint}>Not copied: {result.skipped.join(', ')}</Text>
                  )}
                </>
              ) : (
                <>
                  <View style={styles.field}>
                    <Text style={styles.label}>Name</Text>
                    <TextInput
                      accessibilityLabel="Session name"
                      value={draftName}
                      onChangeText={setDraftName}
                      editable={!busy && !unresolved}
                      maxLength={80}
                      placeholder={displayName}
                      placeholderTextColor={theme.colors.textFaint}
                      style={styles.nameInput}
                      returnKeyType="done"
                      onSubmitEditing={() => {
                        void save();
                      }}
                    />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>Project</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Project"
                      accessibilityValue={{ text: targetName ?? 'Choose a project' }}
                      accessibilityState={{
                        expanded: pickerOpen,
                        disabled: busy || unresolved || !canMove || projects.length === 0,
                      }}
                      disabled={busy || unresolved || !canMove || projects.length === 0}
                      onPress={() => setPickerOpen((open) => !open)}
                      style={[styles.select, (busy || unresolved || !canMove) && styles.disabled]}
                    >
                      <Text
                        style={[styles.selectText, !target && styles.placeholder]}
                        numberOfLines={1}
                      >
                        {targetName ?? 'Choose a project'}
                      </Text>
                      <Icon
                        name={pickerOpen ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={theme.colors.textMuted}
                      />
                    </Pressable>
                    {pickerOpen && (
                      <ScrollView
                        style={styles.options}
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                      >
                        {[
                          { id: projectId, name: projectName },
                          ...projects.filter((project) => project.id !== projectId),
                        ].map((project) => (
                          <Pressable
                            key={project.id}
                            accessibilityRole="button"
                            accessibilityLabel={project.name}
                            accessibilityState={{ selected: target === project.id }}
                            style={[styles.option, target === project.id && styles.selected]}
                            onPress={() => {
                              setTarget(project.id);
                              setOperationId(randomUUID());
                              setLeaveCommits(false);
                              setCommitConfirmation(false);
                              setError(undefined);
                              setPickerOpen(false);
                            }}
                          >
                            <Icon name="folder" size={16} color={theme.colors.textMuted} />
                            <Text style={styles.optionText}>{project.name}</Text>
                            {target === project.id && (
                              <Icon name="check" size={16} color={theme.colors.accent} />
                            )}
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                  </View>
                  {!canMove && (
                    <Text style={styles.hint}>
                      {moveDisabledReason ??
                        'Moving is available for idle sessions in local projects.'}
                    </Text>
                  )}
                  {error && (
                    <View style={styles.errorBox}>
                      <Text accessibilityRole="alert" style={styles.error}>
                        {error}
                      </Text>
                    </View>
                  )}
                  {unresolved && !busy && (
                    <Text style={styles.hint}>
                      Retry to check whether the move finished. Your selected project is kept until
                      the result is confirmed.
                    </Text>
                  )}
                  {commitConfirmation && (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel="Leave commits in source project"
                      accessibilityState={{ checked: leaveCommits }}
                      onPress={() => {
                        setLeaveCommits((value) => !value);
                        setOperationId(randomUUID());
                      }}
                      style={styles.confirm}
                    >
                      <Icon
                        name={leaveCommits ? 'check-square' : 'square'}
                        size={20}
                        color={theme.colors.accent}
                      />
                      <Text style={styles.optionText}>
                        Leave committed changes in the source project
                      </Text>
                    </Pressable>
                  )}
                  {willMove && (
                    <Text style={styles.hint}>
                      Your conversation and uncommitted files move with you. Committed changes stay
                      in the original project.
                    </Text>
                  )}
                </>
              )}
            </ScrollView>
            <View style={[styles.footer, compact && styles.compactFooter]}>
              {compact ? (
                <>
                  {!result && (
                    <View style={styles.compactActions}>
                      {deleteButton}
                      {cancelButton}
                    </View>
                  )}
                  {primaryButton}
                </>
              ) : (
                <>
                  {deleteButton}
                  <View style={styles.footerRight}>
                    {cancelButton}
                    {primaryButton}
                  </View>
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function moveErrorMessage(cause: unknown): string {
  if (cause instanceof VerityApiError) {
    if (cause.status === 404) {
      return cause.code === 'not_found'
        ? 'This session no longer exists. Close this dialog and refresh your session list.'
        : 'The server could not find the move endpoint. Update the Verity server, then try again.';
    }
    if (cause.code === 'busy')
      return 'This session or project is busy. Wait for the current operation to finish, then retry.';
    if (cause.code === 'source_commits')
      return 'This session has committed changes that will stay in the source project. Confirm below to continue.';
  }
  if (
    cause instanceof Error &&
    cause.message.trim() &&
    !/^(unknown|unknown error|not found)$/i.test(cause.message.trim())
  )
    return cause.message;
  return 'The move could not be confirmed. Retry to check its result; your original workspace is kept.';
}

// Use React Native styles here: the Unistyles transform currently covers app/ only.
const createStyles = (theme: ReturnType<typeof useUnistyles>['theme']) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
      backgroundColor: 'rgba(0,0,0,0.66)',
    },
    card: {
      width: '100%',
      maxWidth: 440,
      maxHeight: '90%',
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      overflow: 'hidden',
    },
    header: { flexDirection: 'row', alignItems: 'flex-start', padding: 20, gap: 12 },
    heading: { flex: 1, gap: 4 },
    title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
    subtitle: { color: theme.colors.textMuted, fontSize: theme.text.sm },
    close: {
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: -10,
      marginRight: -10,
    },
    body: { flexGrow: 0, flexShrink: 1 },
    content: { paddingHorizontal: 20, paddingBottom: 20, gap: 16 },
    description: {
      color: theme.colors.textMuted,
      fontSize: theme.text.sm,
      lineHeight: 21 * theme.fontScale,
    },
    hint: {
      color: theme.colors.textMuted,
      fontSize: theme.text.xs,
      lineHeight: 18 * theme.fontScale,
    },
    field: { gap: 8 },
    nameInput: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: theme.colors.background,
      color: theme.colors.text,
      fontSize: theme.text.md,
    },
    compactFooter: { flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' },
    compactActions: { flexShrink: 0, flexDirection: 'row', justifyContent: 'space-between' },
    footerRight: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: 4,
      flex: 1,
    },
    deleteButton: { paddingHorizontal: 4 },
    deleteText: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '600' },
    label: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
    select: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.background,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectText: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
    placeholder: { color: theme.colors.textFaint },
    options: {
      maxHeight: 208,
      flexGrow: 0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
    },
    option: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
    selected: { backgroundColor: theme.colors.surfaceAlt },
    optionText: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm },
    errorBox: { borderLeftWidth: 2, borderLeftColor: theme.colors.tone.danger, paddingLeft: 12 },
    error: {
      color: theme.colors.tone.danger,
      fontSize: theme.text.sm,
      lineHeight: 21 * theme.fontScale,
    },
    confirm: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
    footer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: 8,
      padding: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    button: {
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: theme.radius.pill,
    },
    primary: {
      backgroundColor: `${theme.colors.accent}24`,
      borderWidth: 1,
      borderColor: theme.colors.accent,
    },
    primaryText: { color: theme.colors.accent, fontSize: theme.text.md, fontWeight: '700' },
    cancelText: { color: theme.colors.textMuted, fontSize: theme.text.md, fontWeight: '600' },
    disabled: { opacity: 0.45 },
  });
