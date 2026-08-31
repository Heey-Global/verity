/**
 * Readiness probe entrypoint (ADR 0008, in-place cutover addendum).
 *
 * The Updater runs with `network_mode: none` — deliberately, so a compromised
 * Updater cannot reach the control plane or the internet even though it holds
 * the Docker socket. That leaves it unable to ask a freshly activated Server
 * whether it came up. This entrypoint closes the gap the only way the topology
 * allows: the Updater starts a throwaway container from the SAME image on
 * `verity-net`, which polls the Server's unauthenticated `/healthz` and exits
 * 0 or 1. The verdict crosses the network boundary as an exit code.
 */

/**
 * Where the probe looks by default: the managed Server's own service name on
 * `verity-net`, at the port the official image bakes in (`ENV PORT=8082`).
 */
export const DEFAULT_READINESS_PROBE_URL = 'http://verity-managed-server:8082/healthz';
export const READINESS_PROBE_URL_ENV = 'VERITY_READINESS_PROBE_URL';
export const READINESS_PROBE_TIMEOUT_ENV = 'VERITY_READINESS_PROBE_TIMEOUT_MS';
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export interface ReadinessProbeOptions {
  /** Defaults to the managed Server's health endpoint on `verity-net`. */
  readonly url?: string | undefined;
  /** Overall budget; the probe keeps retrying until it expires. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReadinessProbeResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly detail: string;
}

/**
 * Validate the endpoint this probe is pointed at.
 *
 * The Updater builds the argument, not a device, so this is not the security
 * boundary — but the probe container sits on `verity-net` with no other reason
 * to speak, and a typo that silently probed some other host would report a
 * healthy update that never happened. Narrow beats forgiving here.
 */
export function parseReadinessProbeUrl(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_READINESS_PROBE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('readiness probe URL is not a URL');
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/healthz' ||
    !HOSTNAME.test(url.hostname)
  )
    throw new Error('readiness probe URL must be a plain http /healthz endpoint');
  return url.toString();
}

/**
 * Whether a `/healthz` answer means "this Server is serving".
 *
 * A `degraded` 503 counts. That endpoint reports 503 when an OPTIONAL runtime
 * dependency (the secret-job sandbox) is unavailable — a condition the previous
 * generation would have reported identically, and one an update neither caused
 * nor can fix. Treating it as failure would roll back every update on such a
 * host. What the probe is actually asking is narrower: did this image boot and
 * start answering HTTP with the shape a Verity Server answers with.
 */
function healthy(status: number, body: unknown): boolean {
  if (status !== 200 && status !== 503) return false;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.version === 'string' && (record.status === 'ok' || record.status === 'degraded')
  );
}

/**
 * The probe's configuration as the Updater passes it: through the container's
 * environment, because a one-shot container is the whole interface.
 */
export function readinessProbeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadinessProbeOptions {
  const url = parseReadinessProbeUrl(environment[READINESS_PROBE_URL_ENV]);
  const raw = environment[READINESS_PROBE_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return { url };
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
    throw new Error(`${READINESS_PROBE_TIMEOUT_ENV} must be between 1000 and 600000`);
  return { url, timeoutMs };
}

/** Deliberately NOT `unref`'d. This is a one-shot process whose only pending
 *  work between attempts is this timer: unreferencing it lets Node run out of
 *  handles and exit — status 0, the code that means "ready" — while the Server
 *  it was asked about is still not answering. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runReadinessProbe(
  options: ReadinessProbeOptions = {},
): Promise<ReadinessProbeResult> {
  const url = parseReadinessProbeUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? wait;
  const doFetch = options.fetch ?? globalThis.fetch;
  const deadline = now() + timeoutMs;
  const attempt = async (remainingMs: number): Promise<{ ok: boolean; detail: string }> => {
    try {
      const response = await doFetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
        headers: { accept: 'application/json' },
      });
      const body: unknown = await response.json();
      if (healthy(response.status, body))
        return {
          ok: true,
          detail: `serving version ${String((body as { version: string }).version)}`,
        };
      return { ok: false, detail: `unhealthy response: HTTP ${String(response.status)}` };
    } catch (error) {
      return { ok: false, detail: `request failed: ${(error as Error).message}` };
    }
  };
  let attempts = 0;
  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { ok: false, attempts, detail: 'readiness deadline expired' };
    attempts += 1;
    const outcome = await attempt(remainingMs);
    if (outcome.ok) return { ok: true, attempts, detail: outcome.detail };
    // A restarting container refuses connections for a while; only the overall
    // budget decides when that stops being "not yet" and becomes "not at all".
    const remainingAfterAttempt = deadline - now();
    if (remainingAfterAttempt <= intervalMs) return { ok: false, attempts, detail: outcome.detail };
    await sleep(Math.min(intervalMs, remainingAfterAttempt));
  }
}
