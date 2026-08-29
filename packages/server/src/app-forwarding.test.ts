import type { EventBus } from '@verity/session';
import type { EventStore, ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from './server.js';

// Capture what buildControlPlane hands to buildServer. The control plane forwards
// its dependencies key by key rather than spreading them, so a dep the route layer
// reads can be declared, wired in embedded.ts, type-check cleanly (a conditional
// spread bypasses excess-property checking) and still never arrive — which is how
// the sandbox git for the GitHub-free merge went missing in production while every
// route-level test, injecting into buildServer directly, stayed green.
const forwarded: ServerDeps[] = [];
vi.mock('./server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server.js')>();
  return {
    ...actual,
    buildServer: (deps: ServerDeps): FastifyInstance => {
      forwarded.push(deps);
      return {} as FastifyInstance;
    },
  };
});

const { buildControlPlane } = await import('./app.js');

const project = { id: 'p1' } as ProjectRecord;

/** buildControlPlane only reads `projectBackend` eagerly and takes the conductor as a
 *  factory, so bare stores are enough to observe the forwarding. */
function forward(deps: Partial<Parameters<typeof buildControlPlane>[0]>): ServerDeps {
  forwarded.length = 0;
  buildControlPlane({
    eventStore: {} as EventStore,
    bus: {} as EventBus,
    ...deps,
  });
  const [got] = forwarded;
  expect(got).toBeDefined();
  return got!;
}

describe('buildControlPlane dependency forwarding', () => {
  it('passes the managed release-channel resolver through', () => {
    const serverUpdateResolver = { resolve: vi.fn() };
    const got = forward({ serverUpdateResolver });
    expect(got.serverUpdateResolver).toBe(serverUpdateResolver);
  });

  /**
   * The state path is the notifier's on/off switch — `buildServer` builds no
   * notifier without it. Declared in `EmbeddedServerConfig` and set by `main.ts`,
   * it was dropped here in between: the conditional spread type-checks, so the
   * feature would have shipped inert in production with every unit test green.
   */
  it('passes the update-notifier state path through, without which nothing is announced', () => {
    const got = forward({ serverUpdateNotifierStatePath: '/data/server-state/announced.json' });
    expect(got.serverUpdateNotifierStatePath).toBe('/data/server-state/announced.json');
  });

  it('passes the sandbox git through, so the GitHub-free merge is not refused as unconfigured', () => {
    const sandboxGit = vi.fn(() => async () => '');
    const got = forward({ sandboxGit });
    expect(got.sandboxGit).toBe(sandboxGit);
  });

  it('passes the project-fleet dependencies through', () => {
    const listAvailableRepositories = vi.fn(async () => [project]);
    const reconcileProjectState = vi.fn(async () => project);
    const refreshProjectToken = vi.fn(async () => undefined);
    const got = forward({ listAvailableRepositories, reconcileProjectState, refreshProjectToken });
    expect(got.listAvailableRepositories).toBe(listAvailableRepositories);
    expect(got.reconcileProjectState).toBe(reconcileProjectState);
    expect(got.refreshProjectToken).toBe(refreshProjectToken);
  });

  it('omits an absent dep instead of forwarding an explicit undefined', () => {
    const got = forward({});
    expect('sandboxGit' in got).toBe(false);
    expect('reconcileProjectState' in got).toBe(false);
  });
});
