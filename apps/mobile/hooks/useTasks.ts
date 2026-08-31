import {
  type VerityClient,
  VerityApiError,
  publishIssuesChanged,
  type TaskBoard,
} from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseTasks {
  /** The Projects v2 board (ADR 0007), or `null` — which means EITHER not-yet-loaded
   *  OR task management isn't configured on the server (the client maps a 503 to
   *  `null`). Use {@link loaded} to tell those apart. */
  board: TaskBoard | null;
  loading: boolean;
  /** True once the first load has resolved. `loaded && board === null && !error` is
   *  the "task management not configured" state (show a hint, not a spinner/error). */
  loaded: boolean;
  /** A human-readable load/mutation error, or undefined. A 503 is NOT an error — it
   *  surfaces as `board === null` so the Plan tab shows a configure hint. */
  error: string | undefined;
  /** Re-fetch the board (pull-to-refresh / retry / after a mutation). */
  refresh: () => Promise<void>;
  /** Capture a draft task (the inbox) and refresh. No-op on an empty title. */
  createDraft: (title: string) => Promise<boolean>;
  /** Create a real backlog issue with the given title + markdown body and refresh.
   *  `repo` (`owner/repo`, the repo picker) targets a specific repo; omitted files into
   *  the server's origin repo. Returns whether it succeeded (so the caller can close a
   *  review sheet). */
  createIssue: (title: string, body: string, repo?: string) => Promise<boolean>;
  /** File an inbox draft into a repository issue and refresh. */
  fileDraft: (itemId: string, repo?: string) => Promise<boolean>;
  /** Move `itemId` to sit right after `afterId` (null → to the top) and refresh. */
  reorder: (itemId: string, afterId: string | null) => Promise<void>;
  /** Remove a board item without closing/deleting its GitHub content, then refresh. */
  remove: (itemId: string) => Promise<void>;
  /** Set a single-select field (Priority/Status) on an item by field + option name,
   *  then refresh. */
  setField: (itemId: string, field: string, value: string) => Promise<void>;
}

/**
 * Loader + mutations for the task-management board. Like {@link import('./useIssues').useIssues}
 * it is on-demand (mount + explicit refresh), never polled — the backlog changes
 * slowly and the board rides GitHub's GraphQL budget (ADR 0007: on-demand only).
 * Mutations optimistically re-fetch so the reordered/added board is authoritative.
 * A mounted-guard drops a late response after unmount (StrictMode-safe).
 */
export function useTasks(client: VerityClient): UseTasks {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await client.getTasks();
      if (mounted.current && sequence === requestSequence.current) {
        setBoard(next);
        setLoaded(true);
      }
    } catch (caught) {
      if (mounted.current && sequence === requestSequence.current) {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load tasks');
      }
    } finally {
      if (mounted.current && sequence === requestSequence.current) setLoading(false);
    }
  }, [client]);

  const createDraft = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (trimmed.length === 0) return false;
      try {
        await client.createTaskDraft({ title: trimmed });
        await load();
        return true;
      } catch (caught) {
        if (mounted.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not create the task');
        }
        return false;
      }
    },
    [client, load],
  );

  const createIssue = useCallback(
    async (title: string, body: string, repo?: string): Promise<boolean> => {
      try {
        await client.createTaskIssue({ title, body, ...(repo ? { repo } : {}) });
        publishIssuesChanged();
        await load();
        return true;
      } catch (caught) {
        if (mounted.current) {
          setError(
            caught instanceof VerityApiError ? caught.message : 'Could not create the issue',
          );
        }
        return false;
      }
    },
    [client, load],
  );

  const reorder = useCallback(
    async (itemId: string, afterId: string | null) => {
      try {
        await client.reorderTask(itemId, afterId);
        await load();
      } catch (caught) {
        if (mounted.current) {
          setError(
            caught instanceof VerityApiError ? caught.message : 'Could not reorder the task',
          );
        }
      }
    },
    [client, load],
  );

  const fileDraft = useCallback(
    async (itemId: string, repo?: string): Promise<boolean> => {
      try {
        await client.convertTaskDraft(itemId, repo !== undefined ? { repo } : undefined);
        publishIssuesChanged();
        await load();
        return true;
      } catch (caught) {
        if (mounted.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not file the task');
        }
        return false;
      }
    },
    [client, load],
  );

  const remove = useCallback(
    async (itemId: string) => {
      try {
        await client.removeTaskItem(itemId);
        await load();
      } catch (caught) {
        if (mounted.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not remove the task');
        }
      }
    },
    [client, load],
  );

  const setField = useCallback(
    async (itemId: string, field: string, value: string) => {
      try {
        await client.setTaskField(itemId, field, value);
        await load();
      } catch (caught) {
        if (mounted.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not set the field');
        }
      }
    },
    [client, load],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return {
    board,
    loading,
    loaded,
    error,
    refresh: load,
    createDraft,
    createIssue,
    fileDraft,
    reorder,
    remove,
    setField,
  };
}
