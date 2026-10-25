import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { VerityClient, SessionGoogleStatus } from '@verity/mobile';
import { subscribeLiveRefresh } from '../lib/liveConnection';

/** Seed visible grants from detail; compatibility reads never fetch the account catalog. */
export function useSessionGoogleStatus(
  client: VerityClient,
  sessionId: string,
  summary: SessionGoogleStatus | undefined,
  detailLoaded: boolean,
  ready: boolean,
) {
  const [status, setStatus] = useState<SessionGoogleStatus | undefined>(summary);
  const [identity, setIdentity] = useState({ client, sessionId });
  const generation = useRef(0);
  const focused = useRef(false);
  const owner = useRef({ client, sessionId });
  owner.current = { client, sessionId };
  const seeded = useRef(summary !== undefined);
  if (identity.client !== client || identity.sessionId !== sessionId) {
    generation.current++;
    seeded.current = summary !== undefined;
    setIdentity({ client, sessionId });
    setStatus(summary);
  }
  // Actions may start before detail/history readiness, so their lifetime must
  // follow focus independently of the deferred read subscription below.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        generation.current++;
      };
    }, [client, sessionId]),
  );
  useEffect(() => {
    if (summary && !seeded.current) {
      seeded.current = true;
      setStatus(summary);
    }
  }, [summary]);
  const read = useCallback(
    async (signal: AbortSignal) => {
      const version = generation.current;
      const fresh = () => !signal.aborted && version === generation.current;
      if (summary) {
        const current = await client.getSessionGoogleStatus(sessionId, signal);
        if (fresh()) setStatus(current);
        return;
      }
      const gmail = await client.getSessionGmailConnection(sessionId, signal);
      if (!fresh()) return;
      const calendar = await client.getSessionCalendarConnection(sessionId, signal);
      if (!fresh()) return;
      const contacts = await client.getSessionContactsConnection(sessionId, signal);
      if (!fresh()) return;
      const workspaceFile = await client.getSessionGoogleWorkspaceFile(sessionId, signal);
      if (fresh()) setStatus({ gmail, calendar, contacts, workspaceFile });
    },
    [client, sessionId, Boolean(summary)],
  );
  useFocusEffect(
    useCallback(() => {
      if (!detailLoaded || !ready) return;
      const controller = new AbortController();
      if (!summary) {
        void read(controller.signal).catch(() => undefined);
        return () => controller.abort();
      }
      const path = `/sessions/${encodeURIComponent(sessionId)}/google-status`;
      const detach = subscribeLiveRefresh(
        client,
        () => read(controller.signal),
        (observed) => observed === path,
        summary ? [{ path }] : [],
        { initial: !summary },
      );
      return () => {
        controller.abort();
        detach();
      };
    }, [client, sessionId, detailLoaded, ready, Boolean(summary), read]),
  );
  const invalidate = useCallback(() => {
    if (
      !focused.current ||
      owner.current.client !== client ||
      owner.current.sessionId !== sessionId
    )
      return () => false;
    generation.current++;
    // Local mutation results must win over the initial detail arriving late.
    seeded.current = true;
    const version = generation.current;
    return () => focused.current && version === generation.current;
  }, [client, sessionId]);
  return { status, invalidate };
}
