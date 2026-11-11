import { beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const files = vi.hoisted(() => new Map<string, string>());
// Host paths remain entirely virtual; no service or Docker process is invoked.
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  openSync: () => 42,
  closeSync: () => {},
  fsyncSync: () => {},
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  lstat: async () => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o700,
  }),
  mkdir: async () => {},
  realpath: async (path: string) => path,
  writeFile: async (path: string, content: string) => {
    files.set(path, content);
  },
  rename: async (source: string, target: string) => {
    files.set(target, files.get(source)!);
    files.delete(source);
  },
  rm: async (path: string) => {
    files.delete(path);
  },
  open: async (path: string) => {
    if (!files.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return {
      stat: async () => ({
        isFile: () => true,
        uid: 0,
        mode: 0o600,
        nlink: 1,
        size: files.get(path)!.length,
      }),
      readFile: async () => files.get(path)!,
      close: async () => {},
    };
  },
  readFile: async (path: string) => {
    if (path.endsWith('/cgroup.events')) return 'populated 1\n';
    throw new Error('Unexpected read ' + path);
  },
}));
import {
  createNativeProtectedBuildHost,
  protectedBuildAttemptDirectory,
} from './project-egress-build-host.js';
const request = {
  projectId: 'project-one',
  attemptId: '11111111-1111-4111-8111-111111111111',
  snapshot: 'attempt-abc/verity-build-def',
  image: 'verity-devc-example-repo:0123456789ab',
  noCache: false,
};
beforeEach(() => files.clear());

it.each([false, true])(
  'contains partial work after bootstrap failure, protecting foreign checkpoint=%s',
  async (foreign) => {
    files.set(
      '/var/lib/verity/protected-build/controller.json',
      JSON.stringify({ request, phase: 'stopping', ended: false }),
    );
    files.set(
      join(protectedBuildAttemptDirectory(request), 'checkpoint.json'),
      JSON.stringify({
        binding: {
          projectId: foreign ? 'foreign' : request.projectId,
          generation: request.attemptId,
          networkId: 'a'.repeat(64),
          networkName: 'verity-build-a',
          bridge: 'vebaaaaaaaaaaaa',
        },
        attemptId: request.attemptId,
      }),
    );
    const run = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === '/sbin/ip') return '[]';
      if (file === '/usr/bin/systemctl') {
        if (args[0] === 'stop') return '';
        return 'LoadState=loaded\nActiveState=active\nControlGroup=/verity.slice/verity-buildkit.slice/verity-protected-build-abc.service\n';
      }
      if (file === '/usr/bin/docker' && args[0] === 'container' && args[1] === 'ls') return '';
      throw new Error('Unexpected host command');
    });
    const host = await createNativeProtectedBuildHost({
      imageRef: 'sha256:' + 'a'.repeat(64),
      dataVolume: 'verity-data',
      run,
      verifyReady: async () => {},
      dependencies: {
        apply: async () => {
          throw new Error('nft failed');
        },
        resolve: async () => ({ addresses: [], expiresAt: 0 }),
        directTargetAllowed: async () => false,
        destinationAllowed: async () => false,
        deadline: {
          prepare: async () => {},
          revoke: async () => {},
          clock: async () => 0,
          arm: async () => {},
          renew: async () => {},
        },
      },
    });
    await expect(host.restore()).rejects.toThrow();
    const stops = run.mock.calls.filter(
      ([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'stop',
    );
    expect(stops).toHaveLength(foreign ? 0 : 1);
    expect(
      run.mock.calls.some(
        ([file, args]) => file === '/usr/bin/docker' && args[0] === 'container' && args[1] === 'ls',
      ),
    ).toBe(!foreign);
    expect([...files.keys()].some((path) => path.includes('/receipts/'))).toBe(false);
  },
);
