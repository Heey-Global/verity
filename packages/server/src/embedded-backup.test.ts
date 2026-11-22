import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedBackup } from './embedded-backup.js';
import { openBackupRuntime } from './backup/runtime.js';
import { SERVER_COMPAT } from './self-update/compat.js';

vi.mock('./backup/runtime.js', () => ({ openBackupRuntime: vi.fn() }));
type Context = Parameters<typeof createEmbeddedBackup>[0];
function context(): Context {
  return {
    config: { databaseUrl: 'postgres://localhost/verity', dataVolumeRoot: '/data' },
    projectDocker: {
      inspectContainer: vi.fn(async () => ({ image: 'server@sha256:current' })),
    } as unknown as NonNullable<Context['projectDocker']>,
    eventStore: {} as Context['eventStore'],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(openBackupRuntime).mockReset();
});
describe('embedded backup bootstrap', () => {
  it.each(['databaseUrl', 'dataVolumeRoot', 'projectDocker'] as const)(
    'does not open a runtime without %s',
    async (missing) => {
      const ctx = context();
      if (missing === 'projectDocker') ctx.projectDocker = undefined;
      else delete ctx.config[missing];
      expect(await createEmbeddedBackup(ctx)).toBeUndefined();
      expect(openBackupRuntime).not.toHaveBeenCalled();
    },
  );
  it('does not open a runtime on an unsupported architecture', async () => {
    vi.stubGlobal('process', { ...process, arch: 's390x' });
    expect(await createEmbeddedBackup(context())).toBeUndefined();
    expect(openBackupRuntime).not.toHaveBeenCalled();
  });
  it.each([
    ['x64', 'amd64'],
    ['arm64', 'arm64'],
  ])('wires %s backups and defers the current-container lookup', async (arch, architecture) => {
    vi.stubGlobal('process', { ...process, arch });
    const ctx = context();
    const inspectContainer = vi.spyOn(ctx.projectDocker!, 'inspectContainer');
    const runtime = { close: vi.fn(async () => undefined) };
    vi.mocked(openBackupRuntime).mockResolvedValue(runtime);
    expect(await createEmbeddedBackup(ctx)).toBe(runtime);
    expect(inspectContainer).not.toHaveBeenCalled();
    expect(openBackupRuntime).toHaveBeenCalledOnce();
    const options = vi.mocked(openBackupRuntime).mock.calls[0]![0];
    expect(options).toMatchObject({
      root: '/data',
      databaseUrl: ctx.config.databaseUrl,
      architecture,
      release: SERVER_COMPAT.serverVersion,
      schema: SERVER_COMPAT.schema.current,
      store: ctx.eventStore,
      probe: {
        docker: ctx.projectDocker,
        network: 'verity-net',
        tufCachePath: '/data/backup-state/tuf-cache',
      },
    });
    expect(await options.currentImage()).toBe('server@sha256:current');
    expect(inspectContainer).toHaveBeenCalledWith(hostname());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    options.onError(new Error('private diagnostic details'));
    expect(warn).toHaveBeenCalledWith(
      'verity: backup operation unavailable; queued revocations remain durable',
    );
  });
});
