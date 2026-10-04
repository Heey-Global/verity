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

import {
  branchesSnapshotWriter,
  cachedBranches,
  invalidateBranches,
  rememberBranches,
  takePrefetchedBranches,
} from '../lib/branchesPrefetch';
import { hasLocalSaveChanges } from '../lib/localSaveVisibility';

const ACTIVE_PR_POLL_MS = 5_000;
// Still discovering: no PR yet, so poll briskly to surface one the agent opens
// after mount (the server keeps a "no PR" answer for only ~4s, so this converges
// within a few seconds without hammering GitHub).
const DISCOVER_PR_POLL_MS = 5_000;
const SETTLED_PR_POLL_MS = 30_000;
const TERMINAL_PR_POLL_MS = 60_000;

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
  localMergeHasChanges: boolean;
  /** Ask the agent to commit this session's work, then add it to the local project. */
  saveToProject: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * Branch switcher binding (#91): fetches a session worktree's current +
 * switchable branches on mount and exposes a `switchTo` that maps the server's
 * dirty-worktree 409 into a non-throwing result the sheet can branch on. A small
 * glue hook (no headless model) in the spirit of {@link useSession} /
 * {@link useSessionList}.
 */
export function useBranches(client: VerityClient, sessionId: string, enabled = true): UseBranches {
  const cached = cachedBranches(client, sessionId);
  const [identity, setIdentity] = useState({ client, sessionId });
  const [current, setCurrent] = useState<string | undefined>(cached?.current);
  const [switchable, setSwitchable] = useState<string[]>(cached?.switchable ?? []);
  const [previewable, setPreviewable] = useState<string[]>(cached?.previewable ?? []);
  const [currentPr, setCurrentPr] = useState<number | null>(cached?.currentPr ?? null);
  const [pullRequest, setPullRequest] = useState<NonNullable<BranchList['pullRequest']> | null>(
    cached?.pullRequest ?? null,
  );
  const [owner, setOwner] = useState<string | undefined>(cached?.owner);
  const [repo, setRepo] = useState<string | undefined>(cached?.repo);
  const [localMergeBase, setLocalMergeBase] = useState<string | undefined>(
    cached?.localMerge?.base,
  );
  const [localMergeHasChanges, setLocalMergeHasChanges] = useState(
    hasLocalSaveChanges(cached?.localMerge),
  );
  const [loading, setLoading] = useState(cached === undefined);
  const [workspaceMissing, setWorkspaceMissing] = useState(cached?.workspaceMissing === true);
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

  const [discoveryPollMs, setDiscoveryPollMs] = useState(DISCOVER_PR_POLL_MS);
  const discoveryBranch = useRef<string | undefined>(undefined);
  // All triggers share the request. Explicit refreshes queue one fresh read so
  // a response started before a mutation cannot become its final projection.
  const pending = useRef<{
    client: VerityClient;
    sessionId: string;
    promise: Promise<void>;
    followup: boolean;
    silent: boolean;
  } | null>(null);

  // A reused split-view pane must never show the previous session's PR, even for
  // one frame before focus effects run.
  if (identity.client !== client || identity.sessionId !== sessionId) {
    setIdentity({ client, sessionId });
    reqId.current += 1;
    if (pending.current) pending.current.followup = false;
    pending.current = null;
    discoveryBranch.current = undefined;
    setDiscoveryPollMs(DISCOVER_PR_POLL_MS);
    setCurrent(cached?.current);
    setSwitchable(cached?.switchable ?? []);
    setPreviewable(cached?.previewable ?? []);
    setCurrentPr(cached?.currentPr ?? null);
    setPullRequest(cached?.pullRequest ?? null);
    setOwner(cached?.owner);
    setRepo(cached?.repo);
    setLocalMergeBase(cached?.localMerge?.base);
    setLocalMergeHasChanges(hasLocalSaveChanges(cached?.localMerge));
    setLoading(cached === undefined);
    setWorkspaceMissing(cached?.workspaceMissing === true);
    setError(undefined);
  }

  const load = useCallback(
    (opts: { silent?: boolean; force?: boolean } = {}) => {
      const existing = pending.current;
      if (existing?.client === client && existing.sessionId === sessionId) {
        if (opts.force !== false) {
          existing.followup = true;
          existing.silent = existing.silent && opts.silent === true;
        }
        return existing.promise;
      }
      const request = {
        client,
        sessionId,
        promise: Promise.resolve(),
        followup: false,
        silent: opts.silent === true,
      };
      pending.current = request;
      request.promise = (async () => {
        do {
          request.followup = false;
          const id = ++reqId.current;
          const fresh = (): boolean => mounted.current && id === reqId.current;
          if (!request.silent) setLoading(true);
          try {
            const publishSnapshot = branchesSnapshotWriter(client, sessionId);
            const prefetched = takePrefetchedBranches(client, sessionId);
            const res = await (prefetched ?? client.getBranches(sessionId));
            if (fresh()) {
              publishSnapshot(res);
              setCurrent(res.current);
              setSwitchable(res.switchable);
              setPreviewable(res.previewable ?? []);
              setCurrentPr(res.currentPr ?? null);
              setPullRequest(res.pullRequest ?? null);
              setOwner(res.owner);
              setRepo(res.repo);
              setLocalMergeBase(res.localMerge?.base);
              setLocalMergeHasChanges(hasLocalSaveChanges(res.localMerge));
              setWorkspaceMissing(res.workspaceMissing === true);
              setError(undefined);
              const sameBranch = discoveryBranch.current === res.current;
              discoveryBranch.current = res.current;
              setDiscoveryPollMs((previous) =>
                res.pullRequest || !sameBranch
                  ? DISCOVER_PR_POLL_MS
                  : Math.min(previous * 2, 30_000),
              );
            }
          } catch (err) {
            if (fresh()) setError(err instanceof Error ? err.message : String(err));
          } finally {
            if (fresh()) setLoading(false);
          }
        } while (request.followup && mounted.current && pending.current === request);
      })().finally(() => {
        if (pending.current === request) pending.current = null;
      });
      return request.promise;
    },
    [client, sessionId],
  );

  // Fetch on focus — opening the session OR returning to it — and pause between
  // visits so a session left in the background (another one opened on top) fires no
  // requests. This immediate load also covers the initial mount (the screen is
  // focused then), replacing a plain mount effect.
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (appActive && enabled) void load({ silent: true });
      return () => {
        setFocused(false);
        reqId.current += 1;
        if (pending.current) pending.current.followup = false;
      };
    }, [appActive, load, enabled]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const active = nextState === 'active';
      setAppActive(active);
      if (!active) {
        reqId.current += 1; // stale in-flight response must not write in background
        if (pending.current) pending.current.followup = false;
      }
      // Changing appActive reruns the focus effect (immediate load) and recreates
      // the polling interval; native timers are not guaranteed to resume themselves.
    });
    return () => subscription.remove();
  }, []);

  const activePr =
    pullRequest !== null &&
    pullRequest.phase === 'open' &&
    (pullRequest.pipeline === 'running' ||
      pullRequest.pipeline === 'pending' ||
      (pullRequest.checks.failed === 0 && pullRequest.checks.total === 0));
  const intervalMs =
    pullRequest === null
      ? discoveryPollMs
      : pullRequest.phase !== 'open'
        ? TERMINAL_PR_POLL_MS
        : activePr
          ? ACTIVE_PR_POLL_MS
          : SETTLED_PR_POLL_MS;

  useEffect(() => {
    if (!focused || !appActive || !enabled || workspaceMissing) return undefined;
    // Response objects change on every read; only a cadence change restarts the
    // timer, and every trigger shares load's overlap guard.
    const timer = setInterval(() => void load({ silent: true, force: false }), intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs, focused, appActive, workspaceMissing, enabled]);

  const refresh = useCallback(() => {
    if (enabled) void load();
  }, [load, enabled]);

  const switchTo = useCallback<UseBranches['switchTo']>(
    async (opts) => {
      try {
        await client.switchBranch(sessionId, opts);
        invalidateBranches(client, sessionId);
        reqId.current += 1;
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
        const snapshot = cachedBranches(client, sessionId);
        invalidateBranches(client, sessionId);
        reqId.current += 1;
        if (snapshot?.pullRequest?.number === number) {
          rememberBranches(client, sessionId, {
            ...snapshot,
            pullRequest: {
              ...snapshot.pullRequest,
              phase: 'merged',
              mergeable: false,
              mergeState: undefined,
            },
          });
        }
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

  const saveToProject = useCallback<UseBranches['saveToProject']>(async () => {
    try {
      await client.saveSessionToProject(sessionId);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }, [client, sessionId]);

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
    localMergeHasChanges,
    saveToProject,
  };
}
