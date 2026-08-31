import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READINESS_PROBE_URL,
  parseReadinessProbeUrl,
  readinessProbeOptionsFromEnvironment,
  runReadinessProbe,
} from './readiness-probe.js';

const answer = (status: number, body: unknown): Response =>
  ({ status, json: async () => Promise.resolve(body) }) as Response;

const serving = answer(200, { status: 'ok', version: '10.6.0' });

describe('readiness probe endpoint', () => {
  it('defaults to the managed Server and rejects anything but a plain health URL', () => {
    expect(parseReadinessProbeUrl(undefined)).toBe(DEFAULT_READINESS_PROBE_URL);
    expect(parseReadinessProbeUrl('')).toBe(DEFAULT_READINESS_PROBE_URL);
    expect(parseReadinessProbeUrl('http://verity-managed-server:8083/healthz')).toBe(
      'http://verity-managed-server:8083/healthz',
    );
    for (const rejected of [
      'verity-managed-server/healthz',
      'https://verity-managed-server:8082/healthz',
      'http://user:pass@verity-managed-server:8082/healthz',
      'http://verity-managed-server:8082/server/updates',
      'http://verity-managed-server:8082/healthz?token=x',
      'http://verity-managed-server:8082/healthz#x',
      'http://_evil_/healthz',
    ])
      expect(() => parseReadinessProbeUrl(rejected)).toThrow();
  });

  it('reads its budget from the container environment within sane bounds', () => {
    expect(readinessProbeOptionsFromEnvironment({})).toEqual({
      url: DEFAULT_READINESS_PROBE_URL,
    });
    expect(
      readinessProbeOptionsFromEnvironment({ VERITY_READINESS_PROBE_TIMEOUT_MS: '30000' }),
    ).toEqual({ url: DEFAULT_READINESS_PROBE_URL, timeoutMs: 30_000 });
    for (const bad of ['0', '900000', 'soon', '1.5'])
      expect(() =>
        readinessProbeOptionsFromEnvironment({ VERITY_READINESS_PROBE_TIMEOUT_MS: bad }),
      ).toThrow(/between 1000 and 600000/);
  });
});

describe('readiness probe verdict', () => {
  const options = { timeoutMs: 10_000, intervalMs: 1_000, sleep: async () => Promise.resolve() };

  it('accepts the first serving answer', async () => {
    const fetch = vi.fn(async () => Promise.resolve(serving));
    await expect(runReadinessProbe({ ...options, fetch })).resolves.toEqual({
      ok: true,
      attempts: 1,
      detail: 'serving version 10.6.0',
    });
    expect(fetch).toHaveBeenCalledWith(DEFAULT_READINESS_PROBE_URL, expect.anything());
  });

  it('keeps retrying a refused connection until the generation answers', async () => {
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('connect ECONNREFUSED');
      return Promise.resolve(serving);
    });
    await expect(runReadinessProbe({ ...options, fetch })).resolves.toMatchObject({
      ok: true,
      attempts: 3,
    });
  });

  // The endpoint answers 503/degraded when an OPTIONAL runtime dependency is
  // down — a condition the previous generation shared and no update can fix.
  // Failing on it would roll back every update on such a host.
  it('counts a degraded but answering Server as serving', async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(answer(503, { status: 'degraded', version: '10.6.0' })),
    );
    await expect(runReadinessProbe({ ...options, fetch })).resolves.toMatchObject({ ok: true });
  });

  it('rejects an answer that is not a Verity Server', async () => {
    for (const body of [{ status: 'ok' }, 'ok', { version: '10.6.0' }, null]) {
      const fetch = vi.fn(async () => Promise.resolve(answer(200, body)));
      await expect(runReadinessProbe({ ...options, timeoutMs: 1, fetch })).resolves.toMatchObject({
        ok: false,
        attempts: 1,
      });
    }
    const gateway = vi.fn(async () => Promise.resolve(answer(502, { status: 'ok', version: '1' })));
    await expect(
      runReadinessProbe({ ...options, timeoutMs: 1, fetch: gateway }),
    ).resolves.toMatchObject({ ok: false, detail: 'unhealthy response: HTTP 502' });
  });

  it('gives up at its deadline instead of retrying forever', async () => {
    let clock = 0;
    const fetch = vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED')));
    const result = await runReadinessProbe({
      timeoutMs: 5_000,
      intervalMs: 1_000,
      fetch,
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ ok: false, attempts: 5 });
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });

  /**
   * The tests above inject a `sleep`, which is exactly what this one must not
   * do: the verdict travels as an exit code, and the failure mode being guarded
   * is the process EXITING between attempts. An `unref`'d retry timer leaves the
   * one-shot probe with no referenced handle, so Node runs the loop dry and
   * exits 0 — the code that means "ready" — while nothing has answered yet. Only
   * a real child process can tell that apart from a probe that waited.
   */
  it('keeps the process alive between attempts instead of exiting as ready', async () => {
    const module = fileURLToPath(new URL('readiness-probe.ts', import.meta.url));
    // Shaped like the real entrypoint: a floating promise, whose pending state
    // does NOT keep Node running by itself.
    const source = `
      import(${JSON.stringify(module)})
        .then((probe) => probe.runReadinessProbe({
          url: 'http://127.0.0.1:9/healthz',
          timeoutMs: 2_500, intervalMs: 500, requestTimeoutMs: 200,
        }))
        .then((result) => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); })
        .catch(() => process.exit(2));`;
    const started = Date.now();
    const failure = await promisify(execFile)('node', ['--input-type=module', '-e', source]).then(
      () => null,
      (error: { code?: number; stdout?: string }) => error,
    );

    expect(failure?.code).toBe(1);
    expect(JSON.parse(failure?.stdout ?? '{}')).toMatchObject({ ok: false });
    // It spent its whole budget rather than falling out of the loop early.
    expect(Date.now() - started).toBeGreaterThan(2_000);
  }, 20_000);
});
