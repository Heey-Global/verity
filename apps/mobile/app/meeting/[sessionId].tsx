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
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LiveMeetingInsight, SessionHistoryPage } from '@verity/mobile';

import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  subscribeMeeting,
  subscribeVoiceMeetingRequest,
  updateSpeakerEdits,
} from '../../lib/liveMeetingSession';
import { liveMeetingSTT, type STTEngine, type STTEngineId } from '../../lib/liveMeetingSTT';
import {
  listMeetings,
  listNotes,
  loadDraftNote,
  finalizeNote,
  saveNote,
  type MeetingNote,
  type MeetingRecord,
  type SpeakerCorrection,
} from '../../lib/liveMeetingStore';
import { createVerityClient, getActiveMeetingServerId } from '../../lib/client';
import { followRemoteMeeting, syncMeetingSession } from '../../lib/liveMeetingSync';
import {
  latestResearchQuestion,
  meetingRequestPrompt,
  researchPrompt,
} from '../../lib/liveMeetingInsights';
import {
  compactMeetingAnswer,
  meetingAnswerCards,
  meetingAnswerSource,
  meetingRequestFromPrompt,
  type MeetingAnswerCard,
  unacknowledgedMeetingAnswers,
} from '../../lib/liveMeetingAnswers';
import {
  resolvedSpeaker,
  speakerLines,
  reconcileTimedTranscript,
  type SpeakerLine,
} from '../../lib/liveMeetingSpeakers';

type TranscriptRow = SpeakerLine | { text: string };

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

