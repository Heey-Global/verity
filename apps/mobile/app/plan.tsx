// The Plan tab (ADR 0007): the task backlog over a GitHub Projects v2 board, plus the
// Voice → Refiner capture flow. Two sections — Inbox (repo-less drafts) and Backlog
// (real issues with field chips) — a capture composer with voice dictation, and a
// "Refine" action that turns the note into a structured blueprint (one stateless model
// query) shown in an editable review sheet the operator tweaks before filing as an
// issue. Reordering is move up/down (drag is a follow-up). Data flows through
// {@link useTasks}; a 503 → null board → a configure hint.
import {
  VerityApiError,
  type VerityClient,
  composeRefinedIssueBody,
  type RefinedTask,
  type TaskField,
  type TaskItem,
  TASKS_AGENT_SEED_PROMPT,
  projectRepoRef,
} from '@verity/mobile';
import { Stack, router } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../components/Icon';
import { useTasks } from '../hooks/useTasks';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { createVerityClient } from '../lib/client';

/** Split a multiline field into a trimmed, non-empty string[] (one item per line). */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export default function PlanScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const [launching, setLaunching] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Open the task assistant: create a session, then immediately start its first
  // turn because tapping the assistant is already the operator's go-ahead.
  const onAssistant = useCallback(() => {
    if (!client || launching) return;
    setLaunching(true);
    void (async () => {
      try {
        const result = await client.createSession({
          prompt: TASKS_AGENT_SEED_PROMPT,
          name: 'Tasks',
        });
        if ('awaitingProvisioning' in result) {
          if (mounted.current) setLaunching(false);
          return;
        }
        await client.sendTurn(result.sessionId, { prompt: TASKS_AGENT_SEED_PROMPT });
        router.replace({
          pathname: '/session/[id]',
          params: { id: result.sessionId },
        });
      } catch {
        if (mounted.current) setLaunching(false);
      }
    })();
  }, [client, launching]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Own header styled to match the app's AppHeader (the overview look): a 56px
          row with a centered title, a left-side assistant launcher and a right-side
          close. The route's own header is hidden; the screen is a full-screen overlay
          so there's no modal-sheet gap. */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <View style={styles.headerSide}>
            {client ? (
              <Pressable
                onPress={onAssistant}
                disabled={launching}
                hitSlop={8}
                style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
                accessibilityRole="button"
                accessibilityLabel="Open the task assistant"
              >
                {launching ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : (
                  <Icon name="message-square" size={22} color={theme.colors.accent} />
                )}
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
            Plan
          </Text>
          <View style={[styles.headerSide, styles.headerSideRight]}>
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
              accessibilityRole="button"
              accessibilityLabel="Close plan"
            >
              <Icon name="x" size={24} color={theme.colors.textMuted} />
            </Pressable>
          </View>
        </View>
      </View>
      {client ? (
        <PlanBoard client={client} />
      ) : (
        <View style={styles.centered}>
          <Text style={styles.hint}>Set the server URL to plan tasks.</Text>
        </View>
      )}
    </View>
  );
}

function PlanBoard({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const {
    board,
    loading,
    loaded,
    error,
    refresh,
    createDraft,
    createIssue,
    fileDraft,
    reorder,
    remove,
    setField,
  } = useTasks(client);
  const [draftTitle, setDraftTitle] = useState('');
  const voice = useVoiceInput(draftTitle, setDraftTitle);
  // The item whose task actions (fields/removal) are open in the sheet.
  const [fieldItem, setFieldItem] = useState<TaskItem | null>(null);

  // Voice → Refiner review-sheet state. `review` non-null ⇒ the sheet is open with a
  // blueprint; `refining`/`filing` drive the busy states; `refineError` surfaces a
  // failed refine inline under the composer.
  const [review, setReview] = useState<RefinedTask | null>(null);
  const [refining, setRefining] = useState(false);
  const [filing, setFiling] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [refineError, setRefineError] = useState<string | undefined>(undefined);
  // Repo picker (`owner/repo`) for direct filing and the review flow. Loaded once,
  // best-effort — an empty list (or failed/503 load) leaves filing on the server's
  // origin repo.
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void client
      .listProjects()
      .then((projects) => {
        if (alive) {
          setRepos(
            projects
              .filter((project) => project.state === 'active')
              .map(projectRepoRef)
              .filter((repo): repo is string => repo !== undefined),
          );
        }
      })
      .catch(() => {
        /* optional — leave repos empty and default to origin */
      });
    return () => {
      alive = false;
    };
  }, [client]);
  // Guard post-await setState if the operator leaves the Plan tab mid-refine/-file
  // (mirrors the mounted-guard in useTasks).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const items = board?.items ?? [];
  const drafts = items.filter((it) => it.type === 'DRAFT_ISSUE');
  // Non-draft items in board order — index within THIS array is the visible rank, and
  // reordering against it keeps the relative order correct because drafts are excluded.
  const backlog = items.filter((it) => it.type !== 'DRAFT_ISSUE');
  // Single-select fields (Priority/Status) the operator can set from a task row.
  const settableFields = (board?.fields ?? []).filter((f) => f.options.length > 0);

  const submitDraft = async (): Promise<void> => {
    const trimmed = draftTitle.trim();
    if (trimmed.length === 0) return;
    voice.abort();
    setDraftTitle('');
    setCreatingDraft(true);
    await createDraft(trimmed);
    if (mounted.current) setCreatingDraft(false);
  };

  // Run the one-shot refiner over a transcript and open/refresh the review sheet.
  const runRefine = async (transcript: string): Promise<void> => {
    const t = transcript.trim();
    if (t.length === 0) return;
    setRefining(true);
    setRefineError(undefined);
    try {
      const refined = await client.refineTask(t);
      if (mounted.current) setReview(refined);
    } catch (caught) {
      if (mounted.current) {
        setRefineError(caught instanceof VerityApiError ? caught.message : 'Refinement failed');
      }
    } finally {
      if (mounted.current) setRefining(false);
    }
  };

  const onRefine = (): void => {
    const t = draftTitle.trim();
    if (t.length === 0) return;
    voice.abort();
    void runRefine(t).then(() => setDraftTitle(''));
  };

  const submitIssue = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (title.length === 0) return;
    voice.abort();
    setCreatingIssue(true);
    const ok = await createIssue(title, '', selectedRepo);
    if (!mounted.current) return;
    setCreatingIssue(false);
    if (ok) setDraftTitle('');
  };

  // "Refine again": re-run the model over the operator's edited blueprint so their
  // edits/answers are folded into the next pass.
  const onRefineAgain = (edited: RefinedTask): void => {
    void runRefine(`${edited.title}\n\n${composeRefinedIssueBody(edited)}`);
  };

  const onCreate = async (edited: RefinedTask, repo?: string): Promise<void> => {
    const title = edited.title.trim();
    if (title.length === 0) return;
    setFiling(true);
    const ok = await createIssue(title, composeRefinedIssueBody(edited), repo);
    if (!mounted.current) return;
    setFiling(false);
    if (ok) setReview(null);
  };

  // Move a backlog item one slot. Up → sit after the item two slots above (null = to
  // the top); down → sit after the next item. reorderTask preserves every other item's
  // order, so positioning against the backlog subsequence is exact.
  const move = (index: number, dir: -1 | 1): void => {
    const item = backlog[index];
    if (!item) return;
    if (dir === -1) {
      const afterId = index - 2 >= 0 ? (backlog[index - 2]?.id ?? null) : null;
      void reorder(item.id, afterId);
    } else {
      const after = backlog[index + 1];
      if (!after) return;
      void reorder(item.id, after.id);
    }
  };

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
            tintColor={theme.colors.textMuted}
          />
        }
      >
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={draftTitle}
            onChangeText={setDraftTitle}
            placeholder={voice.state === 'recording' ? 'Listening…' : 'Capture a task — or dictate'}
            placeholderTextColor={theme.colors.textFaint}
            multiline
            accessibilityLabel="New task note"
          />
          <Pressable
            style={
              voice.state === 'recording'
                ? [styles.composerMic, { backgroundColor: theme.colors.accent }]
                : styles.composerMic
            }
            onPress={voice.toggle}
            accessibilityRole="button"
            accessibilityLabel={voice.state === 'recording' ? 'Stop dictation' : 'Start dictation'}
          >
            <Icon
              name={voice.state === 'recording' ? 'check' : 'mic'}
              size={22}
              color={voice.state === 'recording' ? theme.colors.background : theme.colors.accent}
            />
          </Pressable>
        </View>

        <View style={styles.composerActions}>
          <Pressable
            style={({ pressed }) => [styles.addButton, pressed ? styles.pressed : null]}
            onPress={() => void submitDraft()}
            disabled={creatingDraft || creatingIssue || refining}
            accessibilityRole="button"
            accessibilityLabel="Add to inbox"
          >
            {creatingDraft ? (
              <ActivityIndicator size="small" color={theme.colors.textMuted} />
            ) : (
              <Icon name="inbox" size={16} color={theme.colors.textMuted} />
            )}
            <Text style={styles.addButtonText}>{creatingDraft ? 'Adding' : 'Add to inbox'}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.issueButton, pressed ? styles.pressed : null]}
            onPress={() => void submitIssue()}
            disabled={creatingDraft || creatingIssue || refining}
            accessibilityRole="button"
            accessibilityLabel="Create issue from note"
          >
            {creatingIssue ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Icon name="plus-circle" size={16} color={theme.colors.onPrimary} />
            )}
            <Text style={styles.issueButtonText}>
              {creatingIssue ? 'Creating' : 'Create issue'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.refineButton, pressed ? styles.pressed : null]}
            onPress={onRefine}
            disabled={creatingDraft || creatingIssue || refining}
            accessibilityRole="button"
            accessibilityLabel="Review before filing"
          >
            {refining ? (
              <ActivityIndicator size="small" color={theme.colors.textMuted} />
            ) : (
              <Icon name="zap" size={16} color={theme.colors.textMuted} />
            )}
            <Text style={styles.refineButtonText}>{refining ? 'Reviewing' : 'Review'}</Text>
          </Pressable>
        </View>

        {repos.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.repoPicker}
            keyboardShouldPersistTaps="handled"
          >
            <RepoChip
              label="Origin"
              selected={selectedRepo === undefined}
              onPress={() => setSelectedRepo(undefined)}
              accessibilityLabel="Select origin repository"
            />
            {repos.map((repo) => (
              <RepoChip
                key={repo}
                label={repo}
                selected={selectedRepo === repo}
                onPress={() => setSelectedRepo(repo)}
                accessibilityLabel={`Select repository ${repo}`}
              />
            ))}
          </ScrollView>
        ) : null}
        {voice.error ? <Text style={styles.error}>Voice: {voice.error}</Text> : null}
        {refineError ? <Text style={styles.error}>{refineError}</Text> : null}

        {error ? (
          <Pressable
            onPress={() => void refresh()}
            accessibilityRole="button"
            accessibilityLabel="Retry"
          >
            <Text style={styles.error}>Couldn&apos;t load tasks — {error}. Tap to retry.</Text>
          </Pressable>
        ) : null}

        {loaded && board === null && !error ? (
          <Text style={styles.hint}>Task management isn&apos;t configured on the server.</Text>
        ) : null}

        {!loaded && loading ? <ActivityIndicator style={styles.loader} /> : null}

        {board ? (
          <>
            <SectionHeader icon="inbox" title="Inbox" count={drafts.length} />
            {drafts.length === 0 ? (
              <Text style={styles.empty}>No drafts. Capture an idea above.</Text>
            ) : (
              drafts.map((it) => (
                <TaskRow key={it.id} item={it} onOpenTask={() => setFieldItem(it)} />
              ))
            )}

            <SectionHeader icon="list" title="Backlog" count={backlog.length} />
            {backlog.length === 0 ? (
              <Text style={styles.empty}>No tasks yet.</Text>
            ) : (
              backlog.map((it, i) => (
                <TaskRow
                  key={it.id}
                  item={it}
                  canMoveUp={i > 0}
                  canMoveDown={i < backlog.length - 1}
                  onMoveUp={() => move(i, -1)}
                  onMoveDown={() => move(i, 1)}
                  onOpenTask={() => setFieldItem(it)}
                />
              ))
            )}
          </>
        ) : null}
      </ScrollView>

      {review ? (
        <ReviewSheet
          refined={review}
          repos={repos}
          initialRepo={selectedRepo}
          busy={refining || filing}
          onRefineAgain={onRefineAgain}
          onCreate={onCreate}
          onClose={() => setReview(null)}
        />
      ) : null}

      {fieldItem ? (
        <FieldSheet
          item={fieldItem}
          fields={settableFields}
          repos={repos}
          onClose={() => setFieldItem(null)}
          onFile={async (repo) => {
            const ok = await fileDraft(fieldItem.id, repo);
            if (ok) setFieldItem(null);
            return ok;
          }}
          onOpenIssue={() => {
            if (fieldItem.number === null) return;
            router.push({
              pathname: '/issue/[number]',
              params: {
                number: String(fieldItem.number),
                title: fieldItem.title,
                body: fieldItem.body,
                url: fieldItem.url,
              },
            });
            setFieldItem(null);
          }}
          onRemove={() => {
            void remove(fieldItem.id);
            setFieldItem(null);
          }}
          onSet={(field, value) => {
            void setField(fieldItem.id, field, value);
            setFieldItem(null);
          }}
        />
      ) : null}
    </>
  );
}

