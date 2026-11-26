import { getVerityBaseUrl } from './client';
import { subscribeLiveRefresh } from './liveConnection';
import { useOverviewStore, useOverviewTopics } from './overviewTopics';
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
  applyOverviewEvent,
  projectEventUpdate,
  publishProjectStatusMutation,
  subscribeProjectStatusMutations,
  type OverviewStore,
  type ProjectDetail,
  type ProjectProfile,
  type ProjectRecord,
  type ProjectSettings,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** The `[id]` route param as one string. Expo Router hands back an array when a
 *  link repeats the segment; the first value is the project. */
export function projectIdParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

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
  /** Adopt the saved profile before attempting a fallible detail refresh. */
  onProfileSaved: (profile: ProjectProfile) => void;
  savedProfile: ProjectProfile | undefined;
  /** A settings PATCH returned the saved settings: adopt them in place. */
  onSettingsSaved: (settings: ProjectSettings) => void;
  /** The signed-in person's own default model was saved (ADR 0023 §3). */
  onOwnDefaultModelSaved: (model: string | null) => void;
};

// Projects whose `pending` setup status is being migrated right now. Module
// level, because the project screen and its settings routes stack on top of
// each other and each mounts this hook — without the guard every one of them
// would PATCH the same status.
const setupMigrations = new Set<string>();

/** A project an action or another screen returned is newer than any read
 * still on its way, so it is applied as the newest read of that project. */
function adoptProject(store: OverviewStore, project: ProjectRecord): void {
  // `applyProjects` ends the read it is given; no `endRead` is needed.
  store.applyProjects(store.beginRead(), [project], { covers: (p) => p.id === project.id });
}

