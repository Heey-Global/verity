/** Content-free, bounded timings. No work is collected without an explicit row gesture. */
export type SwitchTiming = {
  id: string;
  sessionId: string;
  kind: 'session' | 'permission';
  started: number;
  recorded: number;
  at: number;
  phases: { phase: string; elapsedMs: number; value?: number }[];
  status: 'active' | 'superseded' | 'cancelled';
};
const budgets = new WeakMap<
  SwitchTiming,
  { metrics: number; lifecycle: number; dropped: number }
>();
let current: SwitchTiming | undefined;
let sequence = 0;
const retained: SwitchTiming[] = [];
const now = (): number => performance.now();

export function beginSessionSwitch(
  sessionId: string,
  kind: SwitchTiming['kind'] = 'session',
): SwitchTiming {
  if (current?.status === 'active') current.status = 'superseded';
  current = {
    id: `${Date.now().toString(36)}-${++sequence}`,
    sessionId,
    kind,
    started: now(),
    phases: [],
    recorded: 0,
    at: Date.now(),
    status: 'active',
  };
  retained.push(current);
  if (retained.length > 8) retained.shift();
  return current;
}

export function sessionSwitchTiming(
  sessionId: string,
  kind: SwitchTiming['kind'] = 'session',
): SwitchTiming | undefined {
  return current?.sessionId === sessionId &&
    current.status === 'active' &&
    current.kind === kind &&
    now() - current.started < 30_000
    ? current
    : undefined;
}

export function markSessionSwitch(
  trace: SwitchTiming | undefined,
  phase: string,
  value?: number,
): void {
  if (!trace || trace !== current || trace.status !== 'active') return;
  // Aggregates must not consume the slots needed to explain readiness.
  const metric = /^(render-|activity-|js-timer-|ui-frame-)/.test(phase);
  const budget = budgets.get(trace) ?? { metrics: 0, lifecycle: 0, dropped: 0 };
  const category = metric ? 'metrics' : 'lifecycle';
  if (budget[category] >= 64) {
    budget.dropped++;
    budgets.set(trace, budget);
    return;
  }
  const elapsedMs = now() - trace.started;
  if (elapsedMs >= 30_000) return;
  budget[category]++;
  budgets.set(trace, budget);
  trace.recorded++;
  trace.phases.push({
    phase: phase.slice(0, 64),
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
  });
}

/** Export copies only timing metadata, never session identities or transcript content. */
export function exportSessionSwitchTimings(): {
  switchId: string;
  kind: SwitchTiming['kind'];
  at: number;
  status: string;
  droppedPhases: number;
  readiness: 'list-loaded' | 'not-recorded';
  transportRequests: SwitchTransportRequest[];
  transportOmissions: { requests: number; phases: number };
  phases: SwitchTiming['phases'];
}[] {
  return retained.map((trace) => ({
    switchId: trace.id,
    kind: trace.kind,
    at: trace.at,
    status: trace.status === 'active' && now() - trace.started >= 30_000 ? 'expired' : trace.status,
    droppedPhases: budgets.get(trace)?.dropped ?? 0,
    readiness: trace.phases.some((p) => p.phase === 'flash-list-on-load')
      ? 'list-loaded'
      : 'not-recorded',
    transportOmissions: { ...(transportOmissions.get(trace) ?? { requests: 0, phases: 0 }) },
    transportRequests: (transportRequests.get(trace) ?? []).map((request) => ({
      ...request,
      phases: request.phases.map((phase) => ({ ...phase })),
    })),
    phases: trace.phases.map((phase) => ({ ...phase })),
  }));
}

export function cancelSessionSwitch(sessionId: string): void {
  const trace = sessionSwitchTiming(sessionId);
  markSessionSwitch(trace, 'touch-cancel');
  if (trace) trace.status = 'cancelled';
}

export type SwitchTransportPhase =
  | 'fetch-dispatch'
  | 'pinned-entry'
  | 'body-encoded'
  | 'route-ready'
  | 'lane-admitted'
  | 'native-dispatch'
  | 'native-return'
  | 'native-error'
  | 'fetch-return'
  | 'fetch-error';
export type SwitchTransportRequest = {
  requestId: string;
  kind: 'events' | 'session';
  phases: { phase: SwitchTransportPhase; elapsedMs: number; value?: number }[];
};
const transportRequests = new WeakMap<SwitchTiming, SwitchTransportRequest[]>();
const transportOmissions = new WeakMap<SwitchTiming, { requests: number; phases: number }>();

/** Opaque per-attempt correlation; never encodes the session or request URL. */
export function beginSwitchTransportRequest(
  trace: SwitchTiming | undefined,
  kind: SwitchTransportRequest['kind'],
): string | undefined {
  if (!trace || sessionSwitchTiming(trace.sessionId) !== trace) return;
  const requests = transportRequests.get(trace) ?? [];
  if (requests.length >= 16) {
    const omitted = transportOmissions.get(trace) ?? { requests: 0, phases: 0 };
    omitted.requests++;
    transportOmissions.set(trace, omitted);
    return;
  }
  const requestId = `${trace.id}-r${requests.length + 1}`;
  requests.push({ requestId, kind, phases: [] });
  transportRequests.set(trace, requests);
  markSwitchTransportRequest(requestId, 'fetch-dispatch');
  return requestId;
}

/** Late results remain on their original trace, never on a replacement gesture. */
export function markSwitchTransportRequest(
  requestId: string | undefined,
  phase: SwitchTransportPhase,
  value?: number,
): void {
  if (!requestId) return;
  for (const trace of retained) {
    const request = transportRequests.get(trace)?.find((entry) => entry.requestId === requestId);
    if (!request || now() - trace.started >= 30_000) continue;
    if (request.phases.length >= 24) {
      const omitted = transportOmissions.get(trace) ?? { requests: 0, phases: 0 };
      omitted.phases++;
      transportOmissions.set(trace, omitted);
      return;
    }
    request.phases.push({
      phase,
      elapsedMs: Math.round((now() - trace.started) * 10) / 10,
      ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
    });
    return;
  }
}
