import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { LiveMeetingResult } from '@verity/mobile';
import { Button, Card, Row, SectionHeader, Text } from '../ui';
import { createVerityClient, getActiveMeetingServerId } from '../../lib/client';
import { refreshTasks } from '../../lib/tasksStore';
import type { MeetingRecord } from '../../lib/liveMeetingStore';

type ResultItem = LiveMeetingResult['decisions'][number];

export function MeetingResult(props: {
  meeting: MeetingRecord;
  wide: boolean;
  people: number;
  notes: ReactNode;
  speakers: ReactNode;
  answers: ReactNode;
  status: ReactNode;
  bottomInset: number;
  onEditTitle: () => void;
  onTranscript: () => void;
  onShare: () => void;
  onContinue: () => void;
  onDone: () => void;
  onResearch: (question: string) => void;
}) {
  const { meeting } = props;
  const [result, setResult] = useState<LiveMeetingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const locked = useRef(false);
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
  const ready = result?.status === 'ready';
  const minutes = Math.max(
    1,
    Math.round(((meeting.endedAt ?? meeting.startedAt) - meeting.startedAt) / 60000),
  );
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.bottomInset + 24 }]}>
      <View style={styles.header}>
        <View style={styles.grow}>
          <Button
            label={meeting.title || result?.title || 'Meeting'}
            accessibilityLabel="Edit meeting title"
            variant="text"
            onPress={props.onEditTitle}
          />
          <Text variant="subtitle">
            {new Date(meeting.startedAt).toLocaleDateString()} ·{' '}
            {new Date(meeting.startedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {meeting.endedAt
              ? `–${new Date(meeting.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''}{' '}
            · {minutes} min · {props.people} people
          </Text>
        </View>
        <Button label="Continue in chat" size="compact" onPress={props.onContinue} />
        <Button label="Done" size="compact" variant="text" onPress={props.onDone} />
      </View>
      <View
        style={[styles.columns, props.wide && styles.wide]}
        testID={props.wide ? 'meeting-result-wide' : 'meeting-result-stacked'}
      >
        <View style={[styles.main, props.wide && styles.column]}>
          <Card stacked>
            <Text variant="title">Verity</Text>
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
              <View style={styles.header}>
                <ActivityIndicator />
                <Text>Verity is summarizing…</Text>
              </View>
            )}
            {error ? <Text tone="attention">{error}</Text> : null}
            {props.status}
          </Card>
          {ready && result.decisions.length ? (
            <>
              <SectionHeader title="DECISIONS" />
              {result.decisions.map((item) => (
                <Card key={item.id} stacked>
                  <Text>{item.text}</Text>
                  {evidence(item)}
                </Card>
              ))}
            </>
          ) : null}
          {ready && result.tasks.some((task) => task.state !== 'dismissed') ? (
            <>
              <SectionHeader title="TASKS" />
              {result.tasks
                .filter((task) => task.state !== 'dismissed')
                .map((task) => (
                  <Card key={task.id} stacked>
                    <Text>{task.text}</Text>
                    {evidence(task)}
                    {task.state === 'added' ? (
                      <Text tone="muted">Added to tasks</Text>
                    ) : (
                      <View style={styles.header}>
                        <Button
                          label="Add task"
                          size="compact"
                          loading={busy === task.id}
                          disabled={busy !== null}
                          onPress={() => taskAction(task, 'added')}
                        />
                        <Button
                          label="Not a task"
                          size="compact"
                          variant="text"
                          disabled={busy !== null}
                          onPress={() => taskAction(task, 'dismissed')}
                        />
                      </View>
                    )}
                  </Card>
                ))}
            </>
          ) : null}
          {ready && result.openQuestions.length ? (
            <>
              <SectionHeader title="OPEN QUESTIONS" />
              {result.openQuestions.map((item) => (
                <Card key={item.id} stacked>
                  <Text>{item.text}</Text>
                  {evidence(item)}
                  <Button
                    label="Let Verity research"
                    size="compact"
                    onPress={() => props.onResearch(item.text)}
                  />
                </Card>
              ))}
            </>
          ) : null}
          {props.answers}
        </View>
        <View style={[styles.side, props.wide && styles.column]}>
          {props.notes}
          {props.speakers}
          <Card flush>
            <Row
              title="Transcript"
              accessibilityLabel="Open full transcript"
              onPress={props.onTranscript}
            />
          </Card>
          <Card flush>
            <Row title="Share" onPress={props.onShare} />
          </Card>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { padding: theme.spacing.md, gap: theme.spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing.sm },
  grow: { flex: 1 },
  column: { flex: 1 },
  columns: { gap: theme.spacing.lg },
  wide: { flexDirection: 'row', alignItems: 'flex-start' },
  main: { gap: theme.spacing.sm },
  side: { gap: theme.spacing.sm },
}));
