import type { AssistantConversation, InboxItem } from '@verity/mobile';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';

import {
  getAuthToken,
  isBiometricUnlockEnabled,
  subscribeAuthToken,
  subscribeBiometricUnlock,
} from './authToken';
import { getVerityBaseUrl, subscribeVerityBaseUrl } from './client';
import { getServerProfile } from './serverProfile';
import { taskAccountScope } from './tasksStore';
import {
  answerVerity,
  sendToVerity,
  subscribeVerity,
  type VerityState,
} from './verityConversation';

/** A watch recording the iPhone has transcribed (native/VerityWatchInbox.swift). */
export interface WatchCapture {
  id: string;
  text: string;
  createdAt: string;
  durationMs: number;
  /** Picked on older watch builds; offered to Verity as context only. */
  projectId?: string;
  /** The account the watch knew while recording. */
  scope?: string;
}

/** An answer to Verity's question given on the watch. */
interface WatchAnswer {
  id: string;
  questionId: string;
  labels: string[];
  scope?: string;
}

export interface WatchStatus {
  supported: boolean;
  activated?: boolean;
  paired?: boolean;
  watchAppInstalled?: boolean;
  reachable?: boolean;
  /** Transcribed captures that have not reached Verity yet. */
  waiting?: number;
}

/** The direct connection native code uses while the app is in the background. */
export interface WatchLink {
  baseUrl: string;
  token: string;
  tlsPin: string;
  scope: string;
}

/** What the watch shows of the conversation (`VeritySnapshot` on the watch). */
export interface WatchSnapshot {
  availability: string;
  state: string;
  revision: number;
  approvals: number;
  scope?: string;
  reply?: string;
  question?: { id: string; text?: string; options: string[]; multiSelect: boolean };
}

/** One open item from Home as the watch lists it (`WatchInbox` on the watch). */
export interface WatchInboxItem {
  key: string;
  title: string;
  context: string;
  tag: string;
  tone: InboxItem['tone'];
  message?: string;
}

/** Home's open items for the watch, with when the iPhone last read them. */
export interface WatchInboxPayload {
  scope: string;
  /** Milliseconds since the epoch; the watch says "as of" when this is old. */
  at: number;
  items: WatchInboxItem[];
}

/** How many open items the wrist lists; the rest wait on the iPhone. */
export const WATCH_INBOX_LIMIT = 12;

interface NativeWatchBridge {
  pending(): Promise<WatchCapture[]>;
  acknowledge(id: string): Promise<void>;
  pendingAnswers(): Promise<WatchAnswer[]>;
  acknowledgeAnswer(id: string): Promise<void>;
  setLink(link: WatchLink | null): Promise<void>;
  setVerity(snapshot: WatchSnapshot | null): Promise<void>;
  /** Missing on native builds older than the watch's "Needs you" list. */
  setInbox?(inbox: WatchInboxPayload | null): Promise<void>;
  log(): Promise<string[]>;
  status(): Promise<WatchStatus>;
  discardWaiting(): Promise<number>;
  setProjects(scope: string | null, projects: [], lastProjectId: null): Promise<void>;
  addListener(event: 'onWatchInbox', listener: () => void): { remove(): void };
}

const native =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeWatchBridge>('VerityWatchBridge')
    : null;

interface Inbox<T extends { id: string }> {
  pending(): Promise<T[]>;
  acknowledge(id: string): Promise<void>;
}

/**
 * Hands what the watch said over to Verity's outbox, releasing each item from
 * the native inbox only after the outbox has persisted it. An item that cannot
 * be handed over (signed out, said under another account) stays for the next
 * drain without holding back the ones after it. Calls during a drain fold into
 * one more pass, so an item that lands mid-drain is not left waiting for the
 * next app activation. Native code usually sends first; the outbox then
 * delivers the same request id once more, which the server recognises.
 */
