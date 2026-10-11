import { pickRecognitionLocale } from '@verity/mobile';
import { requireOptionalNativeModule } from 'expo-modules-core';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionNativeEventMap,
} from 'expo-speech-recognition';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { loadVoiceVocabulary, correctVoiceText } from './voiceVocabulary';

interface DictationEvent {
  session: string;
  kind: 'segment' | 'status' | 'level';
  text?: string;
  final?: boolean;
  start?: number;
  state?: string;
  value?: number;
  message?: string;
}
interface NativeDictation {
  dictationLocales(): Promise<string[]>;
  prepareDictation(locale: string): Promise<void>;
  releasePreparedDictation(): Promise<void>;
  startDictation(
    session: string,
    locale: string,
    vocabulary: string[],
    tappedAt: number,
  ): Promise<void>;
  stopDictation(session: string, abort: boolean): Promise<void>;
  addListener(
    name: 'onDictationEvent',
    listener: (event: DictationEvent) => void,
  ): { remove(): void };
}
export type VoiceEvent = {
  results: { transcript: string }[];
  isFinal: boolean;
  value: number;
  error: string;
  message?: string;
};
type EventName =
  'result' | 'end' | 'error' | 'volumechange' | 'speechstart' | 'speechend' | 'status';
const native =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeDictation>('VerityLiveSTT') : null;
const listeners = new Map<EventName, Set<(event: VoiceEvent) => void>>();
let session: string | null = null;
let sequence = 0;
let subscription: { remove(): void } | undefined;
let finalRanges = new Set<number>();
function emit(name: EventName, event: Partial<VoiceEvent> = {}) {
  for (const listener of listeners.get(name) ?? []) listener(event as VoiceEvent);
}
function end(id: string) {
  if (session !== id) return;
  session = null;
  subscription?.remove();
  subscription = undefined;
  emit('end');
}
function fail(id: string, message: string) {
  if (session !== id) return;
  emit('error', { error: 'native', message });
  // Keep ownership until native teardown has completed.
  void native
    ?.stopDictation(id, true)
    .catch(() => undefined)
    .finally(() => end(id));
}

const preparationClients = new Map<symbol, string[]>();
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let applicationSubscription: { remove(): void } | undefined;
let preparationRequest = 0;
let warming: Promise<void> | undefined;

function releasePreparation() {
  preparationRequest += 1;
  warming = undefined;
  void native?.releasePreparedDictation?.().catch(() => undefined);
}

function warmPreparation() {
  if (AppState.currentState !== 'active' || !native?.prepareDictation || warming) return;
  const preferred = [...preparationClients.values()].at(-1);
  if (!preferred) return;
  const request = ++preparationRequest;
  const work = (async () => {
    try {
      const locale = await voiceRecognition.prepare(preferred);
      if (request !== preparationRequest || AppState.currentState !== 'active') return;
      await native.prepareDictation(locale);
    } catch {
      // Explicit start reports unsupported languages and missing native builds.
    }
  })();
  warming = work;
  void work.finally(() => {
    if (warming === work) warming = undefined;
  });
}

