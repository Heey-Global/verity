import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildStorageLease } from './build-storage.js';
import { createProtectedDevcontainerBuilder } from './protected-devcontainer-builder.js';
const { health } = vi.hoisted(() => ({
  health: vi.fn(async () => ({ version: 1, available: true })),
}));
vi.mock('./project-egress-build-client.js', () => ({ createProtectedBuildClient: () => health }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  health.mockResolvedValue({ version: 1, available: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'protected-spawner-'));
  roots.push(root);
  const directory = join(root, 'attempt-a');
  mkdirSync(directory);
  const workspaceFolder = join(directory, 'verity-build-a');
  mkdirSync(workspaceFolder);
  const keyPath = join(root, 'control.key');
  writeFileSync(keyPath, 'a'.repeat(64));
  const run = vi.fn<BuildStorageLease['run']>(async (_command, _args, options) => ({
    stdout: options.remoteOperation === 'protected-build' ? '{"success":true}' : 'imported',
    stderr: '',
  }));
  const lease: BuildStorageLease = {
    directory,
    retainArtifacts: false,
    reserveBuild() {},
    dispose() {},
    run,
  };
  const build = createProtectedDevcontainerBuilder({
    root,
    keyPath,
    socketPath: '/run/control.sock',
    workerFile: '/fixed-worker.js',
  });
  const args = {
    projectId: 'project-a',
    storageLease: lease,
    workspaceFolder,
    imageName: `verity-devc-repo:${'a'.repeat(12)}`,
    dockerHost: 'unix:///var/run/docker.sock',
    additionalFeatures: `ghcr.io/trusted/feature@sha256:${'a'.repeat(64)}`,
    registryToken: 'fixture-registry-credential',
  };
  return { root, directory, args, build, lease, run };
}
describe('protected devcontainer Server executor', () => {
  it('imports only after the trusted worker confirms termination, without passing credentials in argv or env', async () => {
    const f = fixture();
    await f.build(f.args);
    expect(f.run.mock.calls.map((call) => call[2].remoteOperation)).toEqual([
      'protected-build',
      'image-import',
    ]);
    expect(JSON.stringify(f.run.mock.calls)).not.toContain(f.args.registryToken);
    const [command, argv, options] = f.run.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(argv[0]).toBe('/fixed-worker.js');
    expect(options.env).toEqual({ PATH: process.env.PATH });
    const job = JSON.parse(readFileSync(join(f.directory, 'protected-build/job.json'), 'utf8'));
    expect(job.request).toMatchObject({
      projectId: 'project-a',
      snapshot: 'attempt-a/verity-build-a',
      noCache: false,
    });
    expect(options.protectedBuild).toEqual({
      projectId: job.request.projectId,
      attemptId: job.request.attemptId,
    });
    expect(existsSync(join(f.directory, 'protected-build/registry.json'))).toBe(false);
  });
  it('does not register remote work while host readiness is missing', async () => {
    const f = fixture();
    health.mockResolvedValue({ version: 1, available: false });
    await expect(f.build(f.args)).rejects.toThrow('not ready');
    expect(f.run).not.toHaveBeenCalled();
    expect(existsSync(join(f.directory, 'protected-build'))).toBe(false);
  });
  it('does not import after a failed host build', async () => {
    const f = fixture();
    f.run.mockResolvedValue({ stdout: '{"success":false}', stderr: '' });
    await expect(f.build(f.args)).rejects.toThrow('build failed');
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('preserves safe host refusal diagnostics after confirmed failed termination', async () => {
    const f = fixture();
    const correlationId = '22222222-2222-4222-8222-222222222222';
    f.run.mockResolvedValue({
      stdout: JSON.stringify({
        success: false,
        failure: { reason: 'files_prepare_failed', correlationId },
      }),
      stderr: '',
    });
    await expect(f.build(f.args)).rejects.toThrow(
      `files_prepare_failed; reference ${correlationId}`,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('passes bounded post-termination diagnostics into the existing failure recorder', async () => {
    const f = fixture();
    f.run.mockImplementation(async () => {
      writeFileSync(
        join(f.directory, 'protected-build/build.log'),
        'destination was not approved',
        { mode: 0o600 },
      );
      return { stdout: '{"success":false}', stderr: '' };
    });
    await expect(f.build(f.args)).rejects.toMatchObject({ stderr: 'destination was not approved' });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('retains private inputs when remote execution is uncertain', async () => {
    const f = fixture();
    Object.defineProperty(f.lease, 'retainArtifacts', { value: true });
    f.run.mockRejectedValue(new Error('transport disconnected'));
    await expect(f.build(f.args)).rejects.toThrow('transport disconnected');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(f.directory, 'protected-build/registry.json'))).toBe(true);
  });
  it('requires explicit project and managed storage ownership', async () => {
    const f = fixture();
    const noProject: Parameters<typeof f.build>[0] = { ...f.args };
    delete noProject.projectId;
    const noLease: Parameters<typeof f.build>[0] = { ...f.args };
    delete noLease.storageLease;
    await expect(f.build(noProject)).rejects.toThrow('project identity');
    await expect(f.build(noLease)).rejects.toThrow('managed build storage');
    expect(f.run).not.toHaveBeenCalled();
  });
});
