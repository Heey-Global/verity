import type { AssistantConversationItem, AssistantQuestion } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useVoiceInput } from '../hooks/useVoiceInput';
import { taskAccountScope } from '../lib/tasksStore';
import {
  answerVerity,
  discardOutgoing,
  dismissVerityNotice,
  retryOutgoing,
  sendToVerity,
  useVerity,
  type Outgoing,
  type VerityState,
} from '../lib/verityConversation';
import { subscribeVerityShortcut } from '../lib/voiceShortcut';
import { Button, CaptureField, Card, Sheet, SheetHeaderButton, StatusDot, Text } from './ui';
import { VerityMark } from './VerityMark';

/** Newest items shown in the panel; the full conversation is one tap away. */
const RECENT = 8;

/** How old a meeting still being readied may be to open by itself once it is ready. */
const RECENT_MEETING_MS = 2 * 60_000;

type MeetingItem = Extract<AssistantConversationItem, { kind: 'meeting' }>;

/** The live meeting screen for a meeting Verity prepared or joined, in her session. */
function meetingRoute(sessionId: string, item: MeetingItem) {
  return {
    pathname: '/meeting/[sessionId]' as const,
    params:
      item.action === 'join'
        ? { sessionId }
        : {
            sessionId,
            prepare: '1',
            // Each opening fills the screen in again, even for the same meeting.
            request: `${item.id}-${String(Date.now())}`,
            source: item.mode === 'online' ? 'online' : 'presence',
            ...(item.eventKey ? { eventKey: item.eventKey } : {}),
          },
  };
}

/** What the user had typed or dictated but not sent, kept across minimising,
 *  and only offered again in the account it was written in. */
let draft = { scope: null as string | null, text: '' };

/**
 * Verity's panel behind the V (docs/assistant.md): the one way to tell Verity
 * something, by voice or typing, and to answer her. Closing it minimises the
 * conversation; nothing Verity works on stops, and an open question waits here
 * and on Home.
 */
