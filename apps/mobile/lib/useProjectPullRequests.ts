import type { RepositoryPullRequests, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A project's repositories with their open pull requests. `undefined` until the
 * first answer; an error keeps the last list, so a failed refresh does not empty it.
 */
export function useProjectPullRequests(
  client: VerityClient,
  projectId: string,
  enabled = true,
): {
  repositories: RepositoryPullRequests[] | undefined;
  error: string | undefined;
  reload: (refresh?: boolean) => Promise<void>;
} {
  const [repositories, setRepositories] = useState<RepositoryPullRequests[]>();
  const [error, setError] = useState<string>();
  // Only the latest request may write: a slow first answer must not replace a newer one.
  const latest = useRef(0);
  const reload = useCallback(
    async (refresh = false) => {
      if (!enabled) return;
      const request = ++latest.current;
      try {
        const next = await client.getProjectPullRequests(projectId, { refresh });
        if (request !== latest.current) return;
        setRepositories(next);
        setError(undefined);
      } catch (caught) {
        if (request !== latest.current) return;
        setError(caught instanceof Error ? caught.message : 'Could not load pull requests');
      }
    },
    [client, projectId, enabled],
  );
  useEffect(() => {
    // Another project's list must not stay actionable under this project's id.
    setRepositories(undefined);
    setError(undefined);
    void reload();
  }, [reload]);
  return { repositories, error, reload };
}
