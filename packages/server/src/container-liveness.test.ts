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
  const getProject = vi.fn(async (id: string) => projects.get(id));
  const listProjects = vi.fn(async () => [...projects.values()]);
  const liveness = createContainerLiveness({
    eventStore: {
      getProject,
      listProjects,
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
    getProject,
    listProjects,
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
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
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

  // Until every project has been compared after the stream opened, the rows
  // may still miss what happened while it was down.
  it('lets reads rely on the rows only once the catch-up is done', async () => {
    const l = setup([project('p1')]);
    let release!: () => void;
    l.inspectContainer.mockImplementationOnce(
      (id: string) => new Promise((resolve) => (release = () => resolve({ id, running: true }))),
    );
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(l.liveness.following()).toBe(false);
    release();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    await stop();
  });

  // A catch-up folded into a running sweep would compare only the projects
  // that sweep filtered for, with rows read before what it must catch up on.
  it('runs a full comparison asked for during a filtered sweep after it', async () => {
    vi.useFakeTimers();
    const l = setup([project('p1'), project('p2', { state: 'container_starting' })]);
    let release!: () => void;
    l.inspectContainer.mockImplementationOnce(
      (id: string) => new Promise((resolve) => (release = () => resolve({ id, running: true }))),
    );
    const stop = l.liveness.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.inspectContainer.mock.calls).toEqual([['dev-p2']]);
    l.handlers().onConnected();
    release();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    expect(l.inspectContainer.mock.calls.map(([name]) => name)).toContain('dev-p1');
    await stop();
  });

  // Stopping comes with the server closing its store: a comparison still
  // writing then, or one an event starts afterwards, would write into it.
  it('waits for comparisons under way when stopped, and starts no more', async () => {
    const l = setup([project('p1')]);
    let release!: () => void;
    l.inspectContainer.mockImplementationOnce(
      (id: string) => new Promise((resolve) => (release = () => resolve({ id, running: false }))),
    );
    const stop = l.liveness.start();
    l.handlers().onEvent('p1', 'die');
    await vi.waitFor(() => expect(release).toBeDefined());
    let stoppedAll = false;
    const stopping = stop().then(() => (stoppedAll = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stoppedAll).toBe(false);
    release();
    await stopping;
    l.inspectContainer.mockClear();
    l.getProject.mockClear();
    l.handlers().onEvent('p1', 'start');
    await new Promise((resolve) => setImmediate(resolve));
    expect(l.getProject).not.toHaveBeenCalled();
    expect(l.inspectContainer).not.toHaveBeenCalled();
  });

  // Trusting rows whose catch-up failed would leave a sandbox that died while
  // the stream was down unnoticed until the next full comparison.
  it('lets reads rely on the rows only after a catch-up that succeeded', async () => {
    vi.useFakeTimers();
    const l = setup([project('p1')]);
    l.listProjects.mockRejectedValueOnce(new Error('store busy'));
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(l.liveness.following()).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(l.liveness.following()).toBe(true);
    await stop();
  });

  it('starts afresh after it was stopped', async () => {
    const l = setup([project('p1')]);
    await l.liveness.start()();
    const stop = l.liveness.start();
    l.stopContainer('p1');
    l.handlers().onEvent('p1', 'die');
    await vi.waitFor(() => expect(l.state('p1')).toBe('failed'));
    expect(l.liveness.start()).toBe(stop);
    await stop();
  });

  // A reported change the rows never took must not be read as current.
  it('hands comparing back to reads when an event cannot be compared', async () => {
    const l = setup([project('p1')]);
    const written = vi.fn();
    l.liveness.onStateWritten(written);
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    let release!: () => void;
    const rows = await l.listProjects();
    l.listProjects.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(rows))),
    );
    l.getProject.mockRejectedValueOnce(new Error('store busy'));
    l.handlers().onEvent('p1', 'die');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(l.liveness.following()).toBe(false);
    // The full pass it starts catches up, and a state it writes is announced.
    l.stopContainer('p1');
    release();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    expect(l.state('p1')).toBe('failed');
    expect(written).toHaveBeenCalled();
    await stop();
  });

  // A stream that answers after the stop belongs to no running follower; a
  // restart that inherited it would have reads trust rows nothing follows.
  it('ignores a stream that answers after the stop', async () => {
    vi.useFakeTimers();
    const l = setup([project('p1')]);
    await l.liveness.start()();
    const late = l.handlers();
    l.listProjects.mockClear();
    late.onConnected();
    expect(l.listProjects).not.toHaveBeenCalled();
    const stop = l.liveness.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(l.liveness.following()).toBe(false);
    await stop();
  });

  // A sweep that read the projects before an event it then failed to compare
  // has not caught up on it.
  it('does not count a sweep under way when an event fails as the catch-up', async () => {
    const l = setup([project('p1'), project('p2')]);
    const rows = await l.listProjects();
    const releases: (() => void)[] = [];
    l.listProjects.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(rows))),
    );
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    l.getProject.mockRejectedValueOnce(new Error('store busy'));
    l.handlers().onEvent('p2', 'die');
    await new Promise((resolve) => setImmediate(resolve));
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(l.liveness.following()).toBe(false);
    releases[1]!();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    await stop();
  });

  // An older inspect landing after a newer one would write a state the
  // container has already left, and reads would trust it.
  it('compares a project an event names after the sweep comparing it', async () => {
    const l = setup([project('p1')]);
    let release!: () => void;
    l.inspectContainer.mockImplementationOnce(
      (id: string) => new Promise((resolve) => (release = () => resolve({ id, running: false }))),
    );
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(release).toBeDefined());
    // The container came back while the sweep's inspect was out.
    l.handlers().onEvent('p1', 'start');
    release();
    await vi.waitFor(() => expect(l.inspectContainer).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(l.state('p1')).toBe('active'));
    await stop();
  });

  // The comparison keeps the row when Docker cannot answer; trusted, it would
  // hide the death the event reported until the next full comparison.
  it('hands comparing back to reads when Docker cannot be asked about an event', async () => {
    const l = setup([project('p1')]);
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    let release!: () => void;
    const rows = await l.listProjects();
    l.listProjects.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(rows))),
    );
    l.inspectContainer.mockRejectedValueOnce(new Error('daemon busy'));
    l.handlers().onEvent('p1', 'die');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(l.liveness.following()).toBe(false);
    release();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    await stop();
  });

  // A read compares outside the follower's queue; its write may land after a
  // catch-up that never saw it.
  it('stops relying on the rows when a read writes a state', async () => {
    const l = setup([project('p1')]);
    const stop = l.liveness.start();
    l.handlers().onConnected();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    let release!: () => void;
    const rows = await l.listProjects();
    l.listProjects.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(rows))),
    );
    l.stopContainer('p1');
    await l.liveness.reconcile([project('p1')]);
    expect(l.liveness.following()).toBe(false);
    release();
    await vi.waitFor(() => expect(l.liveness.following()).toBe(true));
    await stop();
  });

  it('never follows without an event stream, so reads keep comparing', () => {
    const l = setup([project('p1')], { stream: false });
    const stop = l.liveness.start();
    expect(l.liveness.following()).toBe(false);
    return stop();
  });
});
