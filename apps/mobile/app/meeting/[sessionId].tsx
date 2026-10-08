import { subscribeLiveRefresh } from '../../lib/liveConnection';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { LiveMeetingInsight, SessionHistoryPage } from '@verity/mobile';

import {
  clearSpeakerNameSuggestion,
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
  meetingRequestId,
  meetingRequestPrompt,
  researchPrompt,
} from '../../lib/liveMeetingInsights';
import {
  compactMeetingAnswer,
  meetingAnswerTruncated,
  meetingAnswerCards,
  meetingAnswerSource,
  meetingRequestFromPrompt,
  sameMeetingRequest,
  type MeetingAnswerCard,
  unacknowledgedMeetingAnswers,
} from '../../lib/liveMeetingAnswers';
import {
  meetingTranscriptRows,
  resolvedSpeaker,
  type SpeakerLine,
} from '../../lib/liveMeetingSpeakers';
import { Icon } from '../../components/Icon';
import {
  type CardAction,
  MeetingAnswerText,
  NoticedCard,
  SectionLabel,
  SpeakerAvatar,
  speakerTone,
} from '../../components/meeting/MeetingUI';

type TranscriptRow = SpeakerLine | { text: string; pending?: boolean };

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
  const wide = width >= 900;
  const { theme } = useUnistyles();
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
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
  const [meetingSource, setMeetingSource] = useState<'presence' | 'online'>('presence');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [attendeeConfigured, setAttendeeConfigured] = useState(false);
  useEffect(() => {
    let current = true;
    const refreshConfig = () => {
      const client = createVerityClient();
      void client
        ?.getAttendeeSettings?.()
        .then((value) => {
          if (current) setAttendeeConfigured(value.configured);
        })
        .catch(() => undefined);
    };
    refreshConfig();
    const timer = meetingSource === 'online' ? setInterval(refreshConfig, 5000) : undefined;
    return () => {
      current = false;
      if (timer) clearInterval(timer);
    };
  }, [meetingSource]);
  const [selectedEngine, setSelectedEngine] = useState<STTEngineId>('fluid-nemotron');
  const [expectedParticipants, setExpectedParticipants] = useState<number | null>(null);
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [syncError, setSyncError] = useState(false);
  // Every save is briefly pending; only a backlog that lasts is worth showing.
  const [syncPendingSince, setSyncPendingSince] = useState<number | null>(null);
  useEffect(() => {
    setSyncPendingSince((since) => (syncError ? (since ?? Date.now()) : null));
  }, [syncError]);
  const [pendingCommand, setPendingCommand] = useState<'pause' | 'resume' | 'stop' | null>(null);
  const [recorderOnline, setRecorderOnline] = useState(true);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [insightQuestion, setInsightQuestion] = useState('');
  const [sendingInsight, setSendingInsight] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [composing, setComposing] = useState<'note' | 'ask' | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [showEngines, setShowEngines] = useState(false);
  const noteSaveErrorRef = useRef<string | null>(null);
  const speakerEditDraft = useRef<{
    meetingId: string;
    names: Record<string, string>;
    corrections: SpeakerCorrection[];
    merges: Record<string, number>;
  } | null>(null);
  const speakerEditWrite = useRef<Promise<void>>(Promise.resolve());
  if (speakerEditDraft.current?.meetingId !== meeting?.id || meeting?.engine === 'attendee')
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
              requestId: event.requestId,
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
      setError((current) => (current?.startsWith('Note could not be saved:') ? null : current));
    };
    pendingNoteListeners.add(listener);
    return () => {
      pendingNoteListeners.delete(listener);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const saved = await listMeetings(sessionId);
    setMeeting((current) => {
      const local = currentMeeting();
      const serverId = getActiveMeetingServerId();
      if (
        local?.sessionId === sessionId &&
        local.state === 'active' &&
        ((local.serverId ?? null) === serverId || local.serverId == null)
      )
        return local;
      return saved[0] ?? ((current?.serverId ?? null) === serverId ? current : null);
    });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let mounted = true;
    let polling = false;
    const client = createVerityClient();
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const sync = await syncMeetingSession(sessionId, client ?? undefined);
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
          const control = await client?.getLiveMeetingCommands(sessionId, shown);
          if (mounted && control) {
            setRecorderOnline(control.recorderOnline);
            const latest = control.commands[0];
            setPendingCommand(latest?.state === 'pending' ? latest.action : null);
            if (latest?.state === 'failed') setError(latest.error ?? 'Meeting control failed.');
          }
          try {
            const found = await client?.getLiveMeetingInsights?.(sessionId, shown);
            if (mounted && displayedMeetingId.current === shown && found) setInsights(found);
          } catch {
            // An older server can still serve the meeting without insight support.
          }
          try {
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
    const detach = client
      ? subscribeLiveRefresh(
          client,
          () => poll(),
          (path) => path.startsWith(`/sessions/${encodeURIComponent(sessionId)}/`),
          [{ path: `/sessions/${encodeURIComponent(sessionId)}/live-meetings` }],
        )
      : () => undefined;
    return () => {
      mounted = false;
      detach();
    };
  }, [sessionId, refresh, meeting?.id]);

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    return subscribeMeeting((active) => {
      if (
        active?.sessionId === sessionId &&
        (active.serverId == null || active.serverId === getActiveMeetingServerId())
      ) {
        setMeeting(active);
      }
      if (active?.state === 'ended' || active?.state === 'interrupted') {
        void refresh().catch((reason) => setError(String(reason)));
      }
    });
  }, [refresh, sessionId]);

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

  const chunks = useMemo<TranscriptRow[]>(
    () => (meeting ? meetingTranscriptRows(meeting) : []),
    // Recomputed only when the transcript or its attribution changes, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      meeting?.transcript,
      meeting?.timedWords,
      meeting?.speakerTurns,
      meeting?.tentativeSpeakerTurns,
      meeting?.speakerHorizon,
      meeting?.speakerStatus,
      meeting?.state,
      meeting?.speakerCorrections,
      meeting?.speakerMerges,
    ],
  );
  const suggestedQuestion = useMemo(
    () => latestResearchQuestion(meeting?.transcript ?? ''),
    [meeting?.transcript],
  );
  const visibleAnswers = useMemo(() => {
    const canonical = [
      ...answers,
      ...queuedAnswers.filter(
        (queued) => !answers.some((card) => sameMeetingRequest(card, queued)),
      ),
    ];
    return [
      ...canonical,
      ...localAnswers.filter((local) => !canonical.some((card) => sameMeetingRequest(card, local))),
    ].slice(-4);
  }, [answers, queuedAnswers, localAnswers]);
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
    if (
      !(meeting?.ownerToken || meeting?.engine === 'attendee') ||
      speakerEditDraft.current?.meetingId !== meeting.id
    )
      return false;
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
        .then(async () => {
          if (meeting.engine === 'attendee') {
            const client = createVerityClient();
            if (!client) throw new Error('Connect to the server.');
            await client.editOnlineMeetingSpeakers(meeting.sessionId, next.meetingId, {
              ...(change.names !== undefined ? { speakerNames: next.names } : {}),
              ...(change.corrections !== undefined ? { speakerCorrections: next.corrections } : {}),
              ...(change.merges !== undefined ? { speakerMerges: next.merges } : {}),
            });
          } else
            await updateSpeakerEdits(next.meetingId, next.names, next.corrections, next.merges);
        });
      speakerEditWrite.current = write;
      await write;
      setSyncError(true);
      return true;
    } catch (reason) {
      setError(`Could not save speaker correction: ${String(reason)}`);
      return false;
    }
  };

  const renameSpeaker = (speaker: number) => {
    if (!(meeting?.ownerToken || meeting?.engine === 'attendee')) return;
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
    if (!(meeting?.ownerToken || meeting?.engine === 'attendee')) return;
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
    if (!(meeting?.ownerToken || meeting?.engine === 'attendee')) return;
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
    const requestId = meetingRequestId();
    // The card appears at once, so the suggestion it came from turns into it instead of
    // waiting on the request; a failed send removes it and the suggestion returns.
    const local: MeetingAnswerCard = {
      id: `local-${requestId}`,
      request: question.trim(),
      requestId,
      kind,
      status: 'working',
      answer: '',
    };
    setLocalAnswers((current) => [...current, local]);
    try {
      await client.sendTurn(sessionId, {
        prompt:
          kind === 'research'
            ? researchPrompt(meeting.id, question.trim(), meeting.transcript, requestId)
            : meetingRequestPrompt(meeting.id, question.trim(), meeting.transcript, requestId),
        // Each request needs its own reply; steering would fold it into the running one.
        queueBehindActiveTurn: true,
      });
      // A retried card must not clear what is being typed in the composer.
      if (kind === 'request')
        setInsightQuestion((current) => (current === question ? '' : current));
    } catch (reason) {
      setLocalAnswers((current) => current.filter((card) => card.id !== local.id));
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
        setMeeting(existing);
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (meetingSource === 'online') {
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server.');
        const result = await client.startOnlineMeeting(sessionId, meetingUrl.trim());
        await syncMeetingSession(sessionId);
        const synced = (await listMeetings(sessionId)).find((item) => item.id === result.meetingId);
        if (synced) setMeeting(synced);
        setShowNewMeeting(false);
        await refresh();
        return;
      }
      const next = await startMeeting(sessionId, selectedEngine, expectedParticipants ?? 4);
      setSyncError(true);
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
        if (meeting.engine === 'attendee')
          await client.stopOnlineMeeting(meeting.sessionId, meeting.id);
        else {
          await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, 'stop');
          setPendingCommand('stop');
        }
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
  const live =
    meeting?.state === 'active' ||
    (meeting?.engine === 'attendee' && meeting.state === 'interrupted');
  const noteUnsaved = noteSaveError?.meetingId === meeting?.id;
  const syncDelayed = syncPendingSince !== null && now - syncPendingSince > 30_000;
  // The live header shows only what needs attention, in one fixed slot so nothing moves.
  const liveProblem =
    error ??
    meeting?.error ??
    (noteUnsaved ? 'Note not saved yet. Use retry in the note field.' : null) ??
    (pendingCommand
      ? recorderOnline
        ? `Waiting for recording device to ${pendingCommand}…`
        : 'Recording device unreachable. Open Verity there.'
      : null) ??
    (syncDelayed && meeting?.serverId !== null
      ? 'Server sync delayed · saved on this device'
      : null);
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
  const merges = meeting?.speakerMerges ?? {};
  const activeVoice =
    meeting?.lastSpeakerAt !== undefined && now - meeting.lastSpeakerAt < 2500
      ? resolvedSpeaker(meeting.activeSpeaker ?? null, merges)
      : null;
  const speakerInitial = (speaker: number) =>
    meeting?.speakerNames?.[speaker]?.trim().charAt(0).toUpperCase() || String(speaker + 1);
  const speakerMinutes = (speaker: number) =>
    Math.round(
      (meeting?.speakerTurns ?? [])
        .filter((turn) => resolvedSpeaker(turn.speaker, merges) === speaker)
        .reduce((total, turn) => total + Math.max(0, turn.end - turn.start), 0) / 60,
    );
  const finalizedNotes = notes.filter(
    (note) => !(live || noteUnsaved || draft) || note.id !== draft?.id,
  );
  const composerVisible = live || noteUnsaved || !!draft;
  // Shown after the meeting; the live screen reports problems in its header instead.
  const statusText = !meeting
    ? 'Ready to record'
    : noteUnsaved
      ? `${meeting.state === 'interrupted' ? 'Interrupted' : 'Ended'} · note not saved`
      : meeting.serverId === null
        ? `${meeting.state === 'interrupted' ? 'Interrupted' : 'Ended'} · saved only on this device`
        : meeting.state === 'interrupted'
          ? meeting.error?.startsWith('Local save failed')
            ? 'Interrupted · local save failed'
            : syncError
              ? 'Interrupted · server sync pending'
              : 'Interrupted · saved on server'
          : syncError
            ? 'Ended · server sync pending'
            : 'Ended · saved on server';
  const asNote = (text: string): CardAction | null =>
    // A point already saved as a note loses the action, so a second tap cannot duplicate it.
    meeting?.state === 'active' && !notes.some((note) => note.text === text.trim().slice(0, 10_000))
      ? { label: '+ As note', accessibilityLabel: 'Save as note', onPress: () => addNoteText(text) }
      : null;
  const minimize = () => {
    if (live && !active && meeting) followRemoteMeeting(meeting.sessionId, meeting.id);
    router.back();
  };

  const addNoteText = (text: string) => {
    if (!meeting || meeting.state !== 'active' || !text.trim()) return;
    const note: MeetingNote = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      meetingId: meeting.id,
      atSeconds: (Date.now() - meeting.startedAt) / 1000,
      text: text.trim().slice(0, 10_000),
    };
    setNotes((current) => [...current, note].sort((a, b) => a.atSeconds - b.atSeconds));
    // Saved directly rather than through the draft queue: a failure here must not mark the
    // composer's draft as unsaved, and without a draft there is nothing to retry.
    void saveNote(note).then(
      async () => {
        // Finalizing marks it ready for the next sync; until then it is pending like any note.
        const finalized = await finalizeNote(note.id, note.text).catch((reason) => {
          setError(`Note could not be finished: ${String(reason)}`);
          return false;
        });
        if (finalized) setSyncError(true);
      },
      (reason) => {
        setNotes((current) => current.filter((entry) => entry.id !== note.id));
        setError(`Note could not be saved: ${String(reason)}`);
      },
    );
  };

  const noticedCards = (): ReactNode[] => {
    // Only the recording device asks the model; a typed name always wins over a suggestion.
    const nameCards: ReactNode[] =
      meeting?.state === 'active'
        ? (meeting.speakerNameSuggestions ?? [])
            .filter((suggestion) => meeting.speakerNames?.[suggestion.speaker] === undefined)
            .map((suggestion) => (
              <NoticedCard
                key={`name-${String(suggestion.speaker)}`}
                label="NAME SUGGESTION"
                tone={speakerTone(theme.colors, suggestion.speaker)}
                quote={`“${suggestion.quote}”`}
                title={`${speakerLabel(suggestion.speaker)} is ${suggestion.name}?`}
                onDismiss={() => clearSpeakerNameSuggestion(meeting.id, suggestion.speaker, true)}
                dismissLabel={`Not ${suggestion.name}`}
                actions={[
                  {
                    label: `Yes, ${suggestion.name}`,
                    primary: true,
                    onPress: () => {
                      const names = {
                        ...(speakerEditDraft.current?.names ?? meeting.speakerNames ?? {}),
                      };
                      if (names[suggestion.speaker] === undefined)
                        names[suggestion.speaker] = suggestion.name;
                      // Keep the card until the name is saved, so a failed save can be retried.
                      void persistSpeakerEdits({ names }).then((saved) => {
                        if (saved)
                          clearSpeakerNameSuggestion(meeting.id, suggestion.speaker, false);
                      });
                    },
                  },
                ]}
              />
            ))
        : [];
    const cards: ReactNode[] = visibleAnswers.map((card) => {
      const source = card.status === 'ready' ? meetingAnswerSource(card.answer) : null;
      const note = card.status === 'ready' ? asNote(card.answer) : null;
      const compact = compactMeetingAnswer(card.answer);
      const expanded = expandedAnswer === card.id;
      return (
        <NoticedCard
          key={card.id}
          label={
            card.status === 'ready'
              ? 'ANSWER'
              : card.status === 'failed'
                ? card.combined
                  ? 'NOT ANSWERED SEPARATELY'
                  : 'REQUEST INTERRUPTED'
                : card.kind === 'research'
                  ? 'RESEARCHING'
                  : 'VERITY IS WORKING'
          }
          tone={
            card.status === 'ready'
              ? theme.colors.tone.done
              : card.status === 'failed'
                ? theme.colors.tone.danger
                : theme.colors.primary
          }
          working={card.status === 'working'}
          prominent
          title={card.request}
          body={
            card.status === 'failed'
              ? card.combined
                ? 'This reply combined requests. Retry for a separate answer.'
                : 'Verity stopped before answering.'
              : undefined
          }
          source={source ? `Source: ${source}` : null}
          actions={
            card.status === 'ready'
              ? [
                  {
                    label: 'Open in chat ›',
                    accessibilityLabel: 'Open answer in chat',
                    primary: true,
                    onPress: () =>
                      router.push({ pathname: '/session/[id]', params: { id: sessionId } }),
                  },
                  ...(meetingAnswerTruncated(card.answer)
                    ? [
                        {
                          label: expanded ? 'Show less' : 'Show full answer',
                          accessibilityLabel: expanded
                            ? 'Collapse meeting answer'
                            : 'Expand meeting answer',
                          onPress: () =>
                            setExpandedAnswer((current) => (current === card.id ? null : card.id)),
                        },
                      ]
                    : []),
                  ...(note ? [note] : []),
                ]
              : card.status === 'failed' && live
                ? [
                    {
                      label: 'Retry',
                      accessibilityLabel: 'Retry meeting request',
                      primary: true,
                      disabled: sendingInsight,
                      onPress: () => void openResearch(card.request, card.kind),
                    },
                  ]
                : []
          }
        >
          {card.status === 'ready' ? (
            <MeetingAnswerText text={expanded ? card.answer : compact} />
          ) : null}
        </NoticedCard>
      );
    });
    // A suggestion that was sent becomes its answer card rather than staying beside it.
    const requested = (text: string) => visibleAnswers.some((card) => card.request === text.trim());
    for (const insight of insights.slice(0, 4)) {
      if (dismissed.includes(insight.id)) continue;
      const contradiction = insight.kind === 'contradiction';
      const researchText = contradiction
        ? `Check whether “${insight.evidenceA}” conflicts with “${insight.evidenceB ?? insight.summary}”${insight.sourcePath ? ` in ${insight.sourcePath}` : ''}.`
        : insight.evidenceA;
      if ((contradiction || insight.kind === 'research') && requested(researchText)) continue;
      const note = asNote(insight.summary);
      cards.push(
        <NoticedCard
          key={insight.id}
          label={contradiction ? 'CONTRADICTS PROJECT' : 'WORTH CHECKING'}
          tone={contradiction ? theme.colors.accent : theme.colors.primary}
          time={timeOfDay(insight.createdAt)}
          quote={`“${insight.evidenceA}”${insight.evidenceB ? ` · “${insight.evidenceB}”` : ''}`}
          title={insight.summary}
          source={insight.sourcePath ? `Source: ${insight.sourcePath}` : null}
          actions={[
            ...(contradiction || insight.kind === 'research'
              ? [
                  {
                    label: contradiction ? 'Let Verity check' : 'Let Verity research',
                    accessibilityLabel: contradiction ? 'Check meeting claim' : 'Research insight',
                    primary: true,
                    disabled: sendingInsight,
                    onPress: () => void openResearch(researchText),
                  },
                ]
              : []),
            ...(note ? [note] : []),
            {
              label: 'Not now',
              onPress: () => setDismissed((current) => [...current, insight.id]),
            },
          ]}
        />,
      );
    }
    if (
      suggestedQuestion &&
      !dismissed.includes(suggestedQuestion) &&
      !requested(suggestedQuestion) &&
      !insights.some((insight) => insight.evidenceA.includes(suggestedQuestion))
    )
      cards.push(
        <NoticedCard
          key="question"
          label="OPEN QUESTION"
          tone={theme.colors.primary}
          prominent
          title={suggestedQuestion}
          actions={[
            {
              label: 'Let Verity research',
              accessibilityLabel: 'Research meeting question',
              primary: true,
              disabled: sendingInsight,
              onPress: () => void openResearch(suggestedQuestion),
            },
            {
              label: 'Not now',
              onPress: () => setDismissed((current) => [...current, suggestedQuestion]),
            },
          ]}
        />,
      );
    return [...nameCards, ...cards];
  };

  const statusLines = (
    <>
      {error || meeting?.error ? <Text style={styles.error}>{error ?? meeting?.error}</Text> : null}
      {meeting ? (
        <Text
          style={[
            styles.status,
            (noteUnsaved || meeting.state === 'interrupted') && styles.statusError,
          ]}
        >
          {statusText}
        </Text>
      ) : null}
      {pendingCommand ? (
        <Text style={styles.status}>
          {recorderOnline
            ? `Waiting for recording device to ${pendingCommand}… Keep Verity open there.`
            : 'Recording device unreachable. Open Verity there to apply this command.'}
        </Text>
      ) : null}
    </>
  );

  const speakerAvatars = (captions: boolean) =>
    speakers.map((speaker) => (
      <SpeakerAvatar
        key={speaker}
        initial={speakerInitial(speaker)}
        tone={speakerTone(theme.colors, speaker)}
        active={activeVoice === speaker}
        dashed={!meeting?.speakerNames?.[speaker]}
        size={captions ? 44 : 36}
        caption={captions ? speakerLabel(speaker) : undefined}
        detail={captions && !live ? `${speakerMinutes(speaker)} min` : undefined}
        accessibilityLabel={`Rename ${speakerLabel(speaker)}`}
        accessibilityHint="Long press to merge this speaker with another"
        disabled={!(meeting?.ownerToken || meeting?.engine === 'attendee')}
        onPress={() => renameSpeaker(speaker)}
        onLongPress={() => mergeSpeaker(speaker, speakers)}
      />
    ));

  const restoreMerged =
    (meeting?.ownerToken || meeting?.engine === 'attendee') && Object.keys(merges).length ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restore merged speaker"
        onPress={() => {
          Alert.alert('Restore merged speaker', 'Choose the speaker to separate again.', [
            ...Object.keys(merges).map((source) => ({
              text: meeting.speakerNames?.[source] ?? `Speaker ${Number(source) + 1}`,
              onPress: () => {
                const next = { ...(speakerEditDraft.current?.merges ?? merges) };
                delete next[source];
                void persistSpeakerEdits({ merges: next });
              },
            })),
            { text: 'Cancel', style: 'cancel' },
          ]);
        }}
      >
        <Text style={styles.link}>Restore merged speaker</Text>
      </Pressable>
    ) : null;

  const speakerStatus = active
    ? meeting?.speakerStatus === 'unavailable'
      ? 'Speaker labels unavailable; transcription continues.'
      : meeting?.speakerStatus === 'loading'
        ? 'Preparing speaker recognition…'
        : 'Listening for voices…'
    : 'No speaker labels yet.';

  const noteRows = (rows: MeetingNote[]) =>
    rows.map((note) => (
      <Text key={note.id} testID="meeting-note" style={styles.note}>
        <Text style={styles.noteTime}>{noteClockTime(meeting!.startedAt, note.atSeconds)} </Text>
        {note.text}
      </Text>
    ));

  const noteComposer = (autoFocus: boolean) => (
    <View style={styles.composer}>
      <Text style={styles.composerTime}>
        {meeting
          ? noteClockTime(
              meeting.startedAt,
              draft?.atSeconds ?? (Date.now() - meeting.startedAt) / 1000,
            )
          : ''}
      </Text>
      <TextInput
        accessibilityLabel="Add a meeting note"
        autoFocus={autoFocus}
        maxLength={10_000}
        placeholder="Add a note…"
        placeholderTextColor={theme.colors.textFaint}
        multiline
        submitBehavior="submit"
        value={draft?.text ?? ''}
        onChangeText={editNote}
        onSubmitEditing={submitNote}
        style={styles.composerInput}
      />
      <Pressable
        onPress={submitNote}
        accessibilityRole="button"
        accessibilityLabel={noteUnsaved ? 'Retry saving note' : 'Add note'}
        style={styles.composerSend}
      >
        <Icon name={noteUnsaved ? 'rotate-cw' : 'check'} size={18} color={theme.colors.onPrimary} />
      </Pressable>
    </View>
  );

  const askComposer = (autoFocus: boolean) => (
    <View style={styles.composer}>
      <Text style={[styles.composerTime, { color: theme.colors.accent }]}>✦</Text>
      <TextInput
        accessibilityLabel="Ask Verity about this meeting"
        autoFocus={autoFocus}
        placeholder="Ask Verity about this meeting…"
        placeholderTextColor={theme.colors.textFaint}
        multiline
        submitBehavior="submit"
        returnKeyType="send"
        value={insightQuestion}
        onChangeText={setInsightQuestion}
        onSubmitEditing={() => void openResearch(insightQuestion, 'request')}
        style={styles.composerInput}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Verity in meeting"
        disabled={!insightQuestion.trim() || sendingInsight}
        onPress={() => void openResearch(insightQuestion, 'request')}
        style={styles.composerSend}
      >
        <Icon name="arrow-up" size={18} color={theme.colors.onPrimary} />
      </Pressable>
    </View>
  );

  const transcriptSheet = meeting ? (
    <Modal
      visible={transcriptExpanded}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setTranscriptExpanded(false)}
    >
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Transcript</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Collapse transcript"
            onPress={() => setTranscriptExpanded(false)}
          >
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>
        {(meeting.ownerToken || meeting.engine === 'attendee') && speakers.length ? (
          <Text style={styles.hint}>Tap a line to correct its speaker.</Text>
        ) : null}
        <FlatList
          ref={transcriptList}
          testID="meeting-transcript"
          data={chunks}
          // Rows read speaker names from the meeting; a rename must redraw them.
          extraData={meeting.speakerNames}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={styles.transcriptContent}
          renderItem={({ item }) =>
            'start' in item && !item.pending ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Correct speaker for ${item.text}`}
                disabled={!(meeting.ownerToken || meeting.engine === 'attendee')}
                onPress={() => correctSpeaker(item, speakerChoices)}
              >
                <Text style={styles.transcriptText}>
                  {speakerLabel(item.speaker)}: {item.text}
                </Text>
              </Pressable>
            ) : (
              // Not yet attributed: shown without a speaker until the diarizer catches up.
              <Text style={[styles.transcriptText, item.pending && styles.transcriptPending]}>
                {item.text}
              </Text>
            )
          }
          ListEmptyComponent={<Text style={styles.hint}>Recognized speech will appear here.</Text>}
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
            if (transcriptAtEnd.current) transcriptList.current?.scrollToEnd({ animated: true });
          }}
        />
      </View>
    </Modal>
  ) : null;

  // Starting replaces the previous meeting's content instead of stacking under it, so the
  // start button can never be pushed below the screen.
  if (!live && (!meeting || showNewMeeting)) {
    const returning = runningMeeting?.state === 'active' && runningMeeting.sessionId === sessionId;
    const engine = engines.find((item) => item.id === selectedEngine);
    return (
      <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[styles.content, styles.narrow]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>New meeting</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => (meeting ? setShowNewMeeting(false) : router.back())}
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {noteUnsaved ? (
            // The note is the only part of the last meeting at risk: the device could not
            // write it to its own storage. Show it and let it be saved again from here.
            <View style={styles.recoveryCard} testID="unsaved-note">
              <Text style={styles.recoveryTitle}>A note from your last meeting isn’t saved</Text>
              {draft?.text.trim() ? <Text style={styles.body}>“{draft.text.trim()}”</Text> : null}
              <Text style={styles.hint}>
                The meeting itself is kept. The note is still on screen and will be saved when you
                retry.
                {noteSaveError?.message
                  ? ` (${noteSaveError.message.replace(/^Note could not be saved: /, '')})`
                  : ''}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry saving note"
                onPress={submitNote}
                style={styles.recoveryButton}
              >
                <Icon name="rotate-cw" size={16} color={theme.colors.primary} />
                <Text style={styles.recoveryButtonText}>Retry save</Text>
              </Pressable>
            </View>
          ) : null}
          <View>
            <Text style={styles.rowText}>Meeting source</Text>
            {(['presence', 'online'] as const).map((source) => (
              <Pressable
                key={source}
                accessibilityRole="radio"
                accessibilityState={{ selected: meetingSource === source }}
                onPress={() => setMeetingSource(source)}
                style={styles.engineChoice}
              >
                <Text
                  style={{
                    color: meetingSource === source ? theme.colors.primary : theme.colors.text,
                  }}
                >
                  {meetingSource === source ? '● ' : '○ '}
                  {source === 'presence' ? 'In person' : 'Online meeting'}
                </Text>
              </Pressable>
            ))}
            {meetingSource === 'online' ? (
              <>
                <TextInput
                  value={meetingUrl}
                  onChangeText={setMeetingUrl}
                  placeholder="Meeting link"
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  accessibilityLabel="Online meeting link"
                  style={styles.engineChoice}
                />
                <Text style={styles.hint}>
                  {attendeeConfigured
                    ? 'Attendee joins and transcribes while the app is closed. Requires premium Uplink / Online Sharing.'
                    : 'Set up online meetings: configure Attendee and enable premium Uplink / Online Sharing.'}
                </Text>
                {!attendeeConfigured ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push('/settings/services')}
                  >
                    <Text style={styles.link}>Set up Attendee</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>
          {meetingSource === 'presence' ? (
            <>
              <View style={styles.block}>
                <SectionLabel>WHO IS THERE?</SectionLabel>
                <View style={styles.segmented}>
                  {(
                    [
                      [4, 'Up to 4 people'],
                      [10, 'Larger group'],
                    ] as const
                  ).map(([count, label]) => {
                    const selected = (expectedParticipants ?? 4) === count;
                    return (
                      <Pressable
                        key={count}
                        accessibilityRole="radio"
                        accessibilityLabel={label}
                        accessibilityState={{ selected }}
                        disabled={busy}
                        onPress={() => setExpectedParticipants(count)}
                        style={[styles.segment, selected && styles.segmentSelected]}
                      >
                        <Text style={selected ? styles.segmentTextSelected : styles.segmentText}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.hint}>
                  {(expectedParticipants ?? 4) > 4
                    ? 'Separates up to 10 voices, with more mix-ups between similar ones.'
                    : 'Keeps voices apart most reliably.'}{' '}
                  Can’t be changed once the meeting runs.
                </Text>
              </View>
              <View style={styles.block}>
                <SectionLabel>PRIVACY</SectionLabel>
                <Text style={styles.body}>
                  Audio stays on this device and is not saved. Text goes to your Verity server only.
                </Text>
              </View>
              <View style={styles.block}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Speech recognition"
                  accessibilityState={{ expanded: showEngines }}
                  onPress={() => setShowEngines((shown) => !shown)}
                  style={styles.row}
                >
                  <Text style={styles.rowText}>Speech recognition</Text>
                  <Text style={styles.rowValue}>{engine?.name ?? 'On device'}</Text>
                  <Icon
                    name={showEngines ? 'chevron-down' : 'chevron-right'}
                    size={16}
                    color={theme.colors.textFaint}
                  />
                </Pressable>
                {showEngines
                  ? engines.map((item) => (
                      <Pressable
                        key={item.id}
                        accessibilityRole="radio"
                        accessibilityState={{
                          selected: selectedEngine === item.id,
                          disabled: !item.available,
                        }}
                        disabled={!item.available || busy}
                        onPress={() => setSelectedEngine(item.id)}
                        style={styles.engineChoice}
                      >
                        <Text
                          style={
                            selectedEngine === item.id ? styles.segmentTextSelected : styles.rowText
                          }
                        >
                          {selectedEngine === item.id ? '● ' : '○ '}
                          {item.name}
                          {item.available ? '' : ' · unavailable'}
                        </Text>
                      </Pressable>
                    ))
                  : null}
              </View>
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start meeting"
            disabled={
              busy || (meetingSource === 'online' && (!attendeeConfigured || !meetingUrl.trim()))
            }
            onPress={start}
            style={styles.startButton}
          >
            {busy ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <>
                {returning ? null : <View style={styles.recordDot} />}
                <Text style={styles.startButtonText}>
                  {returning
                    ? 'Return to live meeting'
                    : meetingSource === 'online'
                      ? 'Start online meeting'
                      : 'Start recording'}
                </Text>
              </>
            )}
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (!meeting) return null;

  if (!live) {
    const minutes = Math.max(
      1,
      Math.round(((meeting.endedAt ?? now) - meeting.startedAt) / 60_000),
    );
    const openPoints = noticedCards().slice(visibleAnswers.length);
    const unnamed = speakers.find((speaker) => !meeting.speakerNames?.[speaker]);
    return (
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.root, { paddingTop: insets.top + 12 }]}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[
            styles.content,
            styles.narrow,
            { paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>Meeting</Text>
            <Pressable accessibilityRole="button" onPress={() => router.back()}>
              <Text style={styles.link}>Done</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            {new Date(meeting.startedAt).toLocaleString([], {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            · {minutes} min
            {speakers.length ? ` · ${speakers.length} people` : ''} · {finalizedNotes.length} notes
          </Text>
          <View style={styles.savedCard}>
            <Icon
              name={
                noteUnsaved || meeting.state === 'interrupted' || syncError
                  ? 'alert-circle'
                  : 'check-circle'
              }
              size={22}
              color={
                noteUnsaved || meeting.state === 'interrupted'
                  ? theme.colors.tone.danger
                  : theme.colors.tone.done
              }
            />
            <View style={styles.fill}>{statusLines}</View>
          </View>
          {openPoints.length ? (
            <View style={styles.block}>
              <SectionLabel>{`OPEN POINTS · ${openPoints.length}`}</SectionLabel>
              {openPoints}
            </View>
          ) : null}
          {visibleAnswers.length ? (
            <View style={styles.block}>
              <SectionLabel>{`ANSWERS · ${visibleAnswers.length}`}</SectionLabel>
              {noticedCards().slice(0, visibleAnswers.length)}
            </View>
          ) : null}
          <View style={styles.block}>
            <SectionLabel>{`YOUR NOTES · ${finalizedNotes.length}`}</SectionLabel>
            {finalizedNotes.length ? (
              noteRows(finalizedNotes)
            ) : (
              <Text style={styles.hint}>No notes in this meeting.</Text>
            )}
            {composerVisible ? noteComposer(false) : null}
          </View>
          <View style={styles.block}>
            <SectionLabel>PEOPLE</SectionLabel>
            {speakers.length ? (
              <View style={styles.avatarRow}>{speakerAvatars(true)}</View>
            ) : (
              <Text style={styles.hint}>{speakerStatus}</Text>
            )}
            {unnamed !== undefined && (meeting.ownerToken || meeting.engine === 'attendee') ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => renameSpeaker(unnamed)}
                style={styles.row}
              >
                <Text style={styles.rowValue}>{speakerLabel(unnamed)} has no name yet</Text>
                <Text style={styles.link}>Name ›</Text>
              </Pressable>
            ) : null}
            {restoreMerged}
          </View>
          <View style={styles.bottomBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open full transcript"
              onPress={() => setTranscriptExpanded(true)}
              style={styles.barButton}
            >
              <Text style={styles.barButtonText}>Transcript</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/session/[id]', params: { id: sessionId } })}
              style={[styles.barButton, styles.barButtonPrimary]}
            >
              <Text style={styles.barButtonPrimaryText}>Continue in chat</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setTranscriptExpanded(false);
              setShowNewMeeting(true);
            }}
            style={styles.centered}
          >
            <Text style={styles.link}>Start another meeting</Text>
          </Pressable>
        </ScrollView>
        {transcriptSheet}
      </KeyboardAvoidingView>
    );
  }

  const paused = meeting.captureStatus === 'paused';
  const preparing =
    meeting.captureStatus === 'preparing' || meeting.captureStatus === 'downloading';
  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={minimize}
        accessibilityRole="button"
        accessibilityLabel="Minimize meeting"
        style={styles.circleButton}
      >
        <Icon name="chevron-down" size={22} color={theme.colors.text} />
      </Pressable>
      <Text
        testID="meeting-live-status"
        numberOfLines={2}
        style={[styles.headerStatus, liveProblem !== null && styles.statusError]}
      >
        {liveProblem ??
          (meeting.captureStatus === 'paused'
            ? 'Ⅱ Paused'
            : meeting.captureStatus === 'downloading'
              ? 'Preparing language model…'
              : meeting.captureStatus === 'preparing'
                ? 'Preparing microphone…'
                : meeting.serverId === null
                  ? 'Saved only on this device'
                  : '')}
      </Text>
      <View
        style={[styles.pill, voiceSending && { borderColor: theme.colors.accent }]}
        accessibilityLabel={paused ? 'Paused' : `Recording ${elapsed(meeting.startedAt, now)}`}
      >
        {voiceSending ? (
          <Text style={[styles.pillText, { color: theme.colors.accent }]}>✦ Sending request…</Text>
        ) : (
          <>
            <BreathingDot
              color={paused ? theme.colors.tone.attention : theme.colors.tone.danger}
              breathing={!paused && !preparing}
            />
            <Text style={[styles.pillText, paused && { color: theme.colors.tone.attention }]}>
              {paused ? 'Paused' : preparing ? 'Preparing…' : elapsed(meeting.startedAt, now)}
            </Text>
          </>
        )}
      </View>
      <Pressable
        disabled={
          busy ||
          meeting.engine === 'attendee' ||
          !!pendingCommand ||
          (!paused && meeting.captureStatus !== 'listening')
        }
        onPress={togglePause}
        style={styles.circleButton}
        accessibilityRole="button"
        accessibilityLabel={paused ? 'Resume meeting' : 'Pause meeting'}
      >
        <Icon name={paused ? 'play' : 'pause'} size={18} color={theme.colors.text} />
      </Pressable>
      <Pressable
        disabled={busy || pendingCommand === 'stop'}
        onPress={end}
        style={styles.endButton}
        accessibilityRole="button"
        accessibilityLabel="End meeting"
      >
        <Text style={styles.endButtonText}>End</Text>
      </Pressable>
    </View>
  );
  const speakerRow = (captions: boolean) => (
    <View style={styles.block}>
      <View style={styles.avatarLine}>
        {speakers.length ? (
          <View style={[styles.avatarRow, styles.fill]}>{speakerAvatars(captions)}</View>
        ) : (
          <Text style={[styles.hint, styles.fill]}>{speakerStatus}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open full transcript"
          onPress={() => setTranscriptExpanded(true)}
        >
          <Text style={styles.hint}>
            {speakers.length ? `${speakers.length} voices · ` : ''}Transcript ›
          </Text>
        </Pressable>
      </View>
      {restoreMerged}
    </View>
  );
  const cards = noticedCards();
  const noticed = (
    <View style={styles.block}>
      <View style={styles.noticedHeader}>
        <Text style={[styles.sparkle, { color: theme.colors.accent }]}>✦</Text>
        <Text style={styles.noticedTitle}>Verity noticed</Text>
        {cards.length ? <Text style={styles.hint}>{cards.length}</Text> : null}
      </View>
      {cards.length ? (
        cards
      ) : (
        <Text style={styles.hint}>
          Questions and contradictions from the conversation appear here.
        </Text>
      )}
    </View>
  );

  if (wide)
    return (
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.page}>
          {header}
          <View style={styles.columns}>
            <View style={styles.column}>
              <SectionLabel>IN THE ROOM</SectionLabel>
              {speakerRow(true)}
              <SectionLabel>{`NOTES · ${finalizedNotes.length}`}</SectionLabel>
              <View style={styles.notesCard}>
                <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
                  {noteRows(finalizedNotes)}
                </ScrollView>
              </View>
              {noteComposer(false)}
            </View>
            <View style={styles.divider} />
            <View style={styles.column}>
              <ScrollView
                style={styles.fill}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
              >
                {noticed}
              </ScrollView>
              {askComposer(false)}
            </View>
          </View>
        </View>
        {transcriptSheet}
      </KeyboardAvoidingView>
    );

  const lastNote = finalizedNotes.at(-1);
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.page}>
        {header}
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {speakerRow(false)}
          {noticed}
          {composing === 'note' && finalizedNotes.length ? (
            <View style={styles.block}>
              <SectionLabel>{`NOTES · ${finalizedNotes.length}`}</SectionLabel>
              {noteRows(finalizedNotes)}
            </View>
          ) : lastNote ? (
            <View style={styles.block}>
              <SectionLabel>LAST NOTE</SectionLabel>
              {noteRows([lastNote])}
            </View>
          ) : null}
        </ScrollView>
        {composing === 'note' || noteUnsaved ? (
          <View style={styles.composerLine}>
            <View style={styles.fill}>{noteComposer(composing === 'note')}</View>
            {/* A failed save keeps the field open until it is retried; a draft stays autosaved. */}
            {noteUnsaved ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close note"
                onPress={() => setComposing(null)}
              >
                <Icon name="x" size={20} color={theme.colors.textMuted} />
              </Pressable>
            )}
          </View>
        ) : composing === 'ask' ? (
          <View style={styles.composerLine}>
            <View style={styles.fill}>{askComposer(true)}</View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close question"
              onPress={() => setComposing(null)}
            >
              <Icon name="x" size={20} color={theme.colors.textMuted} />
            </Pressable>
          </View>
        ) : (
          <View style={styles.bottomBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write a note"
              onPress={() => setComposing('note')}
              style={styles.barButton}
            >
              <Text style={styles.barButtonText}>
                ✎ Note
                {draft?.text
                  ? ' · draft'
                  : finalizedNotes.length
                    ? ` · ${finalizedNotes.length}`
                    : ''}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ask Verity"
              onPress={() => setComposing('ask')}
              style={[styles.barButton, styles.barButtonPrimary]}
            >
              <Text style={styles.barButtonPrimaryText}>✦ Ask Verity</Text>
            </Pressable>
          </View>
        )}
      </View>
      {transcriptSheet}
    </KeyboardAvoidingView>
  );
}

// The recording dot breathes while capture runs and holds still when paused.
function BreathingDot({ color, breathing }: { color: string; breathing: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!breathing) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 1100, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 1100, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathing, opacity]);
  return (
    <View style={[styles.dotRing, { borderColor: color }]}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity }]} />
    </View>
  );
}

function timeOfDay(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  fill: { flex: 1 },
  page: {
    flex: 1,
    width: '100%',
    maxWidth: 1200,
    alignSelf: 'center',
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  content: { padding: theme.spacing.lg, gap: theme.spacing.xl, paddingBottom: theme.spacing.xl },
  narrow: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  block: { gap: theme.spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  circleButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 40,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  pillText: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  dotRing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  endButton: {
    minHeight: 40,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    justifyContent: 'center',
  },
  headerStatus: {
    flex: 1,
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textAlign: 'right',
  },
  endButtonText: { color: theme.colors.tone.danger, fontWeight: '700', fontSize: theme.text.md },
  status: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  statusError: { color: theme.colors.tone.danger },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  hint: { color: theme.colors.textFaint, fontSize: theme.text.sm },
  body: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 },
  link: { color: theme.colors.primary, fontSize: theme.text.md },
  centered: { alignItems: 'center', paddingVertical: theme.spacing.sm },
  avatarLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  avatarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
  noticedHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  sparkle: { fontSize: theme.text.md },
  noticedTitle: { flex: 1, color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  note: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 },
  noteTime: { color: theme.colors.textFaint, fontWeight: '700' },
  notesCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  composerLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.lg,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    paddingVertical: theme.spacing.xs,
  },
  composerTime: { color: theme.colors.primary, fontWeight: '700', fontSize: theme.text.sm },
  composerInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    minHeight: 40,
    maxHeight: 120,
    paddingVertical: theme.spacing.sm,
  },
  composerSend: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBar: { flexDirection: 'row', gap: theme.spacing.md, paddingVertical: theme.spacing.sm },
  barButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barButtonText: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  barButtonPrimary: { borderColor: theme.colors.primary, backgroundColor: 'transparent' },
  barButtonPrimaryText: { color: theme.colors.primary, fontSize: theme.text.md, fontWeight: '700' },
  columns: { flex: 1, flexDirection: 'row', gap: theme.spacing.xl, paddingTop: theme.spacing.md },
  column: { flex: 1, gap: theme.spacing.md },
  divider: { width: 1, backgroundColor: theme.colors.border },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.colors.text, fontSize: theme.text.xl, fontWeight: '800' },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    marginTop: -theme.spacing.lg,
  },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    padding: theme.spacing.xs,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  segmentSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.background },
  segmentText: { color: theme.colors.textMuted, fontSize: theme.text.md },
  segmentTextSelected: { color: theme.colors.primary, fontSize: theme.text.md, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  rowText: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
  rowValue: { flex: 1, color: theme.colors.textMuted, fontSize: theme.text.sm, textAlign: 'right' },
  engineChoice: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.md,
    minHeight: 56,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  recordDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.tone.danger },
  startButtonText: { color: theme.colors.primary, fontSize: theme.text.lg, fontWeight: '700' },
  recoveryCard: {
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  recoveryTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  recoveryButton: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  recoveryButtonText: { color: theme.colors.primary, fontWeight: '700' },
  savedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  sheet: {
    flex: 1,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  transcriptContent: { gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
  transcriptText: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 24 },
  transcriptPending: { color: theme.colors.textMuted },
}));