export function VerityPanel({
  mode,
  projectId,
  onClose,
}: {
  /** `voice` starts listening at once; `text` opens with the keyboard. */
  mode: 'voice' | 'text';
  /** The project on screen, offered to Verity as context. */
  projectId: string | null;
  onClose(): void;
}) {
  const verity = useVerity(true);
  const [text, setText] = useState(() => (draft.scope === taskAccountScope() ? draft.text : ''));
  const [sending, setSending] = useState(false);
  // State lags a fast double tap; this guards the second one.
  const sendingRef = useRef(false);
  const dictated = useRef(false);
  const voice = useVoiceInput(text, (value) => {
    if (value.trim()) dictated.current = true;
    setText(value);
  });
  const started = useRef(false);
  useEffect(() => {
    draft = { scope: taskAccountScope(), text };
  }, [text]);
  // The shortcut that opened the panel starts and stops dictation while it is open.
  useEffect(() => subscribeVerityShortcut(() => voice.toggle()), [voice]);
  useEffect(() => {
    if (started.current || mode !== 'voice') return;
    started.current = true;
    voice.toggle();
  }, [mode, voice]);

  // Send pressed while dictating: stop, and send once the final words are in.
  const sendWhenStopped = useRef(false);
  const send = async () => {
    if (voice.state === 'recording') {
      sendWhenStopped.current = true;
      voice.toggle();
      return;
    }
    const message = text.trim();
    if (!message || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // The outbox holds it from here on, so the field can clear even offline.
      setText('');
      draft = { scope: null, text: '' };
      await sendToVerity({
        text: message,
        input: dictated.current ? 'voice' : 'text',
        projectId,
      });
      dictated.current = false;
    } catch (error) {
      setText(message);
      Alert.alert('Not sent', error instanceof Error ? error.message : 'Try again');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  useEffect(() => {
    if (voice.state !== 'idle' || !sendWhenStopped.current) return;
    sendWhenStopped.current = false;
    // Dictation failed: the words may be cut short, so they wait for a look first.
    if (voice.error) return;
    void send();
  });

  const conversation = verity.conversation;
  const sessionId = conversation?.sessionId ?? null;
  const openMeeting = (item: MeetingItem) => {
    if (!sessionId) return;
    if (voice.state === 'recording') voice.toggle();
    onClose();
    router.push(meetingRoute(sessionId, item));
  };
  // A meeting Verity readies while the panel is open is what the user just asked for:
  // its screen opens by itself. Meetings already settled when the panel opened do not.
  const seenMeetings = useRef<Set<string> | null>(null);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    if (!conversation) return;
    const meetings = conversation.items.filter((item) => item.kind === 'meeting');
    if (seenMeetings.current === null) {
      // One still being readied moments ago is the one the user is waiting for; an older
      // pending one belongs to a turn they left, and must not pull them into it later.
      const recent = Date.now() - RECENT_MEETING_MS;
      seenMeetings.current = new Set(
        meetings
          .filter((item) => item.state !== 'pending' || item.at < recent)
          .map((item) => item.id),
      );
      return;
    }
    const fresh = meetings.find(
      (item) =>
        item.state === 'ready' &&
        !seenMeetings.current?.has(item.id) &&
        // A refresh can bring in a meeting readied long before, e.g. from the Watch.
        item.at >= openedAt.current - RECENT_MEETING_MS,
    );
    for (const item of meetings) if (item.state !== 'pending') seenMeetings.current.add(item.id);
    if (fresh) openMeeting(fresh);
  });
  return (
    <Sheet
      visible
      title="Verity"
      titleLeading={<VerityMark size={32} glow={false} />}
      headerAction={
        sessionId ? (
          <SheetHeaderButton
            icon="maximize-2"
            accessibilityLabel="Open full conversation"
            onPress={() => {
              onClose();
              router.push(`/session/${sessionId}`);
            }}
          />
        ) : undefined
      }
      onClose={() => {
        if (voice.state === 'recording') voice.toggle();
        onClose();
      }}
      footer={
        // The same field as "Tell Verity" on Home; listening shows here, once.
        <CaptureField
          value={text}
          onChangeText={(value) => {
            voice.onComposerEdit(value);
            setText(value);
          }}
          placeholder={voice.state === 'recording' ? 'Listening…' : 'Ask or tell Verity anything'}
          listening={voice.state === 'recording'}
          onMic={voice.toggle}
          onSend={() => void send()}
          sendDisabled={!text.trim() || sending}
          autoFocus={mode === 'text'}
          accessibilityLabel="Message to Verity"
        />
      }
    >
      <View style={styles.body}>
        <StateLine verity={verity} listening={voice.state === 'recording'} />
        {voice.error ? (
          <Text variant="subtitle" tone="attention">
            {voice.error} You can type instead.
          </Text>
        ) : null}
        {verity.notice ? (
          <Card>
            <Text variant="bodySmall">{verity.notice}</Text>
            <Button label="OK" variant="text" size="compact" onPress={dismissVerityNotice} />
          </Card>
        ) : null}
        {verity.outbox.map((entry) => (
          <OutgoingCard key={entry.requestId} entry={entry} />
        ))}
        {(conversation?.items ?? []).slice(-RECENT).map((item) => (
          <ItemView key={item.id} item={item} onOpenMeeting={sessionId ? openMeeting : null} />
        ))}
        {conversation?.question ? (
          <QuestionCard
            key={conversation.question.id}
            question={conversation.question}
            answering={verity.outbox.some(
              (entry) => entry.kind === 'answer' && entry.questionId === conversation.question?.id,
            )}
          />
        ) : null}
        {conversation && conversation.approvals.length > 0 && sessionId ? (
          <Card attention>
            <Text variant="row">Verity needs your approval</Text>
            <Text variant="subtitle">
              {conversation.approvals.length === 1
                ? 'One step waits for you, for example a mail to send.'
                : `${String(conversation.approvals.length)} steps wait for you.`}
            </Text>
            <Button
              label="Review"
              size="compact"
              onPress={() => {
                onClose();
                router.push(`/session/${sessionId}`);
              }}
            />
          </Card>
        ) : null}
      </View>
    </Sheet>
  );
}

function StateLine({ verity, listening }: { verity: VerityState; listening: boolean }) {
  // Listening is shown in the field below; a second line here repeated it.
  if (listening) return null;
  if (verity.access === 'denied')
    return (
      <Text variant="subtitle">
        Verity is available to administrators of this server. Ask one to give you access.
      </Text>
    );
  const conversation = verity.conversation;
  if (conversation === null)
    return verity.access === 'offline' ? (
      <StatusDot intent="unknown" label="Waiting for a connection" />
    ) : null;
  if (conversation.availability === 'disabled')
    return (
      <View style={styles.row}>
        <Text variant="subtitle" style={styles.flex}>
          Verity is switched off. What you say stays here to send once she is on.
        </Text>
        <Button
          label="Settings"
          variant="text"
          size="compact"
          onPress={() => router.push('/settings/assistant')}
        />
      </View>
    );
  if (conversation.availability === 'unavailable')
    return (
      <Text variant="subtitle">
        Verity&apos;s conversation is not available. Switch her on again in settings.
      </Text>
    );
  switch (conversation.state) {
    case 'working':
      return <StatusDot intent="transient" label="Working" />;
    case 'needs_you':
      return <StatusDot intent="needsSetup" label="Needs you" />;
    case 'failed':
      return <StatusDot intent="needsSetup" label="Stopped with an error" />;
    default:
      return <StatusDot intent="ready" label="Ready" />;
  }
}

