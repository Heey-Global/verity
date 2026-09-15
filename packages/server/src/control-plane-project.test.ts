import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { ensureControlPlaneProject } from './control-plane-project.js';

const project = (setupStatus: ProjectRecord['setupStatus'] = 'complete'): ProjectRecord =>
  ({
    id: 'verity-control',
    kind: 'control_plane',
    owner: 'verity',
    repo: 'control',
    containerName: 'verity-control',
    state: 'active',
    setupStatus,
    overviewVisible: true,
    hiddenAt: null,
    cloneDir: null,
    provisionError: null,
    provisionWarning: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as ProjectRecord;

describe('control-plane project initialization', () => {
  it('persists the project before startup can issue its runner certificate', async () => {
    const complete = project();
    const store = {
      upsertProject: vi.fn(async () => project('pending')),
      updateProjectState: vi.fn(async () => complete),
      setProjectSetupStatus: vi.fn(async () => undefined),
      getProject: vi.fn(async () => complete),
    };

    await expect(ensureControlPlaneProject(store as never)).resolves.toEqual(complete);
    expect(store.upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'verity-control', kind: 'control_plane' }),
    );
    expect(store.setProjectSetupStatus).toHaveBeenCalledWith('verity-control', 'complete');

    // The FK failure happens during build, before routes exist. Keep the bootstrap
    // beside EventStore construction rather than relying on the overview endpoint.
    const embedded = await readFile('packages/server/src/embedded.ts', 'utf8');
    const storeCreated = embedded.indexOf('const eventStore = new EventStore');
    const ensured = embedded.indexOf('await ensureControlPlaneProject(eventStore)', storeCreated);
    const identityIssued = embedded.indexOf('.sandboxMaterial(', ensured);
    expect(storeCreated).toBeGreaterThan(-1);
    expect(ensured).toBeGreaterThan(storeCreated);
    expect(identityIssued).toBeGreaterThan(ensured);
  });
});