// Notes carry the time of day: people match them to the clock and the calendar, not to a timer.
function noteClockTime(startedAt: number, atSeconds: number) {
  return new Date(startedAt + atSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function MeetingScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<MeetingRecord[]>([]);
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const [insights, setInsights] = useState<LiveMeetingInsight[]>([]);
  const [answers, setAnswers] = useState<MeetingAnswerCard[]>([]);
  const [queuedAnswers, setQueuedAnswers] = useState<MeetingAnswerCard[]>([]);
  const [localAnswers, setLocalAnswers] = useState<MeetingAnswerCard[]>([]);
  const [expandedAnswer, setExpandedAnswer] = useState<string | null>(null);
  const answerEvents = useRef<{ meetingId: string; events: SessionHistoryPage['events'] } | null>(
    null,
  );
  const [draft, setDraft] = useState<MeetingNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteSaveError, setNoteSaveError] = useState<{ meetingId: string; message: string } | null>(
    null,
  );
  const [engines, setEngines] = useState<STTEngine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<STTEngineId>('fluid-nemotron');
  const [expectedParticipants, setExpectedParticipants] = useState<number | null>(null);
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [syncError, setSyncError] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<'pause' | 'resume' | 'stop' | null>(null);
  const [recorderOnline, setRecorderOnline] = useState(true);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [insightQuestion, setInsightQuestion] = useState('');
  const [sendingInsight, setSendingInsight] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const noteSaveErrorRef = useRef<string | null>(null);
  const speakerEditDraft = useRef<{
    meetingId: string;
    names: Record<string, string>;
    corrections: SpeakerCorrection[];
    merges: Record<string, number>;
  } | null>(null);
  const speakerEditWrite = useRef<Promise<void>>(Promise.resolve());
  if (speakerEditDraft.current?.meetingId !== meeting?.id)
    speakerEditDraft.current = meeting
      ? {
          meetingId: meeting.id,
          names: meeting.speakerNames ?? {},
          corrections: meeting.speakerCorrections ?? [],
          merges: meeting.speakerMerges ?? {},
        }
      : null;
  const displayedMeetingId = useRef<string | null>(null);
  displayedMeetingId.current = meeting?.id ?? null;
  const transcriptList = useRef<FlatList<TranscriptRow>>(null);
  const transcriptAtEnd = useRef(true);

  useEffect(
    () =>
      subscribeVoiceMeetingRequest((event) => {
        if (event.meetingId !== displayedMeetingId.current) return;
        setVoiceSending(event.status === 'sending');
        if (event.status === 'failed') setError(event.message ?? 'Voice request failed.');
        else if (event.status === 'sending') setError(null);
        if (event.status === 'sent' && event.request)
          setLocalAnswers((current) => [
            ...current,
            {
              id: `voice-${Date.now()}-${current.length}`,
              request: event.request!,
              kind: event.kind ?? 'request',
              status: 'working',
              answer: '',
            },
          ]);
      }),
    [],
  );

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
    setMeeting((current) => {
      const local = currentMeeting();
      const serverId = getActiveMeetingServerId();
      if (selectedId) return saved.find((item) => item.id === selectedId) ?? null;
      if (
        local?.sessionId === sessionId &&
        local.state === 'active' &&
        ((local.serverId ?? null) === serverId || local.serverId == null)
      )
        return local;
      return saved[0] ?? ((current?.serverId ?? null) === serverId ? current : null);
    });
  }, [sessionId, selectedId]);

  useEffect(() => {
    if (!sessionId) return;
    let mounted = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const sync = await syncMeetingSession(sessionId);
        if (!mounted) return;
        setSyncError(sync.pending);
        await refresh();
        const shown = displayedMeetingId.current;
        if (shown) {
          const saved = await listNotes(shown);
          if (mounted && displayedMeetingId.current === shown)
            setNotes((current) => {
              const merged = new Map(saved.map((note) => [note.id, note]));
              for (const note of current)
                if (note.meetingId === shown && !merged.has(note.id)) merged.set(note.id, note);
              return [...merged.values()].sort((a, b) => a.atSeconds - b.atSeconds);
            });
          const control = await createVerityClient()?.getLiveMeetingCommands(sessionId, shown);
          if (mounted && control) {
            setRecorderOnline(control.recorderOnline);
            const latest = control.commands[0];
            setPendingCommand(latest?.state === 'pending' ? latest.action : null);
            if (latest?.state === 'failed') setError(latest.error ?? 'Meeting control failed.');
          }
          try {
            const found = await createVerityClient()?.getLiveMeetingInsights?.(sessionId, shown);
            if (mounted && displayedMeetingId.current === shown && found) setInsights(found);
          } catch {
            // An older server can still serve the meeting without insight support.
          }
          try {
            const client = createVerityClient();
            if (client?.getHistory) {
              let page = await client.getHistory(sessionId, { limit: 200 });
              let events = page.events;
              const cached =
                answerEvents.current?.meetingId === shown ? answerEvents.current : null;
              let pages = 1;
              while (
                page.hasMore &&
                pages < 10 &&
                events[0]?.seq > 0 &&
                (cached
                  ? events[0]!.seq > (cached.events.at(-1)?.seq ?? 0) + 1
                  : meetingAnswerCards(events, shown).length < 4)
              ) {
                page = await client.getHistory(sessionId, {
                  beforeSeq: events[0]!.seq,
                  limit: 200,
                });
                events = [...page.events, ...events];
                pages++;
              }
              const merged = new Map<number, SessionHistoryPage['events'][number]>();
              for (const entry of cached?.events ?? []) merged.set(entry.seq, entry);
              for (const entry of events) merged.set(entry.seq, entry);
              const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
              const promptIndexes = ordered.flatMap((entry, index) =>
                entry.event.t === 'prompt' && meetingRequestFromPrompt(entry.event.text, shown)
                  ? [index]
                  : [],
              );
              const kept =
                promptIndexes.length > 32
                  ? ordered.slice(promptIndexes.at(-32))
                  : ordered.slice(-4_000);
              if (mounted && displayedMeetingId.current === shown) {
                answerEvents.current = { meetingId: shown, events: kept };
                const historyCards = meetingAnswerCards(kept, shown);
                setAnswers(historyCards.slice(-4));
                setLocalAnswers((current) => unacknowledgedMeetingAnswers(current, historyCards));
              }
              if (client.getActivity) {
                const activity = await client.getActivity(sessionId);
                if (mounted && displayedMeetingId.current === shown)
                  setQueuedAnswers(
                    activity.queued.flatMap((item, index) => {
                      const request = meetingRequestFromPrompt(item.text, shown);
                      return request
                        ? [
                            {
                              id: `queued-${item.id || index}`,
                              ...request,
                              status: 'working' as const,
                              answer: '',
                            },
                          ]
                        : [];
                    }),
                  );
              }
            }
          } catch {
            // Meeting recording must continue when the session answer feed is unavailable.
          }
        }
      } catch {
        if (mounted) setSyncError(true);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [sessionId, refresh]);

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    return subscribeMeeting((active) => {
      if (
        active?.sessionId === sessionId &&
        (active.serverId == null || active.serverId === getActiveMeetingServerId()) &&
        (selectedId === null || selectedId === active.id)
      ) {
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
    setInsights([]);
    setAnswers([]);
    setQueuedAnswers([]);
    setLocalAnswers([]);
    setExpandedAnswer(null);
    answerEvents.current = null;
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
    if (!pendingDrafts.has(meeting.id)) {
      void loadDraftNote(meeting.id)
        .then((savedDraft) => {
          if (!current || !savedDraft || pendingDrafts.has(meeting.id)) return;
          pendingDrafts.set(meeting.id, savedDraft);
          setDraft(savedDraft);
        })
        .catch((reason) => {
          if (current) setError(String(reason));
        });
    }
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
    if (meeting?.timedWords?.length) {
      const aligned = reconcileTimedTranscript(meeting.transcript, meeting.timedWords);
      if (!aligned) return [{ text: meeting.transcript }];
      const lines: TranscriptRow[] = speakerLines(
        aligned.words,
        meeting.speakerTurns ?? [],
        meeting.speakerCorrections ?? [],
        meeting.speakerMerges ?? {},
      );
      if (aligned.tail) lines.push({ text: `Speaker pending: ${aligned.tail}` });
      return lines;
    }
    const text = meeting?.transcript ?? '';
    const result: TranscriptRow[] = [];
    for (let start = 0; start < text.length; start += 900)
      result.push({ text: text.slice(start, start + 900) });
    return result;
  }, [
    meeting?.transcript,
    meeting?.timedWords,
    meeting?.speakerTurns,
    meeting?.speakerCorrections,
    meeting?.speakerMerges,
  ]);
  const suggestedQuestion = useMemo(
    () => latestResearchQuestion(meeting?.transcript ?? ''),
    [meeting?.transcript],
  );
  const visibleAnswers = useMemo(() => {
    const canonical = [
      ...answers,
      ...queuedAnswers.filter(
        (queued) =>
          !answers.some((card) => card.request === queued.request && card.kind === queued.kind),
      ),
    ];
    return [
      ...canonical,
      ...localAnswers.filter(
        (local) =>
          !canonical.some((card) => card.request === local.request && card.kind === local.kind),
      ),
    ].slice(-4);
  }, [answers, queuedAnswers, localAnswers]);
  const transcriptPreview = useMemo(() => {
    const text = meeting?.transcript.trim() ?? '';
    return text.length > 180 ? `…${text.slice(-180)}` : text;
  }, [meeting?.transcript]);

  const speakerLabel = (speaker: number | null) =>
    speaker === null
      ? 'Unknown speaker'
      : (meeting?.speakerNames?.[speaker] ?? `Speaker ${speaker + 1}`);

  const persistSpeakerEdits = async (
    change: Partial<{
      names: Record<string, string>;
      corrections: SpeakerCorrection[];
      merges: Record<string, number>;
    }>,
  ) => {
    if (!meeting?.ownerToken || speakerEditDraft.current?.meetingId !== meeting.id) return;
    const next = { ...speakerEditDraft.current, ...change };
    speakerEditDraft.current = next;
    setMeeting((current) =>
      current?.id === next.meetingId
        ? {
            ...current,
            speakerNames: next.names,
            speakerCorrections: next.corrections,
            speakerMerges: next.merges,
          }
        : current,
    );
    try {
      const write = speakerEditWrite.current
        .catch(() => undefined)
        .then(() => updateSpeakerEdits(next.meetingId, next.names, next.corrections, next.merges));
      speakerEditWrite.current = write;
      await write;
      setSyncError(true);
    } catch (reason) {
      setError(`Could not save speaker correction: ${String(reason)}`);
    }
  };

  const renameSpeaker = (speaker: number) => {
    if (!meeting?.ownerToken) return;
    Alert.prompt(
      'Name this speaker',
      'The name applies throughout this meeting.',
      (value) => {
        const name = value.trim();
        if (name.length > 60) {
          setError('Speaker names can be at most 60 characters.');
          return;
        }
        const names = { ...(speakerEditDraft.current?.names ?? meeting.speakerNames ?? {}) };
        if (name) names[speaker] = name;
        else delete names[speaker];
        void persistSpeakerEdits({ names });
      },
      'plain-text',
      meeting.speakerNames?.[speaker] ?? '',
    );
  };

  const correctSpeaker = (line: SpeakerLine, available: number[]) => {
    if (!meeting?.ownerToken) return;
    const buttons = [
      ...available.map((speaker) => ({
        text: speakerLabel(speaker),
        onPress: () => {
          void persistSpeakerEdits({
            corrections: [
              ...(speakerEditDraft.current?.corrections ?? meeting.speakerCorrections ?? []),
              { start: line.start, end: line.end, speaker },
            ],
          });
        },
      })),
      {
        text: 'Unknown speaker',
        onPress: () => {
          void persistSpeakerEdits({
            corrections: [
              ...(speakerEditDraft.current?.corrections ?? meeting.speakerCorrections ?? []),
              { start: line.start, end: line.end, speaker: null },
            ],
          });
        },
      },
      { text: 'Cancel', style: 'cancel' as const },
    ];
    Alert.alert('Correct speaker', line.text, buttons);
  };

  const mergeSpeaker = (source: number, available: number[]) => {
    if (!meeting?.ownerToken) return;
    const targets = available.filter((speaker) => speaker !== source);
    if (!targets.length) return;
    Alert.alert('Merge duplicate speaker', `Treat ${speakerLabel(source)} as:`, [
      ...targets.map((target) => ({
        text: speakerLabel(target),
        onPress: () =>
          void persistSpeakerEdits({
            merges: {
              ...(speakerEditDraft.current?.merges ?? meeting.speakerMerges ?? {}),
              [source]: target,
            },
          }),
      })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const openResearch = async (question: string, kind: 'research' | 'request' = 'research') => {
    if (!sessionId || !meeting || !question.trim() || sendingInsight) return;
    if (meeting.serverId && meeting.serverId !== getActiveMeetingServerId()) {
      setError('Reconnect to this meeting’s server before asking Verity.');
      return;
    }
    const client = createVerityClient();
    if (!client) {
      setError('Connect to the server to ask Verity about this meeting.');
      return;
    }
    setSendingInsight(true);
    setError(null);
    try {
      await client.sendTurn(sessionId, {
        prompt:
          kind === 'research'
            ? researchPrompt(meeting.id, question.trim(), meeting.transcript)
            : meetingRequestPrompt(meeting.id, question.trim(), meeting.transcript),
      });
      if (displayedMeetingId.current === meeting.id)
        setLocalAnswers((current) => [
          ...current,
          {
            id: `local-${Date.now()}`,
            request: question.trim(),
            kind,
            status: 'working',
            answer: '',
          },
        ]);
      if (kind === 'request') setInsightQuestion('');
    } catch (reason) {
      setError(`Could not start meeting request: ${String(reason)}`);
    } finally {
      setSendingInsight(false);
    }
  };

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
      const next = await startMeeting(sessionId, selectedEngine, expectedParticipants);
      setSyncError(true);
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
      if (meeting && currentMeeting()?.id !== meeting.id) {
        if (!meeting.serverId || meeting.serverId !== getActiveMeetingServerId())
          throw new Error('This meeting belongs to another server.');
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server to stop this recording.');
        await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, 'stop');
        setPendingCommand('stop');
      } else {
        await endMeeting();
        setSyncError(true);
      }
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
      if (currentMeeting()?.id === meeting.id) {
        if (meeting.captureStatus === 'paused') await resumeMeeting();
        else await pauseMeeting();
      } else {
        if (!meeting.serverId || meeting.serverId !== getActiveMeetingServerId())
          throw new Error('This meeting belongs to another server.');
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server to control this recording.');
        const action = meeting.captureStatus === 'paused' ? 'resume' : 'pause';
        await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, action);
        setPendingCommand(action);
      }
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const editNote = (value: string) => {
    // Keystrokes can arrive before React re-renders; the module draft is already current then.
    const current = meeting ? (pendingDrafts.get(meeting.id) ?? draft) : null;
    if (!meeting || (meeting.state !== 'active' && !current)) return;
    const note = current ?? {
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

  const queueNoteSave = (note: MeetingNote): Promise<void> => {
    const next = saveNote(note);
    const completed = next.then(
      () => {
        const latest = pendingDrafts.get(note.meetingId);
        if (latest?.id === note.id && latest.text !== note.text) return;
        pendingNoteErrors.delete(note.meetingId);
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
    return tail;
  };

  const submitNote = () => {
    if (!draft) return;
    if (!draft.text.trim() && !noteUnsaved) return;
    if (draft.text.length > 10_000) {
      setError('Meeting notes must be 10,000 characters or fewer.');
      return;
    }
    const completing = draft;
    if (noteUnsaved && !draft.text.trim()) {
      void queueNoteSave(completing);
      return;
    }
    void (async () => {
      const completion = noteUnsaved
        ? queueNoteSave(completing)
        : (pendingNoteWrites.get(completing.meetingId) ?? Promise.resolve());
      await completion;
      const latest = pendingDrafts.get(completing.meetingId);
      if (
        (pendingNoteWrites.get(completing.meetingId) &&
          pendingNoteWrites.get(completing.meetingId) !== completion) ||
        pendingNoteErrors.has(completing.meetingId) ||
        latest?.id !== completing.id ||
        latest.text !== completing.text
      )
        return;
      if (!(await finalizeNote(completing.id, completing.text))) return;
      setSyncError(true);
      const currentDraft = pendingDrafts.get(completing.meetingId);
      if (currentDraft?.id === completing.id && currentDraft.text === completing.text) {
        pendingDrafts.delete(completing.meetingId);
        publishPendingNote(completing.meetingId);
      }
      setDraft((current) =>
        current?.id === completing.id && current.text === completing.text ? null : current,
      );
    })().catch((reason) => {
      const message = `Note could not be saved: ${String(reason)}`;
      pendingNoteErrors.set(completing.meetingId, message);
      publishPendingNote(completing.meetingId);
    });
  };

  const runningMeeting = currentMeeting();
  const active = meeting?.state === 'active' && runningMeeting?.id === meeting.id;
  const live = meeting?.state === 'active';
  const noteUnsaved = noteSaveError?.meetingId === meeting?.id;
  const speakers = [
    ...new Set([
      ...(meeting?.speakerTurns ?? []).map((turn) =>
        resolvedSpeaker(turn.speaker, meeting?.speakerMerges ?? {}),
      ),
      ...(meeting?.speakerCorrections ?? []).flatMap((correction) =>
        correction.speaker === null
          ? []
          : [resolvedSpeaker(correction.speaker, meeting?.speakerMerges ?? {})],
      ),
    ]),
  ]
    .filter((speaker): speaker is number => speaker !== null)
    .sort((a, b) => a - b);
  const speakerChoices = Array.from(
    {
      length: Math.max(
        meeting?.expectedParticipants ?? 4,
        ...speakers.map((speaker) => speaker + 1),
      ),
    },
    (_, speaker) => speaker,
  ).filter((speaker) => resolvedSpeaker(speaker, meeting?.speakerMerges ?? {}) === speaker);
  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 12 }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        onPress={() => {
          if (live && !active && meeting) followRemoteMeeting(meeting.sessionId, meeting.id);
          router.back();
        }}
        accessibilityRole="button"
      >
        <Text style={styles.back}>‹ Back to session</Text>
      </Pressable>
      <View style={styles.header}>
        <Text style={styles.title}>Live Meeting</Text>
        {live ? (
          <Pressable
            onPress={() => {
              if (!active && meeting) followRemoteMeeting(meeting.sessionId, meeting.id);
              router.back();
            }}
            accessibilityRole="button"
            accessibilityLabel="Minimize meeting"
          >
            <Text style={styles.minimize}>⌄</Text>
          </Pressable>
        ) : null}
      </View>
      {error || meeting?.error ? <Text style={styles.error}>{error ?? meeting?.error}</Text> : null}
      {voiceSending ? <Text style={styles.status}>Sending voice request…</Text> : null}
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
          : live
            ? meeting.captureStatus === 'paused'
              ? `Ⅱ Paused   ${elapsed(meeting.startedAt, now)}   ${active ? (meeting.serverId === null ? 'Saved only on this device' : 'Saving to server') : 'Live from recording device'}`
              : meeting.captureStatus === 'downloading'
                ? 'Preparing language model…'
                : meeting.captureStatus === 'preparing'
                  ? 'Preparing microphone…'
                  : `● Transcribing   ${elapsed(meeting.startedAt, now)}   ${active ? (meeting.serverId === null ? 'Saved only on this device' : 'Saving to server') : 'Live from recording device'}`
            : meeting
              ? meeting.serverId === null
                ? `${meeting.state === 'interrupted' ? 'Interrupted' : 'Ended'} · saved only on this device`
                : meeting.state === 'interrupted'
                  ? meeting.error?.startsWith('Local save failed')
                    ? 'Interrupted · local save failed'
                    : syncError
                      ? 'Interrupted · server sync pending'
                      : 'Interrupted · saved on server'
                  : syncError
                    ? 'Ended · server sync pending'
                    : 'Ended · saved on server'
              : 'Ready to record'}
      </Text>
      {pendingCommand ? (
        <Text style={styles.status}>
          {recorderOnline
            ? `Waiting for recording device to ${pendingCommand}… Keep Verity open there.`
            : 'Recording device unreachable. Open Verity there to apply this command.'}
        </Text>
      ) : null}
      {syncError && meeting?.serverId !== null ? (
        <Text style={styles.statusPaused}>Saved locally · server sync pending</Text>
      ) : null}
      {meeting ? (
        <>
          <View style={styles.speakerCard}>
            <Text style={styles.section}>In the room</Text>
            {speakers.length ? (
              <View style={styles.participantChoices}>
                {speakers.map((speaker) => (
                  <Pressable
                    key={speaker}
                    accessibilityRole="button"
                    accessibilityLabel={`Rename ${speakerLabel(speaker)}`}
                    accessibilityHint="Long press to merge this speaker with another"
                    disabled={!meeting.ownerToken}
                    onPress={() => renameSpeaker(speaker)}
                    onLongPress={() => mergeSpeaker(speaker, speakers)}
                    style={[
                      styles.speakerBadge,
                      resolvedSpeaker(
                        meeting.activeSpeaker ?? null,
                        meeting.speakerMerges ?? {},
                      ) === speaker &&
                        meeting.lastSpeakerAt !== undefined &&
                        now - meeting.lastSpeakerAt < 2500 &&
                        styles.speakerBadgeActive,
                    ]}
                  >
                    <Text style={styles.speakerText}>{speakerLabel(speaker)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={styles.muted}>
                {active
                  ? meeting.speakerStatus === 'unavailable'
                    ? 'Speaker labels unavailable; transcription continues.'
                    : meeting.speakerStatus === 'loading'
                      ? 'Preparing speaker recognition…'
                      : 'Listening for voices…'
                  : 'No speaker labels yet.'}
              </Text>
            )}
            {meeting.ownerToken && speakers.length > 0 ? (
              <Text style={styles.muted}>Tap to name · Hold to merge</Text>
            ) : null}
            {meeting.ownerToken && Object.keys(meeting.speakerMerges ?? {}).length ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Restore merged speaker"
                onPress={() => {
                  Alert.alert('Restore merged speaker', 'Choose the speaker to separate again.', [
                    ...Object.keys(meeting.speakerMerges ?? {}).map((source) => ({
                      text: meeting.speakerNames?.[source] ?? `Speaker ${Number(source) + 1}`,
                      onPress: () => {
                        const merges = {
                          ...(speakerEditDraft.current?.merges ?? meeting.speakerMerges ?? {}),
                        };
                        delete merges[source];
                        void persistSpeakerEdits({ merges });
                      },
                    })),
                    { text: 'Cancel', style: 'cancel' },
                  ]);
                }}
              >
                <Text style={styles.muted}>Restore merged speaker</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.transcriptCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                transcriptExpanded ? 'Collapse transcript' : 'Open full transcript'
              }
              onPress={() => setTranscriptExpanded((expanded) => !expanded)}
              style={styles.transcriptHeader}
            >
              <Text style={styles.listeningIcon}>{live ? '●' : '○'}</Text>
              <View style={styles.transcriptHeaderText}>
                <Text style={styles.section}>Live transcript</Text>
                {!transcriptExpanded ? (
                  <Text style={styles.preview} numberOfLines={width < 600 ? 2 : 3}>
                    {transcriptPreview || 'Recognized speech will appear here.'}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.expandLabel}>{transcriptExpanded ? 'Close' : 'Full ›'}</Text>
            </Pressable>
            {transcriptExpanded ? (
              <FlatList
                ref={transcriptList}
                testID="meeting-transcript"
                style={styles.transcript}
                data={chunks}
                keyExtractor={(_, index) => String(index)}
                renderItem={({ item }) =>
                  'start' in item ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Correct speaker for ${item.text}`}
                      disabled={!meeting.ownerToken}
                      onPress={() => correctSpeaker(item, speakerChoices)}
                    >
                      <Text style={styles.transcriptText}>
                        {speakerLabel(item.speaker)}: {item.text}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.transcriptText}>{item.text}</Text>
                  )
                }
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
            ) : null}
          </View>
          <View style={styles.insightsCard}>
            <Text style={styles.section}>Live Insights</Text>
            <ScrollView style={styles.insightList} keyboardShouldPersistTaps="handled">
              {visibleAnswers.map((card) => (
                <View key={card.id} style={styles.suggestion}>
                  <Text style={styles.suggestionLabel}>
                    {card.status === 'ready'
                      ? 'ANSWER READY'
                      : card.status === 'failed'
                        ? 'REQUEST INTERRUPTED'
                        : 'VERITY IS WORKING'}
                  </Text>
                  <Text style={styles.suggestionText}>{card.request}</Text>
                  {card.status === 'ready' ? (
                    <>
                      <Text style={styles.evidence}>
                        {expandedAnswer === card.id
                          ? card.answer
                          : compactMeetingAnswer(card.answer)}
                      </Text>
                      {meetingAnswerSource(card.answer) ? (
                        <Text style={styles.evidence}>
                          Source: {meetingAnswerSource(card.answer)}
                        </Text>
                      ) : null}
                      {card.answer.length > 360 ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            expandedAnswer === card.id
                              ? 'Collapse meeting answer'
                              : 'Expand meeting answer'
                          }
                          onPress={() =>
                            setExpandedAnswer((current) => (current === card.id ? null : card.id))
                          }
                        >
                          <Text style={styles.researchButtonText}>
                            {expandedAnswer === card.id ? 'Show less' : 'Show full answer'}
                          </Text>
                        </Pressable>
                      ) : null}
                    </>
                  ) : null}
                  {card.status === 'ready' ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Open answer in chat"
                      onPress={() =>
                        router.push({ pathname: '/session/[id]', params: { id: sessionId } })
                      }
                      style={styles.researchButton}
                    >
                      <Text style={styles.researchButtonText}>Open in chat ›</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {insights.slice(0, 4).map((insight) => (
                <View key={insight.id} style={styles.suggestion}>
                  <Text style={styles.suggestionLabel}>
                    {insight.kind === 'contradiction' ? 'POSSIBLE CONTRADICTION' : 'WORTH CHECKING'}
                  </Text>
                  <Text style={styles.suggestionText}>{insight.summary}</Text>
                  <Text style={styles.evidence}>“{insight.evidenceA}”</Text>
                  {insight.evidenceB ? (
                    <Text style={styles.evidence}>“{insight.evidenceB}”</Text>
                  ) : null}
                  {insight.sourcePath ? (
                    <Text style={styles.evidence}>Source: {insight.sourcePath}</Text>
                  ) : null}
                  {insight.kind === 'research' || insight.kind === 'contradiction' ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        insight.kind === 'contradiction'
                          ? 'Check meeting claim'
                          : 'Research insight'
                      }
                      disabled={sendingInsight}
                      onPress={() =>
                        void openResearch(
                          insight.kind === 'contradiction'
                            ? `Check whether “${insight.evidenceA}” conflicts with “${insight.evidenceB ?? insight.summary}”${insight.sourcePath ? ` in ${insight.sourcePath}` : ''}.`
                            : insight.evidenceA,
                        )
                      }
                      style={styles.researchButton}
                    >
                      <Text style={styles.researchButtonText}>
                        {insight.kind === 'contradiction'
                          ? 'Let Verity check ›'
                          : 'Let Verity research ›'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {suggestedQuestion &&
              !insights.some((insight) => insight.evidenceA.includes(suggestedQuestion)) ? (
                <View style={styles.suggestion}>
                  <Text style={styles.suggestionLabel}>QUESTION HEARD</Text>
                  <Text style={styles.suggestionText}>{suggestedQuestion}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Research meeting question"
                    disabled={sendingInsight}
                    onPress={() => void openResearch(suggestedQuestion)}
                    style={styles.researchButton}
                  >
                    <Text style={styles.researchButtonText}>Let Verity research ›</Text>
                  </Pressable>
                </View>
              ) : insights.length === 0 ? (
                <Text style={styles.muted}>Questions from the conversation will appear here.</Text>
              ) : null}
            </ScrollView>
            <View style={styles.insightComposer}>
              <TextInput
                accessibilityLabel="Ask Verity about this meeting"
                placeholder="Ask here or say “Verity, research…”"
                placeholderTextColor={MUTED}
                value={insightQuestion}
                onChangeText={setInsightQuestion}
                onSubmitEditing={() => void openResearch(insightQuestion, 'request')}
                returnKeyType="go"
                style={styles.insightInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Ask Verity in meeting"
                disabled={!insightQuestion.trim() || sendingInsight}
                onPress={() => void openResearch(insightQuestion, 'request')}
                style={styles.insightGo}
              >
                <Text style={styles.insightGoText}>Go ›</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.notesCard}>
            <Text style={styles.section}>Meeting notes</Text>
            <ScrollView style={styles.notes} keyboardShouldPersistTaps="handled">
              {notes
                .filter((note) => !(live || noteUnsaved || draft) || note.id !== draft?.id)
                .map((note) => (
                  <Text key={note.id} testID="meeting-note" style={styles.note}>
                    <Text style={styles.noteTime}>
                      {noteClockTime(meeting.startedAt, note.atSeconds)}{' '}
                    </Text>
                    {note.text}
                  </Text>
                ))}
            </ScrollView>
            {live || noteUnsaved || draft ? (
              <View style={styles.composer}>
                <TextInput
                  accessibilityLabel="Add a meeting note"
                  maxLength={10_000}
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
          {live ? (
            <View style={styles.controls}>
              <Pressable
                disabled={
                  busy ||
                  !!pendingCommand ||
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
                disabled={busy || pendingCommand === 'stop'}
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
      {!live && (!meeting || showNewMeeting) ? (
        <View>
          <Text style={styles.section}>People in this meeting</Text>
          <View style={styles.participantChoices}>
            {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null] as const).map((count) => (
              <Pressable
                key={count ?? 'unknown'}
                accessibilityRole="radio"
                accessibilityLabel={count === null ? 'Not sure' : `${count} people`}
                accessibilityState={{ selected: expectedParticipants === count }}
                disabled={busy}
                onPress={() => setExpectedParticipants(count)}
                style={[
                  styles.participantChoice,
                  expectedParticipants === count && styles.participantChoiceSelected,
                ]}
              >
                <Text
                  style={
                    expectedParticipants === count ? styles.participantSelectedText : styles.muted
                  }
                >
                  {count ?? 'Not sure'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {!live && (!meeting || showNewMeeting) ? (
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
      {!live && (!meeting || showNewMeeting) ? (
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
      {!live && meeting && !showNewMeeting ? (
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
                    {item.serverId === null ? ' · local only' : ''}
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
  participantChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  participantChoice: {
    borderWidth: 1,
    borderColor: '#433a5c',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  participantChoiceSelected: { borderColor: ACCENT },
  participantSelectedText: { color: ACCENT },
  speakerCard: {
    backgroundColor: CARD,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#433a5c',
    padding: 16,
    gap: 10,
  },
  speakerBadge: {
    borderWidth: 1,
    borderColor: '#433a5c',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  speakerBadgeActive: { borderColor: ACCENT },
  speakerText: { color: TEXT },
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
  transcriptCard: {
    backgroundColor: CARD,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#433a5c',
    padding: 14,
    gap: 10,
    maxHeight: '42%',
  },
  transcriptHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  transcriptHeaderText: { flex: 1, gap: 4 },
  listeningIcon: { color: '#7de5a7', fontSize: 22 },
  preview: { color: TEXT, fontSize: 14, lineHeight: 20 },
  expandLabel: { color: ACCENT, fontSize: 13 },
  insightsCard: {
    flex: 1,
    minHeight: 92,
    backgroundColor: CARD,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#433a5c',
    padding: 14,
    gap: 10,
  },
  suggestion: {
    backgroundColor: '#29243a',
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginBottom: 10,
  },
  suggestionLabel: { color: ACCENT, fontSize: 11, fontWeight: '700' },
  suggestionText: { color: TEXT, fontSize: 15 },
  evidence: { color: MUTED, fontSize: 13 },
  insightList: { flex: 1 },
  researchButton: { alignSelf: 'flex-start', paddingVertical: 6 },
  researchButtonText: { color: ACCENT, fontWeight: '700' },
  insightComposer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#262238',
    borderRadius: 12,
    marginTop: 'auto',
  },
  insightInput: { flex: 1, color: TEXT, minHeight: 48, paddingHorizontal: 12 },
  insightGo: { paddingHorizontal: 14, paddingVertical: 12 },
  insightGoText: { color: ACCENT, fontWeight: '700' },
  notesCard: {
    flex: 1,
    minHeight: 88,
    backgroundColor: CARD,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#433a5c',
    padding: 14,
    gap: 10,
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
