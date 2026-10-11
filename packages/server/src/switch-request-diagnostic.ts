/** Client-generated opaque tokens only; never infer identity from a request URL. */
export function switchRequestDiagnostic(
  method: string | undefined,
  url: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): { diagnosticRequestId: string; kind: 'session' | 'events' } | undefined {
  const id = headers['x-verity-switch-request'];
  const kind = headers['x-verity-switch-kind'];
  const path = (url ?? '').split('?', 1)[0];
  if (
    method !== 'GET' ||
    typeof id !== 'string' ||
    !/^[a-z0-9-]{1,80}$/.test(id) ||
    id.trim() !== id
  )
    return;
  if (kind === 'session' && /^\/sessions\/[^/]+$/.test(path ?? ''))
    return { diagnosticRequestId: id, kind };
  if (kind === 'events' && /^\/sessions\/[^/]+\/events$/.test(path ?? ''))
    return { diagnosticRequestId: id, kind };
}

/** Fixed-window budget holds constant memory regardless of peer input. */
export function createSwitchDiagnosticBudget(): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = performance.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      count = 0;
    }
    if (count >= 120) return false;
    count += 1;
    return true;
  };
}
