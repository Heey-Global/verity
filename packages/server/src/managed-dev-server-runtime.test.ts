import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@verity/store';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerProjectRuntime, type RuntimeRunner } from './project-runtime.js';

const exec = promisify(execFile);

/** Runs the `docker exec` payload in a local shell, so the scripts are exercised
 *  for real rather than compared as strings. */
const localRunner: RuntimeRunner = async (_command, args, opts) => {
  const rest = [...args];
  if (rest.shift() !== 'exec') throw new Error('expected docker exec');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  while (rest[0]?.startsWith('-')) {
    const flag = rest.shift()!;
    if (flag === '-e') {
      const value = rest.shift()!;
      const eq = value.indexOf('=');
      if (eq === -1) env[value] = opts?.env?.[value];
      else env[value.slice(0, eq)] = value.slice(eq + 1);
    } else if (flag === '--user' || flag === '-w') rest.shift();
  }
  rest.shift(); // container name
  const [program, ...programArgs] = rest;
  const result = await exec(program!, programArgs, { env, timeout: opts?.timeoutMs });
  return { stdout: result.stdout, stderr: result.stderr };
};

const project = {
  id: `managed-test-${String(process.pid)}`,
  containerName: 'local',
} as ProjectRecord;
const runtime = new DockerProjectRuntime({ runner: localRunner });
const roots: string[] = [];
const started: string[] = [];

afterEach(async () => {
  for (const id of started.splice(0)) await runtime.stopManagedServer(project, id);
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'verity-managed-'));
  roots.push(root);
  mkdirSync(join(root, 'app'));
  return root;
}

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met');
};

describe('managed dev server runtime scripts', () => {
  // A symlink inside the worktree can point anywhere in the shared sandbox; the
  // start must resolve it and refuse to launch outside this session's worktree.
  it('refuses a subdirectory that is missing or escapes through a symlink', async () => {
    const root = worktree();
    const outside = worktree();
    symlinkSync(outside, join(root, 'escape'));
    const base = { command: 'sleep 30', worktree: root, env: {} };
    expect(
      await runtime.startManagedServer(project, { ...base, instanceId: 'm1', workdir: 'missing' }),
    ).toEqual({ ok: false, reason: 'The subdirectory does not exist in this session' });
    expect(
      await runtime.startManagedServer(project, { ...base, instanceId: 'm2', workdir: 'escape' }),
    ).toEqual({ ok: false, reason: 'The subdirectory leaves the session worktree' });
  });

  // Children inherit the tag, so status and stop still find a server that forked.
  it('tags the process tree, reports it alive, and stops only tagged processes', async () => {
    const root = worktree();
    started.push('m3');
    const untagged = execFile('sleep', ['30']);
    try {
      expect(
        await runtime.startManagedServer(project, {
          instanceId: 'm3',
          command: 'echo "port=$PORT"; sleep 30 & wait',
          worktree: root,
          workdir: 'app',
          env: { PORT: '41000' },
        }),
      ).toEqual({ ok: true });
      await waitFor(async () => (await runtime.managedServerStatus(project, 'm3')).alive);
      await waitFor(async () =>
        (await runtime.managedServerLogs(project, 'm3')).includes('port=41000'),
      );
      await runtime.stopManagedServer(project, 'm3');
      expect(await runtime.managedServerStatus(project, 'm3')).toMatchObject({ alive: false });
      expect(untagged.exitCode).toBeNull();
    } finally {
      untagged.kill();
    }
  });

  it('records the exit code of a command that ends', async () => {
    const root = worktree();
    started.push('m4');
    await runtime.startManagedServer(project, {
      instanceId: 'm4',
      command: 'exit 7',
      worktree: root,
      workdir: '.',
      env: {},
    });
    await waitFor(async () => (await runtime.managedServerStatus(project, 'm4')).exitCode !== null);
    expect(await runtime.managedServerStatus(project, 'm4')).toEqual({ alive: false, exitCode: 7 });
  });
});
