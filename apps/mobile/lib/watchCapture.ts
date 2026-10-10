import { projectsByRecentCapture, type ProjectRecord, type Task } from '@verity/mobile';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';
import { captureTask, taskAccountScope } from './tasksStore';

/** A watch recording the iPhone has transcribed (native/VerityWatchInbox.swift). */
export interface WatchCapture {
  id: string;
  text: string;
  createdAt: string;
  durationMs: number;
  /** Picked on the watch; `scope` is the account its project list came from. */
  projectId?: string;
  scope?: string;
}

/** A project the watch picker offers. */
export interface WatchProject {
  id: string;
  name: string;
}

/** The watch picker lists this many; a longer list is scrolling, not choosing. */
export const WATCH_PROJECT_LIMIT = 12;

export interface WatchStatus {
  supported: boolean;
  activated?: boolean;
  paired?: boolean;
  watchAppInstalled?: boolean;
  reachable?: boolean;
  /** Transcribed captures not yet saved as tasks. */
  waiting?: number;
}

interface NativeWatchBridge {
  pending(): Promise<WatchCapture[]>;
  acknowledge(id: string): Promise<void>;
  log(): Promise<string[]>;
  status(): Promise<WatchStatus>;
  discardWaiting(): Promise<number>;
  setProjects(
    scope: string | null,
    projects: WatchProject[],
    lastProjectId: string | null,
  ): Promise<void>;
  addListener(event: 'onWatchInbox', listener: () => void): { remove(): void };
}

const native =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeWatchBridge>('VerityWatchBridge')
    : null;

type Inbox = Pick<NativeWatchBridge, 'pending' | 'acknowledge'>;
type Save = (capture: WatchCapture) => Promise<unknown>;

/**
 * Moves transcribed watch captures into the task queue, releasing each one from
 * the native inbox only after the queue has persisted it. A capture that cannot
 * be saved (signed out) stays in the inbox for the next drain without holding
 * back the ones after it. Captures go to the account signed in when the drain
 * runs. Calls during a drain fold into one more pass, so an entry that lands
 * mid-drain is not left waiting for the next app activation.
 */
export function createWatchInboxDrainer(inbox: Inbox, save: Save): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const pass = async () => {
    let failure: unknown = null;
    do {
      again = false;
      for (const capture of await inbox.pending()) {
        try {
          await save(capture);
          await inbox.acknowledge(capture.id);
        } catch (error) {
          // An unacknowledged capture is offered again; the queue ignores its id.
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

/** The picker's list: the project last used for quick capture first, then the
 *  rest by most recent capture, cut to what fits a watch screen. */
export function watchProjectList(
  projects: readonly Pick<ProjectRecord, 'id' | 'repo'>[],
  tasks: readonly Pick<Task, 'projectId' | 'origin' | 'createdAt'>[],
  lastProjectId: string | null,
): WatchProject[] {
  const recent = projectsByRecentCapture(projects, tasks);
  const last = recent.findIndex((project) => project.id === lastProjectId);
  if (last > 0) recent.unshift(...recent.splice(last, 1));
  return recent
    .slice(0, WATCH_PROJECT_LIMIT)
    .map((project) => ({ id: project.id, name: project.repo }));
}

/** The account and projects the iPhone currently knows; null until loaded. */
export interface KnownProjects {
  scope: string;
  ids: ReadonlySet<string>;
}

/** The project a capture is saved to. Throws, keeping the capture in the inbox,
 *  when it was picked under another account or its project is not (yet) known:
 *  a task filed under a guessed project is worse than one that waits.
 *  `signedIn` is the account the task queue writes for now; `known` follows
 *  React state, which can still hold the previous account's projects. */
export function watchCaptureProject(
  capture: WatchCapture,
  known: KnownProjects | null,
  signedIn: string | null,
): string {
  if (!capture.projectId) throw new Error('Choose a project on the watch');
  if (!known || capture.scope !== known.scope || known.scope !== signedIn) {
    throw new Error('Captured while another account was signed in');
  }
  if (!known.ids.has(capture.projectId)) throw new Error('The project is not available');
  return capture.projectId;
}

let known: KnownProjects | null = null;

const drain = native
  ? createWatchInboxDrainer(native, (capture) =>
      captureTask(
        {
          title: capture.text,
          projectId: watchCaptureProject(capture, known, taskAccountScope()),
        },
        { id: capture.id, createdAt: capture.createdAt || undefined },
      ),
    )
  : null;

/** Sends the watch its project list and lets captures held for a project the
 *  iPhone had not loaded yet through. Signed out, the watch gets no projects.
 *  `projects` is null while the list for `scope` has not loaded: right after an
 *  account switch it would still be the previous account's. */
export function syncWatchProjects(
  scope: string | null,
  projects: readonly Pick<ProjectRecord, 'id' | 'repo'>[] | null,
  tasks: readonly Pick<Task, 'projectId' | 'origin' | 'createdAt'>[],
  lastProjectId: string | null,
): void {
  if (!native || !drain) return;
  if (scope && !projects) {
    known = null;
    return;
  }
  projects ??= [];
  const list = scope ? watchProjectList(projects, tasks, lastProjectId) : [];
  void native.setProjects(scope, list, scope ? lastProjectId : null).catch(() => undefined);
  const ids = new Set(projects.map((project) => project.id));
  const changed =
    known?.scope !== scope ||
    known.ids.size !== ids.size ||
    [...ids].some((id) => !known?.ids.has(id));
  known = scope ? { scope, ids } : null;
  if (changed && known) void drain().catch(() => undefined);
}

/** Drains on start, whenever the inbox changes while JS runs, and on foreground. */
export function startWatchInbox(): () => void {
  if (!native || !drain) return () => undefined;
  const run = () => void drain().catch(() => undefined);
  const subscription = native.addListener('onWatchInbox', run);
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') run();
  });
  run();
  return () => {
    subscription.remove();
    appState.remove();
  };
}

export const watchBridgeAvailable = native !== null;

export function watchStatus(): Promise<WatchStatus> {
  return native ? native.status() : Promise.resolve({ supported: false });
}

/** Drops captures that wait for an account or project; returns how many. */
export function discardWaitingWatchCaptures(): Promise<number> {
  return native ? native.discardWaiting() : Promise.resolve(0);
}

export function watchInboxLog(): Promise<string[]> {
  return native ? native.log() : Promise.resolve([]);
}
