import type { ProjectRecord } from '@verity/store';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';

import { DockerError, type DockerClient } from './docker.js';
import {
  reconcileProjectContainerStates,
  CONTAINER_PAUSED_REASON,
  CONTAINER_RESTARTING_REASON,
  CONTAINER_STOPPED_REASON,
  CONTAINER_MISSING_REASON,
  STALE_PROVISIONING_REASON,
} from './project-state.js';

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global-verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    createdAt: new Date('2026-06-29T00:00:00.000Z'),
    updatedAt: new Date('2026-06-29T00:00:00.000Z'),
    stateChangedAt: new Date('2026-06-29T00:00:00.000Z'),
    ...overrides,
  };
}

function docker(overrides: Partial<DockerClient>): DockerClient {
  return {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    inspectContainer: vi.fn(async (id: string) => ({ id, running: true })),
    ...overrides,
  };
}

describe('reconcileProjectContainerStates', () => {
  it('marks an active project FAILED (not absent) when its container is gone', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const result = await reconcileProjectContainerStates(
      [project({ state: 'active' })],
      docker({
        inspectContainer: vi.fn(async (id: string) => {
          throw new DockerError({ kind: 'container_not_found', id });
        }),
      }),
      update,
    );

    // NOT 'absent' — absent would hide the project ("unknown project").
    expect(update).toHaveBeenCalledWith('p1', 'failed', CONTAINER_MISSING_REASON);
    expect(result[0]?.state).toBe('failed');
  });

  it('does not reconcile control-plane projects against Docker containers', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const inspect = vi.fn(async (id: string) => {
      throw new DockerError({ kind: 'container_not_found', id });
    });
    const result = await reconcileProjectContainerStates(
      [project({ kind: 'control_plane', state: 'active' })],
      docker({ inspectContainer: inspect }),
      update,
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ kind: 'control_plane', state: 'active' });
  });

  it('marks an active project FAILED (not absent) when its container is stopped', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const result = await reconcileProjectContainerStates(
      [project({ state: 'active' })],
      docker({ inspectContainer: vi.fn(async (id: string) => ({ id, running: false })) }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'failed', CONTAINER_STOPPED_REASON);
    expect(result[0]?.state).toBe('failed');
  });

  // Docker can report `Running: true` for restarting and paused containers. Status
  // must take precedence so neither is mistaken for a healthy sandbox.
  it.each([
    ['restarting', true, CONTAINER_RESTARTING_REASON],
    ['paused', true, CONTAINER_PAUSED_REASON],
    ['exited', false, CONTAINER_STOPPED_REASON],
    [undefined, false, CONTAINER_STOPPED_REASON],
  ])('names why an unusable container failed (%s)', async (status, running, reason) => {
    const update = vi.fn(async (_id, state, provisionError) =>
      project({ state, provisionError: provisionError ?? null }),
    );
    const result = await reconcileProjectContainerStates(
      [project({ state: 'active' })],
      docker({
        inspectContainer: vi.fn(async (id: string) => ({
          id,
          running,
          ...(status === undefined ? {} : { status }),
        })),
      }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'failed', reason);
    expect(result[0]).toMatchObject({ state: 'failed', provisionError: reason });
  });

  it('self-heals a failed project back to active when its container is running again', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const result = await reconcileProjectContainerStates(
      [project({ state: 'failed', provisionError: CONTAINER_MISSING_REASON })],
      docker({ inspectContainer: vi.fn(async (id: string) => ({ id, running: true })) }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'active', null);
    expect(result[0]?.state).toBe('active');
  });

  it('clears an orphaned rebuild notice after the server process restarts', async () => {
    const update = vi.fn(async (_id, state, provisionError, provisionWarning) =>
      project({
        state,
        provisionError: provisionError ?? null,
        provisionWarning: provisionWarning ?? null,
      }),
    );
    const result = await reconcileProjectContainerStates(
      [project({ provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING })],
      docker({}),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'active', null, null);
    expect(result[0]?.provisionWarning).toBeNull();
  });

  it('preserves the rebuild notice while this server still owns the build', async () => {
    const update = vi.fn();
    const original = project({ provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING });
    const result = await reconcileProjectContainerStates(
      [original],
      docker({}),
      update,
      () => true,
    );

    expect(update).not.toHaveBeenCalled();
    expect(result[0]).toBe(original);
  });

  it('marks an absent project active when Docker reports a running container', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const result = await reconcileProjectContainerStates(
      [project({ state: 'absent' })],
      docker({ inspectContainer: vi.fn(async (id: string) => ({ id, running: true })) }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'active', null);
    expect(result[0]?.state).toBe('active');
  });

  it('does not rewrite fresh provisioning states', async () => {
    const update = vi.fn(async (_id, state) => project({ state }));
    const inspect = vi.fn(async (id: string) => ({ id, running: false }));
    const result = await reconcileProjectContainerStates(
      [
        project({ state: 'cloning', stateChangedAt: new Date() }),
        project({ id: 'p2', state: 'container_starting', stateChangedAt: new Date() }),
      ],
      docker({ inspectContainer: inspect }),
      update,
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.map((p) => p.state)).toEqual(['cloning', 'container_starting']);
  });

  it('marks a stale provisioning state FAILED when its container is gone', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const update = vi.fn(async (_id, state, provisionError) =>
      project({ state, provisionError: provisionError ?? null }),
    );
    const result = await reconcileProjectContainerStates(
      [project({ state: 'container_starting', stateChangedAt: stale })],
      docker({
        inspectContainer: vi.fn(async (id: string) => {
          throw new DockerError({ kind: 'container_not_found', id });
        }),
      }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'failed', STALE_PROVISIONING_REASON);
    expect(result[0]).toMatchObject({
      state: 'failed',
      provisionError: STALE_PROVISIONING_REASON,
    });
  });

  it('ages a stuck provisioning state off stateChangedAt, not a churning updatedAt', async () => {
    // Regression: the GitHub installation sync bumps `updated_at` on every pass
    // while deliberately preserving `state`. Measuring staleness against it let a
    // project whose container start failed sit in `container_starting` forever —
    // the relay reconciler only looks at `active` projects, so nothing else ever
    // picked it up and the app showed a permanent "starting…" with no Repair.
    const update = vi.fn(async (_id, state, provisionError) =>
      project({ state, provisionError: provisionError ?? null }),
    );
    const result = await reconcileProjectContainerStates(
      [
        project({
          state: 'container_starting',
          stateChangedAt: new Date(Date.now() - 10 * 60_000),
          updatedAt: new Date(),
        }),
      ],
      docker({
        inspectContainer: vi.fn(async (id: string) => {
          throw new DockerError({ kind: 'container_not_found', id });
        }),
      }),
      update,
    );

    expect(update).toHaveBeenCalledWith('p1', 'failed', STALE_PROVISIONING_REASON);
    expect(result[0]?.state).toBe('failed');
  });
});