export function createWatchInboxDrainer<T extends { id: string }>(
  inbox: Inbox<T>,
  save: (item: T) => Promise<unknown>,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const pass = async () => {
    let failure: unknown = null;
    do {
      again = false;
      for (const item of await inbox.pending()) {
        try {
          await save(item);
          await inbox.acknowledge(item.id);
        } catch (error) {
          // An unacknowledged item is offered again; the outbox ignores its id.
          failure ??= error;
        }
      }
    } while (again);
    if (failure) throw failure;
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = pass().finally(() => {
      running = null;
    });
    return running;
  };
}

/** Words said on the watch go only to the account they were said in. A capture
 *  without an account (an interrupted recording) goes to the one signed in. */
export function watchScopeAllowed(scope: string | undefined, signedIn: string | null): boolean {
  if (signedIn === null) return false;
  return scope === undefined || scope === signedIn;
}

function requireScope(scope: string | undefined): void {
  if (!watchScopeAllowed(scope, taskAccountScope()))
    throw new Error('Said while another account was signed in');
}

const drainCaptures = native
  ? createWatchInboxDrainer(native, async (capture: WatchCapture) => {
      requireScope(capture.scope);
      await sendToVerity(
        { text: capture.text, input: 'voice', projectId: capture.projectId ?? null },
        { requestId: capture.id, device: 'watch' },
      );
    })
  : null;

const drainAnswers = native
  ? createWatchInboxDrainer(
      { pending: () => native.pendingAnswers(), acknowledge: (id) => native.acknowledgeAnswer(id) },
      async (answer: WatchAnswer) => {
        requireScope(answer.scope);
        await answerVerity(answer.questionId, answer.labels, {
          requestId: answer.id,
          device: 'watch',
        });
      },
    )
  : null;

/** The watch's view of a conversation: small enough for the wrist. */
export function watchSnapshot(
  conversation: AssistantConversation | null,
  access: VerityState['access'],
  scope: string | null,
): WatchSnapshot | null {
  if (scope === null) return null;
  if (access === 'denied')
    return { availability: 'denied', state: 'idle', revision: 0, approvals: 0, scope };
  if (conversation === null) return null;
  const reply = conversation.items.findLast((item) => item.kind === 'reply');
  const question = conversation.question;
  return {
    availability: conversation.availability,
    state: conversation.state,
    revision: conversation.revision,
    approvals: conversation.approvals.length,
    scope,
    ...(reply?.kind === 'reply' ? { reply: reply.text.slice(0, 600) } : {}),
    ...(question
      ? {
          question: {
            id: question.id,
            ...(question.question !== undefined ? { text: question.question } : {}),
            options: question.options.map((option) => option.label),
            multiSelect: question.multiSelect,
          },
        }
      : {}),
  };
}

/** Home's items cut to what the wrist shows; property lists hold no undefined. */
export function watchInbox(
  items: readonly InboxItem[],
  scope: string | null,
  at: number,
): WatchInboxPayload | null {
  if (scope === null) return null;
  return {
    scope,
    at,
    items: items.slice(0, WATCH_INBOX_LIMIT).map((item) => ({
      key: item.key,
      title: item.title.slice(0, 160),
      context: item.context.slice(0, 120),
      tag: item.tag,
      tone: item.tone,
      ...(item.message ? { message: item.message.slice(0, 400) } : {}),
    })),
  };
}

/** Unchanged items are sent again after this long, so "as of" stays honest. */
const INBOX_REFRESH_MS = 5 * 60_000;

/**
 * Sends Home's items on a change, and an unchanged list again once it has aged,
 * so the watch's "as of" time stays true without a send on every render.
 */
export function createWatchInboxSync(
  send: (payload: WatchInboxPayload | null) => Promise<void>,
  scope: () => string | null,
): (items: readonly InboxItem[], now?: number) => void {
  let last: { key: string; at: number } | null = null;
  return (items, now = Date.now()) => {
    const payload = watchInbox(items, scope(), now);
    const key = JSON.stringify(payload === null ? null : [payload.scope, payload.items]);
    if (last?.key === key && now - last.at < INBOX_REFRESH_MS) return;
    last = { key, at: now };
    void send(payload).catch(() => undefined);
  };
}

/**
 * Hands the watch the items Home shows under "For you". Home calls it whenever
 * its list changes; the watch keeps the latest list with its time.
 */
