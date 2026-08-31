import {
  type VerityClient,
  SessionListModel,
  type SessionListState,
  subscribePullRequestStatusMutations,
  subscribeSessionStatusMutations,
  subscribeSettledPermissions,
} from '@verity/mobile';
import { AppState } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface UseSessionList extends SessionListState {
  /** Force an immediate reload (e.g. pull-to-refresh / retry button). `silent`
   * skips the loading flip for a refresh the operator did not ask for — a list
   * that is already on screen must not blink back to its spinner. */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** Set a session's display name (or clear it with `null`). Optimistic. */
  rename: (sessionId: string, name: string | null) => void;
  /** Permanently delete a session (removes its history + worktree). Optimistic.
   * Named `remove` rather than `delete` so consumers can destructure it (`delete`
   * is a reserved word and would be a syntax error in a destructuring binding). */
  remove: (sessionId: string, opts?: { force?: boolean }) => Promise<void>;
}

/**
 * React binding for the headless {@link SessionListModel}: instantiates the model
 * for a client, mirrors its state into React via `onChange`, and drives its
 * polling lifecycle with `start()`/`stop()`. All orchestration (loading/error,
 * race guard, polling) lives in the model — this hook is just the glue.
 */
export function useSessionList(client: VerityClient): UseSessionList {
  // `onChange` is the React setter, wrapped so it resolves lazily (it's declared
  // below). This relies on the model emitting a FRESH state object on every change
  // (its `state` getter returns a new literal + a new array), so React never bails
  // out of a re-render on a same-reference no-op.
  const model = useMemo(
    () => new SessionListModel({ client, onChange: (s) => setState(s) }),
    [client],
  );

  // Seed the shape from the model (single source of truth), but force loading:
  // start() runs immediately in the effect, so we show the spinner from frame one
  // rather than flashing the empty state.
  const [state, setState] = useState<SessionListState>(() => ({ ...model.state, loading: true }));

  useEffect(() => {
    setState({ ...model.state, loading: true });
    if (AppState.currentState === 'active') model.start();
    const appState = AppState.addEventListener('change', (nextState) => {
      // Native timers may be suspended or dropped while the app is backgrounded.
      // Recreate the interval and refresh immediately whenever it becomes active.
      if (nextState === 'active') model.start();
      else model.stop();
    });
    return () => {
      appState.remove();
      model.stop();
    };
  }, [model]);

  useEffect(
    () =>
      subscribeSettledPermissions((sessionId, toolUseId) => {
        model.settlePermission(sessionId, toolUseId);
        void model.refresh({ silent: true });
      }),
    [model],
  );

  useEffect(
    () =>
      subscribeSessionStatusMutations((sessionId, status) => {
        model.applySessionStatus(sessionId, status);
      }),
    [model],
  );

  useEffect(
    () =>
      subscribePullRequestStatusMutations(({ sessionId, pr }) => {
        if (pr !== undefined) model.applyPullRequestStatus(sessionId, pr);
        void model.refresh({ silent: true });
      }),
    [model],
  );

  const refresh = useCallback(
    (opts?: { silent?: boolean }) => {
      return model.refresh(opts);
    },
    [model],
  );

  const rename = useCallback(
    (sessionId: string, name: string | null) => {
      void model.rename(sessionId, name);
    },
    [model],
  );

  const remove = useCallback(
    (sessionId: string, opts: { force?: boolean } = {}) => {
      return model.delete(sessionId, opts);
    },
    [model],
  );

  return { ...state, refresh, rename, remove };
}