export function useProjectDetail(client: VerityClient, projectId: string): ProjectDetailState {
  // The same source as Home, so both views share one live connection and one
  // copy of the project and its sessions (ADR 0033).
  const baseUrl = getVerityBaseUrl();
  const store = useOverviewStore(baseUrl);
  const storeRef = useRef(store);
  storeRef.current = store;
  // The last read of this page: settings and everything else the store does
  // not hold, and the order of the sessions it listed.
  const [detail, setDetail] = useState<ProjectDetail | undefined>(undefined);
  // False while the store could not take the last read; the page then shows
  // that read's sessions until the next one lands.
  const [sessionsInStore, setSessionsInStore] = useState(true);
  const [savedProfile, setSavedProfile] = useState<ProjectProfile | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadGeneration = useRef(0);
  // Polls run only while this screen is the one on top. Every route on the
  // project stack mounts this hook, and a screen two levels down has nothing
  // to show the operator until they come back — at which point the focus
  // reload below fetches fresh state anyway.
  const focusedRef = useRef(false);
  // The record this screen published itself; its echo is already adopted.
  const publishedProjectRef = useRef<ProjectRecord | undefined>(undefined);

  const onProjectUpdated = useCallback((next: ProjectRecord) => {
    // A poll already in flight carries pre-action state and must not win later.
    loadGeneration.current += 1;
    setLoading(false);
    adoptProject(storeRef.current, next);
    setDetail((current) => (current ? { ...current, project: next } : current));
    publishedProjectRef.current = next;
    publishProjectStatusMutation(next);
  }, []);
  const onSettingsSaved = useCallback((next: ProjectSettings) => {
    // A detail request started before the PATCH may return old settings later.
    loadGeneration.current += 1;
    setLoading(false);
    setDetail((current) => (current ? { ...current, settings: next } : current));
  }, []);

  const onOwnDefaultModelSaved = useCallback((model: string | null) => {
    // Like a settings save: an older detail request must not bring the old one back.
    loadGeneration.current += 1;
    setLoading(false);
    setDetail((current) =>
      current?.settings
        ? { ...current, settings: { ...current.settings, defaultModel: model } }
        : current,
    );
  }, []);

  const onProfileSaved = useCallback(
    (profile: ProjectProfile) => {
      loadGeneration.current += 1;
      setSavedProfile((current) => ({ ...current, ...profile }));
      const held = storeRef.current.project(projectId);
      if (held !== undefined && profile.name !== undefined && held.name !== profile.name)
        adoptProject(storeRef.current, { ...held, name: profile.name });
      setDetail((current) =>
        current
          ? {
              ...current,
              project:
                profile.name === undefined
                  ? current.project
                  : { ...current.project, name: profile.name },
              settings:
                profile.description === undefined || current.settings === null
                  ? current.settings
                  : { ...current.settings, description: profile.description },
            }
          : current,
      );
    },
    [projectId],
  );

  const load = useCallback(
    // `retry` marks the one repeat of a read the store refused.
    async (silent = false, retry = false): Promise<void> => {
      const generation = ++loadGeneration.current;
      if (!silent) {
        setLoading(true);
        setError(undefined);
      }
      // Events that arrive while the read is on its way are applied again on
      // top of its answer, and a project another screen saved meanwhile wins.
      const target = storeRef.current;
      const projectRead = target.beginRead();
      const sessionsRead = target.beginRead();
      try {
        const next = await client.getProject(projectId);
        if (generation === loadGeneration.current) {
          const projectApplied = target.applyProjects(projectRead, [next.project], {
            covers: (p) => p.id === projectId,
          });
          const sessionsApplied = target.applySessions(sessionsRead, next.sessions, {
            covers: (s) => s.projectId === projectId,
          });
          setDetail(next);
          // A store replaced while the read was out is not the one shown.
          setSessionsInStore(sessionsApplied && target === storeRef.current);
          setSavedProfile(undefined);
          // Events this read would need replayed were dropped: read again.
          // A screen below the one on top reads again when it comes back.
          if ((!projectApplied || !sessionsApplied) && focusedRef.current && !retry) {
            queueMicrotask(() => {
              if (focusedRef.current) void loadRef.current(true, true);
            });
          }
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
        // Ends reads that failed or were superseded; after an `apply…` it
        // changes nothing.
        target.endRead(projectRead);
        target.endRead(sessionsRead);
        if (!silent && generation === loadGeneration.current) setLoading(false);
      }
    },
    [client, projectId],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  const detailLoaded = detail !== undefined;
  useEffect(
    () =>
      subscribeProjectStatusMutations((next) => {
        if (next.id !== projectId || next === publishedProjectRef.current) return;
        // Another screen's action: newer than a read of this one in flight.
        adoptProject(storeRef.current, next);
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

  useEffect(
    () =>
      subscribeLiveRefresh(
        client,
        () => {
          if (focusedRef.current && detailLoaded) return load(true);
        },
        (path) => path.split('?')[0] === `/projects/${encodeURIComponent(projectId)}`,
      ),
    [client, projectId, detailLoaded, load],
  );

  // What the page shows: the project and its sessions as the shared store
  // holds them, so an event or another view's read changes them at once, in
  // the order of this page's last read.
  const version = store.getVersion();
  const shown = useMemo(() => {
    if (detail === undefined) return undefined;
    const fromStore = sessionsInStore && store.project(projectId) !== undefined;
    const sessions = detail.sessions.flatMap((listed) => {
      const held = store.session(listed.sessionId);
      if (held !== undefined) return [held];
      // Until the store took a read of this project (it refused the last one,
      // or it was replaced since), the page's own read speaks for its sessions.
      return fromStore ? [] : [listed];
    });
    return {
      ...detail,
      project: store.project(projectId) ?? detail.project,
      sessions,
    };
    // `version` changes whenever an entity in the store does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, sessionsInStore, store, projectId, version]);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Requests and questions answered anywhere leave this page at once (ADR 0033);
  // the store applies every event, and the page only reads what an event
  // cannot carry.
  useOverviewTopics(
    baseUrl,
    [projectId],
    (event) => {
      const update = projectEventUpdate(event);
      if (update !== undefined) {
        if (update.projectId !== projectId) return;
        // Also kept on the page's own copy, which it shows while the store
        // refuses its read.
        setDetail((latest) =>
          latest === undefined ? latest : { ...latest, project: update.patch(latest.project) },
        );
        if (update.reload && focusedRef.current) void load(true);
        return;
      }
      const current = shownRef.current;
      if (current === undefined) return;
      const effect = applyOverviewEvent(current.sessions, event);
      if (effect.kind === 'local') {
        // Also kept on the page's own copy, which it lists until the store
        // holds this project.
        setDetail((latest) => {
          if (latest === undefined) return latest;
          const applied = applyOverviewEvent(latest.sessions, event);
          return applied.kind === 'local' ? { ...latest, sessions: applied.sessions } : latest;
        });
      } else if (effect.kind === 'reload' && focusedRef.current) void load(true);
    },
    () => {
      if (focusedRef.current && shownRef.current !== undefined) void load(true);
    },
  );

  return {
    detail: shown,
    loading,
    error,
    setError,
    load,
    onProjectUpdated,
    onSettingsSaved,
    onOwnDefaultModelSaved,
    onProfileSaved,
    savedProfile,
  };
}
