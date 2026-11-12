import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import {
  PROJECT_SANDBOX_IDLE_TIMEOUT_MS,
  persistentSandboxActivityReasons,
  observeProjectActivity,
  activityReasons,
  activityObservations,
  recreateRefusalMessage,
  startProjectIdleSleepScheduler,
} from './project-idle-sleep.js';

const project = (id: string, state: ProjectRecord['state'] = 'active'): ProjectRecord =>
  ({ id, state }) as ProjectRecord;

describe('project idle sleep scheduler', () => {
  it('uses the product idle window of 30 minutes', () => {
    expect(PROJECT_SANDBOX_IDLE_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it('reports each observed lifecycle inventory', async () => {
    const projects = [project('p1'), project('p2', 'sleeping')];
    const onSweep = vi.fn();
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => projects,
      isBusy: async () => false,
      sleepProject: async () => undefined,
      idleMs: 300,
      onSweep,
      startTimer: false,
    });

    await scheduler.runOnce();
    expect(onSweep).toHaveBeenCalledWith(projects);
  });

  it('never considers the internal control-plane project for sleep', async () => {
    let at = 1_000;
    const sleepProject = vi.fn(async () => undefined);
    const scheduler = startProjectIdleSleepScheduler({
      listProjects: async () => [{ ...project('control'), kind: 'control_plane' }],
      isBusy: async () => false,
      sleepProject,
      idleMs: 300,
      now: () => at,
      startTimer: false,
    });

    await scheduler.runOnce();
    at += 300;
    await scheduler.runOnce();
    expect(sleepProject).not.toHaveBeenCalled();
  });

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
      persistentSandboxActivityReasons({ listShares: async () => [{ state: 'active' } as never] }),
    ).resolves.toEqual(['preview']);
  });

  it('keeps a project awake for an active local share without consulting public storage', async () => {
    const listShares = vi.fn(async () => []);
    await expect(
      persistentSandboxActivityReasons({ listShares, hasLocalPreviewShares: () => true }),
    ).resolves.toEqual(['preview']);
    expect(listShares).not.toHaveBeenCalled();
  });

  it('names a running dev server apart from a preview', async () => {
    // The remedy differs — stop the server versus stop sharing — so the two must
    // stay distinguishable all the way to the person reading the status.
    await expect(
      persistentSandboxActivityReasons({
        listShares: async () => [],
        hasRunningDevServers: () => true,
      }),
    ).resolves.toEqual(['dev_server']);
  });

  it('releases the activity lease after all shares are inactive', async () => {
    await expect(
      persistentSandboxActivityReasons({
        listShares: async () => [{ state: 'expired' } as never, { state: 'revoked' } as never],
        hasLocalPreviewShares: () => false,
        hasRunningDevServers: () => false,
      }),
    ).resolves.toEqual([]);
  });
});

it('lets a stopped managed server sleep while its public link stays valid', async () => {
  await expect(
    persistentSandboxActivityReasons({
      listShares: async () => [{ state: 'active', managedInstanceId: 'instance-1' } as never],
      hasLocalPreviewShares: () => false,
    }),
  ).resolves.toEqual([]);
});

describe('recreateRefusalMessage', () => {
  it('names the activity that holds the sandbox, a turn first', () => {
    expect(recreateRefusalMessage('p1', ['preview', 'turn'])).toContain('has a turn in flight');
    expect(recreateRefusalMessage('p1', ['dev_server', 'preview'])).toContain('running dev server');
    expect(recreateRefusalMessage('p1', ['preview'])).toContain('shared as a preview');
  });
});

describe('structured project activity', () => {
  const input = () => ({
    projectId: 'p1',
    listSessions: async () => [
      { projectId: 'p1', sessionId: 'running' },
      { projectId: 'p1', sessionId: 'excepted' },
      { projectId: 'other', sessionId: 'foreign' },
    ],
    exceptSessionIds: new Set(['excepted']),
    isTurnBusy: () => true,
    hasRunningDevServers: () => true,
    hasLocalPreviewShares: () => true,
    listShares: async () => [
      { id: 'share-active', state: 'active' } as never,
      { id: 'share-managed', state: 'active', managedInstanceId: 'offline-server' } as never,
      { id: 'share-expired', state: 'expired' } as never,
    ],
  });

  it('retains reliable owner IDs and filters excepted sessions and offline links', async () => {
    const snapshot = await observeProjectActivity(input());
    expect(snapshot.observations).toEqual([
      { reason: 'turn', source: 'sessions', sessionId: 'running' },
      { reason: 'dev_server', source: 'dev_server' },
      { reason: 'preview', source: 'local_preview' },
      { reason: 'preview', source: 'public_preview', shareId: 'share-active' },
    ]);
    expect(activityReasons(snapshot)).toEqual(['turn', 'dev_server', 'preview']);
  });

  it.each(['sessions', 'dev_server', 'local_preview', 'public_preview'] as const)(
    'preserves other observations when %s cannot answer',
    async (source) => {
      const probes = input();
      const fail = () => {
        throw new Error('secret-canary-in-probe');
      };
      if (source === 'sessions') probes.listSessions = fail;
      if (source === 'dev_server') probes.hasRunningDevServers = fail;
      if (source === 'local_preview') probes.hasLocalPreviewShares = fail;
      if (source === 'public_preview') probes.listShares = fail;
      const snapshot = await observeProjectActivity(probes);
      expect(snapshot.observations).toContainEqual({ reason: 'unknown', source });
      expect(snapshot.observations.length).toBe(4);
      expect(activityReasons(snapshot)).toContain('unknown');
      expect(JSON.stringify(snapshot)).not.toContain('secret-canary');
    },
  );

  it('keeps legacy boolean answers compatible without inventing owners or turns', () => {
    expect(activityObservations(false)).toEqual([]);
    expect(activityObservations([])).toEqual([]);
    expect(activityObservations(true)).toEqual([{ reason: 'unknown', source: 'busy_probe' }]);
    expect(recreateRefusalMessage('p1', ['unknown'])).toContain('could not be confirmed idle');
    expect(recreateRefusalMessage('p1', ['unknown'])).not.toContain('preview');
  });
});
