import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
  meta,
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
  // One line under the title, e.g. "Claude Opus 5.5 · control"; falls back to the name.
  meta?: string;
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
    detail?: string;
    running?: boolean;
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
  const measurePicker = () => {
    const card = cardRef.current;
    if (!card) return;
    // Measure the select and the card together, after any layout change, so the
    // list neither opens from a stale spot nor flips on an outdated card height.
    selectRef.current?.measureLayout(card, (x, y, w, h) =>
      card.measure((_left, _top, _width, cardHeight) =>
        setPickerAnchor({ x, y, w, h, cardHeight }),
      ),
    );
  };
  const togglePicker = () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    // The list stays invisible until measured, so it never flashes at a guess.
    setPickerAnchor(undefined);
    setPickerOpen(true);
    if (!Keyboard.isVisible()) {
      measurePicker();
      return;
    }
    // Hiding the keyboard resizes the card; measure once it has settled.
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      hidden.remove();
      requestAnimationFrame(measurePicker);
    });
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
  const [links, setLinks] = useState<Awaited<ReturnType<VerityClient['listSessionLinks']>>>([]);
  const [view, setView] = useState<'settings' | 'link'>('settings');
  const [linkQuery, setLinkQuery] = useState('');
  const [linkFilter, setLinkFilter] = useState<string | null>(null);
  const [linkInfoOpen, setLinkInfoOpen] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  // The link view borrows the settings view's height so the card does not jump
  // when the two swap, however long the list of candidate sessions is.
  const [settingsHeight, setSettingsHeight] = useState<number>();
  const slide = useRef(new Animated.Value(0)).current;
  const showView = (next: 'settings' | 'link') => {
    Keyboard.dismiss();
    setPickerOpen(false);
    setLinkError(undefined);
    if (next === 'link') {
      setLinkQuery('');
      setLinkFilter(null);
    }
    setView(next);
    slide.setValue(next === 'link' ? 1 : -1);
    Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  };
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const isLinked = (id: string) => links.some((link) => link.sessionId === id);
  const linkProjects = [
    ...new Map(linkableSessions.map((item) => [item.projectId, item.projectName])).entries(),
  ];
  const query = linkQuery.trim().toLowerCase();
  const linkCandidates = linkableSessions.filter(
    (item) =>
      (linkFilter === null || item.projectId === linkFilter) &&
      (!query ||
        item.name.toLowerCase().includes(query) ||
        item.projectName.toLowerCase().includes(query)),
  );
  const linkGroups = linkProjects
    .map(([id, name]) => ({
      id,
      name,
      items: linkCandidates.filter((item) => item.projectId === id),
    }))
    .filter((group) => group.items.length > 0);
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
      <Icon name="trash-2" size={16} color={theme.colors.tone.danger} />
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
      {busy && <ActivityIndicator size="small" color={theme.colors.background} />}
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

  const header = (title: string, subtitle: string | undefined, back?: () => void) => (
    <View style={styles.header}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to session settings"
          disabled={linkBusy}
          onPress={back}
          style={styles.iconButton}
        >
          <Icon name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
      ) : null}
      <View style={styles.heading}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {back ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close session settings"
          disabled={busy || linkBusy}
          onPress={close}
          style={styles.iconButton}
        >
          <Icon name="x" size={18} color={theme.colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
  const settingsView = (
    <>
      {header(result ? 'Session moved' : 'Session settings', meta || displayName)}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        // The floating project list is anchored to where the select was measured.
        onScrollBeginDrag={() => setPickerOpen(false)}
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
            <Text style={styles.overline} accessibilityRole="header">
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
                  color={theme.colors.accent}
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
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.overline} accessibilityRole="header">
                Linked sessions
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="About linked sessions"
                accessibilityState={{ expanded: linkInfoOpen }}
                onPress={() => setLinkInfoOpen((open) => !open)}
                hitSlop={12}
              >
                <Icon
                  name="info"
                  size={16}
                  color={linkInfoOpen ? theme.colors.accent : theme.colors.textFaint}
                />
              </Pressable>
            </View>
            <Text style={styles.description}>Share messages with agents in other projects.</Text>
            {linkInfoOpen ? (
              <Text style={styles.hint}>
                Linked agents can share messages across projects, including information they can
                access there. Disconnecting stops future messages; it cannot remove messages already
                delivered.
              </Text>
            ) : null}
            <View style={styles.group}>
              {links.map((link) => {
                const detail = linkableSessions.find((item) => item.id === link.sessionId)?.detail;
                return (
                  <View key={link.sessionId} style={styles.groupRow}>
                    <View style={[styles.rowIcon, styles.rowIconLinked]}>
                      <Icon name="link" size={15} color={theme.colors.primary} />
                    </View>
                    <View style={styles.linkLabel}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {link.name ?? link.sessionId}
                      </Text>
                      <Text style={styles.rowDetail} numberOfLines={1}>
                        {detail ? `${link.projectName} · ${detail}` : link.projectName}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Disconnect ${link.name ?? link.sessionId}`}
                      disabled={linkBusy || busy || unresolved || willMove}
                      onPress={() => void removeLink(link.sessionId)}
                      style={styles.linkRemove}
                    >
                      <Icon name="x" size={18} color={theme.colors.textFaint} />
                    </Pressable>
                  </View>
                );
              })}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={links.length === 0 ? 'Link a session' : 'Link another session'}
                accessibilityState={{ disabled: linkBusy || busy || unresolved || willMove }}
                disabled={linkBusy || busy || unresolved || willMove}
                onPress={() => showView('link')}
                style={[
                  styles.groupRow,
                  links.length > 0 && styles.groupRowDivided,
                  (linkBusy || busy || unresolved || willMove) && styles.disabled,
                ]}
              >
                <View style={[styles.rowIcon, styles.rowIconAction]}>
                  <Icon name="plus" size={16} color={theme.colors.accent} />
                </View>
                <View style={styles.linkLabel}>
                  <Text style={styles.linkActionText}>
                    {links.length === 0 ? 'Link a session' : 'Link another session'}
                  </Text>
                  {links.length === 0 ? (
                    <Text style={styles.rowDetail}>No sessions linked yet</Text>
                  ) : null}
                </View>
                <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
              </Pressable>
            </View>
            {view === 'settings' && linkError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {linkError}
              </Text>
            ) : null}
            {willMove ? (
              <Text style={styles.hint}>Save the project change before linking sessions.</Text>
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
    </>
  );
  const linkView = (
    <>
      {header('Link a session', 'Tap an agent to link it immediately.', () => showView('settings'))}
      <View style={styles.linkTools}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={theme.colors.textMuted} />
          <TextInput
            accessibilityLabel="Search sessions"
            value={linkQuery}
            onChangeText={setLinkQuery}
            placeholder="Search sessions or projects"
            placeholderTextColor={theme.colors.textFaint}
            autoFocus={Platform.OS !== 'android'}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={styles.searchInput}
          />
          {linkQuery ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => setLinkQuery('')}
              hitSlop={10}
            >
              <Icon name="x-circle" size={16} color={theme.colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
        {linkProjects.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chips}
          >
            {[[null, 'All'] as const, ...linkProjects].map(([id, name]) => (
              <Pressable
                key={id ?? 'all'}
                accessibilityRole="button"
                accessibilityLabel={id === null ? 'All projects' : `Only ${name}`}
                accessibilityState={{ selected: linkFilter === id }}
                onPress={() => setLinkFilter(id)}
                style={[styles.chip, linkFilter === id && styles.chipActive]}
              >
                <Text style={[styles.chipText, linkFilter === id && styles.chipTextActive]}>
                  {name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <ScrollView
        style={styles.linkList}
        contentContainerStyle={styles.linkListContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {linkError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {linkError}
          </Text>
        ) : null}
        {linkGroups.map((group) => (
          <View key={group.id} style={styles.linkGroup}>
            <Text style={styles.overline} accessibilityRole="header">
              {group.name}
            </Text>
            {group.items.map((item) => {
              const linked = isLinked(item.id);
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={linked ? `${item.name}, linked` : `Link ${item.name}`}
                  accessibilityState={{ disabled: linked || linkBusy, selected: linked }}
                  disabled={linked || linkBusy}
                  onPress={() => void addLink(item.id)}
                  style={({ pressed }) => [styles.candidate, pressed && styles.candidatePressed]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      item.running && { backgroundColor: theme.colors.tone.attention },
                    ]}
                  />
                  <View style={styles.linkLabel}>
                    <Text
                      style={[styles.rowTitle, linked && styles.rowTitleMuted]}
                      numberOfLines={1}
                    >
                      {item.name}
                    </Text>
                    {item.detail ? (
                      <Text style={styles.rowDetail} numberOfLines={1}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {linked ? (
                    <View style={styles.linkedBadge}>
                      <Icon name="check" size={14} color={theme.colors.tone.done} />
                      <Text style={styles.linkedText}>Linked</Text>
                    </View>
                  ) : (
                    <View style={styles.addButton}>
                      <Icon name="plus" size={16} color={theme.colors.primary} />
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
        {linkGroups.length === 0 ? (
          <Text style={styles.emptyText}>
            {linkableSessions.length === 0
              ? 'No sessions in other projects to link.'
              : 'No sessions match your search.'}
          </Text>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, styles.footerEnd]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done linking"
          disabled={linkBusy}
          onPress={() => showView('settings')}
          style={[styles.button, styles.secondary]}
        >
          {linkBusy ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
          <Text style={styles.secondaryText}>Done</Text>
        </Pressable>
      </View>
    </>
  );
  const linking = view === 'link' && !result;
  const projectOptions = [
    { id: projectId, name: projectName },
    ...projects.filter((project) => project.id !== projectId),
  ];
  // Open downwards when the list fits below the select, otherwise towards the
  // side with more room — the same choice a native menu makes near an edge.
  const listHeight = Math.min(projectOptions.length * 48 + 10, 250);
  const listPosition = (() => {
    if (!pickerAnchor) return { left: 20, right: 20, top: 0, opacity: 0 };
    const { x, y, w, h, cardHeight } = pickerAnchor;
    const below = Math.max(cardHeight - (y + h) - 12, 0);
    const above = Math.max(y - 12, 0);
    return below >= listHeight || below >= above
      ? { left: x, width: w, top: y + h + 6, maxHeight: Math.min(listHeight, below) }
      : { left: x, width: w, bottom: cardHeight - y + 6, maxHeight: Math.min(listHeight, above) };
  })();

  return (
    <Modal
      transparent
      animationType="fade"
      // Android back leaves the link view first, like its on-screen back button.
      onRequestClose={linking ? () => !linkBusy && showView('settings') : close}
    >
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
            style={[styles.card, linking && settingsHeight ? { height: settingsHeight } : null]}
            testID="session-settings-card"
            onLayout={
              linking ? undefined : (event) => setSettingsHeight(event.nativeEvent.layout.height)
            }
          >
            <Animated.View
              style={[
                linking ? styles.paneFill : styles.pane,
                {
                  opacity: slide.interpolate({
                    inputRange: [-1, 0, 1],
                    outputRange: [0, 1, 0],
                  }),
                  transform: [
                    {
                      translateX: slide.interpolate({
                        inputRange: [-1, 0, 1],
                        outputRange: [-24, 0, 24],
                      }),
                    },
                  ],
                },
              ]}
            >
              {linking ? linkView : settingsView}
            </Animated.View>
            {pickerOpen && !linking && !result ? (
              <>
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={() => setPickerOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Close project list"
                />
                <View style={[styles.options, listPosition]}>
                  <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
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
      backgroundColor: 'rgba(3,2,10,0.72)',
    },
    card: {
      width: '100%',
      maxWidth: 440,
      maxHeight: '90%',
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: `${theme.colors.accent}33`,
      overflow: 'hidden',
      // A faint accent halo lifts the card off the dimmed app (iOS; Android has no
      // coloured shadow and keeps the border alone).
      shadowColor: theme.colors.accent,
      shadowOpacity: 0.16,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 8 },
    },
    pane: { flexShrink: 1 },
    paneFill: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 16, gap: 12 },
    heading: { flex: 1, gap: 3 },
    title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
    subtitle: { color: theme.colors.textMuted, fontSize: theme.text.sm },
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
      fontSize: theme.text.sm,
      lineHeight: 20 * theme.fontScale,
    },
    hint: {
      color: theme.colors.textFaint,
      fontSize: theme.text.xs,
      lineHeight: 18 * theme.fontScale,
    },
    field: { gap: 8 },
    overline: {
      color: theme.colors.textFaint,
      fontSize: theme.text.xs,
      fontWeight: '700',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 10,
    },
    group: { borderRadius: 14, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' },
    groupRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingLeft: 12,
      paddingRight: 8,
      paddingVertical: 8,
    },
    groupRowDivided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    rowIcon: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowIconLinked: { backgroundColor: `${theme.colors.primary}26` },
    rowIconAction: { backgroundColor: `${theme.colors.accent}1f` },
    rowTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
    rowTitleMuted: { color: theme.colors.textMuted },
    rowDetail: { color: theme.colors.textMuted, fontSize: theme.text.xs },
    linkLabel: { flex: 1, gap: 2 },
    linkRemove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    linkActionText: {
      color: theme.colors.accent,
      fontSize: theme.text.sm,
      fontWeight: '600',
    },
    linkTools: { paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
    search: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: theme.colors.surfaceAlt,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      color: theme.colors.text,
      fontSize: theme.text.md,
    },
    chips: { gap: 8 },
    chip: {
      minHeight: 32,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: theme.colors.surfaceAlt,
    },
    chipActive: {
      backgroundColor: `${theme.colors.accent}1f`,
      borderColor: `${theme.colors.accent}80`,
    },
    chipText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
    chipTextActive: { color: theme.colors.accent },
    linkList: {
      flex: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    linkListContent: { paddingHorizontal: 12, paddingVertical: 12, gap: 16 },
    linkGroup: { gap: 2 },
    candidate: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 12,
    },
    candidatePressed: { backgroundColor: theme.colors.surfaceAlt },
    statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.tone.idle },
    addButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: `${theme.colors.primary}b3`,
    },
    linkedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 4 },
    linkedText: { color: theme.colors.tone.done, fontSize: theme.text.xs, fontWeight: '600' },
    emptyText: {
      color: theme.colors.textFaint,
      fontSize: theme.text.sm,
      textAlign: 'center',
      paddingVertical: 24,
    },
    nameInput: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: theme.colors.surfaceAlt,
      color: theme.colors.text,
      fontSize: theme.text.md,
    },
    inputFocused: { borderColor: `${theme.colors.accent}cc` },
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
    footerEnd: { justifyContent: 'flex-end' },
    deleteButton: { paddingHorizontal: 6, gap: 6 },
    deleteText: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '600' },
    label: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
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
    selectText: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
    placeholder: { color: theme.colors.textFaint },
    options: {
      position: 'absolute',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surfaceAlt,
      overflow: 'hidden',
      paddingVertical: 4,
      shadowColor: '#000',
      shadowOpacity: 0.45,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
    option: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
    selected: { backgroundColor: `${theme.colors.accent}14` },
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
      backgroundColor: theme.colors.accent,
      shadowColor: theme.colors.accent,
      shadowOpacity: 0.3,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
    },
    primaryText: { color: theme.colors.background, fontSize: theme.text.md, fontWeight: '700' },
    secondary: { minWidth: 96, backgroundColor: theme.colors.surfaceAlt },
    secondaryText: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
    cancelText: { color: theme.colors.textMuted, fontSize: theme.text.md, fontWeight: '600' },
    disabled: { opacity: 0.45 },
  });
