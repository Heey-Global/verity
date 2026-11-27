import type { ProjectRecord } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerLiveness } from './container-liveness.js';
import type { ContainerEventHandlers } from './docker-container-events.js';
import type { DockerClient } from './docker.js';
import { CONTAINER_STOPPED_REASON } from './project-state.js';

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    containerName: `dev-${id}`,
    state: 'active',
    provisionError: null,
    provisionWarning: null,
    stateChangedAt: new Date('2026-11-27T00:00:00Z'),
    ...overrides,
  } as ProjectRecord;
}

function setup(rows: ProjectRecord[], options: { stream?: boolean } = {}) {
  const projects = new Map(rows.map((row) => [row.id, row]));
  const running = new Map(rows.map((row) => [row.containerName, true]));
  let handlers: ContainerEventHandlers | undefined;
  const stopStream = vi.fn(async () => undefined);
  const inspectContainer = vi.fn(async (id: string) => ({ id, running: running.get(id) ?? false }));
  const docker = {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    inspectContainer,
    ...(options.stream === false
      ? {}
      : {
          followContainerEvents: (next: ContainerEventHandlers) => {
            handlers = next;
            return stopStream;
          },
        }),
  } as unknown as DockerClient;
  const updateProjectState = vi.fn(async (id: string, state: ProjectRecord['state'], error) => {
    const next = { ...projects.get(id)!, state, provisionError: error ?? null };
    projects.set(id, next);
    return next;
  });
  const liveness = createContainerLiveness({
    eventStore: {
      getProject: async (id: string) => projects.get(id),
      listProjects: async () => [...projects.values()],
      updateProjectState,
    },
    docker,
    provisioner: undefined,
    log: { warn: () => undefined },
    intervals: { full: 300_000, transitions: 60_000 },
  });
  return {
    liveness,
    inspectContainer,
    updateProjectState,
    stopStream,
    handlers: () => handlers!,
    stopContainer: (projectId: string) => running.set(`dev-${projectId}`, false),
    state: (projectId: string) => projects.get(projectId)?.state,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createContainerLiveness', () => {
  // The point of the stream: a sandbox that died outside Verity shows as
  // failed at once, not at the next read that happens to inspect it.
  it('marks a project whose container died as soon as Docker reports it', async () => {
    const l = setup([project('p1'), project('p2')]);
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(l.inspectContainer).toHaveBeenCalledTimes(2));
    l.inspectContainer.mockClear();

    l.stopContainer('p1');
    l.handlers().onEvent('p1', 'die');
    await vi.waitFor(() =>
      expect(l.updateProjectState).toHaveBeenCalledWith(
        'p1',
        'failed',
        CONTAINER_STOPPED_REASON,
        undefined,
      ),
    );
    // Only the project the event named is inspected.
    expect(l.inspectContainer.mock.calls).toEqual([['dev-p1']]);
    expect(l.state('p1')).toBe('failed');
    await stop();
    expect(l.stopStream).toHaveBeenCalled();
  });

  // Reads skip their inspection only while the stream reports; a dropped
  // stream must hand that duty back to them, and a reconnect must catch up on
  // whatever happened while it was down.
  it('is following only while the stream is open, and catches up after a reconnect', async () => {
    const l = setup([project('p1')]);
    const stop = l.liveness.start();
    expect(l.liveness.following()).toBe(false);
    l.handlers().onConnected();
    expect(l.liveness.following()).toBe(true);
    l.handlers().onDisconnected(new Error('daemon restarting'));
    expect(l.liveness.following()).toBe(false);

    l.stopContainer('p1');
    l.handlers().onConnected();
    await vi.waitFor(() => expect(l.state('p1')).toBe('failed'));
    await stop();
    expect(l.liveness.following()).toBe(false);
  });

  // A provisioning that hangs ends by a timeout, not an event; the full
  // comparison catches whatever the stream missed.
  it('compares projects in a transition every minute and all every five', async () => {
    vi.useFakeTimers();
    const l = setup([project('p1'), project('p2', { state: 'container_starting' })]);
    const stop = l.liveness.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.inspectContainer.mock.calls).toEqual([['dev-p2']]);
    l.inspectContainer.mockClear();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(new Set(l.inspectContainer.mock.calls.map(([name]) => name))).toEqual(
      new Set(['dev-p1', 'dev-p2']),
    );
    await stop();
    l.inspectContainer.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(l.inspectContainer).not.toHaveBeenCalled();
  });

  it('never follows without an event stream, so reads keep comparing', () => {
    const l = setup([project('p1')], { stream: false });
    const stop = l.liveness.start();
    expect(l.liveness.following()).toBe(false);
    return stop();
  });
});
