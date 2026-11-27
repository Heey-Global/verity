import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '../api.js';
import { projectEventUpdate } from './projectEvents.js';

const project = {
  id: 'p1',
  name: 'P1',
  owner: 'o',
  repo: 'r',
  containerName: 'c',
  kind: 'github',
  imageRef: null,
  state: 'active',
  lifecycleState: 'sleeping',
  provisionError: null,
  provisionWarning: 'old warning',
  setupStatus: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies ProjectRecord;

describe('projectEventUpdate', () => {
  it('shows a lifecycle change at once and asks for the fields only the read carries', () => {
    const update = projectEventUpdate({
      t: 'sandbox.lifecycle',
      projectId: 'p1',
      rev: 1,
      state: 'container_starting',
      warning: null,
    })!;
    expect(update.reload).toBe(true);
    const next = update.patch(project);
    expect(next.state).toBe('container_starting');
    // Waking finished: the sleep state must not linger next to the new state.
    expect('lifecycleState' in next).toBe(false);
    expect(next.provisionWarning).toBeNull();
  });

  it('keeps sleep states as the routes show them', () => {
    const update = projectEventUpdate({
      t: 'sandbox.lifecycle',
      projectId: 'p1',
      rev: 1,
      state: 'active',
      lifecycleState: 'waking',
    })!;
    expect(update.patch(project)).toMatchObject({ state: 'active', lifecycleState: 'waking' });
  });

  it('leaves a state this app does not know to the read', () => {
    const update = projectEventUpdate({
      t: 'sandbox.lifecycle',
      projectId: 'p1',
      rev: 1,
      state: 'teleporting',
    })!;
    expect(update.patch(project)).toBe(project);
    expect(update.reload).toBe(true);
  });

  it('reads an update hint, whose detail the event does not carry', () => {
    const update = projectEventUpdate({
      t: 'sandbox.update',
      projectId: 'p1',
      rev: 1,
      available: true,
    })!;
    expect(update.patch(project)).toBe(project);
    expect(update.reload).toBe(true);
  });

  it('applies renames and setup status at once, ignoring unknown values', () => {
    const update = projectEventUpdate({
      t: 'project.changed',
      projectId: 'p1',
      rev: 1,
      patch: { name: 'Renamed', setupStatus: 'nonsense', containerName: 'x' },
    })!;
    expect(update.reload).toBe(true);
    expect(update.patch(project)).toEqual({ ...project, name: 'Renamed' });
  });

  // The release badge and the drift banner change only through this event
  // once nothing re-reads the project for them.
  it('applies the latest release and toolkit drift, and skips values it cannot read', () => {
    const release = projectEventUpdate({
      t: 'project.changed',
      projectId: 'p1',
      rev: 2,
      patch: {
        latestReleaseTag: 'v2.0.0',
        latestReleaseName: null,
        latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
        latestReleasePublishedAt: '2026-11-26T10:00:00Z',
        toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' },
      },
    })!;
    expect(release.patch(project)).toEqual({
      ...project,
      latestReleaseTag: 'v2.0.0',
      latestReleaseName: null,
      latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
      latestReleasePublishedAt: '2026-11-26T10:00:00Z',
      toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' },
    });
    const cleared = projectEventUpdate({
      t: 'project.changed',
      projectId: 'p1',
      rev: 3,
      patch: { toolkitDrift: null, latestReleaseTag: 7 },
    })!;
    expect(cleared.patch({ ...project, latestReleaseTag: 'v1' })).toEqual({
      ...project,
      latestReleaseTag: 'v1',
      toolkitDrift: null,
    });
  });

  it('ignores events about sessions', () => {
    expect(projectEventUpdate({ t: 'choices.opened', sessionId: 's1', rev: 1 })).toBeUndefined();
  });
});
