import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  subscribeMeeting,
} from '../../lib/liveMeetingSession';
import { liveMeetingSTT, type STTEngine, type STTEngineId } from '../../lib/liveMeetingSTT';
import {
  listMeetings,
  listNotes,
  saveNote,
  type MeetingNote,
  type MeetingRecord,
} from '../../lib/liveMeetingStore';

const ACCENT = '#bd8bff';
const TEXT = '#eee9f7';
const MUTED = '#aaa2ba';
const CARD = '#1b1928';
const pendingDrafts = new Map<string, MeetingNote>();
const pendingNoteErrors = new Map<string, string>();
const pendingNoteWrites = new Map<string, Promise<void>>();
const pendingNoteListeners = new Set<(meetingId: string) => void>();

function publishPendingNote(meetingId: string) {
  for (const listener of pendingNoteListeners) listener(meetingId);
}

function elapsed(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function MeetingScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const insets = useSafeAreaInsets();
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<MeetingRecord[]>([]);
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const [draft, setDraft] = useState<MeetingNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteSaveError, setNoteSaveError] = useState<{ meetingId: string; message: string } | null>(
    null,
  );
  const [engines, setEngines] = useState<STTEngine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<STTEngineId>('fluid-nemotron');
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteSaveErrorRef = useRef<string | null>(null);
  const displayedMeetingId = useRef<string | null>(null);
  displayedMeetingId.current = meeting?.id ?? null;
  const transcriptList = useRef<FlatList<string>>(null);
  const transcriptAtEnd = useRef(true);

  useEffect(() => {
    const listener = (meetingId: string) => {
      if (displayedMeetingId.current !== meetingId) return;
      const pending = pendingDrafts.get(meetingId) ?? null;
      setDraft(pending);
      if (pending) {
        setNotes((current) =>
          [...current.filter((note) => note.id !== pending.id), pending].sort(
            (a, b) => a.atSeconds - b.atSeconds,
          ),
        );
      }
      void listNotes(meetingId)
        .then((saved) => {
          if (displayedMeetingId.current !== meetingId) return;
          setNotes((current) => {
            const merged = new Map(saved.map((note) => [note.id, note]));
            for (const note of current) if (note.meetingId === meetingId) merged.set(note.id, note);
            const latest = pendingDrafts.get(meetingId);
            if (latest) merged.set(latest.id, latest);
            return [...merged.values()].sort((a, b) => a.atSeconds - b.atSeconds);
          });
        })
        .catch((reason) => setError(String(reason)));
      const message = pendingNoteErrors.get(meetingId) ?? null;
      noteSaveErrorRef.current = message;
      setNoteSaveError(message ? { meetingId, message } : null);
      setError(
        (current) => message ?? (current?.startsWith('Note could not be saved:') ? null : current),
      );
    };
    pendingNoteListeners.add(listener);
    return () => {
      pendingNoteListeners.delete(listener);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const saved = await listMeetings(sessionId);
    setHistory(saved);
    setMeeting(
      (current) =>
        current ??
        (currentMeeting()?.sessionId === sessionId ? currentMeeting() : (saved[0] ?? null)),
    );
  }, [sessionId]);

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    return subscribeMeeting((active) => {
      if (active?.sessionId === sessionId && (selectedId === null || selectedId === active.id)) {
        setMeeting(active);
      }
      if (active?.state === 'ended' || active?.state === 'interrupted') {
        void refresh().catch((reason) => setError(String(reason)));
      }
    });
  }, [refresh, selectedId, sessionId]);

  useEffect(() => {
    if (!meeting) return;
    let current = true;
    setNotes([]);
    void listNotes(meeting.id)
      .then((saved) => {
        if (!current) return;
        setNotes((shown) => {
          const merged = new Map(saved.map((note) => [note.id, note]));
          for (const note of shown) {
            if (note.meetingId === meeting.id) merged.set(note.id, note);
          }
          const pending = pendingDrafts.get(meeting.id);
          if (pending) merged.set(pending.id, pending);
          return [...merged.values()].sort((a, b) => a.atSeconds - b.atSeconds);
        });
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    setDraft(pendingDrafts.get(meeting.id) ?? null);
    const noteError = pendingNoteErrors.get(meeting.id) ?? null;
    noteSaveErrorRef.current = noteError;
    setNoteSaveError(noteError ? { meetingId: meeting.id, message: noteError } : null);
    return () => {
      current = false;
    };
  }, [meeting?.id]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void liveMeetingSTT
      ?.engines()
      .then(setEngines)
      .catch((reason) => setError(String(reason)));
  }, []);

  const chunks = useMemo(() => {
    const text = meeting?.transcript ?? '';
    const result: string[] = [];
    for (let start = 0; start < text.length; start += 900)
      result.push(text.slice(start, start + 900));
    return result;
  }, [meeting?.transcript]);

  const start = async () => {
    if (!sessionId || busy) return;
    const existing = currentMeeting();
    if (existing?.state === 'active') {
      if (existing.sessionId !== sessionId) {
        Alert.alert(
          'Meeting already active',
          'Finish the current meeting before starting another.',
        );
      } else {
        setSelectedId(null);
        setMeeting(existing);
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await startMeeting(sessionId, selectedEngine);
      setSelectedId(null);
      setMeeting(next);
      setShowNewMeeting(false);
      await refresh();
    } catch (reason) {
      setError(String(reason));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await pendingNoteWrites.get(meeting?.id ?? '');
      await endMeeting();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (busy || !meeting) return;
    setBusy(true);
    try {
      if (meeting.captureStatus === 'paused') await resumeMeeting();
      else await pauseMeeting();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const editNote = (value: string) => {
    if (!meeting || (meeting.state !== 'active' && !draft)) return;
    const note = draft ?? {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      meetingId: meeting.id,
      atSeconds: (Date.now() - meeting.startedAt) / 1000,
      text: '',
    };
    const edited = { ...note, text: value };
    pendingDrafts.set(meeting.id, edited);
    publishPendingNote(meeting.id);
    setDraft(edited);
    setNotes((current) =>
      [...current.filter((entry) => entry.id !== edited.id), edited].sort(
        (a, b) => a.atSeconds - b.atSeconds,
      ),
    );
    queueNoteSave(edited);
  };

  const queueNoteSave = (note: MeetingNote, finishAfterSave = false) => {
    const next = saveNote(note);
    const completed = next.then(
      () => {
        const latest = pendingDrafts.get(note.meetingId);
        if (latest?.id === note.id && latest.text !== note.text) return;
        pendingNoteErrors.delete(note.meetingId);
        if (finishAfterSave && latest?.id === note.id) pendingDrafts.delete(note.meetingId);
        publishPendingNote(note.meetingId);
      },
      (reason) => {
        const latest = pendingDrafts.get(note.meetingId);
        if (latest?.id === note.id && latest.text !== note.text) return;
        const message = `Note could not be saved: ${String(reason)}`;
        pendingNoteErrors.set(note.meetingId, message);
        publishPendingNote(note.meetingId);
      },
    );
    const previous = pendingNoteWrites.get(note.meetingId) ?? Promise.resolve();
    const tail = Promise.all([previous, completed]).then(() => undefined);
    pendingNoteWrites.set(note.meetingId, tail);
    void tail.then(() => {
      if (pendingNoteWrites.get(note.meetingId) === tail) pendingNoteWrites.delete(note.meetingId);
    });
  };

  const submitNote = () => {
    if (!draft) return;
    if (noteUnsaved) {
      queueNoteSave(draft, true);
      return;
    }
    if (!draft.text.trim()) return;
    const completion = pendingNoteWrites.get(draft.meetingId) ?? Promise.resolve();
    const completing = draft;
    void completion.then(() => {
      const latest = pendingDrafts.get(completing.meetingId);
      if (
        (pendingNoteWrites.get(completing.meetingId) &&
          pendingNoteWrites.get(completing.meetingId) !== completion) ||
        pendingNoteErrors.has(completing.meetingId) ||
        latest?.id !== completing.id ||
        latest.text !== completing.text
      )
        return;
      pendingDrafts.delete(completing.meetingId);
      publishPendingNote(completing.meetingId);
      setDraft((current) =>
        current?.id === completing.id && current.text === completing.text ? null : current,
      );
    });
  };

  const runningMeeting = currentMeeting();
  const active = meeting?.state === 'active' && runningMeeting?.id === meeting.id;
  const noteUnsaved = noteSaveError?.meetingId === meeting?.id;
  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 12 }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable onPress={() => router.back()} accessibilityRole="button">
        <Text style={styles.back}>‹ Back to session</Text>
      </Pressable>
      <View style={styles.header}>
        <Text style={styles.title}>Live Meeting</Text>
        {active ? (
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Minimize meeting"
          >
            <Text style={styles.minimize}>⌄</Text>
          </Pressable>
        ) : null}
      </View>
      {error || meeting?.error ? <Text style={styles.error}>{error ?? meeting?.error}</Text> : null}
      <Text
        style={[
          styles.status,
          meeting?.captureStatus === 'paused' && styles.statusPaused,
          (noteUnsaved || meeting?.state === 'interrupted') && styles.statusError,
        ]}
      >
        {noteUnsaved
          ? active
            ? '● Recording · note not saved'
            : `${meeting?.state === 'interrupted' ? 'Interrupted' : 'Ended'} · note not saved`
          : active
            ? meeting.captureStatus === 'paused'
              ? `Ⅱ Paused   ${elapsed(meeting.startedAt, now)}   Saved on this device`
              : meeting.captureStatus === 'downloading'
                ? 'Preparing language model…'
                : meeting.captureStatus === 'preparing'
                  ? 'Preparing microphone…'
                  : `● Transcribing   ${elapsed(meeting.startedAt, now)}   Saving on this device`
            : meeting
              ? meeting.state === 'interrupted'
                ? meeting.error?.startsWith('Local save failed')
                  ? 'Interrupted · local save failed'
                  : 'Interrupted · saved locally'
                : 'Ended · saved locally'
              : 'Ready to record'}
      </Text>
      {meeting ? (
        <>
          <View style={styles.card}>
            <Text style={styles.section}>Live transcript</Text>
            <FlatList
              ref={transcriptList}
              testID="meeting-transcript"
              style={styles.transcript}
              data={chunks}
              keyExtractor={(_, index) => String(index)}
              renderItem={({ item }) => <Text style={styles.transcriptText}>{item}</Text>}
              ListEmptyComponent={
                <Text style={styles.muted}>Recognized speech will appear here.</Text>
              }
              onScrollBeginDrag={() => {
                transcriptAtEnd.current = false;
              }}
              onScrollEndDrag={({ nativeEvent }) => {
                const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
                transcriptAtEnd.current =
                  contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
              }}
              onMomentumScrollEnd={({ nativeEvent }) => {
                const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
                transcriptAtEnd.current =
                  contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
              }}
              scrollEventThrottle={100}
              onContentSizeChange={() => {
                if (transcriptAtEnd.current)
                  transcriptList.current?.scrollToEnd({ animated: true });
              }}
            />
          </View>
          <View style={styles.card}>
            <Text style={styles.section}>Meeting notes</Text>
            <ScrollView style={styles.notes} keyboardShouldPersistTaps="handled">
              {notes
                .filter((note) => !(active || noteUnsaved) || note.id !== draft?.id)
                .map((note) => (
                  <Text key={note.id} testID="meeting-note" style={styles.note}>
                    <Text style={styles.noteTime}>{elapsed(0, note.atSeconds * 1000)} </Text>
                    {note.text}
                  </Text>
                ))}
            </ScrollView>
            {active || noteUnsaved ? (
              <View style={styles.composer}>
                <TextInput
                  accessibilityLabel="Add a meeting note"
                  placeholder="Add a note…"
                  placeholderTextColor={MUTED}
                  multiline
                  submitBehavior="submit"
                  value={draft?.text ?? ''}
                  onChangeText={editNote}
                  onSubmitEditing={submitNote}
                  style={styles.input}
                />
                <Pressable
                  onPress={submitNote}
                  accessibilityRole="button"
                  accessibilityLabel={noteUnsaved ? 'Retry saving note' : 'Add note'}
                  style={styles.addNote}
                >
                  <Text style={styles.addNoteText}>{noteUnsaved ? '↻' : '+'}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
          {active ? (
            <View style={styles.controls}>
              <Pressable
                disabled={
                  busy ||
                  (meeting.captureStatus !== 'paused' && meeting.captureStatus !== 'listening')
                }
                onPress={togglePause}
                style={[styles.button, styles.pauseButton]}
                accessibilityRole="button"
              >
                <Text style={styles.pauseButtonText}>
                  {meeting.captureStatus === 'paused' ? '▶  Resume' : 'Ⅱ  Pause'}
                </Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={end}
                style={[styles.button, styles.endButton]}
                accessibilityRole="button"
              >
                <Text style={styles.buttonText}>End meeting</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
      {!active && (!meeting || showNewMeeting) ? (
        <View>
          <Text style={styles.section}>Engine for next meeting</Text>
          {engines.map((engine) => (
            <Pressable
              key={engine.id}
              accessibilityRole="radio"
              accessibilityState={{
                selected: selectedEngine === engine.id,
                disabled: !engine.available,
              }}
              disabled={!engine.available || busy}
              onPress={() => setSelectedEngine(engine.id)}
              style={styles.engineChoice}
            >
              <Text style={{ color: selectedEngine === engine.id ? ACCENT : TEXT }}>
                {selectedEngine === engine.id ? '● ' : '○ '}
                {engine.name}
                {engine.available ? '' : ' · unavailable'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {!active && (!meeting || showNewMeeting) ? (
        <Pressable disabled={busy} onPress={start} style={[styles.button, styles.startButton]}>
          {busy ? (
            <ActivityIndicator color={TEXT} />
          ) : (
            <Text style={[styles.buttonText, styles.startButtonText]}>
              {runningMeeting?.state === 'active' && runningMeeting.sessionId === sessionId
                ? 'Return to live meeting'
                : 'Start meeting'}
            </Text>
          )}
        </Pressable>
      ) : null}
      {!active && meeting && !showNewMeeting ? (
        <Pressable onPress={() => setShowNewMeeting(true)} accessibilityRole="button">
          <Text style={styles.link}>Start another meeting</Text>
        </Pressable>
      ) : null}
      {history.length > 1 || (history.length === 1 && !meeting) ? (
        <View style={styles.history}>
          <Text style={styles.section}>Earlier meetings</Text>
          <ScrollView>
            {history
              .filter((item) => item.id !== meeting?.id)
              .map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    const running = currentMeeting();
                    setSelectedId(item.id === running?.id ? null : item.id);
                    setMeeting(item.id === running?.id ? running : item);
                  }}
                >
                  <Text style={styles.link}>
                    {new Date(item.startedAt).toLocaleString()} · {item.state}
                  </Text>
                </Pressable>
              ))}
          </ScrollView>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    padding: 16,
    backgroundColor: '#0e0c16',
    gap: 14,
  },
  back: { color: '#c6bdd8', fontSize: 14, paddingVertical: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: TEXT, fontSize: 28, fontWeight: '700' },
  minimize: { color: TEXT, fontSize: 28, paddingHorizontal: 8 },
  muted: { color: MUTED },
  status: { color: '#a8f4c5', fontSize: 13 },
  statusPaused: { color: '#f3c579' },
  statusError: { color: '#ffaba5' },
  card: {
    flex: 1,
    minHeight: 120,
    backgroundColor: CARD,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#433a5c',
    padding: 16,
    gap: 12,
  },
  section: { color: TEXT, fontSize: 18, fontWeight: '700' },
  transcript: { flex: 1 },
  transcriptText: { color: TEXT, fontSize: 16, lineHeight: 25 },
  notes: { flex: 1, minHeight: 40 },
  note: { color: TEXT, paddingVertical: 14, borderBottomWidth: 1, borderColor: '#393349' },
  noteTime: { color: '#a89bc6' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#262238',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#433a5c',
  },
  input: {
    flex: 1,
    color: TEXT,
    minHeight: 48,
    maxHeight: 110,
    padding: 12,
  },
  addNote: {
    backgroundColor: ACCENT,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  addNoteText: { color: '#130f1e', fontSize: 26, lineHeight: 30 },
  button: {
    backgroundColor: '#291b28',
    borderColor: '#a9475d',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  controls: { flexDirection: 'row', gap: 10 },
  pauseButton: { flex: 1, backgroundColor: CARD, borderColor: '#655b82' },
  endButton: { flex: 1 },
  pauseButtonText: { color: TEXT, fontWeight: '700' },
  buttonText: { color: '#ff6878', fontWeight: '700' },
  startButton: { backgroundColor: '#7146a7', borderColor: '#7146a7' },
  startButtonText: { color: TEXT },
  link: { color: ACCENT, paddingVertical: 8 },
  error: { color: '#ffaba5' },
  history: { maxHeight: 160 },
  engineChoice: { paddingVertical: 5 },
});
