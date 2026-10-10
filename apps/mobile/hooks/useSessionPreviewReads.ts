import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerityClient, ManagedDevServer, SessionDevServer } from '@verity/mobile';
import { subscribeLiveRefresh } from '../lib/liveConnection';
import { useReadAbortScope } from './useReadAbortScope';

interface SessionPreviewReadsOptions {
  client: VerityClient;
  sessionId: string;
  projectId: string | null | undefined;
  loaded: boolean;
  completedServerTools: number;
  devServers: SessionDevServer[] | undefined;
}

export function useSessionPreviewReads({
  client,
  sessionId,
  projectId,
  loaded,
  completedServerTools,
  devServers,
}: SessionPreviewReadsOptions) {
  // Names and addresses of managed servers, for their chat cards.
  const [managedByInstance, setManagedByInstance] = useState<Map<string, ManagedDevServer>>(
    () => new Map(),
  );
  const beginManagedRead = useReadAbortScope(client, sessionId);
  useEffect(() => {
    if (typeof client.listManagedDevServers !== 'function') return;
    let active = true;
    const controller = beginManagedRead();
    void client
      .listManagedDevServers(sessionId, controller.signal)
      .then((servers) => {
        if (!active || !servers) return;
        setManagedByInstance(
          new Map(
            servers.flatMap((server) =>
              server.instance ? [[server.instance.id, server] as const] : [],
            ),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, completedServerTools, devServers, sessionId, beginManagedRead]);
  const [hasActiveStaticPreview, setHasActiveStaticPreview] = useState(false);
  const [hasRunningDevServer, setHasRunningDevServer] = useState(false);
  // Set once a Core without port detection says so, so the header stops asking.
  const devServersUnsupported = useRef(false);
  const beginStaticPreviewRead = useReadAbortScope(client, sessionId);
  const refreshStaticPreview = useCallback(() => {
    if (!projectId) return;
    const controller = beginStaticPreviewRead();
    if (typeof client.listSessionDevServers === 'function' && !devServersUnsupported.current) {
      void client
        .listSessionDevServers(sessionId, controller.signal)
        .then((servers) => {
          if (controller.signal.aborted) return;
          if (servers === null) devServersUnsupported.current = true;
          setHasRunningDevServer((servers ?? []).length > 0);
        })
        .catch(() => undefined);
    }
    // Shared means shared on the local network or online alike: either lights the
    // preview button. A failed read counts as "not shared" for that source only.
    const now = Date.now();
    const publicShared = client
      .listPublicPreviewShares(projectId, controller.signal)
      .then((shares) =>
        shares.some(
          (share) =>
            (share.targetKind === 'static-folder' ||
              (share.targetKind === 'dev-server' && share.devServerId === null)) &&
            share.sessionId === sessionId &&
            share.state === 'active' &&
            new Date(share.expiresAt).getTime() > now,
        ),
      )
      .catch(() => false);
    const localShared =
      typeof client.listSessionLocalPreviewShares === 'function'
        ? client
            .listSessionLocalPreviewShares(sessionId, controller.signal)
            .then((shares) => shares.some((share) => share.expiresAt.getTime() > now))
            .catch(() => false)
        : Promise.resolve(false);
    void Promise.all([publicShared, localShared]).then(([online, local]) => {
      if (!controller.signal.aborted) setHasActiveStaticPreview(online || local);
    });
  }, [client, projectId, sessionId, beginStaticPreviewRead]);
  useEffect(() => {
    if (!loaded) return;
    refreshStaticPreview();
    const detach = subscribeLiveRefresh(
      client,
      refreshStaticPreview,
      (path) =>
        (projectId != null &&
          path === `/projects/${encodeURIComponent(projectId)}/public-shares`) ||
        (path.startsWith(`/sessions/${encodeURIComponent(sessionId)}/`) &&
          /preview|share|dev-server/u.test(path)),
    );
    return () => {
      detach();
      beginStaticPreviewRead().abort();
    };
  }, [refreshStaticPreview, loaded, client, projectId, sessionId, beginStaticPreviewRead]);

  useEffect(() => {
    if (devServers !== undefined) setHasRunningDevServer(devServers.length > 0);
  }, [devServers]);

  return { managedByInstance, hasActiveStaticPreview, hasRunningDevServer, refreshStaticPreview };
}
