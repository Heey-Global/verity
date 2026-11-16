import type { STTEvent } from './liveMeetingSTT';
import type { SpeakerTurn, TimedWord } from './liveMeetingStore';
import {
  applySTTEvent,
  emptySTTTranscript,
  type STTTranscriptState,
} from './liveMeetingSTTTranscript';
import { wordsFromRuns } from './liveMeetingSpeakers';

export interface NativeMeetingState {
  sequence: number;
  transcript: STTTranscriptState;
  words: TimedWord[];
  turns: SpeakerTurn[];
  gaps: Array<{ at: number; message: string }>;
  captureStatus: 'preparing' | 'downloading' | 'listening' | 'paused';
  terminal?: 'ended' | 'interrupted';
  error: string | null;
  recordedAt?: number;
  endedAt?: number;
  confirmedAudioThrough?: number;
}

export const emptyNativeMeetingState: NativeMeetingState = {
  sequence: 0,
  transcript: emptySTTTranscript,
  words: [],
  turns: [],
  gaps: [],
  captureStatus: 'preparing',
  error: null,
};

/** Replayed events replace by audio range, never append the same phrase twice. */
export function reduceNativeMeetingEvent(
  state: NativeMeetingState,
  sequence: number,
  event: STTEvent,
  participants = 4,
): NativeMeetingState {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Invalid native sequence.');
  if (sequence <= state.sequence) return state;
  const next: NativeMeetingState = { ...state, sequence };
  // iOS stamps events with fractional milliseconds; the server keeps whole ones.
  const recordedAt =
    event.recordedAt !== undefined && Number.isFinite(event.recordedAt)
      ? Math.round(event.recordedAt)
      : undefined;
  if (recordedAt !== undefined) next.recordedAt = recordedAt;
  if (event.kind === 'segment' || event.kind === 'snapshot') {
    next.transcript = applySTTEvent(state.transcript, event);
    const through = event.kind === 'segment' ? event.end : event.audioThrough;
    if (event.final && through !== undefined && Number.isFinite(through) && through >= 0)
      next.confirmedAudioThrough = Math.max(state.confirmedAudioThrough ?? 0, through);
  }
  const words =
    event.kind === 'words'
      ? event.words
      : event.kind === 'segment' && event.final
        ? event.runs
          ? wordsFromRuns(event.runs)
          : [{ text: event.text, start: event.start, end: event.end }]
        : [];
  const valid = words.filter(
    (word) =>
      word.text.trim() &&
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.start >= 0 &&
      word.end > word.start,
  );
  if (valid.length) {
    const keys = new Set(state.words.map((word) => JSON.stringify(word)));
    next.words = [
      ...state.words,
      ...valid.filter((word) => {
        const key = JSON.stringify(word);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      }),
    ].sort((a, b) => a.start - b.start);
  }
  if (
    event.kind === 'speaker' &&
    Number.isInteger(event.speaker) &&
    event.speaker >= 0 &&
    event.speaker < (participants > 4 ? 10 : 4) &&
    Number.isFinite(event.start) &&
    Number.isFinite(event.end) &&
    event.start >= 0 &&
    event.end > event.start
  ) {
    const turn = { speaker: event.speaker, start: event.start, end: event.end };
    if (
      !state.turns.some(
        (old) => old.speaker === turn.speaker && old.start === turn.start && old.end === turn.end,
      )
    )
      next.turns = [...state.turns, turn].sort((a, b) => a.start - b.start);
  }
  if (event.kind === 'gap') {
    next.gaps = [...state.gaps, { at: event.at, message: event.message }];
    next.error = event.message;
  }
  if (event.kind === 'buffer-status') next.error = event.message;
  if (event.kind === 'activity-status' && !event.available)
    next.error = 'The Lock Screen meeting display is unavailable. Open Verity to check recording.';
  if (event.kind === 'status') {
    if (event.state === 'failed') {
      next.terminal = 'interrupted';
      next.endedAt = recordedAt;
      next.error = event.message ?? 'Transcription stopped.';
    } else if (event.state === 'stopped') {
      next.terminal = 'ended';
      next.endedAt = recordedAt;
    } else next.captureStatus = event.state;
  }
  return next;
}
