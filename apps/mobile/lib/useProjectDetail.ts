// One project's live record for the project screen and each of its settings
// routes.
//
// Project settings are a stack of sibling routes (index, GitHub, services,
// environment, model), and expo-router mounts each of them independently. Every
// route reads the project through this hook, so the container state ages the
// same wherever the operator is looking, and a lifecycle action taken on one
// screen reaches the others through the shared status-mutation bus rather than
// through a stale copy each screen fetched for itself.
import {
  VerityApiError,
  publishProjectStatusMutation,
  subscribeProjectStatusMutations,
  type ProjectDetail,
  type ProjectRecord,
  type ProjectSettings,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { projectLifecycleState } from './projectSetup';

/** The `[id]` route param as one string. Expo Router hands back an array when a
 *  link repeats the segment; the first value is the project. */
export function projectIdParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Matches the overview's project poll (`PROJECTS_POLL_MS` in app/index.tsx) so the
 *  container state ages the same wherever the operator is looking. */
export const PROJECT_DETAIL_POLL_MS = 15_000;

export type ProjectDetailState = {
  detail: ProjectDetail | undefined;
  /** The first load is in flight. A silent refresh over existing data does not set this. */
  loading: boolean;
  /** The last non-silent load failed, or an action reported one through `setError`. */
  error: string | undefined;
  setError: (error: string | undefined) => void;
  /** Reload the project. `silent` keeps the rendered project while the request runs. */
  load: (silent?: boolean) => Promise<void>;
  /** An action returned a newer project record: adopt it and tell the other screens. */
  onProjectUpdated: (project: ProjectRecord) => void;
  /** A settings PATCH returned the saved settings: adopt them in place. */
  onSettingsSaved: (settings: ProjectSettings) => void;
};

// Projects whose `pending` setup status is being migrated right now. Module
// level, because the project screen and its settings routes stack on top of
// each other and each mounts this hook — without the guard every one of them
// would PATCH the same status.
const setupMigrations = new Set<string>();

export function useProjectDetail(client: VerityClient, projectId: string): ProjectDetailState {
  const [detail, setDetail] = useState<ProjectDetail | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadGeneration = useRef(0);
  const publishedProjectRef = useRef<ProjectRecord | undefined>(undefined);
  const pendingProjectMutationRef = useRef<ProjectRecord | undefined>(undefined);
  // Polls run only while this screen is the one on top. Every route on the
  // project stack mounts this hook, and a screen two levels down has nothing
  // to show the operator until they come back — at which point the focus
  // reload below fetches fresh state anyway.
  const focusedRef = useRef(false);

  const onProjectUpdated = useCallback((next: ProjectRecord) => {
    // A poll already in flight carries pre-action state and must not win later.
    loadGeneration.current += 1;
    setLoading(false);
    pendingProjectMutationRef.current = undefined;
    publishedProjectRef.current = next;
    setDetail((current) => (current ? { ...current, project: next } : current));
    publishProjectStatusMutation(next);
  }, []);
  const onSettingsSaved = useCallback((next: ProjectSettings) => {
    // A detail request started before the PATCH may return old settings later.
    loadGeneration.current += 1;
    setLoading(false);
    setDetail((current) => (current ? { ...current, settings: next } : current));
  }, []);

  const load = useCallback(
    async (silent = false): Promise<void> => {
      const generation = ++loadGeneration.current;
      if (!silent) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const next = await client.getProject(projectId);
        if (generation === loadGeneration.current) {
          const project = pendingProjectMutationRef.current ?? next.project;
          pendingProjectMutationRef.current = undefined;
          setDetail({ ...next, project });
          // A fetch result deliberately stays off the status bus. Only an
          // action's response is published (see `onProjectUpdated`): with the
          // project screen and its settings routes stacked, each polling, a
          // published fetch would land in the other instances as a "pending
          // mutation" that outranks their own newer fetch — an older poll
          // could then roll the visible screen back to a state it had left.
        }
      } catch (caught) {
        if (!silent && generation === loadGeneration.current) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not load project');
        }
      } finally {
        if (!silent && generation === loadGeneration.current) setLoading(false);
      }
    },
    [client, projectId],
  );

  const detailLoaded = detail !== undefined;
  useEffect(
    () =>
      subscribeProjectStatusMutations((next) => {
        if (next.id !== projectId) return;
        if (publishedProjectRef.current === next) return;
        pendingProjectMutationRef.current = next;
        setDetail((current) => (current ? { ...current, project: next } : current));
      }),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (detail?.project.setupStatus !== 'pending') return;
    if (setupMigrations.has(projectId)) return;
    setupMigrations.add(projectId);
    // Projects created before the guided flow was removed can use the same
    // independent settings and repair controls as newly created projects.
    void client
      .setProjectSetupStatus(projectId, 'complete')
      .then(onProjectUpdated)
      .catch(() => {
        // A later visit retries; the project remains usable in the meantime.
      })
      .finally(() => setupMigrations.delete(projectId));
  }, [client, detail?.project.setupStatus, onProjectUpdated, projectId]);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (detailLoaded) void load(true);
      return () => {
        focusedRef.current = false;
      };
    }, [detailLoaded, load]),
  );

  // Keep the container state live while the screen is open. `GET /projects/:id`
  // reconciles the project against Docker, so this is what turns a sandbox that
  // died under the operator into a visible "Needs repair" plus the Repair action,
  // instead of a stale "Running" with a Pause button. Silent: a failing poll must
  // not replace the rendered project with an error banner. Same cadence as the
  // overview poll. Native timers resume after the app returns to the foreground.
  useEffect(() => {
    // The initial request owns the loading gate. Starting a silent generation
    // before it settles could supersede it without any request clearing loading.
    if (!detailLoaded) return;
    const refresh = (): void => {
      if (focusedRef.current) void load(true);
    };
    const timer = setInterval(refresh, PROJECT_DETAIL_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [detailLoaded, load]);

  useEffect(() => {
    const project = detail?.project;
    if (project === undefined) return;
    const state = projectLifecycleState(project);
    if (
      state !== 'cloning' &&
      state !== 'container_starting' &&
      state !== 'sleeping_starting' &&
      state !== 'waking'
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      if (focusedRef.current) await load(true);
      if (!cancelled) timer = setTimeout(() => void poll(), 2_000);
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detail?.project.lifecycleState, detail?.project.state, load]);

  return { detail, loading, error, setError, load, onProjectUpdated, onSettingsSaved };
}
