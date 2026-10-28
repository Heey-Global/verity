import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDockerClient,
  DEFAULT_PULL_IDLE_TIMEOUT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  type DockerClientOptions,
} from './docker.js';
import { PullProgressTracker } from './docker-pull-progress.js';
import type { HttpFetch, HttpResponse } from './github.js';

/**
 * The pull watchdogs (see `pullImage` in docker.ts). The production failure
 * these exist for: a Server update whose pull was making steady progress at
 * 0.67 MB/s was cut off by a fixed 300 s budget on every attempt and reported
 * as a `network` failure, so it could never install and never said why.
 */

const IMAGE = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const MB = 1_000_000;

/** A pull response whose body the test writes line by line. */
function controlledPull() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const signals: AbortSignal[] = [];
  const fetch: HttpFetch = async (_url, init) => {
    if (init?.signal !== undefined) signals.push(init.signal);
    const response: HttpResponse = { ok: true, status: 200, json: async () => ({}), body };
    return response;
  };
  return {
    fetch,
    signals,
    emit: (event: object) => {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    end: () => {
      controller.close();
    },
  };
}

const client = (fetch: HttpFetch, options: Partial<DockerClientOptions> = {}) =>
  createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch, ...options });

/** Settle `promise` into an inspectable state without letting it reject unhandled. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

describe('DockerClient.pullImage watchdogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a pull whose stream stops moving as pull_stalled, not network', async () => {
    const pull = controlledPull();
    const result = track(client(pull.fetch).pullImage!(IMAGE));
    pull.emit({ status: 'Pulling fs layer', progressDetail: {}, id: 'layer1' });
    pull.emit({
      status: 'Downloading',
      progressDetail: { current: 5 * MB, total: 916 * MB },
      id: 'layer1',
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_PULL_IDLE_TIMEOUT_MS - 1);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.error).toMatchObject({
      kind: 'pull_stalled',
      image: IMAGE,
      payload: { idleMs: DEFAULT_PULL_IDLE_TIMEOUT_MS },
    });
    // The transport is told to stop, so the daemon cancels its side of the pull.
    expect(pull.signals[0]?.aborted).toBe(true);
  });

  it('keeps a slow pull alive for as long as its byte counters keep rising', async () => {
    const pull = controlledPull();
    const result = track(client(pull.fetch).pullImage!(IMAGE));
    pull.emit({ status: 'Pulling fs layer', progressDetail: {}, id: 'layer1' });
    // 916 MB at the incident host's 0.67 MB/s: one progress line a minute for
    // well over the 300 s the old fixed budget allowed.
    const step = 60_000;
    const total = 916 * MB;
    let current = 0;
    while (current < total) {
      current = Math.min(total, current + Math.round(0.67 * MB * (step / 1000)));
      pull.emit({ status: 'Downloading', progressDetail: { current, total }, id: 'layer1' });
      await vi.advanceTimersByTimeAsync(step);
      expect(result.settled).toBe(false);
    }
    expect(Date.now()).toBeGreaterThan(300_000 * 4);
    pull.emit({ status: 'Download complete', progressDetail: {}, id: 'layer1' });
    pull.emit({ status: 'Pull complete', progressDetail: {}, id: 'layer1' });
    pull.emit({ status: 'Status: Downloaded newer image' });
    pull.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.settled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  /** With the containerd image store the daemon re-sends every active layer's
   *  `Downloading` line every 100 ms whether its offset moved or not. A guard
   *  that counted lines instead of progress would never notice a dead link. */
  it('does not mistake a repeated, unchanged progress line for progress', async () => {
    const pull = controlledPull();
    const result = track(client(pull.fetch).pullImage!(IMAGE));
    const frozen = {
      status: 'Downloading',
      progressDetail: { current: 300 * MB, total: 916 * MB },
      id: 'layer1',
    };
    pull.emit(frozen);
    for (let elapsed = 0; elapsed < DEFAULT_PULL_IDLE_TIMEOUT_MS; elapsed += 1_000) {
      pull.emit(frozen);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(result.error).toMatchObject({ kind: 'pull_stalled' });
  });

  it('does not stall while every layer is on disk and only local extraction is left', async () => {
    const pull = controlledPull();
    const result = track(client(pull.fetch).pullImage!(IMAGE));
    pull.emit({ status: 'Pulling fs layer', progressDetail: {}, id: 'layer1' });
    pull.emit({ status: 'Download complete', progressDetail: {}, id: 'layer1' });
    // The containerd store unpacks with no progress lines at all.
    await vi.advanceTimersByTimeAsync(DEFAULT_PULL_IDLE_TIMEOUT_MS * 5);
    expect(result.settled).toBe(false);
    pull.emit({ status: 'Digest: sha256:abc' });
    pull.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.settled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('reports a pull still moving at its ceiling as timeout, not network', async () => {
    const pull = controlledPull();
    const ceiling = 10 * 60_000;
    const result = track(client(pull.fetch, { pullTimeoutMs: ceiling }).pullImage!(IMAGE));
    let current = 0;
    for (let elapsed = 0; elapsed < ceiling; elapsed += 30_000) {
      current += MB;
      pull.emit({
        status: 'Downloading',
        progressDetail: { current, total: 916 * MB },
        id: 'layer1',
      });
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(result.error).toMatchObject({
      kind: 'timeout',
      image: IMAGE,
      payload: { timeoutMs: ceiling },
    });
  });

  it('defaults the ceiling far above the no-progress window', () => {
    // Not a restatement: the ceiling must leave room for a multi-gigabyte pull on
    // a slow link, which the incident host needed about an hour for.
    expect(DEFAULT_PULL_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60_000);
    expect(DEFAULT_PULL_IDLE_TIMEOUT_MS).toBeLessThan(DEFAULT_PULL_TIMEOUT_MS / 10);
  });

  it('logs aggregate progress at most once per interval', async () => {
    const pull = controlledPull();
    const log = vi.fn<(message: string) => void>();
    const result = track(
      client(pull.fetch, { pullLogIntervalMs: 30_000 }).pullImage!(IMAGE, { log }),
    );
    pull.emit({ status: 'Pulling fs layer', progressDetail: {}, id: 'a' });
    pull.emit({ status: 'Already exists', progressDetail: {}, id: 'b' });
    for (let second = 1; second <= 90; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      pull.emit({
        status: 'Downloading',
        progressDetail: { current: second * MB, total: 100 * MB },
        id: 'a',
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0]?.[0]).toBe(
      `pulling ${IMAGE}: 30.0 MB of 100.0 MB downloaded, 1/2 layers on disk`,
    );
    pull.emit({ status: 'Download complete', progressDetail: {}, id: 'a' });
    pull.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.error).toBeUndefined();
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^pulled .* in 90s: 100\.0 MB of 100\.0 MB/);
  });

  it('still surfaces an in-stream error from a streamed body', async () => {
    const pull = controlledPull();
    const result = track(client(pull.fetch).pullImage!(IMAGE));
    pull.emit({ status: 'Pulling fs layer', progressDetail: {}, id: 'a' });
    pull.emit({ error: 'manifest unknown', errorDetail: { message: 'manifest unknown' } });
    pull.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.error).toMatchObject({ kind: 'image_not_found', image: IMAGE });
  });
});

