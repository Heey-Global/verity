import AsyncStorage from '@react-native-async-storage/async-storage';
import { VerityApiError, type AssistantConversation } from '@verity/mobile';
import { randomUUID } from 'expo-crypto';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createVerityClient } from './client';
import { taskAccountScope } from './tasksStore';

/**
 * The conversation with Verity on this phone (docs/assistant.md).
 *
 * The server holds the conversation; this keeps only what has not reached it
 * yet. Everything the user says is written to the outbox before it is sent and
 * leaves it once the server confirmed it, so a crash, a dead connection or a
 * switched-off assistant never loses words. Each entry keeps its request id for
 * every retry, and the server delivers an id once.
 */

export type Outgoing = {
  requestId: string;
  /** The account it was said in; it is only ever sent there. */
  scope: string;
  createdAt: number;
  /** Why the last attempt failed; cleared on the next attempt. */
  error?: string;
  /** Kept until the user retries or discards it, rather than retried on a timer. */
  held?: boolean;
  /** Where it was said; the Apple Watch hands its words over through the phone. */
  device?: 'phone' | 'watch';
} & (
  | { kind: 'message'; text: string; input: 'voice' | 'text'; projectId?: string }
  | { kind: 'answer'; questionId: string; labels: string[] }
);

export type VerityAccess = 'unknown' | 'ready' | 'denied' | 'offline';

export interface VerityState {
  conversation: AssistantConversation | null;
  access: VerityAccess;
  outbox: Outgoing[];
  /** Shown once: the question was answered on another device first. */
  notice: string | null;
}

const KEY = 'verity.assistant.outbox';
let state: VerityState = { conversation: null, access: 'unknown', outbox: [], notice: null };
const listeners = new Set<() => void>();
let restored: Promise<void> | null = null;
let flushing: Promise<void> | null = null;

