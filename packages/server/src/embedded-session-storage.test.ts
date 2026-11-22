import { describe, expect, it, vi } from 'vitest';
import { createEmbeddedSessionStorage } from './embedded-session-storage.js';

const captured = vi.hoisted<{ session: unknown; cache: unknown }>(() => ({
  session: undefined,
  cache: undefined,
}));
vi.mock('./session-storage.js', () => ({
  SessionStorage: class {
    constructor(deps: unknown) {
      captured.session = deps;
    }
  },
}));
vi.mock('./runner-cache-storage.js', () => ({
  RunnerCacheStorage: class {
    constructor(deps: unknown) {
      captured.cache = deps;
    }
  },
}));
vi.mock('./session-storage-access.js', () => ({ sessionStorageAccess: () => ({}) }));

type Context = Parameters<typeof createEmbeddedSessionStorage>[0];
function context(): Context {
  return {
    config: {},
    eventStore: {} as Context['eventStore'],
    projectDocker: undefined,
    provisioner: undefined,
    withStorageProjectMutation: async (_id, run) => run(),
    devServers: () => undefined,
    localPreviewManager: undefined,
    preparedWorktreeImages: new Map(),
    defaultProjectImage: 'project:stable',
    maintenanceImages: undefined,
    cachedProjectTokenMint: async () => undefined,
    dataVolumeRoot: undefined,
    readProjectStatus: async () => null,
    log: () => {
      throw new Error('app not created yet');
    },
  };
}
describe('embedded session storage bootstrap', () => {
  it('omits storage when its host roots are unavailable without reading the future app', () => {
    expect(createEmbeddedSessionStorage(context())).toEqual({
      sessionStorage: undefined,
      runnerCacheStorage: undefined,
    });
  });
  it('defers logger access until storage callbacks execute', () => {
    const ctx = context();
    ctx.config = { hostCloneRoot: '/host/clones' };
    ctx.dataVolumeRoot = '/host/data';
    ctx.projectDocker = {} as NonNullable<Context['projectDocker']>;
    ctx.provisioner = { withProjectExclusiveMutation: vi.fn() } as unknown as NonNullable<
      Context['provisioner']
    >;
    createEmbeddedSessionStorage(ctx);
    const info = vi.fn();
    const warn = vi.fn();
    ctx.log = () => ({ info, warn }) as unknown as ReturnType<Context['log']>;
    const session = captured.session as { log: (summary: object) => void };
    const cache = captured.cache as { onFailure: (failure: object) => void };
    const summary = { completed: true };
    const failure = { code: 'runtime-not-idle' };
    session.log(summary);
    cache.onFailure(failure);
    expect(info).toHaveBeenCalledWith(summary, 'session storage pass complete');
    expect(warn).toHaveBeenCalledWith(
      failure,
      'Runner cache maintenance failed; unverified caches retained',
    );
  });
});
