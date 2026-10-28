/**
 * Reading the Docker Engine's `POST /images/create` progress stream.
 *
 * The Engine answers a pull with HTTP 200 and a stream of newline-delimited JSON
 * objects. The ones that matter here look like
 *
 *   {"status":"Pulling fs layer","progressDetail":{},"id":"3f4e…"}
 *   {"status":"Downloading","progressDetail":{"current":1048576,"total":916000000},"id":"3f4e…"}
 *   {"status":"Download complete","progressDetail":{},"id":"3f4e…"}
 *   {"status":"Extracting","progressDetail":{"current":…,"total":…},"id":"3f4e…"}
 *   {"status":"Pull complete","progressDetail":{},"id":"3f4e…"}
 *   {"status":"Digest: sha256:…"}
 *
 * {@link PullProgressTracker} turns that stream into the one question the pull
 * watchdog asks — "did this line move the pull forward?" — and into a byte
 * summary for the progress log.
 *
 * "A line arrived" is deliberately NOT progress. With the containerd image store
 * (`io.containerd.snapshotter.v1`) the daemon polls the content store every 100 ms
 * and re-emits a `Downloading` line for every active layer whether or not its
 * offset moved (moby `daemon/containerd/progress.go`), so a dead registry
 * connection still produces a steady stream of identical lines. Only a layer
 * reaching a new state, or a byte counter passing its previous high-water mark,
 * counts.
 */

/** One parsed line of the pull stream; every field is optional on the wire. */
export interface PullStreamEvent {
  readonly id?: string;
  readonly status?: string;
  readonly progressDetail?: { readonly current?: number; readonly total?: number };
  readonly error?: string;
  readonly errorDetail?: { readonly message?: string };
}

/** Aggregate pull state for the progress log. */
export interface PullProgressSummary {
  /** Layers the stream has named so far. */
  readonly layers: number;
  /** Layers whose bytes are on the host (downloaded, extracted or already present). */
  readonly layersDownloaded: number;
  /** Bytes received across layers whose size the stream has reported. */
  readonly bytesDone: number;
  /** Sum of the reported layer sizes. Grows as layers start downloading; layers
   *  that already existed on the host report no size and are not counted. */
  readonly bytesTotal: number;
}

interface LayerState {
  status: string;
  /** High-water mark of `progressDetail.current` within the current status. */
  current: number;
  /** Compressed download size, once a `Downloading` line has reported it. */
  downloadTotal: number | undefined;
  /** Bytes downloaded so far (the `Downloading` counter). */
  downloaded: number;
  /** The layer's bytes are on the host; what is left is local work. */
  settled: boolean;
  /** A retry countdown ran; the next attempt's counter starts a new epoch. */
  retrying: boolean;
}

/**
 * States after which a layer needs nothing more from the network. `Verifying
 * Checksum` and `Extracting` are local work on bytes already received.
 */
const SETTLED_STATUSES = new Set([
  'Verifying Checksum',
  'Download complete',
  'Extracting',
  'Pull complete',
  'Already exists',
]);

/** Statuses that mean "the bytes were fetched" for the layer count. */
const DOWNLOADED_STATUSES = new Set(['Download complete', 'Extracting', 'Pull complete']);

/**
 * The classic store's own per-layer retry counts down once a second
 * ("Retrying in 5 seconds", "Retrying in 4 seconds", …). Each line is a new
 * status, but none of them is the pull getting anywhere.
 */
const RETRY_COUNTDOWN = /^Retrying in \d+ seconds?$/;

export class PullProgressTracker {
  private readonly layers = new Map<string, LayerState>();
  private readonly messages = new Set<string>();

