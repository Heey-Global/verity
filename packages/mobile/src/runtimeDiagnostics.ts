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

export type MobileRuntimeSnapshot = Readonly<typeof counters>;

/** Cumulative totals since module load; gauges describe logical work, not sockets or GC. */
export function mobileRuntimeSnapshot(): MobileRuntimeSnapshot {
  return { ...counters };
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
export function beginRuntimeApiRequest(): (failed: boolean) => void {
  counters.inFlightApiRequests += 1;
  counters.apiRequestsStarted += 1;
  let ended = false;
  return (failed) => {
    if (ended) return;
    ended = true;
    counters.inFlightApiRequests -= 1;
    counters.apiRequestsSettled += 1;
    if (failed) counters.apiRequestFailures += 1;
  };
}
