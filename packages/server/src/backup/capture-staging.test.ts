import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withCaptureStaging } from './capture-staging.js';

it('recovers only owned unlocked runs and preserves active staging and unrelated data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-recovery-'));
  const capture = join(root, 'capture');
  await mkdir(capture);
  for (const name of ['run-ABC123', 'run-DEF456', 'foreign']) {
    await mkdir(join(capture, name));
    await writeFile(join(capture, name, 'data'), name);
  }
  await writeFile(join(capture, 'run-ABC123', 'owner'), 'verity-capture-v1');
  await writeFile(join(capture, 'run-DEF456', 'owner'), 'foreign');
  await symlink(join(capture, 'foreign'), join(capture, 'run-GHI789'));
  await mkdir(join(root, 'backup-state'));
  await writeFile(join(root, 'backup-state', 'index'), 'reusable uploads');
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: (path: string) => void;
  const ready = new Promise<string>((resolve) => {
    started = resolve;
  });
  const active = withCaptureStaging(root, async (run) => {
    started(run);
    await waiting;
  });
  try {
    const path = await ready;
    await withCaptureStaging(root, async () => {
      await expect(access(join(capture, 'run-ABC123'))).rejects.toThrow();
      await access(path);
      expect(await readFile(join(capture, 'run-DEF456', 'data'), 'utf8')).toBe('run-DEF456');
      expect(await readFile(join(capture, 'foreign', 'data'), 'utf8')).toBe('foreign');
      expect(await readFile(join(root, 'backup-state', 'index'), 'utf8')).toBe('reusable uploads');
    });
    finish();
    await active;
    await expect(access(path)).rejects.toThrow();
    await expect(
      withCaptureStaging(root, async () => {
        throw new Error('capture failed');
      }),
    ).rejects.toThrow('capture failed');
  } finally {
    finish();
    await active;
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers staging after the lock-owning process is killed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-crash-'));
  const run = join(root, 'capture', 'run-KILLED');
  await mkdir(run, { recursive: true });
  await writeFile(join(run, 'owner'), 'verity-capture-v1');
  const child = spawn(
    'flock',
    [
      '--no-fork',
      '--exclusive',
      '--nonblock',
      join(run, 'lock'),
      'sh',
      '-c',
      'printf ready; exec cat',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Lock process exited before readiness')));
    });
    await withCaptureStaging(root, async () => {
      await access(run);
    });
    child.kill('SIGKILL');
    await exited;
    await withCaptureStaging(root, async () => {
      await expect(access(run)).rejects.toThrow();
    });
  } finally {
    child.kill('SIGKILL');
    child.stdin.end();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