  /**
   * Feed one stream event. Returns true when it is forward progress: a layer or
   * stream-level message seen for the first time, a layer entering a new state,
   * or a byte counter rising above its previous high-water mark.
   */
  observe(event: PullStreamEvent): boolean {
    const status = typeof event.status === 'string' ? event.status : undefined;
    if (status === undefined) return false;
    const id = typeof event.id === 'string' && event.id !== '' ? event.id : undefined;
    const current = finiteNonNegative(event.progressDetail?.current);
    const total = finiteNonNegative(event.progressDetail?.total);
    if (id === undefined) {
      // "Pulling from …", "Digest: …", "Status: …": each appears once per pull.
      if (this.messages.has(status)) return false;
      this.messages.add(status);
      return true;
    }
    // A message keyed by the tag ("Pulling from x" carries `id: <tag>`) is not a
    // layer; it never reaches a settled state and must not hold the watchdog.
    if (status.startsWith('Pulling from ')) {
      const key = `${id}\u0000${status}`;
      if (this.messages.has(key)) return false;
      this.messages.add(key);
      return true;
    }
    let layer = this.layers.get(id);
    if (RETRY_COUNTDOWN.test(status)) {
      // The retried attempt restarts its counter, possibly below the previous
      // high-water mark; comparing against that mark would read a healthy
      // retry as a stall. The countdown itself is still not progress.
      if (layer !== undefined) layer.retrying = true;
      return false;
    }
    if (layer?.retrying === true) {
      layer.retrying = false;
      layer.status = status;
      layer.current = 0;
      this.apply(layer, status, current, total);
      return true;
    }
    if (layer === undefined) {
      layer = {
        status,
        current: 0,
        downloadTotal: undefined,
        downloaded: 0,
        settled: false,
        retrying: false,
      };
      this.layers.set(id, layer);
      this.apply(layer, status, current, total);
      return true;
    }
    if (layer.status !== status) {
      layer.status = status;
      layer.current = 0;
      this.apply(layer, status, current, total);
      return true;
    }
    if (current !== undefined && current > layer.current) {
      this.apply(layer, status, current, total);
      return true;
    }
    return false;
  }

  /**
   * True while some layer still needs bytes from the registry, or before the
   * stream has named any layer (manifest resolution). Once every known layer is
   * settled the remaining work — extraction, snapshot unpacking — is local, and
   * the containerd image store reports none of it: it unpacks a layer with no
   * progress lines at all, which for a large layer on a slow disk can take
   * minutes. A network idle timeout must not fire there.
   */
  get awaitingNetwork(): boolean {
    if (this.layers.size === 0) return true;
    for (const layer of this.layers.values()) if (!layer.settled) return true;
    return false;
  }

  summary(): PullProgressSummary {
    let layersDownloaded = 0;
    let bytesDone = 0;
    let bytesTotal = 0;
    for (const layer of this.layers.values()) {
      if (layer.settled) layersDownloaded += 1;
      if (layer.downloadTotal !== undefined) {
        bytesTotal += layer.downloadTotal;
        bytesDone += layer.settled
          ? layer.downloadTotal
          : Math.min(layer.downloaded, layer.downloadTotal);
      }
    }
    return { layers: this.layers.size, layersDownloaded, bytesDone, bytesTotal };
  }

  private apply(
    layer: LayerState,
    status: string,
    current: number | undefined,
    total: number | undefined,
  ): void {
    if (current !== undefined) layer.current = Math.max(layer.current, current);
    if (status === 'Downloading') {
      if (total !== undefined && total > 0) layer.downloadTotal = total;
      if (current !== undefined) layer.downloaded = Math.max(layer.downloaded, current);
    }
    if (SETTLED_STATUSES.has(status)) layer.settled = true;
    if (DOWNLOADED_STATUSES.has(status) && layer.downloadTotal !== undefined)
      layer.downloaded = layer.downloadTotal;
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** `1536` → `1.5 KB`; decimal units, as `docker pull` prints them. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${String(bytes)} B` : `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/** One human-readable progress line, e.g. for the Updater's log. */
export function describePullProgress(summary: PullProgressSummary): string {
  return (
    `${formatBytes(summary.bytesDone)} of ${formatBytes(summary.bytesTotal)} downloaded, ` +
    `${String(summary.layersDownloaded)}/${String(summary.layers)} layers on disk`
  );
}

/**
 * Split a growing NDJSON buffer into complete lines. Returns the parsed events
 * of every complete line and the unterminated remainder to carry into the next
 * chunk. Non-JSON lines are skipped, as the Engine never sends them on this
 * endpoint and a stray one must not fail an otherwise healthy pull.
 */
export function drainPullStreamLines(buffer: string): {
  events: PullStreamEvent[];
  rest: string;
} {
  const events: PullStreamEvent[] = [];
  let start = 0;
  for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n', start)) {
    const event = parsePullStreamLine(buffer.slice(start, newline));
    if (event !== undefined) events.push(event);
    start = newline + 1;
  }
  return { events, rest: buffer.slice(start) };
}

export function parsePullStreamLine(rawLine: string): PullStreamEvent | undefined {
  const line = rawLine.trim();
  if (line === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** The in-stream failure an event carries, if any (see `findPullStreamError`). */
export function pullStreamEventError(event: PullStreamEvent): string | undefined {
  if (!('error' in event)) return undefined;
  if (typeof event.error === 'string' && event.error !== '') return event.error;
  const detail = event.errorDetail?.message;
  if (typeof detail === 'string' && detail !== '') return detail;
  return 'image pull failed';
}
