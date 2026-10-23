import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/** Observe only while visible, coalescing slow reads and discarding obsolete responses. */
export function useScanResource<T>(load: () => Promise<T>) {
  const [snapshot, setSnapshot] = useState<{ load: typeof load; value: T }>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true,
        running = false;
      const read = async () => {
        if (running) return;
        running = true;
        try {
          const value = await load();
          if (active) {
            setSnapshot({ load, value });
            setError(undefined);
          }
        } catch (e) {
          if (active)
            setError(e instanceof Error ? e.message : 'Could not load vulnerability scan.');
        } finally {
          running = false;
        }
      };
      void read();
      const timer = setInterval(() => void read(), 3000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [load, version]),
  );
  return {
    data: snapshot?.load === load ? snapshot.value : undefined,
    error,
    setError,
    reload: () => setVersion((v) => v + 1),
  };
}
