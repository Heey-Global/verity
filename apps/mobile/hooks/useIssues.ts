import {
  type VerityClient,
  VerityApiError,
  type IssueSummary,
  subscribeIssuesChanged,
} from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseIssues {
  /** Open issues for the overview backlog (#137); empty until loaded / when GitHub
   * isn't configured server-side (the server 503s → the client maps it to `[]`). */
  issues: IssueSummary[];
  loading: boolean;
  /** A human-readable load error, or undefined. A 503 (GitHub not configured) is NOT
   * an error — it surfaces as an empty list so the section simply hides. */
  error: string | undefined;
  /** Re-fetch (pull-to-refresh / retry). */
  refresh: () => Promise<void>;
}

/**
 * One-shot loader for the repo's open GitHub issues. Unlike the live session list
 * (which polls), the backlog is fetched on mount and on explicit `refresh()` only —
 * it changes slowly, so polling would burn GitHub rate limit for little gain (a
 * focus-refresh is a possible follow-up). A StrictMode-safe mounted-guard drops a
 * late response after unmount.
 */
export function useIssues(client: VerityClient): UseIssues {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await client.listIssues();
      if (mounted.current && generation === loadGeneration.current) setIssues(next);
    } catch (caught) {
      if (mounted.current && generation === loadGeneration.current) {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load issues');
      }
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => subscribeIssuesChanged(() => void load()), [load]);

  return { issues, loading, error, refresh: load };
}
