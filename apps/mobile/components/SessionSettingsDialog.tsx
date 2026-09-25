import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
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
  linkableSessions = [],
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
  linkableSessions?: readonly {
    id: string;
    name: string;
    projectId: string;
    projectName: string;
  }[];
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
  const [links, setLinks] = useState<Awaited<ReturnType<VerityClient['listSessionLinks']>>>([]);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkProjectId, setLinkProjectId] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const unlinkedSessions = linkableSessions.filter(
    (item) => !links.some((link) => link.sessionId === item.id),
  );
  useEffect(() => {
    let active = true;
    void client
      .listSessionLinks(sessionId)
      .then((items) => {
        if (active) setLinks(items);
      })
      .catch(() => {
        if (active) setLinkError('Linked sessions could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [client, sessionId]);
  const addLink = async (targetId: string) => {
    setLinkBusy(true);
    setLinkError(undefined);
    try {
      await client.linkSessions(sessionId, targetId);
      setLinks(await client.listSessionLinks(sessionId));
      setLinkPickerOpen(false);
      setLinkProjectId(null);
    } catch (error) {
      setLinkError(
        error instanceof VerityApiError && error.status < 500
          ? `Could not link the sessions: ${error.message}.`
          : 'Could not link the sessions. Please try again.',
      );
    } finally {
      setLinkBusy(false);
    }
  };
  const removeLink = async (targetId: string) => {
    setLinkBusy(true);
    setLinkError(undefined);
    try {
      await client.unlinkSessions(sessionId, targetId);
      setLinks((current) => current.filter((link) => link.sessionId !== targetId));
    } catch {
      setLinkError('Could not disconnect the sessions. Please try again.');
    } finally {
      setLinkBusy(false);
    }
  };
  const willMove = unresolved || (target !== null && target !== projectId);
  const canSave =
    !busy &&
    !linkBusy &&
    (!willMove || (canMove && !!target && (!commitConfirmation || leaveCommits)));
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
      const input: MoveInput = pending.get(sessionId) ?? {
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
    if (!busy && !linkBusy) onClose();
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
      disabled={busy || linkBusy}
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
        <View style={styles.backdrop}>
          {/* A sibling behind the card, not its parent: a Pressable card would take
              every touch that starts on text inside it, so the body could not scroll. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityLabel="Dismiss session settings"
          />
          <View style={styles.card} testID="session-settings-card">
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
                disabled={busy || linkBusy}
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
                  <Text style={styles.sectionTitle} accessibilityRole="header">
                    Details
                  </Text>
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
                            accessibilityState={{
                              selected: target === project.id,
                              disabled: busy || unresolved || !canMove,
                            }}
                            disabled={busy || unresolved || !canMove}
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
                      accessibilityState={{ checked: leaveCommits, disabled: busy || unresolved }}
                      disabled={busy || unresolved}
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
                  <View style={styles.sectionDivider} />
                  <Text style={styles.sectionTitle} accessibilityRole="header">
                    Linked sessions
                  </Text>
                  <Text style={styles.hint}>
                    Linked agents can share messages across projects, including information they can
                    access there. Disconnecting stops future messages; it cannot remove messages
                    already delivered.
                  </Text>
                  {links.length === 0 ? (
                    <Text style={styles.hint}>No sessions linked yet.</Text>
                  ) : (
                    links.map((link) => (
                      <View key={link.sessionId} style={styles.linkRow}>
                        <Icon name="link" size={17} color={theme.colors.primary} />
                        <View style={styles.linkLabel}>
                          <Text style={styles.optionText} numberOfLines={1}>
                            {link.name ?? link.sessionId}
                          </Text>
                          <Text style={styles.hint} numberOfLines={1}>
                            {link.projectName}
                          </Text>
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Disconnect ${link.name ?? link.sessionId}`}
                          disabled={linkBusy || busy || unresolved || willMove}
                          onPress={() => void removeLink(link.sessionId)}
                          style={styles.linkRemove}
                        >
                          <Icon name="x" size={18} color={theme.colors.textMuted} />
                        </Pressable>
                      </View>
                    ))
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      links.length === 0 ? 'Link a session' : 'Link another session'
                    }
                    disabled={linkBusy || busy || unresolved || willMove}
                    onPress={() => setLinkPickerOpen((open) => !open)}
                    style={styles.linkAction}
                  >
                    <Icon name="plus" size={18} color={theme.colors.primary} />
                    <Text style={styles.linkActionText}>
                      {links.length === 0 ? 'Link a session' : 'Link another session'}
                    </Text>
                    <Icon
                      name={linkPickerOpen ? 'chevron-up' : 'chevron-right'}
                      size={18}
                      color={theme.colors.textFaint}
                    />
                  </Pressable>
                  {linkError ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {linkError}
                    </Text>
                  ) : null}
                  {willMove ? (
                    <Text style={styles.hint}>
                      Save the project change before linking sessions.
                    </Text>
                  ) : null}
                  {linkPickerOpen ? (
                    <View style={styles.linkPicker}>
                      {linkProjectId === null ? (
                        <>
                          <Text style={styles.hint}>Choose a project</Text>
                          {[
                            ...new Map(
                              unlinkedSessions.map((item) => [item.projectId, item.projectName]),
                            ).entries(),
                          ].map(([id, name]) => (
                            <Pressable
                              key={id}
                              accessibilityRole="button"
                              accessibilityLabel={`Choose ${name}`}
                              style={styles.option}
                              onPress={() => setLinkProjectId(id)}
                            >
                              <Icon name="folder" size={16} color={theme.colors.textMuted} />
                              <Text style={styles.optionText}>{name}</Text>
                              <Icon name="chevron-right" size={16} color={theme.colors.textFaint} />
                            </Pressable>
                          ))}
                          {unlinkedSessions.length === 0 ? (
                            <Text style={styles.hint}>No more project sessions available.</Text>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Back to projects"
                            style={styles.option}
                            onPress={() => setLinkProjectId(null)}
                          >
                            <Icon name="chevron-left" size={16} color={theme.colors.textMuted} />
                            <Text style={styles.optionText}>Choose another project</Text>
                          </Pressable>
                          {unlinkedSessions
                            .filter((item) => item.projectId === linkProjectId)
                            .map((item) => (
                              <Pressable
                                key={item.id}
                                accessibilityRole="button"
                                accessibilityLabel={`Link ${item.name}`}
                                disabled={linkBusy || busy || unresolved || willMove}
                                style={styles.option}
                                onPress={() => void addLink(item.id)}
                              >
                                <Icon name="link" size={16} color={theme.colors.primary} />
                                <Text style={styles.optionText}>{item.name}</Text>
                              </Pressable>
                            ))}
                        </>
                      )}
                    </View>
                  ) : null}
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
          </View>
        </View>
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
    sectionTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
    sectionDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border,
      marginVertical: 4,
    },
    linkRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.background,
    },
    linkLabel: { flex: 1, gap: 2 },
    linkRemove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    linkAction: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceAlt,
    },
    linkActionText: {
      flex: 1,
      color: theme.colors.text,
      fontSize: theme.text.sm,
      fontWeight: '600',
    },
    linkPicker: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      padding: 8,
      gap: 4,
    },
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
