import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';
import { captureTask } from './tasksStore';

/** A watch recording the iPhone has transcribed (native/VerityWatchInbox.swift). */
export interface WatchCapture {
  id: string;
  text: string;
  createdAt: string;
  durationMs: number;
}

export interface WatchStatus {
  supported: boolean;
  activated?: boolean;
  paired?: boolean;
  watchAppInstalled?: boolean;
  reachable?: boolean;
}

interface NativeWatchBridge {
  pending(): Promise<WatchCapture[]>;
  acknowledge(id: string): Promise<void>;
  log(): Promise<string[]>;
  status(): Promise<WatchStatus>;
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

const drain = native
  ? createWatchInboxDrainer(native, (capture) =>
      // The watch has no project picker yet: captures land unassigned.
      captureTask(
        { title: capture.text, projectId: null },
        { id: capture.id, createdAt: capture.createdAt || undefined },
      ),
    )
  : null;

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

export function watchInboxLog(): Promise<string[]> {
  return native ? native.log() : Promise.resolve([]);
}
