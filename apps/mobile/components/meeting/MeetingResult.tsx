import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { LiveMeetingResult } from '@verity/mobile';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { Icon } from '../Icon';
import { Button, Card, IconButton, Row, SectionHeader, Text } from '../ui';
import { Disclosure } from '../ui/Disclosure';
import { tint } from '../ui/tint';
import type { AttachAnchor } from '../../lib/attachMenu';
import { createVerityClient, getActiveMeetingServerId } from '../../lib/client';
import { refreshTasks } from '../../lib/tasksStore';
import type { MeetingRecord } from '../../lib/liveMeetingStore';

type ResultItem = LiveMeetingResult['decisions'][number];

export function MeetingResult(props: {
  meeting: MeetingRecord;
  wide: boolean;
  people: number;
  notes: ReactNode;
  noteCount: number;
  /** An unfinished note is open: the section starts expanded so it cannot be missed. */
  notesOpen?: boolean;
  speakers: ReactNode;
  answers: ReactNode;
  answerCount: number;
  status: ReactNode;
  bottomInset: number;
  onEditTitle: () => void;
  /** Whether this device may rename the meeting; hides the menu entry otherwise. */
  canRename?: boolean;
  onTranscript: () => void;
  onShare: (format: 'markdown' | 'pdf') => void;
  onDiscard: () => void;
  onContinue: () => void;
  onDone: () => void;
  onResearch: (question: string) => void;
}) {
  const { meeting } = props;
  const [result, setResult] = useState<LiveMeetingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const locked = useRef(false);
  const { theme } = useUnistyles();
  const menuAnchor = useRef<View>(null);
  const [menu, setMenu] = useState<AttachAnchor | null>(null);
  // Opens for an unfinished note, e.g. after a failed save, and stays open once saved.
  const [notesExpanded, setNotesExpanded] = useState(props.notesOpen ?? false);
  useEffect(() => {
    if (props.notesOpen) setNotesExpanded(true);
  }, [props.notesOpen]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setResult(null);
    const poll = async () => {
      try {
        if (meeting.serverId && meeting.serverId !== getActiveMeetingServerId())
          throw new Error('Reconnect to this meeting’s server.');
        const client = createVerityClient();
        if (!client) throw new Error('Connect to your server to load the meeting result.');
        const next = await client.getLiveMeetingResult(meeting.sessionId, meeting.id);
        if (!disposed) {
          setResult(next);
          setError(null);
        }
      } catch (reason) {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : 'Could not load the meeting result.');
      } finally {
        if (!disposed)
          timer = setTimeout(() => {
            void poll();
          }, 3000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [meeting.id, meeting.sessionId, meeting.revision]);
  const act = async (key: string, action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(key);
    try {
      await action();
    } catch (reason) {
      Alert.alert('Could not save', reason instanceof Error ? reason.message : 'Please try again.');
    } finally {
      locked.current = false;
      setBusy(null);
    }
  };
  const taskAction = (task: LiveMeetingResult['tasks'][number], state: 'added' | 'dismissed') => {
    void act(task.id, async () => {
      if (!result) return;
      if (meeting.serverId && meeting.serverId !== getActiveMeetingServerId())
        throw new Error('Reconnect to this meeting’s server.');
      const client = createVerityClient();
      if (!client) throw new Error('Connect to your server first.');
      setResult(
        await client.updateLiveMeetingResultTask(
          meeting.sessionId,
          meeting.id,
          task.id,
          state === 'added'
            ? { revision: result.revision, state, taskId: task.taskId || task.id }
            : { revision: result.revision, state },
        ),
      );
      if (state === 'added') void refreshTasks(true).catch(() => undefined);
    });
  };
  const evidence = (item: ResultItem) => {
    const name =
      item.speaker === null
        ? ''
        : meeting.speakerNames?.[item.speaker] || `Speaker ${item.speaker + 1}`;
    const time =
      item.atSeconds === null
        ? ''
        : new Date(meeting.startedAt + item.atSeconds * 1000).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
    return (
      <Text variant="footnote">{[name, time, `“${item.quote}”`].filter(Boolean).join(' · ')}</Text>
    );
  };
  const addAll = () => {
    void act('all', async () => {
      if (meeting.serverId && meeting.serverId !== getActiveMeetingServerId())
        throw new Error('Reconnect to this meeting’s server.');
      const client = createVerityClient();
      if (!client) throw new Error('Connect to your server first.');
      let current = result;
      try {
        // One at a time: every change bumps the result revision the next one must name.
        for (const { id } of current?.tasks ?? []) {
          // Decide from the latest result: another device may have dismissed it meanwhile.
          const task = current?.tasks.find((candidate) => candidate.id === id);
          if (!current || task?.state !== 'proposed') continue;
          current = await client.updateLiveMeetingResultTask(
            meeting.sessionId,
            meeting.id,
            task.id,
            {
              revision: current.revision,
              state: 'added',
              taskId: task.taskId || task.id,
            },
          );
          setResult(current);
        }
      } finally {
        // Tasks added before a failure must still show up in the task list.
        void refreshTasks(true).catch(() => undefined);
      }
    });
  };
  const ready = result?.status === 'ready';
  const minutes = Math.max(
    1,
    Math.round(((meeting.endedAt ?? meeting.startedAt) - meeting.startedAt) / 60000),
  );
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const meta = [
    new Date(meeting.startedAt).toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }),
    `${time(meeting.startedAt)}${meeting.endedAt ? `–${time(meeting.endedAt)}` : ''}`,
    `${minutes} min`,
    `${props.people} ${props.people === 1 ? 'person' : 'people'}`,
  ].join(' · ');
  const review = ready ? result.tasks.filter((task) => task.state !== 'dismissed') : [];
  const proposed = review.filter((task) => task.state === 'proposed').length;
  const openMenu = () =>
    menuAnchor.current?.measureInWindow((x, y, width, height) => setMenu({ x, y, width, height }));
  const share = (format: 'markdown' | 'pdf') => props.onShare(format);

  const decisions =
    ready && result.decisions.length
      ? result.decisions.map((item) => (
          <Card key={item.id} stacked>
            <Text>{item.text}</Text>
            {evidence(item)}
          </Card>
        ))
      : null;
  const questions =
    ready && result.openQuestions.length
      ? result.openQuestions.map((item) => (
          <Card key={item.id} stacked>
            <Text>{item.text}</Text>
            {evidence(item)}
            <Button
              label="Let Verity research"
              size="compact"
              variant="secondary"
              onPress={() => props.onResearch(item.text)}
            />
          </Card>
        ))
      : null;
  // Everything after the summary and the review is reference material: collapsed with
  // a count, so the first screen shows what was concluded and what needs a decision.
  const sections = (
    <Card flush>
      {!props.wide && decisions ? (
        <Disclosure title={`Decisions · ${result!.decisions.length}`}>
          <View style={styles.stack}>{decisions}</View>
        </Disclosure>
      ) : null}
      {questions ? (
        <Disclosure title={`Open questions · ${result!.openQuestions.length}`}>
          <View style={styles.stack}>{questions}</View>
        </Disclosure>
      ) : null}
      {props.notes ? (
        <Disclosure
          title={props.noteCount ? `Your notes · ${props.noteCount}` : 'Your notes'}
          expanded={notesExpanded}
          onExpandedChange={setNotesExpanded}
        >
          {props.notes}
        </Disclosure>
      ) : null}
      {props.answerCount ? (
        <Disclosure title={`Verity’s answers · ${props.answerCount}`}>{props.answers}</Disclosure>
      ) : null}
      {props.speakers ? (
        <Disclosure title={`People · ${props.people}`}>{props.speakers}</Disclosure>
      ) : null}
      <Row
        title="Transcript"
        accessibilityLabel="Open full transcript"
        onPress={props.onTranscript}
      />
    </Card>
  );

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.page,
          { paddingBottom: (props.wide ? 0 : 88) + props.bottomInset + 24 },
        ]}
      >
        <View style={styles.toolbar}>
          <Button label="Done" variant="text" size="compact" onPress={props.onDone} />
          <View style={styles.grow} />
          <IconButton
            icon="share"
            accessibilityLabel="Share meeting"
            onPress={() =>
              Alert.alert('Share meeting', 'Choose a format.', [
                { text: 'Markdown', onPress: () => share('markdown') },
                { text: 'PDF', onPress: () => share('pdf') },
                { text: 'Cancel', style: 'cancel' },
              ])
            }
          />
          <View ref={menuAnchor} collapsable={false}>
            <IconButton
              icon="more-horizontal"
              accessibilityLabel="Meeting actions"
              onPress={openMenu}
            />
          </View>
          {props.wide ? (
            <Button label="Continue in chat" size="compact" onPress={props.onContinue} />
          ) : null}
        </View>
        <View style={styles.heading}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit meeting title"
            onPress={props.onEditTitle}
          >
            <Text variant="display">{meeting.title || result?.title || 'Meeting'}</Text>
          </Pressable>
          <Text variant="subtitle">{meta}</Text>
        </View>
        <View
          style={[styles.columns, props.wide && styles.wide]}
          testID={props.wide ? 'meeting-result-wide' : 'meeting-result-stacked'}
        >
          <View style={[styles.main, props.wide && styles.mainWide]}>
            <View style={styles.summary}>
              <View style={styles.summaryHead}>
                <Image source={MARK} accessibilityIgnoresInvertColors style={styles.mark} />
                <Text variant="row">Summary</Text>
              </View>
              {ready ? (
                <Text>{result.summary}</Text>
              ) : result?.status === 'failed' ? (
                <>
                  <Text>Verity could not summarize this meeting.</Text>
                  <Button
                    label="Retry summary"
                    loading={busy === 'retry'}
                    onPress={() => {
                      void act('retry', async () => {
                        if (meeting.serverId && meeting.serverId !== getActiveMeetingServerId())
                          throw new Error('Reconnect to this meeting’s server.');
                        const client = createVerityClient();
                        if (!client) throw new Error('Connect to your server first.');
                        await client.retryLiveMeetingResult(meeting.sessionId, meeting.id);
                        setResult({ ...result, status: 'working' });
                      });
                    }}
                  />
                </>
              ) : (
                <View style={styles.inline}>
                  <ActivityIndicator />
                  <Text>Verity is summarizing…</Text>
                </View>
              )}
              {error ? <Text tone="attention">{error}</Text> : null}
              {props.status}
            </View>
            {review.length ? (
              <Card flush>
                <View style={styles.reviewHead}>
                  <Text variant="row" style={styles.grow}>
                    {proposed ? `To review · ${proposed}` : 'Tasks'}
                  </Text>
                  {proposed > 1 ? (
                    <Button
                      label="Add all"
                      variant="text"
                      size="compact"
                      loading={busy === 'all'}
                      disabled={busy !== null}
                      onPress={addAll}
                    />
                  ) : null}
                </View>
                {review.map((task) => {
                  const added = task.state === 'added';
                  return (
                    <View key={task.id} style={styles.reviewRow}>
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Add task: ${task.text}`}
                        accessibilityState={{ checked: added, disabled: added || busy !== null }}
                        disabled={added || busy !== null}
                        hitSlop={8}
                        onPress={() => taskAction(task, 'added')}
                        style={[styles.check, added && styles.checkOn]}
                      >
                        {busy === task.id ? (
                          <ActivityIndicator size="small" />
                        ) : added ? (
                          <Icon name="check" size={14} color={theme.colors.background} />
                        ) : null}
                      </Pressable>
                      <View style={styles.grow}>
                        <Text>{task.text}</Text>
                        {added ? <Text tone="muted">Added to tasks</Text> : evidence(task)}
                      </View>
                      {added ? null : (
                        <Button
                          label="Not a task"
                          size="compact"
                          variant="text"
                          disabled={busy !== null}
                          onPress={() => taskAction(task, 'dismissed')}
                        />
                      )}
                    </View>
                  );
                })}
              </Card>
            ) : null}
            {props.wide && decisions ? (
              <>
                <SectionHeader title={`DECISIONS · ${result!.decisions.length}`} />
                {decisions}
              </>
            ) : null}
            {props.wide ? null : sections}
          </View>
          {props.wide ? <View style={styles.side}>{sections}</View> : null}
        </View>
      </ScrollView>
      {props.wide ? null : (
        <View style={[styles.dock, { paddingBottom: props.bottomInset + 16 }]}>
          <Button label="Continue in chat" onPress={props.onContinue} />
        </View>
      )}
      {menu ? (
        <ActionMenu
          anchor={menu}
          label="Meeting actions"
          onClose={() => setMenu(null)}
          items={[
            ...(props.canRename === false
              ? []
              : ([
                  {
                    icon: 'edit-2',
                    title: 'Rename meeting',
                    subtitle: 'The title appears in the filed meeting',
                    onPress: () => {
                      setMenu(null);
                      props.onEditTitle();
                    },
                  },
                ] satisfies ActionMenuItem[])),
            {
              icon: 'share',
              title: 'Share as Markdown',
              subtitle: 'Summary, notes and transcript as text',
              onPress: () => {
                setMenu(null);
                share('markdown');
              },
            },
            {
              icon: 'file-text',
              title: 'Share as PDF',
              subtitle: 'The same content as a document',
              onPress: () => {
                setMenu(null);
                share('pdf');
              },
            },
            {
              icon: 'trash-2',
              title: 'Discard meeting…',
              subtitle: meeting.serverId
                ? 'Deletes it here and on the server'
                : 'Deletes it from this device',
              destructive: true,
              onPress: () => {
                setMenu(null);
                props.onDiscard();
              },
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/** Names exactly what discarding deletes, and what stays. */
export function discardMessage(notes: number, shared: boolean): string {
  const parts = [
    'the transcript',
    notes ? (notes === 1 ? 'your note' : `your ${notes} notes`) : null,
    'the summary',
  ].filter((part): part is string => part !== null);
  const list =
    parts.length === 2
      ? parts.join(' and ')
      : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Deletes ${list} ${shared ? 'on this device and the server' : 'on this device'}. Tasks you added and chat messages stay. This cannot be undone.`;
}

const MARK = require('../../assets/brand/verity-v-mark.png') as number;
// The mark's artwork is wider than tall.
const MARK_RATIO = 240 / 168;

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  page: {
    width: '100%',
    maxWidth: 1200,
    alignSelf: 'center',
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  heading: { gap: theme.spacing.xs },
  grow: { flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  columns: { gap: theme.spacing.lg },
  wide: { flexDirection: 'row', alignItems: 'flex-start' },
  main: { gap: theme.spacing.md },
  mainWide: { flex: 3 },
  side: { flex: 2, gap: theme.spacing.md },
  stack: { gap: theme.spacing.sm },
  // Verity's own words carry the signature edge, like her pane in the live meeting.
  summary: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: tint(theme.colors.signature, 'border'),
    backgroundColor: theme.colors.surface,
  },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  mark: { width: 20, height: 20 / MARK_RATIO },
  reviewHead: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: theme.spacing.lg,
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: theme.colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: theme.colors.action },
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
}));
