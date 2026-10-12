import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runAgentSpawnBroker } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { DockerProjectRuntime, type RuntimeRunner } from './project-runtime.js';
import type { ProjectRecord } from '@verity/store';

it('starts and stops a secret server through the stdin bridge and protected broker socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-secret-server-integration-'));
  const runtimeDir = join(root, 'runtime');
  await mkdir(runtimeDir, { mode: 0o700 });
  await mkdir(join(root, 'private'), { mode: 0o700 });
  const broker = await runAgentSpawnBroker({
    runtimeDir,
    worktreeRoot: root,
    enforceRoot: false,
    agentUid: Math.max(1, process.getuid?.() ?? 1000),
    agentGid: Math.max(1, process.getgid?.() ?? 1000),
    scriptIsolation: { available: true },
    spawnChild: (_command, args, options) => spawn('/bin/sh', args.slice(-6), options),
  });
  const runner: RuntimeRunner = async (_command, args, options) => {
    // Production uses Docker exec as root; the fixture substitutes only its transport.
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '--user', '0']);
    expect(JSON.stringify(args)).not.toContain('synthetic-broker-key');
    expect(
      Object.values(options?.env ?? {}).some((value) => value?.includes('synthetic-broker-key')),
    ).toBe(false);
    const bridge = args
      .at(-1)!
      .replace('/run/verity-runner-broker/agent-spawn-broker.sock', broker.socketPath);
    return await new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['-e', bridge],
        { timeout: 10_000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(error.message));
          else resolve({ stdout, stderr });
        },
      );
      child.stdin?.end(options?.stdin);
    });
  };
  const runtime = new DockerProjectRuntime({ runner });
  const project = { containerName: 'fixture' } as ProjectRecord;
  const instanceId = randomUUID();
  try {
    expect(
      await runtime.startManagedServer(project, {
        instanceId,
        command: 'echo "$API_KEY"; sleep 30',
        worktree: root,
        workdir: 'private',
        env: { PORT: '41000' },
        secrets: [{ env: 'API_KEY', value: 'synthetic-broker-key' }],
      }),
    ).toEqual({ ok: true });
    // Every bridge connection has ended; the managed process still belongs to the broker.
    expect(await runtime.managedServerStatus(project, instanceId)).toMatchObject({ alive: true });
    expect(await runtime.managedServerLogs(project, instanceId)).toContain('disabled');
    expect(await readdir(join(root, 'private'))).toEqual([]);
    await runtime.stopManagedServer(project, instanceId);
    expect(await runtime.managedServerStatus(project, instanceId)).toMatchObject({ alive: false });
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
