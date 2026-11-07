import type { VerityClient, WikiCatalog } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';

/** Long enough that moving between the Wiki's screens reads it once, short
 *  enough that a page Verity just maintained shows up on the next visit. */
const FRESH_MS = 30_000;

const cache = new Map<string, { at: number; read: Promise<WikiCatalog | null> }>();

/** Forget a project's catalog, so a saved edit shows in its lists. */
export function invalidateWikiCatalog(projectId: string): void {
  cache.delete(projectId);
}

function readCatalog(client: VerityClient, projectId: string, force: boolean) {
  const cached = cache.get(projectId);
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.read;
  // A client that throws instead of rejecting must still end in an error state.
  const read = Promise.resolve().then(() => client.getProjectWiki(projectId));
  cache.set(projectId, { at: Date.now(), read });
  // A failed read must not be served to the next screen.
  read.catch(() => {
    if (cache.get(projectId)?.read === read) cache.delete(projectId);
  });
  return read;
}

/**
 * A project Wiki's catalog: `undefined` while it loads, `null` from a server
 * without one (the Wiki is then a folder, as before). Shared libraries have no
 * catalog; pass `null` as the project for them.
 */
export function useWikiCatalog(client: VerityClient, projectId: string | null) {
  const [catalog, setCatalog] = useState<WikiCatalog | null>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (projectId === null) {
      setCatalog(null);
      return undefined;
    }
    let active = true;
    setError(undefined);
    readCatalog(client, projectId, attempt > 0).then(
      (next) => {
        if (active) setCatalog(next);
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Could not load the Wiki');
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { catalog, error, retry };
}
