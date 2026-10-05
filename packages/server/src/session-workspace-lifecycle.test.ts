import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvisionerImpl, type ProvisionerOptions } from './provisioner.js';
import type { ContainerCommandRunner } from './devcontainer-lifecycle.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(failHook = false) {
  const root = mkdtempSync(join(tmpdir(), 'verity-private-lifecycle-'));
  roots.push(root);
  const path = join(root, 'checkout');
  const runtime = join(root, 'runtime');
  mkdirSync(join(path, '.devcontainer'), { recursive: true });
  mkdirSync(runtime);
  writeFileSync(
    join(path, '.devcontainer/devcontainer.json'),
    JSON.stringify({ remoteUser: 'root', postCreateCommand: 'npm ci && echo private-hook' }),
  );
  const commands: string[] = [];
  const containerCommand = vi.fn<ContainerCommandRunner>(async ({ command }) => {
    commands.push(command);
    if (failHook && command.includes('private-hook')) throw new Error('hook failed');
    return { stdout: '', stderr: '' };
  });
  const provisioner = new ProvisionerImpl({
    docker: { ensureNetwork: vi.fn() },
    claudeEgressGatewayUrl: 'https://relay:8443',
    dockerHostForBuild: 'unix:///docker.sock',
    containerCommand,
    supervisorReachable: async () => {
      commands.push('ready');
    },
  } as unknown as ProvisionerOptions);
  return {
    provisioner,
    runtime,
    workspace: { path, waitForPostCreate: true },
    commands,
    containerCommand,
  };
}
describe('private devcontainer lifecycle', () => {
  it('installs dependencies and runs private post-create before releasing post-start and admitting turns', async () => {
    const f = fixture();
    await f.provisioner.startSessionRuntime('private', f.runtime, f.workspace);
    expect(f.commands[0]).toBe('verity-runner-stack-start');
    expect(f.commands[1]).toContain('verity-node-modules-install --wait');
    expect(f.commands[2]).toContain('npm ci && echo private-hook');
    expect(f.containerCommand.mock.calls[2]?.[0]).toMatchObject({
      containerName: 'private',
      user: '1000:1000',
      workdir: '/work',
    });
    expect(f.commands.slice(3)).toEqual(['touch /tmp/verity-post-create-complete', 'ready']);
    f.commands.length = 0;
    await f.provisioner.startSessionRuntime('private', f.runtime, f.workspace);
    expect(f.commands).toEqual([
      'verity-runner-stack-start',
      'touch /tmp/verity-post-create-complete',
      'ready',
    ]);
    f.commands.length = 0;
    await f.provisioner.startSessionRuntime('private', f.runtime, {
      ...f.workspace,
      freshContainer: true,
    });
    expect(f.commands.some((command) => command.includes('private-hook'))).toBe(true);
  });
  it('keeps the inherited startup gate closed after a failed post-create', async () => {
    const f = fixture(true);
    await expect(
      f.provisioner.startSessionRuntime('private', f.runtime, f.workspace),
    ).rejects.toThrow('hook failed');
    expect(f.commands.some((command) => command.startsWith('touch '))).toBe(false);
    expect(f.commands).not.toContain('ready');
    expect(existsSync(join(f.runtime, 'workspace-post-create-complete'))).toBe(false);
  });
});
