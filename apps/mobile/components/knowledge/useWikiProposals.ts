import type { VerityClient, WikiProposalSummary } from '@verity/mobile';
import { useEffect, useState } from 'react';

/** Mounted screens of a project, told when its proposals were decided. */
const listeners = new Map<string, Set<() => void>>();

/** Have every screen showing a project's proposals read them again. */
export function invalidateWikiProposals(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

/**
 * A project's proposed Wiki changes waiting for review: `undefined` while they
 * load or when they cannot be read, `null` from a server without proposals.
 * A failure leaves the start page as it was; proposals are an addition to it.
 */
export function useWikiProposals(
  client: VerityClient,
  projectId: string | null,
): WikiProposalSummary[] | null | undefined {
  const [state, setState] = useState<{
    key: string | null;
    client: VerityClient | null;
    proposals: WikiProposalSummary[] | null | undefined;
  }>({ key: null, client: null, proposals: undefined });
  const [attempt, setAttempt] = useState(0);
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
    Promise.resolve()
      .then(() => client.listWikiProposals(projectId))
      .then(
        (proposals) => {
          if (active) setState({ key: projectId, client, proposals });
        },
        () => {
          if (active) setState({ key: projectId, client, proposals: undefined });
        },
      );
    return () => {
      active = false;
    };
  }, [client, projectId, attempt]);
  if (projectId === null || state.key !== projectId || state.client !== client) return undefined;
  return state.proposals;
}
