import { expect, it } from 'vitest';
import {
  createDockerExecDiagnostics,
  DOCKER_EXEC_PURPOSES,
  measureDockerExec,
} from './docker-exec-diagnostics.js';

it('tracks overlapping exec lifetimes and finishes error/close pairs only once', () => {
  let now = 0;
  const diagnostics = createDockerExecDiagnostics(() => now);
  const watcher = diagnostics.begin('listener-watch');
  now = 5;
  const git = diagnostics.begin('git');
  expect(diagnostics.snapshot()).toMatchObject({ active: 2, peak: 2, started: 2 });
  now = 10;
  git(Object.assign(new Error('private command output'), { code: 'EAGAIN' }));
  git();
  now = 20;
  watcher();
  const snapshot = diagnostics.snapshot();
  expect(snapshot).toMatchObject({
    active: 0,
    peak: 2,
    started: 2,
    completed: 2,
    failed: 1,
    eagain: 1,
    elapsedMs: 25,
    maxElapsedMs: 20,
  });
  expect(snapshot.purposes.find(({ purpose }) => purpose === 'git')).toMatchObject({
    started: 1,
    completed: 1,
    failed: 1,
    eagain: 1,
    elapsedMs: 5,
  });
  expect(JSON.stringify(snapshot)).not.toContain('private');
});

it('keeps only fixed counters and returns detached snapshots', () => {
  const diagnostics = createDockerExecDiagnostics(() => 0);
  for (let index = 0; index < 1000; index++) diagnostics.begin('runtime')();
  const snapshot = diagnostics.snapshot();
  snapshot.active = 999;
  snapshot.purposes[0]!.started = 999;
  expect(diagnostics.snapshot().purposes.map(({ purpose }) => purpose)).toEqual(
    DOCKER_EXEC_PURPOSES,
  );
  expect(diagnostics.snapshot()).toMatchObject({ active: 0, started: 1000 });
  expect(diagnostics.snapshot().purposes[0]!.started).toBe(0);
});

it('preserves async results and the exact original failure', async () => {
  const result = {};
  expect(await measureDockerExec('lifecycle', () => Promise.resolve(result))).toBe(result);
  const error = Object.assign(new Error('private error'), { code: 'EAGAIN' });
  await expect(measureDockerExec('runtime', () => Promise.reject(error))).rejects.toBe(error);
});
