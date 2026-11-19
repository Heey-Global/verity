import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SealedError } from '@verity/store';
import {
  createEmbeddedControlPlaneRunnerIdentity,
  createEmbeddedRunnerIdentityPublisher,
} from './embedded-control-plane-runner-identity.js';

const fs = vi.hoisted(() => ({
  chmod: vi.fn(),
  chown: vi.fn(),
  lstat: vi.fn<(path: string) => Promise<{ gid: number; mode: number }>>(),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  rename: vi.fn<(from: string, to: string) => Promise<void>>(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fs,
}));

type Context = Parameters<typeof createEmbeddedControlPlaneRunnerIdentity>[0];
const root = '/identity';
const generationAck = '/data/runners/verity-control/claude-egress-generation';
const material = { caCertPem: 'ca', clientCertPem: 'cert', clientKeyPem: 'key' };
const fingerprint = createHash('sha256').update(material.clientKeyPem).digest('hex');

function fixture() {
  fs.chown.mockResolvedValue(undefined);
  fs.chmod.mockResolvedValue(undefined);
  fs.rm.mockResolvedValue(undefined);
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const directory = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 1101,
    mode: 0o2770,
  };
  fs.lstat.mockImplementation(async (path: string) => {
    if (path === root) return directory;
    if (!modes.has(path)) throw new Error('ENOENT');
    return { gid: 1101, mode: modes.get(path)! };
  });
  fs.readFile.mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error('ENOENT');
    return files.get(path)!;
  });
  fs.writeFile.mockImplementation(
    async (path: string, value: string, options: { mode: number }) => {
      files.set(path, value);
      modes.set(path, options.mode);
    },
  );
  fs.rename.mockImplementation(async (from: string, to: string) => {
    files.set(to, files.get(from)!);
    modes.set(to, modes.get(from)!);
    files.delete(from);
    modes.delete(from);
  });
  const projectDefault = vi.fn(async () => ({ userId: 'person' }));
  const sandboxMaterial = vi.fn(async () => material);
  const context = {
    config: { controlPlaneRunnerIdentityDir: root, dataVolumeRoot: '/data' },
    eventStore: { projectSandboxes: { projectDefault } },
    claudeEgressIdentity: { sandboxMaterial },
  } as unknown as Context;
  return { context, files, modes, directory, projectDefault, sandboxMaterial };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('control-plane Runner identity', () => {
  it('publishes private material with generation last and avoids unchanged rewrites', async () => {
    const f = fixture();
    const identity = await createEmbeddedControlPlaneRunnerIdentity(f.context);
    await identity.refreshControlPlaneRunnerIdentity();
    expect(f.projectDefault).toHaveBeenCalledWith('verity-control');
    expect(f.sandboxMaterial).toHaveBeenCalledWith({
      projectId: 'verity-control',
      userId: 'person',
    });
    expect(fs.rename.mock.calls.map(([, target]) => target)).toEqual([
      `${root}/ca.crt`,
      `${root}/client.crt`,
      `${root}/client.key`,
      `${root}/client.key.sha256`,
      `${root}/generation`,
    ]);
    expect(f.modes.get(`${root}/client.key`)).toBe(0o040);
    expect(f.files.get(`${root}/client.key.sha256`)).toBe(fingerprint);
    const generation = f.files.get(`${root}/generation`);
    await identity.refreshControlPlaneRunnerIdentity();
    expect(fs.rename).toHaveBeenCalledTimes(5);
    expect(f.files.get(`${root}/generation`)).toBe(generation);
    expect(fs.readFile.mock.calls.map(([path]) => path)).not.toContain(`${root}/client.key`);
  });

  it.each(['owner-readable key', 'stale fingerprint', 'missing generation'])(
    'repairs %s even when certificates are current',
    async (stale) => {
      const f = fixture();
      f.files.set(`${root}/ca.crt`, material.caCertPem);
      f.files.set(`${root}/client.crt`, material.clientCertPem);
      f.files.set(
        `${root}/client.key.sha256`,
        stale === 'stale fingerprint' ? 'stale' : fingerprint,
      );
      f.modes.set(`${root}/client.key`, stale === 'owner-readable key' ? 0o640 : 0o040);
      if (stale !== 'missing generation') f.files.set(`${root}/generation`, 'old');
      const identity = await createEmbeddedControlPlaneRunnerIdentity(f.context);
      await identity.refreshControlPlaneRunnerIdentity();
      expect(f.files.get(`${root}/generation`)).toBeTruthy();
      expect(f.files.get(`${root}/generation`)).not.toBe('old');
      expect(f.modes.get(`${root}/client.key`)).toBe(0o040);
      expect(f.files.get(`${root}/client.key.sha256`)).toBe(fingerprint);
    },
  );

  it('serializes concurrent refreshes and permits retries after a failed publication', async () => {
    const f = fixture();
    const identity = await createEmbeddedControlPlaneRunnerIdentity(f.context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sandboxMaterial.mockImplementationOnce(async () => {
      await gate;
      throw new Error('sealed');
    });
    const first = identity.refreshControlPlaneRunnerIdentity();
    const firstResult = expect(first).rejects.toThrow('sealed');
    await vi.waitFor(() => expect(f.sandboxMaterial).toHaveBeenCalledTimes(1));
    const second = identity.refreshControlPlaneRunnerIdentity();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const requestsBeforeRelease = f.sandboxMaterial.mock.calls.length;
    release();
    await firstResult;
    await expect(second).resolves.toBeUndefined();
    expect(requestsBeforeRelease).toBe(1);
    expect(f.sandboxMaterial).toHaveBeenCalledTimes(2);
    expect(f.files.get(`${root}/generation`)).toBeTruthy();
  });

  it('rejects unsafe volume ownership before issuing identity material', async () => {
    const f = fixture();
    f.directory.uid = 1000;
    await expect(createEmbeddedControlPlaneRunnerIdentity(f.context)).rejects.toThrow(
      'unsafe ownership',
    );
    expect(f.sandboxMaterial).not.toHaveBeenCalled();
  });

  it('rejects files that did not inherit the Runner group without publishing generation', async () => {
    const f = fixture();
    const directoryStats = fs.lstat.getMockImplementation()!;
    fs.lstat.mockImplementation(async (path: string) =>
      path === root ? directoryStats(path) : { gid: 1000, mode: 0o640 },
    );
    fs.chown.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const identity = await createEmbeddedControlPlaneRunnerIdentity(f.context);
    await expect(identity.refreshControlPlaneRunnerIdentity()).rejects.toThrow(
      'does not hand ca.crt',
    );
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining(`${root}/ca.crt.`), { force: true });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(f.files.has(`${root}/generation`)).toBe(false);
  });

  it('waits for the exact published generation and times out on a stale acknowledgement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const identity = await createEmbeddedControlPlaneRunnerIdentity(f.context);
    f.files.set(`${root}/generation`, 'new');
    f.files.set(generationAck, 'old');
    const acknowledgement = identity.awaitControlPlaneRunnerIdentity();
    await vi.advanceTimersByTimeAsync(50);
    let done = false;
    void acknowledgement.then(() => {
      done = true;
    });
    expect(done).toBe(false);
    f.files.set(generationAck, 'new');
    await vi.advanceTimersByTimeAsync(50);
    await acknowledgement;
    const stale = identity.awaitControlPlaneRunnerIdentity();
    const rejection = expect(stale).rejects.toThrow('did not acknowledge');
    f.files.set(generationAck, 'old');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it('keeps sealed boot failures best-effort while strict turn refresh still rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let refresh: (() => Promise<void>) | undefined;
    const publish = createEmbeddedRunnerIdentityPublisher(() => refresh);
    await expect(publish('startup')).resolves.toBe(true);
    const failure = new SealedError();
    refresh = vi.fn(async () => {
      throw failure;
    });
    await expect(publish('secret unlock')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferred until unlock'));
    await expect(refresh()).rejects.toBe(failure);
    refresh = vi.fn(async () => undefined);
    await expect(publish('key handover')).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
