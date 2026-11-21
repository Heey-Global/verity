import type { ProjectQAState, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A project's QA role: its issues, sources and the sessions it works in.
 * `undefined` until the first answer; a failed refresh keeps the last state.
 * `revision` reloads it whenever the project record changes.
 */
export function useProjectQA(
  client: VerityClient | null,
  projectId: string,
  enabled: boolean,
  revision?: unknown,
): {
  state: ProjectQAState | undefined;
  error: string | undefined;
  reload: () => Promise<void>;
  setState: (state: ProjectQAState) => void;
} {
  const [state, setState] = useState<ProjectQAState>();
  const [error, setError] = useState<string>();
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled || !client) return;
    const request = ++latest.current;
    try {
      const next = await client.projectQA.state(projectId);
      if (request !== latest.current) return;
      setState(next);
      setError(undefined);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(caught instanceof Error ? caught.message : 'Could not load QA');
    }
  }, [client, projectId, enabled]);
  useEffect(() => {
    setState(undefined);
    setError(undefined);
  }, [projectId]);
  useEffect(() => {
    void reload();
  }, [reload, revision]);
  return { state, error, reload, setState };
}