export const syncWatchInbox: (items: readonly InboxItem[], now?: number) => void = native?.setInbox
  ? createWatchInboxSync((payload) => native.setInbox!(payload), taskAccountScope)
  : () => undefined;

/**
 * The direct connection for native code, or null. Only a certificate-pinned
 * direct endpoint qualifies, and only when the sign-in is not held behind Face
 * ID: native code keeps the token readable after first unlock so it can send
 * from the background, which must not undo a biometric protection the user chose.
 */
export async function watchLink(): Promise<WatchLink | null> {
  const baseUrl = getVerityBaseUrl();
  const scope = taskAccountScope();
  const token = getAuthToken(baseUrl);
  const endpoint = getServerProfile()?.endpoints.find(({ url }) => url === baseUrl);
  if (baseUrl === null || scope === null || token === null) return null;
  if (endpoint?.transport !== 'direct' || !endpoint.tlsPin) return null;
  if (await isBiometricUnlockEnabled(baseUrl)) return null;
  return { baseUrl, token, tlsPin: endpoint.tlsPin, scope };
}

let linkSync = 0;

/** Hands native code the current link. Only the latest call writes: a sign-out
 *  must not be overtaken by an earlier call still checking Face ID. */
function syncLink(): void {
  if (!native) return;
  const call = ++linkSync;
  void watchLink()
    .catch(() => null)
    .then((link) => (call === linkSync ? native.setLink(link) : undefined))
    .catch(() => undefined);
}

/**
 * Connects the watch to Verity while the app runs: hands over what the watch
 * said, keeps the native connection current, tells the watch which account is
 * signed in and sends it Verity's state whenever the conversation changes.
 */
export function startWatchInbox(): () => void {
  if (!native || !drainCaptures || !drainAnswers) return () => undefined;
  const run = () => {
    void drainCaptures().catch(() => undefined);
    void drainAnswers().catch(() => undefined);
  };
  let scope: string | null | undefined;
  const syncAccount = () => {
    const next = taskAccountScope();
    if (next === scope) return;
    scope = next;
    // The watch only needs the account now; it has no project picker.
    void native.setProjects(next, [], null).catch(() => undefined);
    syncLink();
    run();
  };
  let last: string | undefined;
  const unsubscribeVerity = subscribeVerity((current) => {
    syncAccount();
    const snapshot = watchSnapshot(current.conversation, current.access, taskAccountScope());
    // Nothing read yet: keep what native code last sent rather than clearing it.
    if (snapshot === null && taskAccountScope() !== null) return;
    const key = JSON.stringify(snapshot);
    if (key === last) return;
    last = key;
    void native.setVerity(snapshot).catch(() => undefined);
  });
  const subscription = native.addListener('onWatchInbox', run);
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      syncAccount();
      syncLink();
      run();
    }
  });
  const unsubscribeToken = subscribeAuthToken(() => {
    syncAccount();
    syncLink();
  });
  const unsubscribeBiometric = subscribeBiometricUnlock(syncLink);
  const unsubscribeBaseUrl = subscribeVerityBaseUrl(() => {
    syncAccount();
    syncLink();
  });
  syncAccount();
  run();
  return () => {
    unsubscribeVerity();
    subscription.remove();
    appState.remove();
    unsubscribeToken();
    unsubscribeBiometric();
    unsubscribeBaseUrl();
  };
}

export const watchBridgeAvailable = native !== null;

/** Settings only show the watch section to people who use a watch, or who still
 * have captures waiting from one they have since unpaired. */
export function showWatchSettings(status: WatchStatus | null): status is WatchStatus {
  return Boolean(status && (status.paired || status.waiting));
}

export function watchStatus(): Promise<WatchStatus> {
  return native ? native.status() : Promise.resolve({ supported: false });
}

/** Drops captures that wait for their account; returns how many. */
export function discardWaitingWatchCaptures(): Promise<number> {
  return native ? native.discardWaiting() : Promise.resolve(0);
}

export function watchInboxLog(): Promise<string[]> {
  return native ? native.log() : Promise.resolve([]);
}