describe('DockerClient.pullImage over the unix socket', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** The unix transport used to buffer the whole body before handing it over,
   *  which would leave an idle watchdog blind until the pull had already ended.
   *  This drives the real transport against a daemon stand-in that sends some
   *  progress and then goes silent with the connection open. */
  it('sees progress as it arrives and stops a silent daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-pull-'));
    const socketPath = join(dir, 'docker.sock');
    let clientGone = false;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(
        `${JSON.stringify({ status: 'Downloading', progressDetail: { current: 1, total: 9 }, id: 'a' })}\n`,
      );
      req.socket.on('close', () => {
        clientGone = true;
      });
    });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
    close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      });
    const log = vi.fn<(message: string) => void>();
    const docker = createDockerClient({
      baseUrl: `unix://${socketPath}`,
      pullIdleTimeoutMs: 300,
      pullLogIntervalMs: 0,
    });
    await expect(docker.pullImage!(IMAGE, { log })).rejects.toMatchObject({
      kind: 'pull_stalled',
    });
    // The first line was seen while the response was still open.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 B of 9 B downloaded'));
    await vi.waitFor(() => expect(clientGone).toBe(true));
  });
});

describe('PullProgressTracker', () => {
  it('ignores the retry countdown but follows the retried counter from zero', () => {
    const tracker = new PullProgressTracker();
    const downloading = (current: number) =>
      tracker.observe({
        status: 'Downloading',
        id: 'a',
        progressDetail: { current, total: 1000 },
      });
    expect(downloading(1)).toBe(true);
    expect(downloading(800)).toBe(true);
    expect(tracker.observe({ status: 'Retrying in 5 seconds', id: 'a' })).toBe(false);
    expect(tracker.observe({ status: 'Retrying in 4 seconds', id: 'a' })).toBe(false);
    // The retried attempt restarts below the previous mark of 800. Measuring it
    // against that mark would fail a healthy transfer as stalled.
    expect(downloading(0)).toBe(true);
    expect(downloading(0)).toBe(false);
    expect(downloading(100)).toBe(true);
    expect(downloading(200)).toBe(true);
    expect(downloading(200)).toBe(false);
    // The byte summary keeps what was already received.
    expect(tracker.summary()).toMatchObject({ bytesDone: 800, bytesTotal: 1000 });
  });

  it('keeps waiting on the network while any layer is still queued', () => {
    const tracker = new PullProgressTracker();
    expect(tracker.awaitingNetwork).toBe(true);
    tracker.observe({ status: 'Pulling from verity/verity-server', id: 'v1' });
    tracker.observe({ status: 'Download complete', id: 'a' });
    tracker.observe({ status: 'Waiting', id: 'b' });
    expect(tracker.awaitingNetwork).toBe(true);
    tracker.observe({ status: 'Already exists', id: 'b' });
    expect(tracker.awaitingNetwork).toBe(false);
  });
});