// A bottom sheet for a backlog item's task actions: single-select fields
// (Priority/Status) and remove-from-board cleanup.
function FieldSheet({
  item,
  fields,
  repos,
  onSet,
  onFile,
  onOpenIssue,
  onRemove,
  onClose,
}: {
  item: TaskItem;
  fields: TaskField[];
  repos: string[];
  onSet: (field: string, value: string) => void;
  onFile: (repo?: string) => Promise<boolean>;
  onOpenIssue: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [fileRepo, setFileRepo] = useState<string | undefined>(undefined);
  const [filing, setFiling] = useState(false);
  const isDraft = item.type === 'DRAFT_ISSUE';
  const current = (name: string): string | undefined =>
    item.fields.find((f) => f.field === name)?.value;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityRole="button">
        <Pressable style={styles.sheetCard} onPress={() => undefined}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {isDraft ? 'Inbox: ' : item.number !== null ? `#${item.number} ` : ''}
              {item.title}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="x" size={22} color={theme.colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {isDraft ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Repository</Text>
                <View style={styles.chips}>
                  <RepoChip
                    label="Origin"
                    selected={fileRepo === undefined}
                    onPress={() => setFileRepo(undefined)}
                    accessibilityLabel="File in origin repository"
                  />
                  {repos.map((repo) => (
                    <RepoChip
                      key={repo}
                      label={repo}
                      selected={fileRepo === repo}
                      onPress={() => setFileRepo(repo)}
                      accessibilityLabel={`File in ${repo}`}
                    />
                  ))}
                </View>
              </View>
            ) : (
              fields.map((field) => {
                const active = current(field.name);
                return (
                  <View key={field.id} style={styles.field}>
                    <Text style={styles.fieldLabel}>{field.name}</Text>
                    <View style={styles.chips}>
                      {field.options.map((option) => {
                        const selected = active === option.name;
                        return (
                          <Pressable
                            key={option.id}
                            onPress={() => onSet(field.name, option.name)}
                            style={({ pressed }) => [
                              styles.optionChip,
                              selected ? styles.optionChipActive : null,
                              pressed ? styles.pressed : null,
                            ]}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`Set ${field.name} to ${option.name}`}
                          >
                            <Text style={selected ? styles.optionTextActive : styles.optionText}>
                              {option.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
          <View style={styles.sheetActions}>
            {isDraft ? (
              <Pressable
                onPress={() => {
                  setFiling(true);
                  void onFile(fileRepo).then((ok) => {
                    if (!ok) setFiling(false);
                  });
                }}
                disabled={filing}
                style={({ pressed }) => [styles.sheetPrimary, pressed ? styles.pressed : null]}
                accessibilityRole="button"
                accessibilityLabel="File inbox task in repository"
              >
                {filing ? (
                  <ActivityIndicator size="small" color={theme.colors.onPrimary} />
                ) : (
                  <Text style={styles.sheetPrimaryText}>File in repository</Text>
                )}
              </Pressable>
            ) : item.number !== null ? (
              <Pressable
                onPress={onOpenIssue}
                style={({ pressed }) => [styles.sheetSecondary, pressed ? styles.pressed : null]}
                accessibilityRole="button"
                accessibilityLabel={`Open issue ${item.number ?? ''}`}
              >
                <Text style={styles.sheetSecondaryText}>Start / open issue</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                if (confirmRemove) onRemove();
                else setConfirmRemove(true);
              }}
              style={({ pressed }) => [styles.sheetDanger, pressed ? styles.pressed : null]}
              accessibilityRole="button"
              accessibilityLabel={
                confirmRemove
                  ? `Confirm remove ${item.title} from board`
                  : `Remove ${item.title} from board`
              }
            >
              <Icon name="trash-2" size={16} color={theme.colors.tone.danger} />
              <Text style={styles.sheetDangerText}>
                {confirmRemove ? 'Confirm remove' : 'Remove from board'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SectionHeader({
  icon,
  title,
  count,
}: {
  icon: 'inbox' | 'list';
  title: string;
  count: number;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.sectionHeader}>
      <Icon name={icon} size={16} color={theme.colors.textMuted} />
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
  );
}

function TaskRow({
  item,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onOpenTask,
}: {
  item: TaskItem;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onOpenTask: () => void;
}) {
  const { theme } = useUnistyles();
  const isDraft = item.type === 'DRAFT_ISSUE';

  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : null]}
        onPress={onOpenTask}
        accessibilityRole="button"
        accessibilityLabel={`Open task ${item.title}`}
      >
        <View style={styles.rowTop}>
          {isDraft ? (
            <View style={styles.draftPill}>
              <Text style={styles.draftPillText}>Inbox</Text>
            </View>
          ) : (
            <Text style={styles.rowNumber}>#{item.number}</Text>
          )}
          <Text style={styles.rowTitle} numberOfLines={2}>
            {item.title}
          </Text>
        </View>
        {item.fields.length > 0 ? (
          <View style={styles.chips}>
            {item.fields.map((f) => (
              <View key={`${f.field}:${f.value}`} style={styles.chip}>
                <Text style={styles.chipText}>{f.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Pressable>
      {onMoveUp || onMoveDown ? (
        <View style={styles.reorder}>
          <Pressable
            onPress={onMoveUp}
            disabled={!canMoveUp}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Move ${item.title} up`}
          >
            <Icon
              name="chevron-up"
              size={20}
              color={canMoveUp ? theme.colors.textMuted : theme.colors.textFaint}
            />
          </Pressable>
          <Pressable
            onPress={onMoveDown}
            disabled={!canMoveDown}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Move ${item.title} down`}
          >
            <Icon
              name="chevron-down"
              size={20}
              color={canMoveDown ? theme.colors.textMuted : theme.colors.textFaint}
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// The editable issue review sheet (ADR 0007 flow A). Seeded from the refined
// issue draft; the operator edits the fields (arrays are edited one-per-line), can
// "Refine again" to re-run the model over their edits, or "Create issue" to file it.
function ReviewSheet({
  refined,
  repos,
  initialRepo,
  busy,
  onRefineAgain,
  onCreate,
  onClose,
}: {
  refined: RefinedTask;
  repos: string[];
  initialRepo?: string | undefined;
  busy: boolean;
  onRefineAgain: (edited: RefinedTask) => void;
  onCreate: (edited: RefinedTask, repo?: string) => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const [title, setTitle] = useState(refined.title);
  // Selected target repo (`owner/repo`) for the repo picker; undefined ⇒ the server's
  // origin repo. Only shown when the server exposes provisioned projects to choose from.
  const [repo, setRepo] = useState<string | undefined>(initialRepo);
  const [problem, setProblem] = useState(refined.problem);
  const [criteria, setCriteria] = useState(refined.acceptanceCriteria.join('\n'));
  const [areas, setAreas] = useState(refined.affectedAreas.join('\n'));
  const [questions, setQuestions] = useState(refined.openQuestions.join('\n'));

  // Re-seed when a "Refine again" pass replaces the blueprint.
  useEffect(() => {
    setTitle(refined.title);
    setProblem(refined.problem);
    setCriteria(refined.acceptanceCriteria.join('\n'));
    setAreas(refined.affectedAreas.join('\n'));
    setQuestions(refined.openQuestions.join('\n'));
  }, [refined]);

  const edited = (): RefinedTask => ({
    title: title.trim(),
    problem: problem.trim(),
    acceptanceCriteria: splitLines(criteria),
    affectedAreas: splitLines(areas),
    openQuestions: splitLines(questions),
  });

  const hasQuestions = splitLines(questions).length > 0;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheetCard}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Review issue</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="x" size={22} color={theme.colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Field label="Title">
              <TextInput
                style={styles.sheetInput}
                value={title}
                onChangeText={setTitle}
                placeholder="Issue title"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="Blueprint title"
              />
            </Field>
            {repos.length > 0 ? (
              <Field label="Repository — none = origin">
                <View style={styles.chips}>
                  {repos.map((r) => {
                    const selected = repo === r;
                    return (
                      <Pressable
                        key={r}
                        onPress={() => setRepo(selected ? undefined : r)}
                        style={({ pressed }) => [
                          styles.optionChip,
                          selected ? styles.optionChipActive : null,
                          pressed ? styles.pressed : null,
                        ]}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`File into ${r}`}
                      >
                        <Text style={selected ? styles.optionTextActive : styles.optionText}>
                          {r}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Field>
            ) : null}
            <Field label="Problem">
              <TextInput
                style={[styles.sheetInput, styles.sheetInputMultiline]}
                value={problem}
                onChangeText={setProblem}
                multiline
                placeholder="What and why"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="Blueprint problem"
              />
            </Field>
            <Field label="Acceptance criteria (one per line)">
              <TextInput
                style={[styles.sheetInput, styles.sheetInputMultiline]}
                value={criteria}
                onChangeText={setCriteria}
                multiline
                placeholder="One criterion per line"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="Blueprint acceptance criteria"
              />
            </Field>
            <Field label="Affected areas (one per line)">
              <TextInput
                style={[styles.sheetInput, styles.sheetInputMultiline]}
                value={areas}
                onChangeText={setAreas}
                multiline
                placeholder="Files / modules"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="Blueprint affected areas"
              />
            </Field>
            <Field
              label={
                hasQuestions ? 'Open questions — answer or clear before filing' : 'Open questions'
              }
            >
              <TextInput
                style={[
                  styles.sheetInput,
                  styles.sheetInputMultiline,
                  hasQuestions ? styles.sheetInputWarn : null,
                ]}
                value={questions}
                onChangeText={setQuestions}
                multiline
                placeholder="None"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="Blueprint open questions"
              />
            </Field>
          </ScrollView>

          <View style={styles.sheetActions}>
            <Pressable
              style={({ pressed }) => [styles.sheetSecondary, pressed ? styles.pressed : null]}
              onPress={() => onRefineAgain(edited())}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Refine again"
            >
              <Text style={styles.sheetSecondaryText}>Refine again</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.sheetPrimary, pressed ? styles.pressed : null]}
              onPress={() => onCreate(edited(), repo)}
              disabled={busy || title.trim().length === 0}
              accessibilityRole="button"
              accessibilityLabel="Create reviewed issue"
            >
              {busy ? (
                <ActivityIndicator size="small" color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.sheetPrimaryText}>Create issue</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function RepoChip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionChip,
        selected ? styles.optionChipActive : null,
        pressed ? styles.pressed : null,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={selected ? styles.optionTextActive : styles.optionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  // Mirrors AppHeader (_layout.tsx) so the overlay reads as part of the app chrome.
  header: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  headerSide: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  headerSideRight: { justifyContent: 'flex-end' },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: theme.spacing.md, gap: theme.spacing.xs, paddingBottom: theme.spacing.xl },
  loader: { marginTop: theme.spacing.xl },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    marginTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    marginBottom: theme.spacing.sm,
  },
  empty: {
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.text.md,
  },
  composerMic: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  composerActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  addButtonText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
  issueButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  issueButtonText: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '700' },
  refineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  refineButtonText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '700' },
  repoPicker: {
    gap: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionCount: { color: theme.colors.textFaint, fontSize: theme.text.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
  },
  rowMain: { flex: 1, padding: theme.spacing.md, gap: theme.spacing.xs },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  rowNumber: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '700' },
  rowTitle: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
  draftPill: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 1,
    backgroundColor: theme.colors.surfaceAlt,
  },
  draftPillText: { color: theme.colors.accent, fontSize: theme.text.xs, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs },
  chip: {
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipText: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  reorder: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
  },
  fieldEdit: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
  },
  optionChip: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  optionChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  optionText: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  optionTextActive: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '700' },
  pressed: { opacity: 0.62 },

  // Review sheet
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.scrim,
  },
  sheetCard: {
    maxHeight: '88%',
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  sheetScroll: { flexGrow: 0 },
  sheetScrollContent: { padding: theme.spacing.lg, gap: theme.spacing.md },
  field: { gap: theme.spacing.xs },
  fieldLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sheetInput: {
    backgroundColor: theme.colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.text.md,
    minHeight: 44,
  },
  sheetInputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  sheetInputWarn: { borderColor: theme.colors.tone.attention },
  sheetActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  sheetSecondary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  sheetSecondaryText: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  sheetDanger: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    minHeight: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.tone.danger,
  },
  sheetDangerText: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  sheetPrimary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  sheetPrimaryText: { color: theme.colors.onPrimary, fontSize: theme.text.md, fontWeight: '700' },
}));
