import { AppState } from 'react-native';
import { PreviewReadScheduler } from '../lib/previewReadScheduler';
import { publishSessionPreviews } from '../lib/sessionPreviews';
import { readContextProjects } from '../lib/sharedTaskContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  VerityApiError,
  subscribeProjectStatusMutations,
  type VerityClient,
  type ProjectRecord,
  type DevServer,
  type DevServerDetection,
} from '@verity/mobile';
import { liveConnectionFor, subscribeLiveRefresh } from '../lib/liveConnection';
import { beginClientActivity } from '../lib/sessionSwitchTiming';
import { mergeProjectStatusMutation } from '../lib/projectStatusMutation';
import {
  localPreviewLinks,
  mergeSessionPreviewUrls,
  nextProjectPreviewLinks,
  publicPreviewLinks,
  publicPreviewSessionIds,
  type ProjectPreviewLinks,
} from '../lib/sessionPreviewLinks';

// Project and preview changes arrive over the shared live connection.
export function useProjects(client: VerityClient) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [devServersByProject] = useState(() => new Map<string, DevServer[]>());
  const [detectionsByProject] = useState(() => new Map<string, DevServerDetection>());
  // Session id → the URL its preview icon opens; see mergeSessionPreviewUrls.
  const [previewUrls, setPreviewUrls] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  // Sessions with an unexpired public share: their row shows "online" even when
  // the preview entry opens the local link.
  const [publicPreviews, setPublicPreviews] = useState<ReadonlySet<string>>(() => new Set());
  const publicPreviewLinksRef = useRef<ProjectPreviewLinks>(new Map());
  const localPreviewLinksRef = useRef<ProjectPreviewLinks>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [failures, setFailures] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadGeneration = useRef(0);
  const focused = useRef(false);
  const projectsDirty = useRef(true);
  const [previewsActive, setPreviewsActive] = useState(false);
  const publishPreviews = useCallback(() => {
    const now = Date.now();
    const urls = mergeSessionPreviewUrls(
      publicPreviewLinksRef.current,
      localPreviewLinksRef.current,
      now,
    );
    const publicIds = publicPreviewSessionIds(publicPreviewLinksRef.current, now);
    setPreviewUrls((previous) =>
      previous.size === urls.size &&
      [...urls].every(([id, url]) => previous.has(id) && previous.get(id) === url)
        ? previous
        : urls,
    );
    setPublicPreviews((previous) =>
      previous.size === publicIds.size && [...publicIds].every((id) => previous.has(id))
        ? previous
        : publicIds,
    );
  }, []);
  // Another server's previews must not show under this one: start empty for
  // every client, and leave nothing behind when the overview goes away.
  useEffect(() => {
    publishSessionPreviews({ urls: new Map(), online: new Set() });
    return () => publishSessionPreviews({ urls: new Map(), online: new Set() });
  }, [client]);
  // The Work list of a project page shows exactly the markers this overview
  // shows, without a poll of its own.
  useEffect(
    () => publishSessionPreviews({ urls: previewUrls, online: publicPreviews }),
    [previewUrls, publicPreviews],
  );
  const previewReads = useMemo(
    () => new PreviewReadScheduler(publishPreviews),
    [client, publishPreviews],
  );
  const activatePreviews = useCallback(() => {
    const connection =
      typeof client.observeReads === 'function'
        ? liveConnectionFor(client.liveBaseUrl())
        : undefined;
    const active = focused.current && AppState.currentState === 'active';
    setPreviewsActive(active);
    previewReads.setActive(
      active,
      connection?.connectionState === 'connected' && connection.resourceWatching,
    );
  }, [client, previewReads]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', activatePreviews);
    return () => {
      listener.remove();
      previewReads.stop();
    };
  }, [activatePreviews, previewReads]);
  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    [client],
  );
  const pendingProjectMutations = useRef(
    new Map<string, { project: ProjectRecord; generation: number }>(),
  );

  useEffect(
    () =>
      subscribeProjectStatusMutations((updated) => {
        setProjects((current) => {
          const existing = current.find((project) => project.id === updated.id);
          const merged = mergeProjectStatusMutation(existing, updated);
          pendingProjectMutations.current.set(updated.id, {
            project: merged,
            generation: loadGeneration.current,
          });
          return existing
            ? current.map((project) => (project.id === updated.id ? merged : project))
            : [...current, merged];
        });
      }),
    [],
  );

  // `silent` skips the loading-spinner flip so live refreshes update in
  // place (no flicker); the initial load + pull-to-refresh flip it as before.
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      projectsDirty.current = true;
      if (!focused.current || AppState.currentState !== 'active') return;
      projectsDirty.current = false;
      const generation = ++loadGeneration.current;
      clearTimeout(retryTimer.current);
      if (!opts?.silent) setLoading(true);
      try {
        const nextProjects = await readContextProjects(client, true);
        const activeProjects = nextProjects.filter((project) => project.state === 'active');
        const projectIds = activeProjects.map((project) => project.id);
        if (generation !== loadGeneration.current) return;
        publicPreviewLinksRef.current = nextProjectPreviewLinks(
          publicPreviewLinksRef.current,
          projectIds,
          [],
        );
        localPreviewLinksRef.current = nextProjectPreviewLinks(
          localPreviewLinksRef.current,
          projectIds,
          [],
        );
        const finishPublish = beginClientActivity('project-list-publish');
        try {
          publishPreviews();
          const pending = new Map(
            [...pendingProjectMutations.current].filter(
              ([, entry]) => entry.generation >= generation,
            ),
          );
          const seen = new Set(nextProjects.map((project) => project.id));
          setProjects([
            ...nextProjects.map((project) => pending.get(project.id)?.project ?? project),
            ...[...pending.values()]
              .map(({ project }) => project)
              .filter((project) => !seen.has(project.id)),
          ]);
          pendingProjectMutations.current.clear();
        } finally {
          finishPublish();
        }
        setHasLoaded(true);
        setFailures(0);
        setError(undefined); // recovered — clear any stale banner
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        projectsDirty.current = true;
        // Keep the last-good list, but expose a failed read even when live
        // observation triggered it: unchanged resources may never notify again.
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load projects');
        if (!(caught instanceof VerityApiError) || caught.status >= 500)
          setFailures((count) => count + 1);
        else setFailures(0);
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [client, publishPreviews],
  );

  // Retain invalidations while hidden, and reject responses admitted before blur.
  // Foreground catch-up also covers servers that cannot watch resources reliably.
  useEffect(() => {
    let previousState = AppState.currentState;
    const listener = AppState.addEventListener('change', (state) => {
      if (state === previousState) return;
      previousState = state;
      if (state !== 'active') {
        projectsDirty.current = true;
        loadGeneration.current += 1;
        clearTimeout(retryTimer.current);
      } else if (focused.current && projectsDirty.current) {
        void load({ silent: true });
      }
    });
    return () => listener.remove();
  }, [load]);

  useEffect(() => {
    if (failures === 0) return;
    const retry = () => {
      if (focused.current && AppState.currentState === 'active') void load({ silent: true });
    };
    if (AppState.currentState === 'active')
      retryTimer.current = setTimeout(
        retry,
        Math.min(1_000 * 2 ** Math.min(failures - 1, 4), 15_000),
      );
    return () => {
      clearTimeout(retryTimer.current);
    };
  }, [failures, load]);

  // Refresh on return: hidden overview watches must not keep server polling alive.
  const loadedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load(loadedOnce.current ? { silent: true } : undefined);
      activatePreviews();
      loadedOnce.current = true;
      return () => {
        focused.current = false;
        projectsDirty.current = true;
        loadGeneration.current += 1;
        clearTimeout(retryTimer.current);
        setPreviewsActive(false);
        previewReads.setActive(false);
      };
    }, [load, activatePreviews, previewReads]),
  );

  useEffect(
    () =>
      subscribeLiveRefresh(
        client,
        () => load({ silent: true }),
        (path) => path.split('?')[0] === '/projects',
      ),
    [client, load],
  );

  const activeProjectIds = JSON.stringify(
    projects
      .filter((project) => project.state === 'active')
      .map((project) => project.id)
      .sort(),
  );
  const shareSubscriptions = useRef(new Map<string, { projectId: string; dispose: () => void }>());
  useEffect(() => {
    const subscriptions = shareSubscriptions.current;
    return () => {
      for (const entry of subscriptions.values()) entry.dispose();
      subscriptions.clear();
    };
  }, [client, previewReads]);
  useEffect(() => {
    const projectIds = previewsActive ? (JSON.parse(activeProjectIds) as string[]) : [];
    const wanted = new Set(projectIds);
    for (const [path, entry] of shareSubscriptions.current) {
      if (!wanted.has(entry.projectId)) {
        entry.dispose();
        shareSubscriptions.current.delete(path);
      }
    }
    for (const projectId of projectIds) {
      for (const source of ['public', 'local'] as const) {
        const path = `/projects/${encodeURIComponent(projectId)}/${source}-shares`;
        if (shareSubscriptions.current.has(path)) continue;
        let active = true;
        previewReads.add(path, async (signal) => {
          const links =
            source === 'public'
              ? publicPreviewLinks(await client.listPublicPreviewShares(projectId, signal))
              : localPreviewLinks(await client.listProjectLocalPreviewShares(projectId, signal));
          if (!active || signal.aborted) return;
          const target = source === 'public' ? publicPreviewLinksRef : localPreviewLinksRef;
          target.current = new Map(target.current).set(projectId, links);
        });
        const detach = subscribeLiveRefresh(
          client,
          () => previewReads.invalidate(path),
          (resourcePath) => resourcePath.split('?')[0] === path,
          [{ path }],
        );
        shareSubscriptions.current.set(path, {
          projectId,
          dispose: () => {
            active = false;
            previewReads.remove(path);
            detach();
          },
        });
      }
    }
  }, [client, activeProjectIds, previewReads, previewsActive]);

  const refresh = useCallback(() => {
    previewReads.invalidate();
    return load();
  }, [load, previewReads]);

  return {
    projects,
    devServersByProject,
    detectionsByProject,
    previewUrls,
    publicPreviews,
    loading,
    error,
    listState: error ? ('error' as const) : hasLoaded ? ('ready' as const) : ('loading' as const),
    refresh,
  };
}