export const voiceRecognition = {
  retainPreparation(preferred: string[]) {
    if (Platform.OS !== 'ios' || !native?.prepareDictation) return () => {};
    const client = Symbol('dictation-preparation');
    const previous = [...preparationClients.values()].at(-1);
    preparationClients.set(client, preferred);
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    if (previous && previous.join() !== preferred.join()) releasePreparation();
    if (!applicationSubscription) {
      applicationSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') warmPreparation();
        else if (state === 'background') {
          releasePreparation();
          // Dictation never keeps the microphone active after leaving the app.
          voiceRecognition.abort();
        }
      });
    }
    warmPreparation();
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      const previousPreferred = [...preparationClients.values()].at(-1);
      preparationClients.delete(client);
      const nextPreferred = [...preparationClients.values()].at(-1);
      if (nextPreferred) {
        if (previousPreferred?.join() !== nextPreferred.join()) {
          releasePreparation();
          warmPreparation();
        }
      } else {
        // Invalidate pending JS locale selection immediately on blur.
        preparationRequest += 1;
        warming = undefined;
        releaseTimer = setTimeout(() => {
          releasePreparation();
          applicationSubscription?.remove();
          applicationSubscription = undefined;
          releaseTimer = undefined;
        }, 60_000);
      }
    };
  },
  addListener(name: EventName, listener: (event: VoiceEvent) => void) {
    if (Platform.OS !== 'ios')
      return ExpoSpeechRecognitionModule.addListener(
        name === 'status' ? 'end' : name,
        (event: ExpoSpeechRecognitionNativeEventMap[keyof ExpoSpeechRecognitionNativeEventMap]) =>
          listener(event as VoiceEvent),
      );
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    set.add(listener);
    return { remove: () => set.delete(listener) };
  },
  async prepare(preferred: string[]) {
    if (Platform.OS !== 'ios') throw new Error('Native preparation is only available on iOS.');
    if (
      !native ||
      typeof native.dictationLocales !== 'function' ||
      typeof native.startDictation !== 'function' ||
      typeof native.stopDictation !== 'function' ||
      typeof native.prepareDictation !== 'function' ||
      typeof native.releasePreparedDictation !== 'function'
    )
      throw new Error('Voice input requires a new native app build.');
    const language = (tag: string) => tag.replace(/_/g, '-').split('-')[0]?.toLowerCase();
    const languages = new Set(preferred.map(language));
    const supported = (await native.dictationLocales()).filter((tag) =>
      languages.has(language(tag)),
    );
    const locale = pickRecognitionLocale(supported, preferred);
    if (!locale) throw new Error('Speech recognition is unavailable for your device or language.');
    return locale;
  },
  async startIOS(locale: string, tappedAt = Date.now()) {
    if (
      !native ||
      typeof native.dictationLocales !== 'function' ||
      typeof native.startDictation !== 'function' ||
      typeof native.stopDictation !== 'function' ||
      typeof native.prepareDictation !== 'function' ||
      typeof native.releasePreparedDictation !== 'function'
    )
      throw new Error('Voice input requires a new native app build.');
    if (session) throw new Error('Another voice recording is active.');
    const id = `dictation-${++sequence}`;
    session = id;
    finalRanges = new Set();
    try {
      const vocabulary = await loadVoiceVocabulary();
      if (session !== id) return;
      subscription = native.addListener('onDictationEvent', (event) => {
        if (session !== id || event.session !== id) return;
        if (event.kind === 'segment') {
          const range = event.start ?? 0;
          if (finalRanges.has(range)) return;
          if (event.final) finalRanges.add(range);
          emit('speechstart');
          emit('result', {
            results: [
              {
                transcript: event.final
                  ? correctVoiceText(event.text ?? '', vocabulary)
                  : (event.text ?? ''),
              },
            ],
            isFinal: event.final ?? false,
          });
          if (event.final) emit('speechend');
        } else if (event.kind === 'level') {
          emit('volumechange', { value: (event.value ?? 0) * 12 - 2 });
        } else if (event.state === 'failed') {
          fail(id, event.message ?? 'Speech recognition failed.');
        } else if (event.state === 'stopped') {
          end(id);
        } else {
          emit('status', { message: event.state });
        }
      });
      await native.startDictation(
        id,
        locale,
        vocabulary.terms.map((entry) => entry.term),
        tappedAt,
      );
    } catch (error) {
      if (session === id)
        emit('error', {
          error: 'native',
          message: error instanceof Error ? error.message : 'Could not start voice input.',
        });
      end(id);
      throw error;
    }
  },
  stop() {
    if (Platform.OS !== 'ios') {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const id = session;
    if (id)
      void native
        ?.stopDictation(id, false)
        .then(() => end(id))
        .catch(() => fail(id, 'Could not finish voice input.'));
  },
  abort() {
    if (Platform.OS !== 'ios') {
      ExpoSpeechRecognitionModule.abort();
      return;
    }
    const id = session;
    if (id)
      void native
        ?.stopDictation(id, true)
        .catch(() => undefined)
        .finally(() => end(id));
  },
};

export function useVoiceRecognitionEvent(name: EventName, handler: (event: VoiceEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useSpeechRecognitionEvent(
    name === 'status' ? 'end' : name,
    (event: ExpoSpeechRecognitionNativeEventMap[keyof ExpoSpeechRecognitionNativeEventMap]) => {
      if (Platform.OS !== 'ios' && name !== 'status') latest.current(event as VoiceEvent);
    },
  );
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const listener = voiceRecognition.addListener(name, (event) => latest.current(event));
    return () => {
      listener.remove();
    };
  }, [name]);
}
