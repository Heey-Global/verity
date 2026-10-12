import { useEffect, useState, type ReactNode } from 'react';

/** Key this boundary by session identity so an obsolete mount cannot win a switch. */
export function DeferredSessionPane({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // A single frame callback runs before drawing. Leave a frame opportunity for
    // selection feedback before mounting the chat; this is not a paint guarantee.
    let frame = requestAnimationFrame(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);
  return ready ? children : fallback;
}
