import type { VerityClient, WikiCatalog } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';

/** Long enough that moving between the Wiki's screens reads it once, short
 *  enough that a page Verity just maintained shows up on the next visit. */
const FRESH_MS = 30_000;

/** One read per project, remembered with the client it came from: another
 *  server can hold a project with the same id. */
const cache = new Map<
  string,
  { client: VerityClient; at: number; read: Promise<WikiCatalog | null> }
>();
/** Mounted screens of a project, told when its catalog is stale. */
const listeners = new Map<string, Set<() => void>>();

/**
 * Forget a project's catalog after a change to its Wiki, and have every screen
 * showing it read it again — the lists under an edited page as well as the page.
 */
export function invalidateWikiCatalog(projectId: string): void {
  cache.delete(projectId);
  for (const listener of listeners.get(projectId) ?? []) listener();
}

function readCatalog(client: VerityClient, projectId: string) {
  const cached = cache.get(projectId);
  if (cached && cached.client === client && Date.now() - cached.at < FRESH_MS) return cached.read;
  // A client that throws instead of rejecting must still end in an error state.
  const read = Promise.resolve().then(() => client.getProjectWiki(projectId));
  cache.set(projectId, { client, at: Date.now(), read });
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
  const [state, setState] = useState<{
    key: string | null;
    client: VerityClient | null;
    catalog: WikiCatalog | null | undefined;
    error?: string;
  }>({ key: null, client: null, catalog: undefined });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    if (projectId === null) return;
    cache.delete(projectId);
    // Loading again, not still failed: the error gives way to the spinner.
    setState({ key: projectId, client, catalog: undefined });
    setAttempt((value) => value + 1);
  }, [client, projectId]);
  useEffect(() => {
    if (projectId === null) return undefined;
    const subscribers = listeners.get(projectId) ?? new Set<() => void>();
    const refresh = () => setAttempt((value) => value + 1);
    subscribers.add(refresh);
    listeners.set(projectId, subscribers);
    return () => {
      subscribers.delete(refresh);
      if (!subscribers.size && listeners.get(projectId) === subscribers)
        listeners.delete(projectId);
    };
  }, [projectId]);
  useEffect(() => {
    if (projectId === null) return undefined;
    let active = true;
    readCatalog(client, projectId).then(
      (catalog) => {
        if (active) setState({ key: projectId, client, catalog });
      },
      (failure: unknown) => {
        if (active)
          setState({
            key: projectId,
            client,
            catalog: undefined,
            // A reply the app cannot read says nothing useful in its own words.
            error:
              failure instanceof Error && failure.name !== 'ZodError'
                ? failure.message
                : 'Could not load the Wiki',
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, attempt]);
  if (projectId === null) return { catalog: null, error: undefined, retry };
  // Another project's catalog, or another server's, still in state until this
  // one arrives, is not shown.
  if (state.key !== projectId || state.client !== client)
    return { catalog: undefined, error: undefined, retry };
  return { catalog: state.catalog, error: state.error, retry };
}
