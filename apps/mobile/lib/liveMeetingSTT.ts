import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type STTEngineId = 'apple-speech' | 'apple-dictation' | 'fluid-nemotron' | 'fluid-parakeet';

export interface STTEngine {
  id: STTEngineId;
  name: string;
  available: boolean;
}

export type STTEvent = STTEventBody & {
  journalMeetingId?: string;
  journalSequence?: number;
  recordedAt?: number;
  audioThrough?: number;
};

export type MeetingCaptureHealth = {
  kind: 'health';
  microphone: 'running' | 'paused' | 'stalled';
  transcription: 'listening' | 'paused';
  persistence: 'saved';
  audioSeconds: number;
  lastAudioAt: number | null;
  lastTranscriptAt: number | null;
};

type STTEventBody =
  | { kind: 'activity-status'; available: boolean }
  | MeetingCaptureHealth
  | { kind: 'gap'; at: number; message: string }
  | { kind: 'buffer-status'; state: 'failed'; message: string }
  | {
      kind: 'status';
      state: 'preparing' | 'downloading' | 'listening' | 'paused' | 'stopped' | 'failed';
      engine?: string;
      message?: string;
    }
  | {
      kind: 'segment';
      text: string;
      final: boolean;
      start: number;
      end: number;
      /** Apple attributed-string runs of a final result, timed where the run has audio. */
      runs?: Array<{ text: string; start?: number; end?: number }>;
    }
  | { kind: 'snapshot'; text: string; final: boolean }
  | { kind: 'speaker'; speaker: number; start: number; end: number }
  /** The diarizer's still-open turns, replaced on every update, and how far it has heard. */
  | {
      kind: 'speaker-tentative';
      turns: Array<{ speaker: number; start: number; end: number }>;
      through: number;
    }
  | { kind: 'words'; words: Array<{ text: string; start: number; end: number }> }
  | { kind: 'speaker-status'; state: 'loading' | 'ready' | 'unavailable'; message?: string };

interface NativeLiveSTT {
  configureMeeting?(
    meetingId: string,
    sessionId: string,
    startedAt: number,
    audioSafetyBuffer: boolean,
  ): Promise<void>;
  currentCapture?(): Promise<{ meetingId: string; state: string } | null>;
  journalMeetings?(): Promise<Array<{ meetingId: string }>>;
  readMeetingJournal?(
    meetingId: string,
    after: number,
    limit: number,
  ): Promise<Array<{ meetingId: string; sequence: number; event: STTEvent }>>;
  acknowledgeMeetingJournal?(meetingId: string, through: number): Promise<void>;
  pendingAudioBuffers?(): Promise<
    Array<{ meetingId: string; locale: string; segments: number; duration: number }>
  >;
  recoverAudioBuffer?(
    meetingId: string,
    confirmedThrough: number,
  ): Promise<RecoveredAudioSegment[]>;
  discardAudioBuffer?(meetingId: string): Promise<void>;
  discardMeetingData?(meetingId: string): Promise<void>;
  acknowledgeAudioRecovery?(meetingId: string, segmentIds: string[]): Promise<void>;
  engines(): Promise<STTEngine[]>;
  start(
    engine: STTEngineId,
    locale: string,
    vocabulary: string[],
    participants: number,
  ): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  addListener(event: 'onSTTEvent', listener: (event: STTEvent) => void): { remove(): void };
}

export interface RecoveredAudioSegment {
  id: string;
  text: string;
  start: number;
  end: number;
}

export const liveMeetingSTT =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeLiveSTT>('VerityLiveSTT') : null;
