import { discardMessage, MeetingResult } from '../../components/meeting/MeetingResult';
import { shareMeetingResult } from '../../lib/shareMeetingResult';
import {
  meetingModelChoice,
  meetingResearchModel,
  type MeetingModelChoice,
  setMeetingModel,
} from '../../lib/meetingResearchModel';
import { setMeetingTranscriptVisible, useMeetingPreferences } from '../../lib/meetingPreferences';
import { subscribeLiveRefresh } from '../../lib/liveConnection';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
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
  updateNote,
  updateMeetingTitle,
  type MeetingNote,
  type MeetingRecord,
  type SpeakerCorrection,
} from '../../lib/liveMeetingStore';
import { createVerityClient, getActiveMeetingServerId } from '../../lib/client';
import {
  discardFinishedMeeting,
  followRemoteMeeting,
  syncMeetingSession,
} from '../../lib/liveMeetingSync';
import {
  meetingQuestionKey,
  meetingRequestId,
  meetingRequestPrompt,
  meetingRequestTime,
  researchPrompt,
} from '../../lib/liveMeetingInsights';
import {
  meetingAnswerCards,
  distinctMeetingAnswers,
  meetingAnswerSource,
  meetingAnswerSourceUrl,
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
import { MeetingWave } from '../../components/meeting/MeetingWave';
import { AskVerityField, MeetingModelSheet, VerityPane } from '../../components/meeting/VerityPane';
import {
  type CardAction,
  MeetingAnswerText,
  NoticedCard,
  SectionLabel,
  SpeakerAvatar,
  speakerTone,
} from '../../components/meeting/MeetingUI';
import {
  Button,
  useTextPrompt,
  Card,
  Group,
  HintBox,
  IconButton,
  Row,
  SectionHeader,
  Text as UiText,
  SearchField,
  TextField,
  Toggle,
  useConfirm,
} from '../../components/ui';
import {
  CalendarMeetingPicker,
  canJoinCalendarMeeting,
  UnassignedMeetingCard,
  useCalendarMeetingChoice,
  useUnassignedMeetings,
  useUpcomingMeetings,
} from '../../components/meeting/OnlineMeetingStart';
import { tint } from '../../components/ui/tint';

type TranscriptRow = SpeakerLine | { text: string; pending?: boolean };

const VERITY_MARK = require('../../assets/brand/verity-v-mark.png') as number;
// The mark's artwork is wider than tall.
const VERITY_MARK_RATIO = 240 / 168;

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
  const { sessionId, meetingId } = useLocalSearchParams<{
    sessionId: string;
    meetingId?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const textPrompt = useTextPrompt();
  const [transcriptSearch, setTranscriptSearch] = useState('');
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
  const recoveryMeetingId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteSaveError, setNoteSaveError] = useState<{ meetingId: string; message: string } | null>(
    null,
  );
  const [engines, setEngines] = useState<STTEngine[]>([]);
  const [meetingSource, setMeetingSource] = useState<'presence' | 'online'>('presence');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [now, setNow] = useState(Date.now());
  // Both sources can take a calendar title; online calls can also use its join link.
  const { upcoming, loadFailed: calendarLoadFailed } = useUpcomingMeetings(true);
  const {
    selectedEventKey,
    setSelectedEventKey,
    manualLink,
    setManualLink,
    selectedEvent: selectedCalendarEvent,
  } = useCalendarMeetingChoice(upcoming, now, meetingSource === 'presence');
  const selectedEvent =
    selectedCalendarEvent?.provider && canJoinCalendarMeeting(selectedCalendarEvent, now)
      ? selectedCalendarEvent
      : null;
  const [unassignedMeetings, reloadUnassigned] = useUnassignedMeetings();
  const [continuing, setContinuing] = useState<string | null>(null);
  const [confirm, confirmSheet] = useConfirm();
  const [meetingTitle, setMeetingTitle] = useState('');
  const titledEvent = useRef<string | null>(null);
  const titleEdited = useRef(false);
  useEffect(() => {
    const chosen = upcoming?.find((event) => event.eventKey === selectedEventKey);
    if (chosen && titledEvent.current !== chosen.eventKey) {
      titledEvent.current = chosen.eventKey;
      if (!titleEdited.current) setMeetingTitle(chosen.title ?? '');
    }
  }, [selectedEventKey, upcoming]);
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
  const askClearedAfterSend = useRef(false);
  const askText = useRef(insightQuestion);
  askText.current = insightQuestion;
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
  const speakerEditBusy = useRef(false);
  const [speakerEditPending, setSpeakerEditPending] = useState(false);
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
  if (meeting && meeting.id !== recoveryMeetingId.current) recoveryMeetingId.current = null;
  const transcriptList = useRef<FlatList<TranscriptRow>>(null);
  const transcriptAtEnd = useRef(true);
  const [transcriptBehind, setTranscriptBehind] = useState(false);
  // Reopened, the transcript starts at the newest words and follows them again.
  useEffect(() => {
    if (transcriptExpanded) return;
    transcriptAtEnd.current = true;
    setTranscriptBehind(false);
  }, [transcriptExpanded]);

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
              ...(event.questionId ? { questionId: event.questionId } : {}),
              ...(event.questionTitle ? { questionTitle: event.questionTitle } : {}),
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
      if (displayedMeetingId.current !== meetingId && recoveryMeetingId.current !== meetingId)
        return;
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
          if (displayedMeetingId.current !== meetingId && recoveryMeetingId.current !== meetingId)
            return;
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
    if (
      !meetingId &&
      currentMeeting()?.state !== 'active' &&
      !saved.some((item) => item.state === 'active')
    ) {
      for (const item of saved) {
        const recovered = pendingDrafts.get(item.id) ?? (await loadDraftNote(item.id));
        if (!recovered || (!recovered.text.trim() && !pendingNoteErrors.has(item.id))) continue;
        // A slow storage read must not replace a draft in a newly started meeting.
        if (displayedMeetingId.current || currentMeeting()?.state === 'active') break;
        pendingDrafts.set(item.id, recovered);
        recoveryMeetingId.current = item.id;
        setDraft(recovered);
        const message = pendingNoteErrors.get(item.id) ?? null;
        noteSaveErrorRef.current = message;
        setNoteSaveError(message ? { meetingId: item.id, message } : null);
        break;
      }
    }
    setMeeting((current) => {
      const selected = meetingId ? saved.find((item) => item.id === meetingId) : undefined;
      const local = currentMeeting();
      if (meetingId && (!selected || selected.id !== local?.id || local.state !== 'active'))
        return selected ?? null;
      const serverId = getActiveMeetingServerId();
      if (
        local?.sessionId === sessionId &&
        local.state === 'active' &&
        ((local.serverId ?? null) === serverId || local.serverId == null)
      )
        return local;
      return (
        saved.find(
          (item) =>
            item.state === 'active' || (item.engine === 'attendee' && item.state === 'interrupted'),
        ) ??
        (current?.sessionId === sessionId && (current.serverId ?? null) === serverId
          ? (saved.find((item) => item.id === current.id) ?? current)
          : null)
      );
    });
  }, [sessionId, meetingId]);

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
              const summaryHistory =
                meeting?.state === 'ended' ||
                (meeting?.state === 'interrupted' && meeting.engine !== 'attendee');
              let pages = 1;
              while (
                page.hasMore &&
                (summaryHistory || pages < 10) &&
                events[0]?.seq > 0 &&
                (summaryHistory
                  ? page.events[0]?.ts === undefined || page.events[0].ts >= meeting.startedAt
                  : cached
                    ? events[0]!.seq > (cached.events.at(-1)?.seq ?? 0) + 1
                    : distinctMeetingAnswers(meetingAnswerCards(events, shown)).length < 4)
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
              const retained = distinctMeetingAnswers(meetingAnswerCards(ordered, shown)).slice(
                -32,
              );
              const firstSeq = Number(retained[0]?.id);
              const firstIndex = ordered.findIndex((entry) => entry.seq === firstSeq);
              const kept = summaryHistory
                ? ordered
                : (firstIndex >= 0 ? ordered.slice(firstIndex) : ordered).slice(-4_000);
              if (mounted && displayedMeetingId.current === shown) {
                answerEvents.current = { meetingId: shown, events: kept };
                const historyCards = meetingAnswerCards(kept, shown);
                setAnswers(historyCards);
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
  }, [sessionId, refresh, meeting?.id, meeting?.state]);

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    return subscribeMeeting((active) => {
      if (
        active?.sessionId === sessionId &&
        (!meetingId || active.id === meetingId) &&
        (active.state === 'active' || active.id === displayedMeetingId.current) &&
        (active.serverId == null || active.serverId === getActiveMeetingServerId())
      ) {
        setMeeting(active);
      }
      if (active?.state === 'ended' || active?.state === 'interrupted') {
        void refresh().catch((reason) => setError(String(reason)));
      }
    });
  }, [refresh, sessionId, meetingId]);

  useEffect(() => {
    if (!meeting) return;
    let current = true;
    setNotes([]);
    setInsights([]);
    setAnswers([]);
    setDismissed([]);
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
  const allMeetingAnswers = useMemo(() => {
    const canonical = [
      ...answers,
      ...queuedAnswers.filter(
        (queued) => !answers.some((card) => sameMeetingRequest(card, queued)),
      ),
    ];
    return distinctMeetingAnswers([
      ...canonical,
      ...localAnswers.filter((local) => !canonical.some((card) => sameMeetingRequest(card, local))),
    ]);
  }, [answers, queuedAnswers, localAnswers]);
  const visibleAnswers = useMemo(() => {
    const shown = allMeetingAnswers.filter(
      (card) => !dismissed.includes(card.questionId ?? meetingQuestionKey(card.request)),
    );
    return meeting?.state === 'ended' ||
      (meeting?.state === 'interrupted' && meeting.engine !== 'attendee')
      ? shown
      : shown.slice(-4);
  }, [allMeetingAnswers, dismissed, meeting?.state, meeting?.engine]);
  const newestReady = visibleAnswers.findLast((card) => card.status === 'ready')?.id;
  const responseMs = visibleAnswers.find((card) => card.id === newestReady)?.responseMs;
  useEffect(() => {
    setExpandedAnswer(newestReady ?? null);
  }, [newestReady]);
  useEffect(() => {
    if (responseMs !== undefined) console.debug('Meeting answer timing', { responseMs });
  }, [newestReady, responseMs]);
  const { transcript: showTranscript } = useMeetingPreferences();
  // The model chip and picker live in Verity's pane, which only the wide layout shows.
  const [modelChoice, setModelChoice] = useState<MeetingModelChoice | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const liveMeetingId = meeting?.id;
  const meetingActive = meeting?.state === 'active';
  useEffect(() => {
    setModelChoice(null);
    if (!wide || !meetingActive || !sessionId || !liveMeetingId) return;
    const client = createVerityClient();
    if (!client) return;
    let current = true;
    void meetingModelChoice(client, sessionId, liveMeetingId).then((choice) => {
      if (current) setModelChoice(choice);
    });
    return () => {
      current = false;
    };
  }, [wide, meetingActive, sessionId, liveMeetingId]);
  const pickMeetingModel = (model: string) => {
    setModelSheetOpen(false);
    if (!liveMeetingId) return;
    setMeetingModel(liveMeetingId, model);
    setModelChoice((current) => (current ? { ...current, model, effective: model } : current));
  };
  const transcriptEnd = useRef<ScrollView>(null);
  // New words follow the reader only while they are at the end; reading back stays put.
  const wideTranscriptAtEnd = useRef(true);
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
    optimistic = true,
  ) => {
    if (
      !(meeting?.ownerToken || meeting?.engine === 'attendee') ||
      speakerEditDraft.current?.meetingId !== meeting.id
    )
      return false;
    if (speakerEditBusy.current) {
      setError('Wait for the current speaker change to finish saving.');
      return false;
    }
    if (!optimistic) {
      speakerEditBusy.current = true;
      setSpeakerEditPending(true);
    }
    const next = { ...speakerEditDraft.current, ...change };
    if (optimistic) speakerEditDraft.current = next;
    const apply = () =>
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
    if (optimistic) apply();
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
      if (!optimistic) {
        speakerEditDraft.current = next;
        apply();
      }
      setSyncError(true);
      return true;
    } catch (reason) {
      setError(`Could not save speaker correction: ${String(reason)}`);
      return false;
    } finally {
      if (!optimistic) {
        speakerEditBusy.current = false;
        setSpeakerEditPending(false);
      }
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

  const openResearch = async (
    question: string,
    kind: 'research' | 'request' = 'research',
    questionId?: string,
    questionTitle?: string,
  ) => {
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
      ...(questionId ? { questionId } : {}),
      ...(questionTitle ? { questionTitle } : {}),
      kind,
      status: 'working',
      answer: '',
    };
    setLocalAnswers((current) => [...current, local]);
    try {
      const server = getActiveMeetingServerId();
      const model = await meetingResearchModel(client, sessionId, meeting.id);
      if (getActiveMeetingServerId() !== server) throw new Error('Meeting server changed.');
      await client.sendTurn(sessionId, {
        ...(model ? { model } : {}),
        prompt:
          kind === 'research'
            ? researchPrompt(
                meeting.id,
                question.trim(),
                meeting.transcript,
                requestId,
                questionId,
                questionTitle,
              )
            : meetingRequestPrompt(
                meeting.id,
                question.trim(),
                meeting.transcript,
                requestId,
                questionId,
                questionTitle,
              ),
        // Each request needs its own reply; steering would fold it into the running one.
        queueBehindActiveTurn: true,
      });
      // A retried card must not clear what is being typed in the composer.
      if (kind === 'request' && askText.current === question) {
        askClearedAfterSend.current = true;
        setInsightQuestion('');
      }
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
        // A link typed earlier stays behind a collapsed field; never start from what is not shown.
        if (!selectedEvent && !manualLink) throw new Error('Pick a meeting or enter its link.');
        const result = selectedEvent
          ? await client.joinCalendarMeeting(selectedEvent.eventKey, sessionId)
          : await client.startOnlineMeeting(
              sessionId,
              meetingUrl.trim(),
              true,
              meetingTitle.trim() || undefined,
            );
        await syncMeetingSession(sessionId);
        const synced = (await listMeetings(sessionId)).find((item) => item.id === result.meetingId);
        if (synced) setMeeting(synced);
        setShowNewMeeting(false);
        await refresh();
        return;
      }
      const next = await (meetingTitle.trim()
        ? startMeeting(sessionId, selectedEngine, expectedParticipants ?? 4, meetingTitle.trim())
        : startMeeting(sessionId, selectedEngine, expectedParticipants ?? 4));
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

  // Moves a meeting Verity joined without a project into this session, with everything said
  // so far, and opens it.
  const continueHere = async (meetingId: string) => {
    if (!sessionId || continuing) return;
    setContinuing(meetingId);
    setError(null);
    try {
      const client = createVerityClient();
      if (!client) throw new Error('Connect to the server.');
      await client.assignLiveMeeting(meetingId, { sessionId });
      await syncMeetingSession(sessionId);
      const synced = (await listMeetings(sessionId)).find((item) => item.id === meetingId);
      if (synced) setMeeting(synced);
      setShowNewMeeting(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await reloadUnassigned();
    } finally {
      setContinuing(null);
    }
  };
  const discardUnassigned = (meetingId: string) =>
    confirm({
      title: 'Discard this meeting?',
      message: 'Verity leaves the call and deletes everything it transcribed.',
      confirmLabel: 'Discard',
      destructive: true,
      onConfirm: async () => {
        try {
          const client = createVerityClient();
          if (!client) throw new Error('Connect to the server to discard this meeting.');
          await client.discardLiveMeeting(meetingId);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        await reloadUnassigned();
      },
    });

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
    const current = meeting
      ? (pendingDrafts.get(meeting.id) ?? (draft?.meetingId === meeting.id ? draft : null))
      : null;
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
  const noteUnsaved =
    noteSaveError !== null && noteSaveError.meetingId === (meeting?.id ?? draft?.meetingId);
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
    (live && !active && meeting?.engine !== 'attendee' && !recorderOnline
      ? 'Recording device unreachable · transcript may be out of date. Notes and research remain available.'
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
      meeting?.state === 'active' && !!meeting.ownerToken
        ? (meeting.speakerNameSuggestions ?? [])
            .filter((suggestion) => meeting.speakerNames?.[suggestion.speaker] === undefined)
            .map((suggestion) => (
              <NoticedCard
                key={`name-${String(suggestion.speaker)}`}
                tone={speakerTone(colors, suggestion.speaker)}
                quote={`“${suggestion.quote}”`}
                title={`${speakerLabel(suggestion.speaker)} is ${suggestion.name}?`}
                onDismiss={() => clearSpeakerNameSuggestion(meeting.id, suggestion.speaker, true)}
                dismissLabel={`Not ${suggestion.name}`}
                actions={[
                  {
                    label: `Yes, ${suggestion.name}`,
                    disabled: speakerEditPending,
                    primary: true,
                    onPress: () => {
                      const names = {
                        ...(speakerEditDraft.current?.names ?? meeting.speakerNames ?? {}),
                      };
                      if (names[suggestion.speaker] === undefined)
                        names[suggestion.speaker] = suggestion.name;
                      // Keep the card until the name is saved, so a failed save can be retried.
                      void persistSpeakerEdits({ names }, false).then((saved) => {
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
      const sourceUrl = source ? meetingAnswerSourceUrl(card.answer) : null;
      const askedAt = meetingRequestTime(card.requestId);
      const note = card.status === 'ready' ? asNote(card.answer) : null;
      const compact =
        card.answer
          .trim()
          .split('\n')
          .find((line) => line.trim()) ?? '';
      const expanded = expandedAnswer === card.id;
      return (
        <NoticedCard
          key={card.id}
          label={
            card.status === 'ready'
              ? undefined
              : card.status === 'failed'
                ? card.combined
                  ? 'NOT ANSWERED SEPARATELY'
                  : 'REQUEST INTERRUPTED'
                : card.kind === 'research'
                  ? 'Researching…'
                  : 'Working on it…'
          }
          tone={
            card.status === 'ready'
              ? colors.success
              : card.status === 'failed'
                ? colors.attention
                : colors.action
          }
          working={card.status === 'working'}
          fresh={live && card.id === newestReady}
          time={askedAt === null ? undefined : timeOfDay(askedAt)}
          title={card.questionTitle ?? card.request}
          onDismiss={() =>
            setDismissed((current) => [
              ...current,
              card.questionId ?? meetingQuestionKey(card.request),
            ])
          }
          dismissLabel="Dismiss meeting answer"
          onToggle={
            card.status === 'ready'
              ? () => setExpandedAnswer((current) => (current === card.id ? null : card.id))
              : undefined
          }
          body={
            card.status === 'failed'
              ? card.combined
                ? 'This reply combined requests. Retry for a separate answer.'
                : 'Verity stopped before answering.'
              : undefined
          }
          source={source}
          sourceUrl={sourceUrl}
          actions={
            card.status === 'ready'
              ? [
                  {
                    label: 'Open in chat',
                    accessibilityLabel: 'Open answer in chat',
                    primary: true,
                    onPress: () =>
                      router.push({ pathname: '/session/[id]', params: { id: sessionId } }),
                  },
                  ...(card.answer.trim()
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
                      onPress: () =>
                        void openResearch(
                          card.request,
                          card.kind,
                          card.questionId,
                          card.questionTitle,
                        ),
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
    const requested = (text: string, questionId?: string) =>
      [...answers, ...queuedAnswers, ...localAnswers].some((card) =>
        questionId && card.questionId
          ? card.questionId === questionId
          : meetingQuestionKey(card.request) === meetingQuestionKey(text),
      );
    let shownInsights = 0;
    for (const insight of insights) {
      if (dismissed.includes(insight.id) || dismissed.includes(meetingQuestionKey(insight.summary)))
        continue;
      const contradiction = insight.kind === 'contradiction';
      const researchText = contradiction
        ? `Check whether “${insight.evidenceA}” conflicts with “${insight.evidenceB ?? insight.summary}”${insight.sourcePath ? ` in ${insight.sourcePath}` : ''}.`
        : insight.id.startsWith('question-')
          ? insight.summary
          : insight.evidenceA;
      const questionId = insight.id.startsWith('question-') ? insight.id : undefined;
      if (
        (contradiction || insight.kind === 'research') &&
        (requested(researchText, questionId) || requested(insight.evidenceA, questionId))
      )
        continue;
      if (shownInsights >= 4) break;
      shownInsights += 1;
      const note = asNote(insight.summary);
      cards.push(
        <NoticedCard
          key={insight.id}
          label={
            contradiction
              ? 'CONTRADICTS PROJECT'
              : insight.id.startsWith('question-')
                ? 'OPEN QUESTION'
                : 'WORTH CHECKING'
          }
          tone={contradiction ? colors.signature : colors.action}
          time={timeOfDay(insight.createdAt)}
          quote={`“${insight.evidenceA}”${insight.evidenceB ? ` · “${insight.evidenceB}”` : ''}`}
          title={insight.summary}
          onDismiss={() =>
            setDismissed((current) => [...current, insight.id, meetingQuestionKey(insight.summary)])
          }
          dismissLabel="Dismiss meeting question"
          source={insight.sourcePath ? `Source: ${insight.sourcePath}` : null}
          actions={[
            ...(contradiction || insight.kind === 'research'
              ? [
                  {
                    label: contradiction ? 'Let Verity check' : 'Let Verity research',
                    accessibilityLabel: contradiction
                      ? 'Check meeting claim'
                      : insight.id.startsWith('question-')
                        ? 'Research meeting question'
                        : 'Research insight',
                    primary: true,
                    disabled: sendingInsight,
                    onPress: () =>
                      void openResearch(
                        researchText,
                        'research',
                        insight.id.startsWith('question-') ? insight.id : undefined,
                      ),
                  },
                ]
              : []),
            ...(note ? [note] : []),
          ]}
        />,
      );
    }
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
        tone={speakerTone(colors, speaker)}
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
        : 'No one has spoken yet.'
    : 'No speaker labels yet.';

  const completedAnswerCount = allMeetingAnswers.filter((card) => card.status === 'ready').length;
  const noteRows = (rows: MeetingNote[]) =>
    rows.map((note) => (
      <Text key={note.id} testID="meeting-note" style={styles.note}>
        <Text style={styles.noteTime}>{noteClockTime(meeting!.startedAt, note.atSeconds)} </Text>
        {note.text}
      </Text>
    ));

  const switchComposer = (mode: 'note' | 'ask') => {
    if (mode === composing) return;
    if (mode === 'ask') {
      askClearedAfterSend.current = false;
      setInsightQuestion(draft?.text ?? '');
    } else if (!askClearedAfterSend.current) editNote(insightQuestion);
    setComposing(mode);
  };
  // The mode switch and its close button share one row; the field itself says what it does.
  const composerMode = (mode: 'note' | 'ask', onClose?: () => void) =>
    !wide && live ? (
      <View style={styles.composerModeRow}>
        <View style={styles.segmented}>
          {(['note', 'ask'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={value === 'note' ? 'Switch to note' : 'Switch to Ask Verity'}
              accessibilityState={{ selected: mode === value, disabled: noteUnsaved }}
              disabled={noteUnsaved}
              onPress={() => switchComposer(value)}
              style={[styles.segment, mode === value && styles.segmentSelected]}
            >
              <Text
                style={[
                  styles.segmentText,
                  mode === value && {
                    color: colors.actionLabel,
                  },
                ]}
              >
                {value === 'note' ? 'Note' : 'Ask Verity'}
              </Text>
            </Pressable>
          ))}
        </View>
        {onClose ? (
          <IconButton
            icon="x"
            accessibilityLabel={mode === 'note' ? 'Close note' : 'Close question'}
            onPress={onClose}
          />
        ) : null}
      </View>
    ) : (
      <SectionLabel>{mode === 'note' ? 'NOTE' : 'ASK VERITY'}</SectionLabel>
    );

  const noteComposer = (autoFocus: boolean, onClose?: () => void) => (
    <View style={styles.composerPanel}>
      {composerMode('note', onClose)}
      <View style={styles.composer}>
        <View style={styles.composerChip}>
          <Text style={styles.composerTime}>
            {meeting
              ? noteClockTime(
                  meeting.startedAt,
                  draft?.atSeconds ?? (Date.now() - meeting.startedAt) / 1000,
                )
              : ''}
          </Text>
        </View>
        <TextInput
          accessibilityLabel="Add a meeting note"
          autoFocus={autoFocus}
          maxLength={10_000}
          placeholder="Add a note…"
          placeholderTextColor={colors.textFaint}
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
          style={[styles.composerSend, noteUnsaved && styles.composerSendRetry]}
        >
          <Icon
            name={noteUnsaved ? 'rotate-cw' : 'arrow-up'}
            size={18}
            color={noteUnsaved ? colors.attention : colors.actionLabel}
          />
        </Pressable>
      </View>
    </View>
  );

  const askDisabled = !insightQuestion.trim() || sendingInsight;
  const askComposer = (autoFocus: boolean, onClose?: () => void) => (
    <View style={styles.composerPanel}>
      {composerMode('ask', onClose)}
      <View style={styles.composer}>
        <View style={styles.composerChip}>
          <Image
            source={VERITY_MARK}
            accessibilityIgnoresInvertColors
            style={styles.composerMark}
          />
        </View>
        <TextInput
          accessibilityLabel="Ask Verity about this meeting"
          autoFocus={autoFocus}
          placeholder="Ask Verity about this meeting…"
          placeholderTextColor={colors.textFaint}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          value={insightQuestion}
          onChangeText={(text) => {
            askClearedAfterSend.current = false;
            setInsightQuestion(text);
          }}
          onSubmitEditing={() => void openResearch(insightQuestion, 'request')}
          style={styles.composerInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask Verity in meeting"
          accessibilityState={{ disabled: askDisabled }}
          disabled={askDisabled}
          onPress={() => void openResearch(insightQuestion, 'request')}
          style={[styles.composerSend, styles.composerSendVerity, askDisabled && styles.dimmed]}
        >
          {sendingInsight ? (
            <ActivityIndicator size="small" color={colors.signature} />
          ) : (
            <Icon name="arrow-up" size={18} color={colors.signature} />
          )}
        </Pressable>
      </View>
    </View>
  );

  const transcriptQuery = transcriptSearch.trim().toLocaleLowerCase();
  const transcriptRows = chunks.filter(
    (chunk) =>
      !transcriptQuery ||
      (chunk.text + ' ' + ('speaker' in chunk ? speakerLabel(chunk.speaker) : ''))
        .toLocaleLowerCase()
        .includes(transcriptQuery),
  );
  const speakerEditable = Boolean(meeting?.ownerToken || meeting?.engine === 'attendee');
  const trackTranscriptEnd = (event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    transcriptAtEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
    setTranscriptBehind(!transcriptAtEnd.current);
  };
  const transcriptSheet = meeting ? (
    <Modal
      visible={transcriptExpanded}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => setTranscriptExpanded(false)}
    >
      <View
        style={[styles.sheet, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}
      >
        {/* The title owns the row; closing sits at its end, never pushed by a long name. */}
        <View style={styles.sheetHeader}>
          <View style={styles.fill}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              Transcript
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {[
                meeting.title || null,
                live ? 'live' : null,
                speakers.length ? `${speakers.length} voices` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <IconButton
            icon="x"
            accessibilityLabel="Collapse transcript"
            onPress={() => setTranscriptExpanded(false)}
          />
        </View>
        <SearchField
          accessibilityLabel="Search transcript"
          placeholder="Search text or speaker"
          value={transcriptSearch}
          onChangeText={setTranscriptSearch}
        />
        {speakerEditable && speakers.length ? (
          <Text style={styles.hint}>Tap a line to correct its speaker.</Text>
        ) : null}
        <FlatList
          ref={transcriptList}
          testID="meeting-transcript"
          data={transcriptRows}
          // Rows read speaker names from the meeting; a rename must redraw them.
          extraData={meeting.speakerNames}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={styles.transcriptContent}
          renderItem={({ item, index }) => {
            const attributed = 'start' in item && !item.pending;
            const previous = transcriptRows[index - 1];
            // A speaker change starts a turn with its avatar; following lines join it.
            const startsTurn =
              attributed &&
              (!previous ||
                !('start' in previous) ||
                previous.pending ||
                previous.speaker !== item.speaker);
            if (!attributed)
              // Not yet attributed: shown without a speaker until the diarizer catches up.
              return (
                <Text
                  style={[
                    styles.transcriptText,
                    styles.transcriptIndent,
                    item.pending && styles.transcriptPending,
                  ]}
                >
                  {item.text}
                </Text>
              );
            const tone =
              item.speaker === null ? colors.textFaint : speakerTone(colors, item.speaker);
            return (
              <View style={startsTurn && index > 0 ? styles.turnGap : null}>
                {startsTurn ? (
                  <View style={styles.turnHead}>
                    <SpeakerAvatar
                      initial={item.speaker === null ? '?' : speakerInitial(item.speaker)}
                      tone={tone}
                      dashed={item.speaker === null}
                      size={28}
                    />
                    <Text style={[styles.turnName, { color: tone }]}>
                      {speakerLabel(item.speaker)}
                    </Text>
                    <Text style={styles.turnTime}>
                      {noteClockTime(meeting.startedAt, item.start)}
                    </Text>
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Correct speaker for ${item.text}`}
                  disabled={!speakerEditable}
                  onPress={() => correctSpeaker(item, speakerChoices)}
                >
                  <Text style={[styles.transcriptText, styles.transcriptIndent]}>{item.text}</Text>
                </Pressable>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.hint}>Recognized speech will appear here.</Text>}
          onScrollBeginDrag={() => {
            transcriptAtEnd.current = false;
          }}
          onScrollEndDrag={trackTranscriptEnd}
          onMomentumScrollEnd={trackTranscriptEnd}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (transcriptAtEnd.current) transcriptList.current?.scrollToEnd({ animated: true });
          }}
        />
        {live && transcriptBehind ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to the latest words"
            onPress={() => {
              transcriptAtEnd.current = true;
              setTranscriptBehind(false);
              transcriptList.current?.scrollToEnd({ animated: true });
            }}
            style={styles.jumpToLive}
          >
            <Icon name="arrow-down" size={16} color={colors.actionLabel} />
            <Text style={styles.transcriptPillText}>Jump to live</Text>
          </Pressable>
        ) : null}
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
            <Button
              label="Cancel"
              variant="text"
              onPress={() => {
                if (meeting) setShowNewMeeting(false);
                else if (router.canGoBack()) router.back();
                else router.replace({ pathname: '/session/[id]', params: { id: sessionId } });
              }}
            />
          </View>
          {error ? <HintBox title="Could not start the meeting" message={error} /> : null}
          {noteUnsaved || draft?.text.trim() ? (
            <Card>
              <View style={styles.setupCard} testID="unsaved-note">
                <UiText variant="row">
                  {noteUnsaved
                    ? 'A note from your last meeting isn’t saved'
                    : 'Finish a note from your last meeting'}
                </UiText>
                {draft?.text.trim() ? <UiText>“{draft.text.trim()}”</UiText> : null}
                <UiText variant="subtitle">
                  The meeting itself is kept. Save this note to finish it.
                  {noteSaveError?.message
                    ? ` (${noteSaveError.message.replace(/^Note could not be saved: /, '')})`
                    : ''}
                </UiText>
                <View style={styles.setupInline}>
                  <Button
                    label={noteUnsaved ? 'Retry save' : 'Save note'}
                    accessibilityLabel={noteUnsaved ? 'Retry saving note' : 'Save recovered note'}
                    icon="rotate-cw"
                    variant="secondary"
                    size="compact"
                    onPress={submitNote}
                  />
                </View>
              </View>
            </Card>
          ) : null}
          {unassignedMeetings.map((item) => (
            <UnassignedMeetingCard
              key={item.id}
              meeting={item}
              now={now}
              busy={continuing === item.id}
              onContinue={() => void continueHere(item.id)}
              onDiscard={() => discardUnassigned(item.id)}
            />
          ))}
          {/* A calendar meeting brings its own title. */}
          {meetingSource === 'online' && selectedEvent ? null : (
            <TextField
              label="Title"
              accessibilityLabel="Meeting title"
              value={meetingTitle}
              onChangeText={(value) => {
                titleEdited.current = true;
                setMeetingTitle(value);
              }}
              maxLength={200}
              placeholder="Optional"
            />
          )}
          <View style={styles.setupSection}>
            <SectionHeader title="Meeting source" />
            <Group>
              <Row
                title="In person"
                subtitle="Records with this device's microphone"
                leading={{ icon: 'mic' }}
                selected={meetingSource === 'presence'}
                onPress={() => setMeetingSource('presence')}
              />
              <Row
                title="Online meeting"
                subtitle="Joins the call and keeps transcribing in the background"
                leading={{ icon: 'video' }}
                selected={meetingSource === 'online'}
                onPress={() => setMeetingSource('online')}
              />
            </Group>
          </View>
          <CalendarMeetingPicker
            upcoming={upcoming}
            loadFailed={calendarLoadFailed}
            inPerson={meetingSource === 'presence'}
            onChooseCalendars={() => router.push('/settings/meeting-calendars')}
            selectedKey={meetingSource === 'presence' || selectedEvent ? selectedEventKey : null}
            onSelect={(eventKey) => {
              titleEdited.current = false;
              setSelectedEventKey(eventKey);
              const chosen = upcoming?.find((event) => event.eventKey === eventKey);
              if (chosen) {
                titledEvent.current = eventKey;
                setMeetingTitle(chosen.title ?? '');
              }
            }}
            manual={manualLink}
            onManualChange={setManualLink}
            meetingUrl={meetingUrl}
            onMeetingUrlChange={setMeetingUrl}
            now={now}
          />
          {meetingSource === 'online' ? (
            <View style={styles.setupSection}>
              <UiText variant="footnote">
                {attendeeConfigured
                  ? 'Transcription continues while the app is closed. Requires Verity Premium Online sharing.'
                  : 'Configure online meetings and enable Verity Premium Online sharing.'}
              </UiText>
              <View style={styles.setupInline}>
                {!attendeeConfigured ? (
                  <Button
                    label="Configure online meetings"
                    variant="text"
                    size="compact"
                    onPress={() => router.push('/settings/services')}
                  />
                ) : null}
                <Button
                  label="Verity Premium"
                  variant="text"
                  size="compact"
                  onPress={() => router.push('/settings/premium')}
                />
              </View>
            </View>
          ) : (
            <>
              <View style={styles.setupSection}>
                <SectionHeader title="Who is there?" />
                <Group>
                  {(
                    [
                      [4, 'Up to 4 people', 'Each voice gets its own speaker'],
                      [10, 'Larger group', 'Tuned for many voices in one room'],
                    ] as const
                  ).map(([count, label, detail]) => (
                    <Row
                      key={count}
                      title={label}
                      subtitle={detail}
                      selected={(expectedParticipants ?? 4) === count}
                      disabled={busy}
                      onPress={() => setExpectedParticipants(count)}
                    />
                  ))}
                </Group>
              </View>
              <View style={styles.setupSection}>
                <SectionHeader title="Speech recognition" />
                <Group>
                  {showEngines && engines.length > 0 ? (
                    engines.map((item) => (
                      <Row
                        key={item.id}
                        title={item.name}
                        subtitle={item.available ? undefined : 'Unavailable on this device'}
                        selected={selectedEngine === item.id}
                        disabled={!item.available || busy}
                        onPress={() => {
                          setSelectedEngine(item.id);
                          setShowEngines(false);
                        }}
                      />
                    ))
                  ) : (
                    <Row
                      title={engine?.name ?? 'On device'}
                      leading={{ icon: 'cpu' }}
                      trailing="Change"
                      accessibilityLabel="Speech recognition"
                      onPress={() => setShowEngines(true)}
                    />
                  )}
                </Group>
              </View>
            </>
          )}
          <Button
            label={
              returning
                ? 'Return to live meeting'
                : meetingSource === 'online'
                  ? selectedEvent
                    ? `Join ${selectedEvent.title || 'meeting'}`
                    : 'Start online meeting'
                  : 'Start recording'
            }
            accessibilityLabel="Start meeting"
            icon={returning ? 'arrow-right' : meetingSource === 'online' ? 'video' : 'mic'}
            loading={busy}
            disabled={
              meetingSource === 'online' &&
              (!attendeeConfigured || (!selectedEvent && !(manualLink && meetingUrl.trim())))
            }
            onPress={start}
            fullWidth
          />
        </ScrollView>
        {confirmSheet}
      </View>
    );
  }

  if (!meeting) return null;

  if (!live) {
    const unnamed = speakers.find((speaker) => !meeting.speakerNames?.[speaker]);
    const editable = Boolean(meeting.ownerToken || meeting.engine === 'attendee');
    const report = (reason: unknown) =>
      Alert.alert('Could not save', reason instanceof Error ? reason.message : 'Please try again.');
    return (
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.root, { paddingTop: insets.top + 12 }]}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <MeetingResult
          meeting={meeting}
          wide={wide}
          people={speakers.length}
          bottomInset={insets.bottom}
          status={statusLines}
          onDone={() => router.back()}
          onContinue={() => router.push({ pathname: '/session/[id]', params: { id: sessionId } })}
          onTranscript={() => setTranscriptExpanded(true)}
          onResearch={(question) => {
            void openResearch(question);
          }}
          onShare={(format) => {
            void shareMeetingResult(sessionId, meeting.id, format, meeting.serverId).catch(report);
          }}
          onDiscard={() =>
            confirm({
              title: `Discard “${meeting.title || 'this meeting'}”?`,
              message: discardMessage(finalizedNotes.length, meeting.serverId != null),
              confirmLabel: 'Discard',
              destructive: true,
              onConfirm: async () => {
                try {
                  // A note write still in flight would otherwise land after the delete.
                  await pendingNoteWrites.get(meeting.id)?.catch(() => undefined);
                  await discardFinishedMeeting(sessionId, meeting);
                  // Nothing cached for it may be written back afterwards.
                  pendingDrafts.delete(meeting.id);
                  pendingNoteErrors.delete(meeting.id);
                } catch (reason) {
                  Alert.alert(
                    'Could not discard',
                    reason instanceof Error ? reason.message : 'Please try again.',
                  );
                  return;
                }
                if (router.canGoBack()) router.back();
                else router.replace({ pathname: '/session/[id]', params: { id: sessionId } });
              },
            })
          }
          onEditTitle={() => {
            if (!editable) return;
            textPrompt.prompt(
              'Meeting title',
              'The title appears in the filed meeting.',
              (value) => {
                if (value.trim().length > 200) {
                  report(new Error('Titles can be at most 200 characters.'));
                  return;
                }
                void (async () => {
                  const client = createVerityClient();
                  if (meeting.engine === 'attendee') {
                    if (!client) throw new Error('Connect to your server first.');
                    await client.editOnlineMeetingSpeakers(sessionId, meeting.id, {
                      title: value.trim() || null,
                    });
                  } else await updateMeetingTitle(meeting.id, value);
                  await syncMeetingSession(sessionId);
                  await refresh();
                })().catch(report);
              },
              'plain-text',
              meeting.title || '',
            );
          }}
          noteCount={finalizedNotes.length}
          canRename={editable}
          notesOpen={composerVisible}
          answerCount={completedAnswerCount}
          notes={
            finalizedNotes.length || composerVisible ? (
              <View style={styles.block}>
                {finalizedNotes.map((note) => (
                  <View key={note.id}>
                    {noteRows([note])}
                    <Button
                      label="Edit note"
                      variant="text"
                      size="compact"
                      accessibilityLabel={`Edit note: ${note.text}`}
                      onPress={() => {
                        textPrompt.prompt(
                          'Edit note',
                          'Keep your note separate from participant statements.',
                          (value) => {
                            if (!value.trim() || value.length > 10000) {
                              report(new Error('Enter a note of 1–10,000 characters.'));
                              return;
                            }
                            void (async () => {
                              await updateNote(note, value);
                              await syncMeetingSession(sessionId);
                              setNotes(await listNotes(meeting.id));
                            })().catch(report);
                          },
                          'plain-text',
                          note.text,
                        );
                      }}
                    />
                  </View>
                ))}
                {composerVisible ? noteComposer(false) : null}
              </View>
            ) : null
          }
          speakers={
            speakers.length ? (
              <View style={styles.block}>
                <View style={styles.avatarRow}>{speakerAvatars(true)}</View>
                {unnamed !== undefined && editable ? (
                  <Button
                    label={`${speakerLabel(unnamed)} · Name ›`}
                    variant="text"
                    onPress={() => renameSpeaker(unnamed)}
                  />
                ) : null}
                {restoreMerged}
              </View>
            ) : null
          }
          answers={
            visibleAnswers.length ? (
              <View style={styles.block}>{noticedCards().slice(0, visibleAnswers.length)}</View>
            ) : null
          }
        />
        {textPrompt.dialog}
        {confirmSheet}
        {transcriptSheet}
      </KeyboardAvoidingView>
    );
  }

  const paused = meeting.captureStatus === 'paused';
  const preparing =
    meeting.captureStatus === 'preparing' || meeting.captureStatus === 'downloading';
  const stateWord = voiceSending
    ? 'Sending request…'
    : paused
      ? 'Paused'
      : meeting.captureStatus === 'downloading'
        ? 'Preparing language model…'
        : preparing
          ? 'Preparing microphone…'
          : !active && !recorderOnline && meeting.engine !== 'attendee'
            ? // Viewed from another device whose recorder stopped reporting.
              'Meeting'
            : 'Recording';
  const statusLine = [
    stateWord,
    paused || preparing ? null : elapsed(meeting.startedAt, now),
    meeting.engine === 'attendee' ? 'Online meeting' : null,
    meeting.serverId === null ? 'Saved only on this device' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // Phone: what is recording and how sits under the title, controls on the right.
  const header = (
    <View style={styles.header}>
      <IconButton icon="chevron-down" accessibilityLabel="Minimize meeting" onPress={minimize} />
      <View style={styles.fill}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {meeting.title || 'Live meeting'}
        </Text>
        <View style={styles.wideStatus}>
          {liveProblem === null ? (
            <BreathingDot
              color={
                voiceSending
                  ? colors.signature
                  : paused || preparing
                    ? colors.textFaint
                    : colors.success
              }
              breathing={!paused && !preparing}
            />
          ) : null}
          <Text
            testID="meeting-live-status"
            numberOfLines={2}
            style={[styles.wideStatusText, styles.fill, liveProblem !== null && styles.statusError]}
          >
            {liveProblem ?? statusLine}
          </Text>
        </View>
      </View>
      <IconButton
        icon={paused ? 'play' : 'pause'}
        accessibilityLabel={paused ? 'Resume meeting' : 'Pause meeting'}
        disabled={
          busy ||
          meeting.engine === 'attendee' ||
          !!pendingCommand ||
          (!paused && meeting.captureStatus !== 'listening')
        }
        onPress={togglePause}
      />
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
          style={styles.transcriptPill}
        >
          <Icon name="file-text" size={16} color={colors.action} />
          <Text style={styles.transcriptPillText}>Transcript</Text>
        </Pressable>
      </View>
      {restoreMerged}
    </View>
  );
  const cards = noticedCards();
  const noticed = (
    <View style={styles.block}>
      <View style={styles.noticedHeader}>
        <Image source={VERITY_MARK} accessibilityIgnoresInvertColors style={styles.composerMark} />
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

  if (wide) {
    // Consecutive lines of one speaker read as one turn; words the diarizer has not
    // reached yet trail the latest turn in a muted tone.
    const turns: { speaker: number | null; start: number; parts: TranscriptRow[] }[] = [];
    for (const line of chunks.slice(-12)) {
      const last = turns.at(-1);
      if ('speaker' in line && !line.pending && last?.speaker !== line.speaker)
        turns.push({ speaker: line.speaker, start: line.start, parts: [line] });
      else if (last) last.parts.push(line);
      else
        turns.push({
          speaker: 'speaker' in line && !line.pending ? line.speaker : null,
          start: 'start' in line ? line.start : (now - meeting.startedAt) / 1000,
          parts: [line],
        });
    }
    return (
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.page}>
          {transcriptExpanded ? null : (
            <View style={styles.header}>
              <IconButton
                icon="chevron-down"
                accessibilityLabel="Minimize meeting"
                onPress={minimize}
              />
              <View style={styles.fill}>
                <Text style={styles.wideTitle} numberOfLines={1}>
                  {meeting.title || 'Live meeting'}
                </Text>
                <View style={styles.wideStatus}>
                  {liveProblem === null ? (
                    <BreathingDot
                      color={paused || preparing ? colors.textFaint : colors.success}
                      breathing={!paused && !preparing}
                    />
                  ) : null}
                  <Text
                    testID="meeting-live-status"
                    numberOfLines={1}
                    style={[styles.wideStatusText, liveProblem !== null && styles.statusError]}
                  >
                    {liveProblem ?? statusLine}
                  </Text>
                </View>
              </View>
              <IconButton
                icon={paused ? 'play' : 'pause'}
                accessibilityLabel={paused ? 'Resume meeting' : 'Pause meeting'}
                disabled={
                  busy ||
                  meeting.engine === 'attendee' ||
                  !!pendingCommand ||
                  (!paused && meeting.captureStatus !== 'listening')
                }
                onPress={togglePause}
              />
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
          )}
          <View style={styles.columns}>
            <View style={styles.column}>
              <View style={styles.roomHead}>
                <Text style={styles.roomLabel}>IN THE ROOM</Text>
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel="Transcript"
                  accessibilityState={{ checked: showTranscript }}
                  onPress={() => {
                    // Shown again, the transcript starts at the newest words and follows them.
                    wideTranscriptAtEnd.current = true;
                    setMeetingTranscriptVisible(!showTranscript);
                  }}
                  style={styles.transcriptSwitch}
                >
                  <Text style={styles.wideStatusText}>Transcript</Text>
                  <Toggle value={showTranscript} />
                </Pressable>
              </View>
              {speakers.length ? (
                <View style={styles.avatarRow}>{speakerAvatars(true)}</View>
              ) : !active || meeting.speakerStatus === 'unavailable' ? (
                <Text style={styles.hint}>{speakerStatus}</Text>
              ) : (
                // Holds the first speaker's place so the row does not jump when they appear.
                <View style={styles.avatarRow}>
                  <SpeakerAvatar
                    initial=""
                    tone={colors.textFaint}
                    dashed
                    size={44}
                    caption={meeting.speakerStatus === 'loading' ? 'Preparing…' : 'No one yet'}
                    accessibilityLabel={speakerStatus}
                  />
                </View>
              )}
              {restoreMerged}
              {showTranscript ? (
                <ScrollView
                  ref={transcriptEnd}
                  testID="meeting-transcript"
                  style={styles.transcriptPane}
                  contentContainerStyle={styles.transcriptTurns}
                  scrollEventThrottle={100}
                  onScroll={({ nativeEvent }) => {
                    wideTranscriptAtEnd.current =
                      nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >=
                      nativeEvent.contentSize.height - 24;
                  }}
                  onContentSizeChange={() => {
                    if (wideTranscriptAtEnd.current)
                      transcriptEnd.current?.scrollToEnd({ animated: false });
                  }}
                >
                  {turns.length ? (
                    turns.map((turn, index) => (
                      <View key={index} style={styles.turn}>
                        <SpeakerAvatar
                          initial={turn.speaker === null ? '?' : speakerInitial(turn.speaker)}
                          tone={
                            turn.speaker === null
                              ? colors.textFaint
                              : speakerTone(colors, turn.speaker)
                          }
                          dashed={turn.speaker === null}
                          size={28}
                        />
                        <View style={styles.fill}>
                          <Text>
                            <Text style={styles.turnName}>{speakerLabel(turn.speaker)}</Text>
                            <Text style={styles.turnTime}>
                              {'  '}
                              {noteClockTime(meeting.startedAt, turn.start)}
                            </Text>
                          </Text>
                          <Text style={styles.transcriptText}>
                            {turn.parts.map((part, partIndex) => (
                              <Text
                                key={partIndex}
                                style={part.pending ? styles.transcriptPending : undefined}
                              >
                                {partIndex ? ' ' : ''}
                                {part.text}
                              </Text>
                            ))}
                          </Text>
                        </View>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.hint}>Listening…</Text>
                  )}
                </ScrollView>
              ) : null}
              <Text style={styles.roomLabel}>NOTES</Text>
              <View style={styles.notesCard}>
                <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
                  {finalizedNotes.map((note, index) => (
                    <View
                      key={note.id}
                      testID="meeting-note"
                      style={[styles.noteRow, index > 0 && styles.noteRowDivided]}
                    >
                      <Text style={styles.noteRowTime}>
                        {noteClockTime(meeting.startedAt, note.atSeconds)}
                      </Text>
                      <Text style={styles.noteRowText}>{note.text}</Text>
                    </View>
                  ))}
                </ScrollView>
                <View style={styles.noteField}>
                  <TextInput
                    accessibilityLabel="Add a meeting note"
                    maxLength={10_000}
                    placeholder="Add a note…"
                    placeholderTextColor={colors.textFaint}
                    multiline
                    submitBehavior="submit"
                    value={draft?.text ?? ''}
                    onChangeText={editNote}
                    onSubmitEditing={submitNote}
                    style={styles.noteInput}
                  />
                  <Pressable
                    onPress={submitNote}
                    accessibilityRole="button"
                    accessibilityLabel={noteUnsaved ? 'Retry saving note' : 'Add note'}
                    style={styles.noteAdd}
                  >
                    <Icon
                      name={noteUnsaved ? 'rotate-cw' : 'plus'}
                      size={18}
                      color={noteUnsaved ? colors.attention : colors.action}
                    />
                  </Pressable>
                </View>
              </View>
            </View>
            <View style={styles.column}>
              <VerityPane
                footer={
                  <AskVerityField
                    value={insightQuestion}
                    onChangeText={(text) => {
                      askClearedAfterSend.current = false;
                      setInsightQuestion(text);
                    }}
                    onSubmit={() => void openResearch(insightQuestion, 'request')}
                    sending={sendingInsight}
                    model={modelChoice?.effective}
                    onPickModel={() => setModelSheetOpen(true)}
                  />
                }
              >
                {cards}
              </VerityPane>
            </View>
          </View>
        </View>
        <MeetingModelSheet
          visible={modelSheetOpen}
          models={modelChoice?.models ?? []}
          selected={modelChoice?.effective}
          onPick={pickMeetingModel}
          onClose={() => setModelSheetOpen(false)}
        />
        {transcriptSheet}
      </KeyboardAvoidingView>
    );
  }

  const lastNote = finalizedNotes.at(-1);
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.page}>
        {transcriptExpanded ? null : header}
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <MeetingWave active={!paused && !preparing} addressed={voiceSending} />
          {speakerRow(true)}
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
            {/* A failed save keeps the field open until it is retried; a draft stays autosaved. */}
            {noteComposer(composing === 'note', noteUnsaved ? undefined : () => setComposing(null))}
          </View>
        ) : composing === 'ask' ? (
          <View style={styles.composerLine}>{askComposer(true, () => setComposing(null))}</View>
        ) : (
          <View style={styles.bottomBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write a note"
              onPress={() => setComposing('note')}
              style={[styles.barButton, styles.barButtonNote]}
            >
              <Icon name="edit-2" size={18} color={colors.text} />
              <Text style={styles.barButtonText}>
                Note
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
              <Image
                source={VERITY_MARK}
                accessibilityIgnoresInvertColors
                style={styles.composerMark}
              />
              <Text style={styles.barButtonText}>Ask Verity</Text>
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

const styles = StyleSheet.create((theme) => {
  const colors = theme.colors;
  return {
    root: { flex: 1, backgroundColor: colors.background },
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
      borderColor: tint(colors.attention, 'border'),
      backgroundColor: tint(colors.attention, 'fill'),
      justifyContent: 'center',
    },
    headerTitle: {
      color: colors.text,
      fontFamily: theme.fonts.bold,
      fontSize: theme.typography.row.fontSize,
    },
    endButtonText: {
      color: colors.attention,
      fontFamily: theme.fonts.bold,
      fontSize: theme.typography.row.fontSize,
    },
    status: {
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.footnote.fontSize,
    },
    statusError: { color: colors.attention },
    error: {
      color: colors.attention,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    hint: {
      color: colors.textFaint,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    link: {
      color: colors.action,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
    },
    avatarLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
    avatarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
    noticedHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    transcriptPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs + 2,
      minHeight: 36,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    transcriptPillText: {
      color: colors.actionLabel,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    noticedTitle: {
      flex: 1,
      color: colors.text,
      fontSize: theme.typography.row.fontSize,
      fontFamily: theme.fonts.bold,
    },
    note: {
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
      lineHeight: 22,
    },
    noteTime: { color: colors.textFaint, fontFamily: theme.fonts.bold },
    notesCard: {
      flex: 1,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    composerLine: { paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.lg },
    composerPanel: { gap: theme.spacing.sm },
    composerModeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    // One row like a message field: what the entry is on the left, send on the right.
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: theme.spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
      borderRadius: 24,
      padding: 5,
    },
    composerChip: {
      minWidth: 38,
      height: 38,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.action, 'fill'),
    },
    composerTime: {
      color: colors.actionLabel,
      fontFamily: theme.fonts.bold,
      fontSize: theme.typography.bodySmall.fontSize,
      fontVariant: ['tabular-nums'],
    },
    composerMark: { width: 18, height: 18 / VERITY_MARK_RATIO },
    composerInput: {
      flex: 1,
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
      minHeight: 38,
      maxHeight: 120,
      paddingTop: 9,
      paddingBottom: 9,
    },
    composerSend: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.action, 'fill'),
      borderWidth: 1,
      borderColor: tint(colors.action, 'border'),
    },
    composerSendRetry: {
      backgroundColor: tint(colors.attention, 'fill'),
      borderColor: tint(colors.attention, 'border'),
    },
    composerSendVerity: {
      backgroundColor: tint(colors.signature, 'fill'),
      borderColor: tint(colors.signature, 'border'),
    },
    dimmed: { opacity: 0.45 },
    // Lifted clear of the home indicator so neither pill sits on the screen edge.
    bottomBar: {
      flexDirection: 'row',
      gap: theme.spacing.md,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.lg,
    },
    barButton: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      minHeight: 52,
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    barButtonNote: { flexGrow: 0, flexShrink: 0, minWidth: 128 },
    barButtonText: {
      color: colors.text,
      fontSize: theme.typography.row.fontSize,
      fontFamily: theme.fonts.bold,
    },
    barButtonPrimary: {
      flex: 1,
      borderColor: tint(colors.signature, 'border'),
      backgroundColor: tint(colors.signature, 'fill'),
    },
    columns: { flex: 1, flexDirection: 'row', gap: theme.spacing.xl, paddingTop: theme.spacing.md },
    wideTitle: { ...theme.typography.title, color: colors.text },
    wideStatus: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    wideStatusText: { ...theme.typography.subtitle, flexShrink: 1, color: colors.textMuted },
    roomHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    roomLabel: { ...theme.typography.label, color: colors.textMuted },
    transcriptSwitch: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    // Splits the bounded column evenly with the notes card (also flex: 1), so the
    // transcript scrolls inside its half instead of pushing the notes down word by word.
    transcriptPane: { flex: 1 },
    transcriptTurns: { gap: theme.spacing.lg },
    turn: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
    turnName: { ...theme.typography.row, color: colors.text },
    turnTime: { ...theme.typography.footnote, color: colors.textFaint },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    noteRowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
    noteRowTime: { ...theme.typography.footnote, width: 44, color: colors.textFaint },
    noteRowText: { ...theme.typography.body, flex: 1, color: colors.text },
    noteField: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.radius.control,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    noteInput: {
      ...theme.typography.body,
      flex: 1,
      maxHeight: 120,
      color: colors.text,
      paddingVertical: theme.spacing.sm,
    },
    noteAdd: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.control,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.action, 'fill'),
      borderWidth: 1,
      borderColor: tint(colors.action, 'border'),
    },
    column: { flex: 1, gap: theme.spacing.md },
    setupSection: { gap: theme.spacing.sm },
    setupCard: { flex: 1, gap: theme.spacing.sm },
    setupInline: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { ...theme.typography.display, color: colors.text },
    subtitle: {
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
      marginTop: -theme.spacing.lg,
    },
    segmented: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
      borderRadius: theme.radius.pill,
      padding: 2,
    },
    segment: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xs + 2,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    segmentSelected: {
      borderColor: tint(colors.action, 'border'),
      backgroundColor: tint(colors.action, 'fill'),
    },
    segmentText: {
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    rowText: {
      flex: 1,
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
    },
    rowValue: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
      textAlign: 'right',
    },
    startButtonText: {
      color: colors.text,
      fontSize: theme.typography.title.fontSize,
      fontFamily: theme.fonts.bold,
    },
    savedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
    },
    sheet: {
      flex: 1,
      backgroundColor: colors.background,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
    sheetTitle: {
      color: colors.text,
      fontSize: theme.typography.display.fontSize,
      fontFamily: theme.fonts.bold,
    },
    transcriptIndent: { paddingLeft: 36 },
    turnHead: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    turnGap: { marginTop: theme.spacing.md },
    jumpToLive: {
      position: 'absolute',
      alignSelf: 'center',
      bottom: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs + 2,
      minHeight: 40,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: tint(colors.action, 'border'),
      backgroundColor: colors.surface,
    },
    transcriptContent: { gap: theme.spacing.xs, paddingBottom: 96 },
    transcriptText: {
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
      lineHeight: 24,
    },
    transcriptPending: { color: colors.textMuted },
  };
});
