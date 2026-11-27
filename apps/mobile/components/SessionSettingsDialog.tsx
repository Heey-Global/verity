import { useEffect, useRef, useState } from 'react';
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
import { tint } from './ui/tint';

type MoveInput = Parameters<VerityClient['moveSession']>[1];
// Keep ambiguous requests through dialog unmounts, scoped to the connected client.
const pendingMoves = new WeakMap<VerityClient, Map<string, MoveInput>>();
// Row height of a project option; the floating list sizes itself from it.
const optionHeight = 48;

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
  // Where the project select sits inside the card, so its options can float over
  // the rest of the dialog instead of pushing it down.
  const [pickerAnchor, setPickerAnchor] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    cardHeight: number;
  }>();
  const cardRef = useRef<View>(null);
  const selectRef = useRef<View>(null);
  // A pending wait for the keyboard to hide; dropped whenever the list closes so
  // a late event cannot measure a closed picker or an unmounted card.
  const keyboardWait = useRef<() => void>(undefined);
  const stopKeyboardWait = () => {
    keyboardWait.current?.();
    keyboardWait.current = undefined;
  };
  useEffect(() => stopKeyboardWait, []);
  const closePicker = () => {
    stopKeyboardWait();
    setPickerOpen(false);
  };
  const measurePicker = () => {
    const card = cardRef.current;
    if (!card) return;
    // Measure the select and the card together, after any layout change, so the
    // list neither opens from a stale spot nor flips on an outdated card height.
    // A failed measurement closes the list rather than leaving it invisible.
    selectRef.current?.measureLayout(
      card,
      (x, y, w, h) =>
        card.measure((_left, _top, _width, cardHeight) =>
          setPickerAnchor({ x, y, w, h, cardHeight }),
        ),
      closePicker,
    );
  };
  const togglePicker = () => {
    if (pickerOpen) {
      closePicker();
      return;
    }
    // The list stays invisible and untouchable until measured, so it never
    // flashes at a guess or takes a tap on an option nobody could see.
    setPickerAnchor(undefined);
    setPickerOpen(true);
    if (!Keyboard.isVisible()) {
      measurePicker();
      return;
    }
    // Hiding the keyboard resizes the card; measure once it has settled. The
    // timeout covers a hide event that never arrives.
    const settle = () => {
      stopKeyboardWait();
      requestAnimationFrame(measurePicker);
    };
    const hidden = Keyboard.addListener('keyboardDidHide', settle);
    const fallback = setTimeout(settle, 400);
    keyboardWait.current = () => {
      hidden.remove();
      clearTimeout(fallback);
    };
    Keyboard.dismiss();
  };
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
  const [nameFocused, setNameFocused] = useState(false);
  const willMove = unresolved || (target !== null && target !== projectId);
  const canSave =
    !busy &&
    (draftName.trim() !== (savedName ?? '') || willMove) &&
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
      <Icon name="trash-2" size={16} color={theme.colors.attention} />
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
      {busy && <ActivityIndicator size="small" color={theme.colors.onAction} />}
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

  const settingsView = (
    <>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.title}>{result ? 'Session moved' : 'Session settings'}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close session settings"
          disabled={busy}
          onPress={close}
          style={styles.iconButton}
        >
          <Icon name="x" size={18} color={theme.colors.textMuted} />
        </Pressable>
      </View>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        // The floating project list is anchored to where the select was measured.
        onScrollBeginDrag={closePicker}
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
                placeholderTextColor={theme.colors.textMuted}
                style={[styles.nameInput, nameFocused && styles.inputFocused]}
                onFocus={() => setNameFocused(true)}
                onBlur={() => setNameFocused(false)}
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
                onPress={togglePicker}
                ref={selectRef}
                style={[styles.select, (busy || unresolved || !canMove) && styles.disabled]}
              >
                <Icon name="folder" size={16} color={theme.colors.textMuted} />
                <Text style={[styles.selectText, !target && styles.placeholder]} numberOfLines={1}>
                  {targetName ?? 'Choose a project'}
                </Text>
                <Icon
                  name={!canMove ? 'lock' : pickerOpen ? 'chevron-up' : 'chevron-down'}
                  size={!canMove ? 15 : 18}
                  color={theme.colors.textMuted}
                />
              </Pressable>
            </View>
            {!canMove && (
              <Text style={styles.hint}>
                {moveDisabledReason ?? 'Moving is available for idle sessions in local projects.'}
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
                Retry to check whether the move finished. Your selected project is kept until the
                result is confirmed.
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
                  color={theme.colors.signature}
                />
                <Text style={styles.optionText}>Leave committed changes in the source project</Text>
              </Pressable>
            )}
            {willMove && (
              <Text style={styles.hint}>
                Your conversation and uncommitted files move with you. Committed changes stay in the
                original project.
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
    </>
  );
  const projectOptions = [
    { id: projectId, name: projectName },
    ...projects.filter((project) => project.id !== projectId),
  ];
  // Open downwards when the list fits below the select, otherwise towards the
  // side with more room — the same choice a native menu makes near an edge.
  const listHeight = Math.min(projectOptions.length * optionHeight + 10, 250);
  const listPosition = (() => {
    if (!pickerAnchor)
      return { left: 20, right: 20, top: 0, opacity: 0, pointerEvents: 'none' as const };
    const { x, y, w, h, cardHeight } = pickerAnchor;
    const below = Math.max(cardHeight - (y + h) - 12, 0);
    const above = Math.max(y - 12, 0);
    return below >= listHeight || below >= above
      ? { left: x, width: w, top: y + h + 6, maxHeight: Math.min(listHeight, below) }
      : { left: x, width: w, bottom: cardHeight - y + 6, maxHeight: Math.min(listHeight, above) };
  })();

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
          <View
            ref={cardRef}
            style={styles.card}
            testID="session-settings-card"
            onLayout={() => {
              // A hint, an error or rotation moves the select under an open list.
              if (pickerOpen) measurePicker();
            }}
          >
            <View style={styles.pane}>{settingsView}</View>
            {pickerOpen && !result ? (
              <>
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={closePicker}
                  accessibilityRole="button"
                  accessibilityLabel="Close project list"
                />
                <View testID="project-options" style={[styles.options, listPosition]}>
                  <ScrollView
                    style={styles.optionsClip}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  >
                    {projectOptions.map((project) => (
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
                          closePicker();
                        }}
                      >
                        <Icon name="folder" size={16} color={theme.colors.textMuted} />
                        <Text style={styles.optionText}>{project.name}</Text>
                        {target === project.id && (
                          <Icon name="check" size={16} color={theme.colors.signature} />
                        )}
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              </>
            ) : null}
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
      backgroundColor: theme.colors.scrim,
    },
    card: {
      width: '100%',
      maxWidth: 440,
      maxHeight: '90%',
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: tint(theme.colors.signature, 'ring'),
      overflow: 'hidden',
      // A faint accent halo lifts the card off the dimmed app (iOS; Android has no
      // coloured shadow and keeps the border alone).
      shadowColor: theme.colors.signature,
      shadowOpacity: 0.16,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 8 },
    },
    pane: { flexShrink: 1 },
    header: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 16, gap: 12 },
    heading: { flex: 1, gap: 3 },
    title: {
      color: theme.colors.text,
      fontSize: theme.typography.title.fontSize,
      fontFamily: theme.fonts.bold,
    },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surfaceAlt,
    },
    body: { flexGrow: 0, flexShrink: 1 },
    content: { paddingHorizontal: 20, paddingBottom: 20, gap: 14 },
    description: {
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 20 * theme.fontScale,
    },
    hint: {
      color: theme.colors.textFaint,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.footnote.fontSize,
      lineHeight: 18 * theme.fontScale,
    },
    field: { gap: 8 },
    nameInput: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: theme.colors.surfaceAlt,
      color: theme.colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
    },
    inputFocused: { borderColor: theme.colors.action },
    compactFooter: { flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' },
    compactActions: { flexShrink: 0, flexDirection: 'row', justifyContent: 'space-between' },
    footerRight: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 4,
      flex: 1,
    },
    deleteButton: { paddingHorizontal: 6, gap: 6 },
    deleteText: {
      color: theme.colors.attention,
      fontSize: theme.typography.bodySmall.fontSize,
      fontFamily: theme.fonts.semibold,
    },
    label: {
      color: theme.colors.text,
      fontSize: theme.typography.bodySmall.fontSize,
      fontFamily: theme.fonts.semibold,
    },
    select: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surfaceAlt,
    },
    selectText: {
      flex: 1,
      color: theme.colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
    },
    placeholder: { color: theme.colors.textFaint },
    options: {
      position: 'absolute',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surfaceAlt,
      paddingVertical: 4,
      // No overflow clipping here: on iOS it would mask the shadow.
      shadowColor: theme.elevation.floating.shadowColor,
      shadowOpacity: 0.45,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
    optionsClip: { borderRadius: 11, overflow: 'hidden' },
    option: {
      minHeight: optionHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 12,
    },
    selected: { backgroundColor: tint(theme.colors.signature, 'neutral') },
    optionText: {
      flex: 1,
      color: theme.colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    errorBox: { borderLeftWidth: 2, borderLeftColor: theme.colors.attention, paddingLeft: 12 },
    error: {
      color: theme.colors.attention,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 21 * theme.fontScale,
    },
    confirm: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
    footer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    button: {
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: theme.radius.pill,
    },
    primary: {
      minWidth: 96,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.action,
    },
    primaryText: {
      color: theme.colors.onAction,
      fontSize: theme.typography.row.fontSize,
      fontFamily: theme.fonts.bold,
    },
    cancelText: {
      color: theme.colors.textMuted,
      fontSize: theme.typography.row.fontSize,
      fontFamily: theme.fonts.semibold,
    },
    disabled: { opacity: 0.45 },
  });
