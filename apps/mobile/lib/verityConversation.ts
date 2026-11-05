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

/** Loads the saved outbox once. A failed read is tried again next time and
 *  fails the caller, so no later save can overwrite words it did not load. */
function restore(): Promise<void> {
  restored ??= AsyncStorage.getItem(KEY)
    .then((data) => {
      let saved: unknown = [];
      try {
        saved = data ? JSON.parse(data) : [];
      } catch {
        // Unreadable for good: starting empty beats refusing every message from now on.
      }
      if (Array.isArray(saved)) set({ outbox: [...(saved as Outgoing[]), ...state.outbox] });
    })
    .catch((error: unknown) => {
      restored = null;
      throw error;
    });
  return restored;
}

let persisted: Promise<void> = Promise.resolve();

/** Writes run in order and each stores the outbox as it is then, so a slow
 *  earlier write can never land last and bring back a discarded entry. */
async function saveOutbox(outbox: Outgoing[]): Promise<void> {
  set({ outbox });
  const write = persisted.then(() => AsyncStorage.setItem(KEY, JSON.stringify(state.outbox)));
  persisted = write.catch(() => undefined);
  await write;
}

/** The account the shown conversation belongs to. */
let shownScope: string | null = null;

/** Forgets the shown conversation when another account signed in, so its reply,
 *  question and revision are never shown, sent to the watch or waited from. */
function forAccount(scope: string | null): void {
  if (scope === shownScope) return;
  const switched = shownScope !== null;
  shownScope = scope;
  if (switched) set({ conversation: null, access: 'unknown', notice: null });
}

/** Takes a read unless it is older than the one shown: a quick refresh and a
 *  held read can answer out of order. */
function showConversation(next: AssistantConversation): void {
  forAccount(taskAccountScope());
  const current = state.conversation;
  if (current !== null && current.sessionId === next.sessionId && next.revision < current.revision)
    return set({ access: 'ready' });
  set({ conversation: next, access: 'ready' });
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
  if (flushing) {
    // Words added meanwhile are not in the running pass; run one more.
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      flushAgain = false;
      await flushOnce();
    } while (flushAgain);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

let flushAgain = false;

async function flushOnce(): Promise<void> {
  await restore();
  const scope = taskAccountScope();
  const client = createVerityClient();
  if (scope === null || client === null) return;
  for (const entry of state.outbox) {
    if (entry.scope !== scope || entry.held === true) continue;
    // Discarded or held while this pass was sending an earlier one.
    if (!state.outbox.some((item) => item.requestId === entry.requestId && item.held !== true))
      continue;
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
}

export async function refreshVerity(): Promise<void> {
  const client = createVerityClient();
  const scope = taskAccountScope();
  if (client === null || scope === null) {
    set({ conversation: null, access: 'unknown' });
    return;
  }
  try {
    const next = await client.assistantConversation();
    // Answered for an account that is no longer signed in.
    if (taskAccountScope() === scope) showConversation(next);
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
  try {
    await saveOutbox([...state.outbox, entry]);
  } catch (error) {
    // Not stored, so not sent either: the caller keeps the words and says so.
    set({ outbox: state.outbox.filter((item) => item.requestId !== entry.requestId) });
    throw error;
  }
  // Stored from here on: a failed send is the outbox's to retry, not the caller's.
  await flushVerity().catch(() => undefined);
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
  await restore();
  await saveOutbox(
    state.outbox.map((item) =>
      item.requestId === requestId ? { ...item, held: false, error: undefined } : item,
    ),
  );
  await flushVerity();
  await refreshVerity();
}

export async function discardOutgoing(requestId: string): Promise<void> {
  await restore();
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
  const waiting = current.outbox.some((entry) => entry.held !== true);
  return current.conversation?.state === 'working' || waiting ? 2_000 : 6_000;
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
    await flushVerity().catch(() => undefined);
    forAccount(taskAccountScope());
    const client = createVerityClient();
    if (client === null || taskAccountScope() === null) {
      set({ conversation: null, access: 'unknown' });
      await sleep(5_000, signal);
      continue;
    }
    const scope = taskAccountScope();
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
      // Answered for an account that is no longer signed in: read again for the new one.
      if (taskAccountScope() !== scope) continue;
      showConversation(next);
      if (next.revision === before && Date.now() - started < VERITY_HELD_MIN_MS)
        await sleep(verityPollMs(state, open()), signal);
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      const denied = error instanceof VerityApiError && error.status === 403;
      set({ access: denied ? 'denied' : 'offline' });
      // Not this user's Verity: that rarely changes, so ask seldom.
      await sleep(denied ? 5 * 60_000 : Math.min(30_000, 1_000 * 2 ** failures), signal);
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
  flushAgain = false;
  shownScope = null;
  persisted = Promise.resolve();
  stopFollowing();
  followers = 0;
  openPanels = 0;
}
