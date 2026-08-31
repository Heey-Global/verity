import {
  VerityApiError,
  type VerityClient,
  type BranchList,
  type BranchSwitchRequest,
  publishPullRequestStatusMutation,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { takePrefetchedBranches } from '../lib/branchesPrefetch';

const ACTIVE_PR_POLL_MS = 2_000;
// Still discovering: no PR yet, so poll briskly to surface one the agent opens
// after mount (the server keeps a "no PR" answer for only ~4s, so this converges
// within a few seconds without hammering GitHub).
const DISCOVER_PR_POLL_MS = 5_000;
const SETTLED_PR_POLL_MS = 15_000;

export interface UseBranches {
  /** The branch currently checked out in the session's worktree (undefined until loaded). */
  current: string | undefined;
  /** Local branches the worktree can switch to (those not checked out elsewhere). */
  switchable: string[];
  /** Pushed branches (open PRs / `origin/*`) the worktree can PREVIEW live (#122) —
   * including ones checked out in another worktree. Empty if the server is older. */
  previewable: string[];
  /** The open PR number for the current branch (#125), or null when there's none /
   * GitHub isn't configured (or the server is older). The header shows `PR #N` only
   * when this is a number — independent of the branch-derived issue chip. */
  currentPr: number | null;
  pullRequest: NonNullable<BranchList['pullRequest']> | null;
  /** The project repo's GitHub `owner`/`repo` (#161), from the server's `origin`-remote
   * parse — used to build tappable Issue/PR chip URLs. Both undefined when the server
   * is older OR there's no GitHub remote, in which case the chips stay non-tappable. */
  owner: string | undefined;
  repo: string | undefined;
  /** True while the initial (or a forced) load is in flight. */
  loading: boolean;
  /** True when the transcript exists but the session workspace was cleaned up. */
  workspaceMissing: boolean;
  /** The last fetch error's message, if the branch list failed to load. */
  error: string | undefined;
  /** Re-fetch the current + switchable + previewable branches. */
  refresh: () => void;
  /**
   * Switch the worktree's branch (keeping the chat). On success refreshes the
   * list and resolves `{ ok: true }`. A server error resolves `{ ok: false, … }`
   * (it never throws) so the UI can react: `dirty` is true on the 409 "uncommitted
   * changes" case, signalling the commit/stash retry prompt.
   */
  switchTo: (
    opts: BranchSwitchRequest,
  ) => Promise<{ ok: true } | { ok: false; dirty: boolean; message: string }>;
  mergePullRequest: (number: number) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The base branch this session can be merged into WITHOUT GitHub, or undefined
   * when the project has a repository (merging goes through its PR) or the server is
   * older. Drives the local merge bar. */
  localMergeBase: string | undefined;
  /** Merge the current branch into {@link localMergeBase}. Never throws: a rejected
   * merge (dirty worktree, conflicts, nothing to merge) resolves `{ ok: false }` with
   * the server's reason, which the bar shows verbatim. */
  mergeLocally: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * Branch switcher binding (#91): fetches a session worktree's current +
 * switchable branches on mount and exposes a `switchTo` that maps the server's
 * dirty-worktree 409 into a non-throwing result the sheet can branch on. A small
 * glue hook (no headless model) in the spirit of {@link useSession} /
 * {@link useSessionList}.
 */
export function useBranches(client: VerityClient, sessionId: string): UseBranches {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [switchable, setSwitchable] = useState<string[]>([]);
  const [previewable, setPreviewable] = useState<string[]>([]);
  const [currentPr, setCurrentPr] = useState<number | null>(null);
  const [pullRequest, setPullRequest] = useState<NonNullable<BranchList['pullRequest']> | null>(
    null,
  );
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [localMergeBase, setLocalMergeBase] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [workspaceMissing, setWorkspaceMissing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Race/unmount guard (mirrors SessionListModel): only the LATEST load writes
  // state, and nothing writes after unmount — so a slow fetch (or one for a
  // previous sessionId) can't clobber the current state or setState-after-unmount.
  const mounted = useRef(true);
  const reqId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const fresh = (): boolean => mounted.current && id === reqId.current;
    setLoading(true);
    try {
      const prefetched = takePrefetchedBranches(client, sessionId);
      const res = await (prefetched ?? client.getBranches(sessionId));
      if (!fresh()) return;
      setCurrent(res.current);
      setSwitchable(res.switchable);
      setPreviewable(res.previewable ?? []);
      setCurrentPr(res.currentPr ?? null);
      setPullRequest(res.pullRequest ?? null);
      setOwner(res.owner);
      setRepo(res.repo);
      setLocalMergeBase(res.localMerge?.base);
      setWorkspaceMissing(res.workspaceMissing === true);
      setError(undefined);
    } catch (err) {
      if (!fresh()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fresh()) setLoading(false);
    }
  }, [client, sessionId]);

  // Fetch on focus — opening the session OR returning to it — and pause between
  // visits so a session left in the background (another one opened on top) fires no
  // requests. This immediate load also covers the initial mount (the screen is
  // focused then), replacing a plain mount effect.
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (appActive) void load();
      return () => setFocused(false);
    }, [appActive, load]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const active = nextState === 'active';
      setAppActive(active);
      if (!active) reqId.current += 1; // stale in-flight response must not write in background
      // Changing appActive reruns the focus effect (immediate load) and recreates
      // the polling interval; native timers are not guaranteed to resume themselves.
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    // Only poll while the screen is focused (see above).
    if (!focused || !appActive) return undefined;
    if (workspaceMissing) return undefined;
    // Poll even with no PR yet: one the agent opens AFTER this screen mounts must
    // surface without a full app reload (the activity poll carries only the branch
    // name, not PR status). Cadence: fast (2s) while a pipeline runs, brisk (5s)
    // while still discovering a PR, relaxed (15s) once it has settled.
    const active =
      pullRequest !== null &&
      (pullRequest.pipeline === 'running' ||
        pullRequest.pipeline === 'pending' ||
        (pullRequest.phase === 'open' &&
          pullRequest.checks.failed === 0 &&
          pullRequest.checks.total === 0));
    const intervalMs = active
      ? ACTIVE_PR_POLL_MS
      : pullRequest === null
        ? DISCOVER_PR_POLL_MS
        : SETTLED_PR_POLL_MS;
    let inFlight = false;
    const poll = (): void => {
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  }, [load, pullRequest, focused, appActive, workspaceMissing]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const switchTo = useCallback<UseBranches['switchTo']>(
    async (opts) => {
      try {
        await client.switchBranch(sessionId, opts);
        await load();
        return { ok: true };
      } catch (err) {
        if (err instanceof VerityApiError) {
          // The dirty-worktree case (409 + "uncommitted") is recoverable: the UI
          // offers commit/stash. Everything else is a plain error to surface.
          const dirty = err.status === 409 && /uncommitted/i.test(err.message);
          return { ok: false, dirty, message: err.message };
        }
        return {
          ok: false,
          dirty: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [client, sessionId, load],
  );

  const mergePullRequest = useCallback<UseBranches['mergePullRequest']>(
    async (number) => {
      try {
        await client.mergePullRequest(sessionId, number);
        setPullRequest((current) =>
          current?.number === number
            ? { ...current, phase: 'merged', mergeable: false, mergeState: undefined }
            : current,
        );
        publishPullRequestStatusMutation({
          sessionId,
          pr: { phase: 'merged', pipeline: 'success', mergeable: false },
        });
        await load();
        return { ok: true };
      } catch (err) {
        if (err instanceof VerityApiError && err.status === 409) {
          publishPullRequestStatusMutation({ sessionId });
          void load();
        }
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [client, sessionId, load],
  );

  const mergeLocally = useCallback<UseBranches['mergeLocally']>(async () => {
    try {
      await client.mergeSessionBranch(sessionId);
      await load();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }, [client, sessionId, load]);

  return {
    current,
    switchable,
    previewable,
    currentPr,
    pullRequest,
    owner,
    repo,
    loading,
    workspaceMissing,
    error,
    refresh,
    switchTo,
    mergePullRequest,
    localMergeBase,
    mergeLocally,
  };
}
