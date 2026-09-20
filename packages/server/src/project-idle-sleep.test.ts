import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectRuntime } from './project-runtime.js';
import {
  projectHasPersistentSandboxActivity,
  startProjectIdleSleepScheduler,
} from './project-idle-sleep.js';

const project = (id: string, state: ProjectRecord['state'] = 'active'): ProjectRecord =>
  ({ id, state }) as ProjectRecord;

describe('project idle sleep scheduler', () => {
  it('sleeps an active project only after one complete idle window', async () => {
    let at = 1_000;
    const sleepProject = vi.fn(async () => undefined);
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [project('p1')],
      isBusy: async () => false,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    at += 299;
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
    at += 1;
    await scheduler.runOnce();
    expect(sleepProject).toHaveBeenCalledOnce();
  });

  it('resets the idle window when work or a persistent runtime is active', async () => {
    let at = 1_000;
    let busy = false;
    const sleepProject = vi.fn(async () => undefined);
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [project('p1')],
      isBusy: async () => busy,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    at += 300;
    busy = true;
    await scheduler.runOnce();
    busy = false;
    at += 299;
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
    at += 1;
    await scheduler.runOnce();
    expect(sleepProject).toHaveBeenCalledOnce();
  });

  it('rechecks activity immediately before sleeping', async () => {
    let at = 1_000;
    const isBusy = vi.fn(async () => false);
    const sleepProject = vi.fn(async () => undefined);
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [project('p1')],
      isBusy,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    at += 300;
    isBusy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
  });

  it('observes work that started and ended between scheduler passes', async () => {
    let at = 1_000;
    const activity: { at: number | undefined } = { at: undefined };
    const sleepProject = vi.fn(async () => undefined);
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [project('p1')],
      isBusy: async () => false,
      lastActivityAt: () => activity.at,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    activity.at = 1_250;
    at = 1_300;
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
    at = 1_550;
    await scheduler.runOnce();
    expect(sleepProject).toHaveBeenCalledOnce();
  });

  it('contains project-list failures from the timer boundary', async () => {
    const error = new Error('database unavailable');
    const onError = vi.fn();
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => Promise.reject(error),
      isBusy: async () => false,
      sleepProject: async () => undefined,
      idleMs: 300,
      onError,
      startTimer: false,
    });

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(undefined, error);
  });

  it('observes activity that completes during the asynchronous busy checks', async () => {
    let at = 1_000;
    let lastActivityAt: number | undefined;
    const sleepProject = vi.fn(async () => undefined);
    const isBusy = vi.fn(async () => {
      if (isBusy.mock.calls.length === 3) lastActivityAt = 1_301;
      return false;
    });
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [project('p1')],
      isBusy,
      lastActivityAt: () => lastActivityAt,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    at = 1_300;
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
  });
});

describe('persistent Sandbox activity', () => {
  it('keeps a project awake for an active public preview', async () => {
    await expect(
      projectHasPersistentSandboxActivity({
        project: project('p1'),
        listShares: async () => [{ state: 'active' } as never],
        listDevServers: async () => [],
      }),
    ).resolves.toBe(true);
  });

  it('keeps a project awake while any configured dev server is running', async () => {
    const runtime = {
      devServerStatus: vi.fn(async () => ({ running: true })),
    } as unknown as ProjectRuntime;
    await expect(
      projectHasPersistentSandboxActivity({
        project: project('p1'),
        listShares: async () => [],
        listDevServers: async () => [
          {
            id: 'dev-1',
            command: 'npm run dev',
            url: null,
            workdir: null,
            hostPort: null,
            containerPort: null,
          } as never,
        ],
        runtime,
      }),
    ).resolves.toBe(true);
  });

  it('fails closed when dev-server state cannot be read', async () => {
    const runtime = {
      devServerStatus: vi.fn(async () => {
        throw new Error('Docker unavailable');
      }),
    } as unknown as ProjectRuntime;
    await expect(
      projectHasPersistentSandboxActivity({
        project: project('p1'),
        listShares: async () => [],
        listDevServers: async () => [{ id: 'dev-1' } as never],
        runtime,
      }),
    ).resolves.toBe(true);
  });
});
