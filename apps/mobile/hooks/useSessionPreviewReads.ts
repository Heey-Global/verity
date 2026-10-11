import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerityClient, ManagedDevServer, SessionDevServer } from '@verity/mobile';
import { subscribeLiveRefresh } from '../lib/liveConnection';

interface SessionPreviewReadsOptions {
  client: VerityClient;
  sessionId: string;
  projectId: string | null | undefined;
  loaded: boolean;
  completedServerTools: number;
  devServers: SessionDevServer[] | undefined;
}

/** Manual, initial and live reads share one request and retain a trailing refresh. */
function usePreviewSource(
  client: VerityClient,
  path: string,
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<void>,
  scope?: string | null,
): () => Promise<void> {
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let inFlight: Promise<void> | undefined;
    let pending = false;
    const refresh = (): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve();
      if (inFlight) {
        pending = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          pending = false;
          try {
            await read(controller.signal);
          } catch {
            // A source owns its display fallback; failed reads must still release
            // the queue so a later invalidation can recover it.
          }
        } while (pending && !controller.signal.aborted);
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    refreshRef.current = refresh;
    const detach = subscribeLiveRefresh(
      client,
      refresh,
      (candidate) => candidate.split('?')[0] === path,
      [{ path }],
    );
    void refresh();
    return () => {
      controller.abort();
      detach();
      refreshRef.current = () => Promise.resolve();
    };
  }, [client, path, enabled, read, scope]);
  return useCallback(() => refreshRef.current(), []);
}

export function useSessionPreviewReads({
  client,
  sessionId,
  projectId,
  loaded,
  completedServerTools,
  devServers,
}: SessionPreviewReadsOptions) {
  const [managedByInstance, setManagedByInstance] = useState<Map<string, ManagedDevServer>>(
    () => new Map(),
  );
  const [publicShared, setPublicShared] = useState(false);
  const [localShared, setLocalShared] = useState(false);
  const [hasRunningDevServer, setHasRunningDevServer] = useState(false);
  // Unsupported is scoped to the client/session, never inherited by a new Core.
  const devServersUnsupported = useRef(false);
  useEffect(() => {
    setManagedByInstance(new Map());
    devServersUnsupported.current = false;
  }, [client, sessionId]);
  useEffect(() => {
    setPublicShared(false);
    setLocalShared(false);
    setHasRunningDevServer(false);
  }, [client, sessionId, projectId]);

  const readManaged = useCallback(
    async (signal: AbortSignal) => {
      const servers = await client.listManagedDevServers(sessionId, signal);
      if (signal.aborted || !servers) return;
      setManagedByInstance(
        new Map(
          servers.flatMap((server) =>
            server.instance ? [[server.instance.id, server] as const] : [],
          ),
        ),
      );
    },
    [client, sessionId],
  );
  const refreshManaged = usePreviewSource(
    client,
    `/sessions/${encodeURIComponent(sessionId)}/managed-dev-servers`,
    typeof client.listManagedDevServers === 'function',
    readManaged,
  );
  const previousManagedInputs = useRef({ client, sessionId, completedServerTools, devServers });
  useEffect(() => {
    const previous = previousManagedInputs.current;
    previousManagedInputs.current = { client, sessionId, completedServerTools, devServers };
    if (
      previous.client === client &&
      previous.sessionId === sessionId &&
      (previous.completedServerTools !== completedServerTools || previous.devServers !== devServers)
    )
      void refreshManaged();
  }, [client, sessionId, completedServerTools, devServers, refreshManaged]);

  const readDevServers = useCallback(
    async (signal: AbortSignal) => {
      if (devServersUnsupported.current) return;
      const servers = await client.listSessionDevServers(sessionId, signal);
      if (signal.aborted) return;
      if (servers === null) devServersUnsupported.current = true;
      setHasRunningDevServer((servers ?? []).length > 0);
    },
    [client, sessionId],
  );
  const readPublic = useCallback(
    async (signal: AbortSignal) => {
      if (!projectId) return;
      const shared = await client
        .listPublicPreviewShares(projectId, signal)
        .then((shares) =>
          shares.some(
            (share) =>
              (share.targetKind === 'static-folder' ||
                (share.targetKind === 'dev-server' && share.devServerId === null)) &&
              share.sessionId === sessionId &&
              share.state === 'active' &&
              new Date(share.expiresAt).getTime() > Date.now(),
          ),
        )
        .catch(() => false);
      if (!signal.aborted) setPublicShared(shared);
    },
    [client, projectId, sessionId],
  );
  const readLocal = useCallback(
    async (signal: AbortSignal) => {
      const shared = await client
        .listSessionLocalPreviewShares(sessionId, signal)
        .then((shares) => shares.some((share) => share.expiresAt.getTime() > Date.now()))
        .catch(() => false);
      if (!signal.aborted) setLocalShared(shared);
    },
    [client, sessionId],
  );
  const enabled = loaded && Boolean(projectId);
  const refreshDevServers = usePreviewSource(
    client,
    `/sessions/${encodeURIComponent(sessionId)}/dev-servers`,
    enabled && typeof client.listSessionDevServers === 'function',
    readDevServers,
    projectId,
  );
  const refreshPublic = usePreviewSource(
    client,
    `/projects/${encodeURIComponent(projectId ?? '')}/public-shares`,
    enabled,
    readPublic,
    projectId,
  );
  const refreshLocal = usePreviewSource(
    client,
    `/sessions/${encodeURIComponent(sessionId)}/local-shares`,
    enabled && typeof client.listSessionLocalPreviewShares === 'function',
    readLocal,
    projectId,
  );
  const refreshStaticPreview = useCallback(
    () => Promise.all([refreshDevServers(), refreshPublic(), refreshLocal()]),
    [refreshDevServers, refreshPublic, refreshLocal],
  );

  useEffect(() => {
    if (devServers !== undefined) setHasRunningDevServer(devServers.length > 0);
  }, [devServers]);

  return {
    managedByInstance,
    hasActiveStaticPreview: publicShared || localShared,
    hasRunningDevServer,
    refreshStaticPreview,
  };
}