function set(next: Partial<VerityState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function restore(): Promise<void> {
  restored ??= AsyncStorage.getItem(KEY)
    .then((data) => {
      const saved = data ? (JSON.parse(data) as Outgoing[]) : [];
      if (Array.isArray(saved)) set({ outbox: [...saved, ...state.outbox] });
    })
    .catch(() => undefined);
  return restored;
}

async function saveOutbox(outbox: Outgoing[]): Promise<void> {
  set({ outbox });
  await AsyncStorage.setItem(KEY, JSON.stringify(outbox));
}

/** What a failed delivery means for its outbox entry. */
export function deliveryOutcome(error: unknown): {
  action: 'drop' | 'hold' | 'retry';
  message: string;
} {
  if (error instanceof VerityApiError) {
    if (error.code === 'answered' || error.code === 'stale_question')
      return { action: 'drop', message: 'This question was already answered on another device.' };
    if (error.code === 'pending' || error.status === 429 || error.status >= 500)
      return { action: 'retry', message: 'Verity is busy. Retrying…' };
    if (error.status === 403)
      return { action: 'hold', message: 'Verity is available to administrators of this server.' };
    if (error.code === 'disabled')
      return { action: 'hold', message: 'Verity is switched off in settings.' };
    return { action: 'hold', message: error.message };
  }
  return { action: 'retry', message: 'Waiting for a connection…' };
}

/** Sends every outbox entry of the current account, oldest first. */
export function flushVerity(): Promise<void> {
  flushing ??= (async () => {
    await restore();
    const scope = taskAccountScope();
    const client = createVerityClient();
    if (scope === null || client === null) return;
    for (const entry of state.outbox) {
      if (entry.scope !== scope || entry.held === true) continue;
      try {
        if (entry.kind === 'message')
          await client.sendAssistantMessage({
            requestId: entry.requestId,
            text: entry.text,
            input: entry.input,
            device: entry.device ?? 'phone',
            ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
          });
        else
          await client.answerAssistantQuestion({
            requestId: entry.requestId,
            questionId: entry.questionId,
            labels: entry.labels,
            device: entry.device ?? 'phone',
          });
        await saveOutbox(state.outbox.filter((item) => item.requestId !== entry.requestId));
      } catch (error) {
        const outcome = deliveryOutcome(error);
        if (outcome.action === 'drop') {
          set({ notice: outcome.message });
          await saveOutbox(state.outbox.filter((item) => item.requestId !== entry.requestId));
          continue;
        }
        await saveOutbox(
          state.outbox.map((item) =>
            item.requestId === entry.requestId
              ? { ...item, error: outcome.message, held: outcome.action === 'hold' }
              : item,
          ),
        );
        // Keep the order: a later message must not overtake an undelivered one.
        if (outcome.action === 'retry') break;
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

export async function refreshVerity(): Promise<void> {
  const client = createVerityClient();
  if (client === null || taskAccountScope() === null) {
    set({ conversation: null, access: 'unknown' });
    return;
  }
  try {
    set({ conversation: await client.assistantConversation(), access: 'ready' });
  } catch (error) {
    set({
      access: error instanceof VerityApiError && error.status === 403 ? 'denied' : 'offline',
    });
  }
}

async function enqueue(entry: Outgoing): Promise<void> {
  await restore();
  // A watch capture handed over twice keeps its first entry.
  if (state.outbox.some((item) => item.requestId === entry.requestId)) return;
  await saveOutbox([...state.outbox, entry]);
  await flushVerity();
  await refreshVerity();
}

/** Where an outgoing entry comes from when it is not the phone itself: the watch
 *  capture's or answer's own id, so every path that delivers it is one request. */
export interface Origin {
  requestId: string;
  device: 'watch';
}

export function sendToVerity(
  message: { text: string; input: 'voice' | 'text'; projectId?: string | null },
  origin?: Origin,
): Promise<void> {
  const scope = taskAccountScope();
  if (scope === null) return Promise.reject(new Error('Sign in to talk to Verity.'));
  return enqueue({
    kind: 'message',
    requestId: origin?.requestId ?? randomUUID(),
    ...(origin ? { device: origin.device } : {}),
    scope,
    createdAt: Date.now(),
    text: message.text.trim(),
    input: message.input,
    ...(message.projectId ? { projectId: message.projectId } : {}),
  });
}

export function answerVerity(questionId: string, labels: string[], origin?: Origin): Promise<void> {
  const scope = taskAccountScope();
  if (scope === null) return Promise.reject(new Error('Sign in to talk to Verity.'));
  return enqueue({
    kind: 'answer',
    requestId: origin?.requestId ?? randomUUID(),
    ...(origin ? { device: origin.device } : {}),
    scope,
    createdAt: Date.now(),
    questionId,
    labels,
  });
}

/** Tries a held entry again under its original id. */
export async function retryOutgoing(requestId: string): Promise<void> {
  await saveOutbox(
    state.outbox.map((item) =>
      item.requestId === requestId ? { ...item, held: false, error: undefined } : item,
    ),
  );
  await flushVerity();
  await refreshVerity();
}

export async function discardOutgoing(requestId: string): Promise<void> {
  await saveOutbox(state.outbox.filter((item) => item.requestId !== requestId));
}

export function dismissVerityNotice(): void {
  set({ notice: null });
}

/**
 * Polling rate when the server cannot hold a read open (an older server): fast
 * while Verity works or something waits to be sent.
 */
export function verityPollMs(current: VerityState, open: boolean): number {
  if (!open) return 30_000;
  return current.conversation?.state === 'working' || current.outbox.length > 0 ? 2_000 : 6_000;
}

/** How long one read waits on the server for Verity to write something. */
export const VERITY_WAIT_MS = 20_000;
/** While words wait to be resent, the read returns sooner so they are retried. */
const VERITY_RETRY_WAIT_MS = 2_000;
/** An unchanged answer sooner than this means the server did not hold the read. */
const VERITY_HELD_MIN_MS = 1_500;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Keeps the conversation current until `signal` aborts. One read stays open on
 * the server and returns as soon as Verity writes, so her reply shows up as she
 * writes it rather than at the next poll. Sends what waits in the outbox
 * between reads. `open` says whether a panel shows the conversation; it only
 * sets the pace against a server that answers at once.
 */
export async function followVerity(
  signal: AbortSignal,
  open: () => boolean = () => true,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = pause,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    await flushVerity();
    const client = createVerityClient();
    if (client === null || taskAccountScope() === null) {
      set({ conversation: null, access: 'unknown' });
      await sleep(5_000, signal);
      continue;
    }
    const before = state.conversation?.revision;
    const retrying = state.outbox.some((entry) => entry.held !== true);
    const started = Date.now();
    try {
      const next = await client.assistantConversation(
        before === undefined
          ? { signal }
          : { after: before, waitMs: retrying ? VERITY_RETRY_WAIT_MS : VERITY_WAIT_MS, signal },
      );
      if (signal.aborted) return;
      failures = 0;
      set({ conversation: next, access: 'ready' });
      if (next.revision === before && Date.now() - started < VERITY_HELD_MIN_MS)
        await sleep(verityPollMs(state, open()), signal);
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      set({
        access: error instanceof VerityApiError && error.status === 403 ? 'denied' : 'offline',
      });
      await sleep(Math.min(30_000, 1_000 * 2 ** failures), signal);
    }
  }
}

let followers = 0;
let openPanels = 0;
let following: AbortController | null = null;

function startFollowing(): void {
  if (following !== null || followers === 0 || AppState.currentState !== 'active') return;
  const controller = new AbortController();
  following = controller;
  void followVerity(controller.signal, () => openPanels > 0).finally(() => {
    if (following === controller) following = null;
  });
}

function stopFollowing(): void {
  following?.abort();
  following = null;
}

/**
 * The conversation, kept current while mounted and the app is in front. Every
 * mounted view shares one open read; `open` marks the panel.
 */
export function useVerity(open: boolean): VerityState {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
  useEffect(() => {
    followers += 1;
    if (open) openPanels += 1;
    startFollowing();
    const app = AppState.addEventListener('change', (next) => {
      // A read held in the background is cut by the system anyway.
      if (next === 'active') startFollowing();
      else stopFollowing();
    });
    return () => {
      app.remove();
      followers -= 1;
      if (open) openPanels -= 1;
      if (followers === 0) stopFollowing();
    };
  }, [open]);
  return current;
}

/** Observes the conversation without keeping it current; returns the unsubscribe. */
export function subscribeVerity(listener: (current: VerityState) => void): () => void {
  const notify = () => listener(state);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Resets the in-memory view, for tests and account switches. */
export function resetVerityForTests(): void {
  state = { conversation: null, access: 'unknown', outbox: [], notice: null };
  restored = null;
  flushing = null;
  stopFollowing();
  followers = 0;
  openPanels = 0;
}