function OutgoingCard({ entry }: { entry: Outgoing }) {
  const label = entry.kind === 'message' ? entry.text : `Answer: ${entry.labels.join(', ')}`;
  return (
    <Card muted>
      <Text variant="bodySmall" numberOfLines={3}>
        {label}
      </Text>
      <Text variant="footnote">{entry.error ?? 'Sending…'}</Text>
      {entry.held ? (
        <View style={styles.row}>
          <Button
            label="Retry"
            variant="secondary"
            size="compact"
            onPress={() => void retryOutgoing(entry.requestId)}
          />
          <Button
            label="Discard"
            variant="text"
            size="compact"
            onPress={() => void discardOutgoing(entry.requestId)}
          />
        </View>
      ) : null}
    </Card>
  );
}

function ItemView({
  item,
  onOpenMeeting,
}: {
  item: AssistantConversationItem;
  onOpenMeeting: ((item: MeetingItem) => void) | null;
}) {
  switch (item.kind) {
    case 'message':
      return (
        <View style={styles.mine}>
          <Text variant="bodySmall">{item.text}</Text>
        </View>
      );
    case 'reply':
      // Her words carry her mark, as her recommendations do on Home (§ 5.8).
      return (
        <View style={styles.reply} testID="verity-reply">
          <VerityMark size={22} glow={false} />
          <Text variant="body" style={styles.flex}>
            {item.text}
          </Text>
        </View>
      );
    case 'task':
      return (
        <Card>
          <Text variant="row">{item.title}</Text>
          <Text variant="subtitle">
            {item.state === 'saved'
              ? 'Saved as a task · no work started'
              : item.state === 'failed'
                ? 'Could not save the task'
                : 'Saving task…'}
          </Text>
        </Card>
      );
    case 'assignment':
      return (
        <Card>
          <Text variant="row">{item.title}</Text>
          <Text variant="subtitle">
            {item.state === 'sent'
              ? `Assigned${item.project ? ` · ${item.project}` : ''}`
              : item.state === 'failed'
                ? 'Not assigned'
                : 'Assigning…'}
          </Text>
        </Card>
      );
    case 'meeting':
      return (
        <Card>
          <Text variant="row">{item.title ?? 'Live meeting'}</Text>
          <Text variant="subtitle">
            {item.state === 'failed'
              ? item.action === 'join'
                ? 'Verity could not join'
                : 'Could not prepare the meeting'
              : item.state === 'pending'
                ? item.action === 'join'
                  ? 'Joining…'
                  : 'Preparing…'
                : item.action === 'join'
                  ? 'Verity joined the call'
                  : `Ready to start · ${item.mode === 'online' ? 'online' : 'in person'}`}
          </Text>
          {item.state !== 'pending' && onOpenMeeting ? (
            <Button
              label={
                item.action === 'join' && item.state === 'ready'
                  ? 'Open meeting'
                  : 'Open start screen'
              }
              size="compact"
              variant="secondary"
              onPress={() =>
                onOpenMeeting(
                  // A failed join still leaves the start screen to try by hand.
                  item.state === 'failed' && item.action === 'join'
                    ? { ...item, action: 'prepare' }
                    : item,
                )
              }
            />
          ) : null}
        </Card>
      );
    case 'error':
      return (
        <Text variant="subtitle" tone="attention">
          {item.text}
        </Text>
      );
  }
}

function QuestionCard({
  question,
  answering,
}: {
  question: AssistantQuestion;
  answering: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const answer = (labels: string[]) => {
    void answerVerity(question.id, labels).catch((error: unknown) =>
      Alert.alert('Not sent', error instanceof Error ? error.message : 'Try again'),
    );
  };
  return (
    <Card attention>
      <Text variant="row">{question.question ?? 'Verity asks'}</Text>
      <View style={styles.options}>
        {question.options.map((option) => {
          const selected = picked.includes(option.label);
          return (
            <Button
              key={option.label}
              label={option.label}
              size="compact"
              variant={question.multiSelect ? (selected ? 'primary' : 'secondary') : 'secondary'}
              disabled={answering}
              onPress={() =>
                question.multiSelect
                  ? setPicked((current) =>
                      selected
                        ? current.filter((label) => label !== option.label)
                        : [...current, option.label],
                    )
                  : answer([option.label])
              }
            />
          );
        })}
      </View>
      {question.multiSelect ? (
        <Button
          label="Send answer"
          size="compact"
          disabled={picked.length === 0 || answering}
          onPress={() => answer(picked)}
        />
      ) : null}
      <Text variant="footnote">Or answer in your own words below.</Text>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  reply: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  flex: { flex: 1 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  mine: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
}));
