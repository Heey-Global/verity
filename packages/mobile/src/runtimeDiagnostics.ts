/** Content-free process-local totals. No session IDs, URLs, or payloads are retained. */
const counters = {
  sessionStreamsCreated: 0,
  activeSessionSubscriptions: 0,
  sessionSubscriptionsStarted: 0,
  sessionEventsReceived: 0,
  sessionEventsAccepted: 0,
  inFlightApiRequests: 0,
  apiRequestsStarted: 0,
  apiRequestsSettled: 0,
  apiRequestFailures: 0,
};

export type RuntimeRequestGroup = 'overview' | 'preview' | 'session' | 'other';
const requestGroups: Record<
  RuntimeRequestGroup,
  { started: number; settled: number; failures: number; inFlight: number; peakInFlight: number }
> = {
  overview: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  preview: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  session: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  other: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
};
export type RuntimeOtherRequestGroup = 'google' | 'links' | 'models' | 'remaining';
const otherRequestGroups: Record<RuntimeOtherRequestGroup, (typeof requestGroups)['other']> = {
  google: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  links: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  models: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
  remaining: { started: 0, settled: 0, failures: 0, inFlight: 0, peakInFlight: 0 },
};

/** Fixed families only; no dynamic keys or request data survive classification. */
export function runtimeOtherRequestGroup(path: string): RuntimeOtherRequestGroup {
  const pathname = path.split('?')[0]!;
  if (
    /^\/google(?:\/|$)/.test(pathname) ||
    /^\/(?:sessions|projects)\/[^/]+\/(?:gmail|calendar|contacts|google-workspace)(?:\/|$)/.test(
      pathname,
    )
  )
    return 'google';
  if (/^\/sessions\/[^/]+\/(?:links|linked-message-approvals)(?:\/|$)/.test(pathname))
    return 'links';
  if (pathname === '/models') return 'models';
  return 'remaining';
}

let requestPeak = 0;

/** Classify locally; paths, query parameters and identifiers are never retained. */
export function runtimeRequestGroup(path: string, method: string): RuntimeRequestGroup {
  const pathname = path.split('?')[0]!;
  if (method !== 'GET') return 'other';
  if (/^\/(?:sessions|projects|provider-limits)$/.test(pathname)) return 'overview';
  if (
    /^\/(?:projects|sessions)\/[^/]+\/(?:public-shares|local-shares|dev-servers|managed-dev-servers)$/.test(
      pathname,
    )
  )
    return 'preview';
  if (/^\/sessions\/[^/]+(?:\/(?:events|activity|history\/v1))?$/.test(pathname)) return 'session';
  return 'other';
}

export type MobileRuntimeSnapshot = ReturnType<typeof mobileRuntimeSnapshot>;

/** Totals since module load; optional peak reset starts a new sampling interval. */
export function mobileRuntimeSnapshot(resetRequestPeaks = false) {
  const groups = {
    overview: { ...requestGroups.overview },
    preview: { ...requestGroups.preview },
    session: { ...requestGroups.session },
    other: { ...requestGroups.other },
  };
  const apiOtherRequestGroups = {
    google: { ...otherRequestGroups.google },
    links: { ...otherRequestGroups.links },
    models: { ...otherRequestGroups.models },
    remaining: { ...otherRequestGroups.remaining },
  };
  const snapshot = {
    apiOtherRequestGroups,
    ...counters,
    apiRequestGroups: groups,
    apiRequestPeakInFlight: requestPeak,
  };
  if (resetRequestPeaks) {
    requestPeak = counters.inFlightApiRequests;
    for (const group of [...Object.values(requestGroups), ...Object.values(otherRequestGroups)])
      group.peakInFlight = group.inFlight;
  }
  return snapshot;
}

export function recordSessionStreamCreated(): void {
  counters.sessionStreamsCreated += 1;
}

/** Includes reconnecting subscriptions; excludes paused, ended, and stopped streams. */
export function beginRuntimeSubscription(): () => void {
  counters.activeSessionSubscriptions += 1;
  counters.sessionSubscriptionsStarted += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    counters.activeSessionSubscriptions -= 1;
  };
}

/** Socket delivery includes replay and duplicate frames, but excludes REST history. */
export function recordRuntimeSessionEvent(accepted: boolean): void {
  counters.sessionEventsReceived += 1;
  if (accepted) counters.sessionEventsAccepted += 1;
}

/** Fetch invocation through response headers/error, excluding response-body processing. */
export function beginRuntimeApiRequest(
  groupName: RuntimeRequestGroup = 'other',
  otherGroupName: RuntimeOtherRequestGroup = 'remaining',
): (failed: boolean) => void {
  counters.inFlightApiRequests += 1;
  counters.apiRequestsStarted += 1;
  requestPeak = Math.max(requestPeak, counters.inFlightApiRequests);
  const group = requestGroups[groupName];
  const subgroup = groupName === 'other' ? otherRequestGroups[otherGroupName] : undefined;
  for (const entry of subgroup ? [group, subgroup] : [group]) {
    entry.started++;
    entry.inFlight++;
    entry.peakInFlight = Math.max(entry.peakInFlight, entry.inFlight);
  }
  let ended = false;
  return (failed) => {
    if (ended) return;
    ended = true;
    counters.inFlightApiRequests -= 1;
    counters.apiRequestsSettled += 1;
    for (const entry of subgroup ? [group, subgroup] : [group]) {
      entry.inFlight--;
      entry.settled++;
      if (failed) entry.failures++;
    }
    if (failed) counters.apiRequestFailures += 1;
  };
}
