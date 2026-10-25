import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type STTEngineId = 'apple-speech' | 'apple-dictation' | 'fluid-nemotron' | 'fluid-parakeet';

export interface STTEngine {
  id: STTEngineId;
  name: string;
  available: boolean;
}

export type STTEvent =
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

export const liveMeetingSTT =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeLiveSTT>('VerityLiveSTT') : null;
