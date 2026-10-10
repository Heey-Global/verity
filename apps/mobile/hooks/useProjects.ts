import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  VerityApiError,
  subscribeProjectStatusMutations,
  type VerityClient,
  type ProjectRecord,
  type DevServer,
  type DevServerDetection,
} from '@verity/mobile';
import { subscribeLiveRefresh } from '../lib/liveConnection';
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
  const loadGeneration = useRef(0);
  const [shareRefresh, setShareRefresh] = useState(0);
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

  // `silent` skips the loading-spinner flip so the interval poll refreshes in
  // place (no flicker); the initial load + pull-to-refresh flip it as before.
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const generation = ++loadGeneration.current;
      if (!opts?.silent) setLoading(true);
      try {
        const nextProjects = await client.listProjects();
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
          const now = Date.now();
          setPreviewUrls(
            mergeSessionPreviewUrls(
              publicPreviewLinksRef.current,
              localPreviewLinksRef.current,
              now,
            ),
          );
          setPublicPreviews(publicPreviewSessionIds(publicPreviewLinksRef.current, now));
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
        setError(undefined); // recovered — clear any stale banner
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        // A silent background poll keeps the last-good list on screen without
        // flashing an error banner over it; only the initial load and
        // pull-to-refresh surface a failure to the operator.
        if (!opts?.silent) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not load projects');
        }
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [client],
  );

  // Load on focus — the first mount AND every return to the overview. The poll
  // below is too coarse to carry a change the operator just made elsewhere: a
  // project deleted on its detail screen pops back here, and waiting out the
  // interval would leave the deleted card on the list, tappable. Every refetch
  // after the first is silent, so coming back never flashes the list into its
  // loading state.
  const loadedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(loadedOnce.current ? { silent: true } : undefined);
      if (loadedOnce.current) setShareRefresh((value) => value + 1);
      loadedOnce.current = true;
    }, [load]),
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
  }, [client, shareRefresh]);
  useEffect(() => {
    const projectIds = JSON.parse(activeProjectIds) as string[];
    const wanted = new Set(projectIds);
    for (const [path, entry] of shareSubscriptions.current) {
      if (!wanted.has(entry.projectId)) {
        entry.dispose();
        shareSubscriptions.current.delete(path);
      }
    }
    const publish = () => {
      const now = Date.now();
      setPreviewUrls(
        mergeSessionPreviewUrls(publicPreviewLinksRef.current, localPreviewLinksRef.current, now),
      );
      setPublicPreviews(publicPreviewSessionIds(publicPreviewLinksRef.current, now));
    };
    for (const projectId of projectIds) {
      for (const source of ['public', 'local'] as const) {
        const path = `/projects/${encodeURIComponent(projectId)}/${source}-shares`;
        if (shareSubscriptions.current.has(path)) continue;
        let active = true;
        const controller = new AbortController();
        let generation = 0;
        let running = false;
        let followup = false;
        const refreshShares = async (): Promise<void> => {
          if (!active) return;
          if (running) {
            followup = true;
            return;
          }
          running = true;
          const requestGeneration = ++generation;
          try {
            const links =
              source === 'public'
                ? publicPreviewLinks(
                    await client.listPublicPreviewShares(projectId, controller.signal),
                  )
                : localPreviewLinks(
                    await client.listProjectLocalPreviewShares(projectId, controller.signal),
                  );
            if (!active || requestGeneration !== generation) return;
            const target = source === 'public' ? publicPreviewLinksRef : localPreviewLinksRef;
            target.current = new Map(target.current).set(projectId, links);
            publish();
          } catch {
            /* Preserve the last successful links on transient failures. */
          } finally {
            running = false;
            if (followup && active) {
              followup = false;
              void refreshShares();
            }
          }
        };
        const detach = subscribeLiveRefresh(
          client,
          refreshShares,
          (resourcePath) => resourcePath.split('?')[0] === path,
          [{ path }],
        );
        shareSubscriptions.current.set(path, {
          projectId,
          dispose: () => {
            active = false;
            controller.abort();
            detach();
          },
        });
        void refreshShares();
      }
    }
  }, [client, activeProjectIds, shareRefresh]);

  return {
    projects,
    devServersByProject,
    detectionsByProject,
    previewUrls,
    publicPreviews,
    loading,
    error,
    refresh: () => {
      setShareRefresh((value) => value + 1);
      return load();
    },
  };
}
