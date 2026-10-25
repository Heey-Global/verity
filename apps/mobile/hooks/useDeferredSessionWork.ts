import { useEffect, useState } from 'react';

/** Give initial history a frame opportunity before starting optional controllers. */
export function useDeferredSessionWork(sessionId: string, ready: boolean): boolean {
  const [admission, setAdmission] = useState({ sessionId, admitted: false });
  if (admission.sessionId !== sessionId) setAdmission({ sessionId, admitted: false });
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let frame = requestAnimationFrame(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        if (!cancelled) setAdmission({ sessionId, admitted: true });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [ready, sessionId]);
  return ready && admission.sessionId === sessionId && admission.admitted;
}
