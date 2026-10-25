import { gestureDiagnosticsEnabled } from './gestureDiagnostics';

// Shared across panes: diagnostics must not build a backlog during slow requests.
let inFlight = false;
let nextAllowedAt = 0;

/** Drop diagnostic events outside recording, during a request, or within one second. */
export function reportRecordedScrollDiagnostic(send: () => Promise<void>): void {
  if (!gestureDiagnosticsEnabled() || inFlight) return;
  const now = performance.now();
  if (now < nextAllowedAt) return;
  nextAllowedAt = now + 1_000;
  inFlight = true;
  void (async () => {
    try {
      await send();
    } catch {
      // Diagnostic failures must never interrupt scrolling or trigger retries.
    } finally {
      inFlight = false;
    }
  })();
}
