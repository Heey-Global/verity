import type { SerialUpdateResult } from './automaticUpdates';

export type AppUpdateState = Readonly<{
  phase: 'idle' | 'check' | 'download';
  downloaded: boolean;
  failure: Extract<SerialUpdateResult, { status: 'failed' }> | null;
}>;

/** One observable download operation shared by timers, foreground events and taps. */
export function createAppUpdateState(
  download: (onPhase: (phase: 'check' | 'download') => void) => Promise<SerialUpdateResult>,
) {
  let state: AppUpdateState = { phase: 'idle', downloaded: false, failure: null };
  let pending: Promise<SerialUpdateResult> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: AppUpdateState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const record = (result: SerialUpdateResult) => {
    if (result === 'busy') return;
    publish({
      phase: 'idle',
      // A later no-update response does not remove an already downloaded bundle.
      downloaded: state.downloaded || result === 'downloaded',
      failure: typeof result === 'object' ? result : null,
    });
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record,
    /** Reset process state between isolated UI tests. */
    resetForTests: () => {
      if (pending) throw new Error('Cannot reset a running update check');
      publish({ phase: 'idle', downloaded: false, failure: null });
    },
    check: () => {
      if (pending) return pending;
      // Defer invocation so all listeners see the same in-flight promise,
      // including a synchronous subscriber that requests another check.
      pending = Promise.resolve()
        .then(() => download((phase) => publish({ ...state, phase })))
        .then((result) => {
          record(result);
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
      publish({ ...state, phase: 'check' });
      return pending;
    },
  };
}
