import { subscribeLiveRefresh } from '../lib/liveConnection';
import {
  type VerityClient,
  SessionListModel,
  type SessionListState,
  subscribePullRequestStatusMutations,
  subscribeSessionAutomationMutations,
  subscribeSessionStatusMutations,
  subscribeSettledPermissions,
} from '@verity/mobile';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVerityBaseUrl } from '../lib/client';
import { useLiveHints } from '../lib/liveConnection';

export interface UseSessionList extends SessionListState {
  /** Force an immediate reload (e.g. pull-to-refresh / retry button). `silent`
   * skips the loading flip for a refresh the operator did not ask for — a list
   * that is already on screen must not blink back to its spinner. */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** Set a session's display name (or clear it with `null`). Optimistic. */
  rename: (sessionId: string, name: string | null) => void;
  /** Mark or unmark a session as a favorite (synced across devices). Optimistic. */
  setFavorite: (sessionId: string, favorite: boolean) => void;
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
    () => new SessionListModel({ client, pollIntervalMs: 0, onChange: (s) => setState(s) }),
    [client],
  );

  // Seed the shape from the model (single source of truth), but force loading:
  // start() runs immediately in the effect, so we show the spinner from frame one
  // rather than flashing the empty state.
  const [state, setState] = useState<SessionListState>(() => ({ ...model.state, loading: true }));

  useEffect(() => {
    setState({ ...model.state, loading: true });
  }, [model]);

  // The list refetches when the server says a session changed; its own poll is
  // only the safety net. Hints for a model that is not running are ignored.
  const onHints = useCallback(
    (hints: Parameters<typeof model.applyHints>[0]) => {
      model.applyHints(hints);
    },
    [model],
  );
  useLiveHints(getVerityBaseUrl(), onHints);
  useEffect(
    () =>
      subscribeLiveRefresh(
        client,
        () => model.applyHints([]),
        (path) => path.split('?')[0] === '/sessions' || path === '/provider-limits',
      ),
    [client, model],
  );

  // Focus only gates background requests; React state would redraw the entire
  // overview and embedded transcript during each navigation transition.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (AppState.currentState === 'active') model.start();
      const appState = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') model.start();
        else model.stop();
      });
      return () => {
        focused.current = false;
        appState.remove();
        model.stop();
      };
    }, [model]),
  );

  useEffect(
    () =>
      subscribeSettledPermissions((sessionId, toolUseId) => {
        model.settlePermission(sessionId, toolUseId);
        if (focused.current) void model.refresh({ silent: true });
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
      subscribeSessionAutomationMutations((sessionId, automation) => {
        model.applySessionAutomation(
          sessionId,
          automation === null ? undefined : { status: automation.status },
        );
      }),
    [model],
  );

  useEffect(
    () =>
      subscribePullRequestStatusMutations(({ sessionId, pr }) => {
        if (pr !== undefined) model.applyPullRequestStatus(sessionId, pr);
        if (focused.current) void model.refresh({ silent: true });
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

  const setFavorite = useCallback(
    (sessionId: string, favorite: boolean) => {
      void model.setFavorite(sessionId, favorite);
    },
    [model],
  );

  const remove = useCallback(
    (sessionId: string, opts: { force?: boolean } = {}) => {
      return model.delete(sessionId, opts);
    },
    [model],
  );

  return { ...state, refresh, rename, setFavorite, remove };
}
