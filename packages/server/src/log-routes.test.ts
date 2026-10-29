import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { registerLogRoutes, type LogRouteDeps } from './log-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';

function deps(): LogRouteDeps {
  return {
    log: {
      operation: vi.fn().mockResolvedValue([{ recordedAt: new Date().toISOString() }]),
    },
    recorder: { isActive: () => false },
  };
}

describe('administrator diagnostic reads', () => {
  it('keeps both routes out of the paired-user allowlist', async () => {
    const app = Fastify();
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      if (route.method === 'GET') routes.push(route.url);
    });
    registerLogRoutes(app, deps());
    await app.ready();
    // Use the real route policy rather than restating its administrator defaults.
    for (const url of routes) {
      const store: Parameters<typeof authorizePairedRoute>[0] = {
        isActiveAdministrator: async () => false,
        isActiveLocalUser: async () => true,
        hasProjectPermission: async () => true,
        getSession: async () => undefined,
      };
      expect(await authorizePairedRoute(store, 'paired', 'GET', url, {})).toBe('forbidden');
      store.isActiveAdministrator = async () => true;
      expect(await authorizePairedRoute(store, 'admin', 'GET', url, {})).toBe('allow');
    }
    await app.close();
  });
  it('does not confuse absent, expired and failed build output', async () => {
    const d = deps();
    const app = Fastify();
    registerLogRoutes(app, d);
    const url = `/audit/operations/${randomUUID()}/diagnostics`;
    expect((await app.inject(url)).json().state).toBe('unavailable');
    d.buildDiagnostics = {
      save: vi.fn(),
      prune: vi.fn(),
      read: vi.fn().mockRejectedValue(new Error('disk failure')),
    };
    expect((await app.inject(url)).json().state).toBe('failed');
    d.buildDiagnostics = undefined;

    vi.mocked(d.log).operation.mockResolvedValue([{ recordedAt: '2000-01-01T00:00:00Z' }] as never);
    expect((await app.inject(url)).json().state).toBe('expired');
    vi.mocked(d.log).operation.mockResolvedValue([]);
    expect((await app.inject(url)).statusCode).toBe(404);
    await app.close();
  });
  it('bounds the requested window, redacts source output and preserves failure state', async () => {
    const d = deps();
    d.serverLogs = vi
      .fn()
      .mockResolvedValue(
        '2026-10-28T12:00:00Z {"level":50,"token":"opaque","msg":"failed"}\nAuthorization: Bearer opaque',
      );
    const app = Fastify();
    registerLogRoutes(app, d);
    expect((await app.inject('/diagnostics/logs?since=2000-01-01T00:00:00Z')).statusCode).toBe(400);
    const result = await app.inject('/diagnostics/logs');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).not.toContain('opaque');
    expect(result.json().supportConsent).toBe('required');
    expect(result.json().entries[0].level).toBe('error');
    expect((await app.inject('/diagnostics/logs?level=error')).json().entries).toHaveLength(1);
    vi.mocked(d.serverLogs).mockRejectedValue(new Error('daemon unavailable'));
    expect((await app.inject('/diagnostics/logs')).json().state).toBe('failed');
    await app.close();
  });
  it('exposes host freshness and coverage without raw journal text', async () => {
    const d = deps();
    const since = new Date(Date.now() - 3600_000).toISOString();
    const until = new Date().toISOString();
    d.runtimeDiagnostics = vi.fn().mockResolvedValue({
      host: {
        state: 'available',
        stale: true,
        snapshot: {
          observedAt: until,
          since,
          until,
          truncated: true,
          sources: { kernel: 'available', runtime: 'failed' },
          records: [
            { at: since, source: 'kernel', code: 'oom_kill' },
            { at: '2000-01-01T00:00:00Z', source: 'runtime', code: 'runtime_error' },
          ],
        },
      },
    });
    const app = Fastify();
    registerLogRoutes(app, d);
    const response = (
      await app.inject(`/diagnostics/logs?source=host&since=${since}&until=${until}`)
    ).json();
    expect(response.stale).toBe(true);
    expect(response.truncated).toBe(true);
    expect(response.sources.runtime).toBe('failed');
    expect(response.entries).toEqual([{ at: since, level: null, text: 'kernel: oom_kill' }]);
    await app.close();
  });
});
