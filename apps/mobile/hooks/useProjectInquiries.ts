import type { VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { pendingSession } from '../lib/pendingSessions';

/** Inquiry reads wait for creation and run only in a visible, foreground screen. */
export function useProjectInquiries(client: VerityClient, sessionId?: string, projectId?: string) {
  const source = useMemo(() => {
    const ready = sessionId === undefined ? undefined : pendingSession(sessionId);
    let flight: ReturnType<VerityClient['listProjectInquiries']> | undefined;
    return {
      ready,
      read: () => {
        flight ??= client.listProjectInquiries(sessionId, projectId).finally(() => {
          flight = undefined;
        });
        return flight;
      },
    };
  }, [client, sessionId, projectId]);
  type Snapshot = {
    source: typeof source;
    data?: Awaited<ReturnType<typeof source.read>>;
    error?: string;
  };
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const controls = useRef<
    { source: typeof source; reload: () => void; setError: (error: string) => void } | undefined
  >(undefined);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let foreground = AppState.currentState === 'active';
      let created = source.ready === undefined;
      let failed = false;
      let running = false;
      let queued = false;
      let generation = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      const read = async () => {
        if (!active || !foreground || !created || failed) return;
        if (running) {
          queued = true;
          return;
        }
        stopTimer();
        running = true;
        const owner = generation;
        try {
          const data = await source.read();
          if (active && foreground && generation === owner) setSnapshot({ source, data });
        } catch (error) {
          if (active && foreground && generation === owner) {
            // A completed decision may have requested a fresh read while this one ran.
            failed = !queued;
            setSnapshot((old) => ({
              source,
              data: old?.source === source ? old.data : undefined,
              error: error instanceof Error ? error.message : 'Could not load project requests.',
            }));
          }
        } finally {
          running = false;
          if (active && foreground && !failed) {
            if (queued) {
              queued = false;
              void read();
            } else
              timer = setTimeout(() => {
                void read();
              }, 60_000);
          }
        }
      };
      const control = {
        source,
        reload: () => {
          failed = false;
          void read();
        },
        setError: (error: string) => {
          failed = true;
          queued = false;
          generation++;
          stopTimer();
          setSnapshot((old) => ({
            source,
            data: old?.source === source ? old.data : undefined,
            error,
          }));
        },
      };
      controls.current = control;
      const subscription = AppState.addEventListener('change', (state) => {
        const next = state === 'active';
        if (next === foreground) return;
        foreground = next;
        generation++;
        stopTimer();
        if (foreground && !failed) void read();
      });
      if (source.ready !== undefined) {
        void source.ready.then(
          () => {
            created = true;
            void read();
          },
          () => {
            // Session creation owns its error; there is no resource to query.
          },
        );
      } else void read();
      return () => {
        active = false;
        stopTimer();
        subscription.remove();
        if (controls.current === control) controls.current = undefined;
      };
    }, [source]),
  );
  return {
    data: snapshot?.source === source ? snapshot.data : undefined,
    error: snapshot?.source === source ? snapshot.error : undefined,
    reload: () => {
      if (controls.current?.source === source) controls.current.reload();
    },
    setError: (error: string) => {
      if (controls.current?.source === source) controls.current.setError(error);
    },
  };
}
