import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { adoptedDeployment } from './managed-daemon.test-helper.js';
import {
  MANAGED_MATRIX_CONNECTOR_NAME,
  reconcileManagedMatrixConnector,
} from './managed-matrix-connector.js';

const image = `ghcr.io/heey-global/verity/verity-matrix-connector@sha256:${'c'.repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('managed Matrix connector', () => {
  it('uses the bundled digest, private credentials and persistent data on every reconcile', async () => {
    const { root, daemon } = await adoptedDeployment('matrix-managed');
    roots.push(root);
    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue([
      `VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE=${image}`,
    ]);

    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    const spec = daemon.spec(MANAGED_MATRIX_CONNECTOR_NAME)!;
    expect(spec.image).toBe(image);
    expect(spec.network).toBe('verity-net');
    expect(spec.env).toContain('VERITY_INTERNAL_URL=http://verity:8083');
    expect(spec.env).toContain(
      'VERITY_MATRIX_CONNECTOR_TOKEN_FILE=/run/verity-matrix/connector-token',
    );
    expect(spec.env).toContain('MATRIX_STORE_PASSPHRASE_FILE=/run/verity-matrix/store-passphrase');
    expect(spec.env?.join()).not.toMatch(/[a-f0-9]{96}/);
    expect(spec.volumeMounts).toEqual([
      {
        volume: 'verity-updater-control',
        target: '/run/verity-matrix',
        subpath: 'matrix',
        readOnly: true,
      },
      { volume: 'verity-matrix-connector-data', target: '/data' },
    ]);
    expect(daemon.names()).toContain(MANAGED_MATRIX_CONNECTOR_NAME);
    expect(daemon.names()).not.toContain('verity-managed-matrix-connector-init');
    const createCount = vi
      .mocked(daemon.docker.createContainer)
      .mock.calls.filter(([candidate]) => candidate.name === MANAGED_MATRIX_CONNECTOR_NAME).length;
    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    expect(
      vi
        .mocked(daemon.docker.createContainer)
        .mock.calls.filter(([candidate]) => candidate.name === MANAGED_MATRIX_CONNECTOR_NAME),
    ).toHaveLength(createCount);
  });

  it('does not launch a worker for an older server image without a bundled digest', async () => {
    const { root, daemon } = await adoptedDeployment('matrix-old');
    roots.push(root);
    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue(['VERITY_SERVER_VERSION=2.4.0']);
    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    expect(daemon.names()).not.toContain(MANAGED_MATRIX_CONNECTOR_NAME);
  });

  it('allows local Server images whose bundled connector reference is empty', async () => {
    const { root, daemon } = await adoptedDeployment('matrix-local');
    roots.push(root);
    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue([
      'VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE=',
    ]);
    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    expect(daemon.names()).not.toContain(MANAGED_MATRIX_CONNECTOR_NAME);
  });

  it('stops the worker when the managed Server rolls back before Matrix support', async () => {
    const { root, daemon } = await adoptedDeployment('matrix-rollback');
    roots.push(root);
    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue([
      `VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE=${image}`,
    ]);
    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    expect(daemon.names()).toContain(MANAGED_MATRIX_CONNECTOR_NAME);

    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue(['VERITY_SERVER_VERSION=2.4.0']);
    await reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker });
    expect(daemon.names()).not.toContain(MANAGED_MATRIX_CONNECTOR_NAME);
  });

  it('rejects an untrusted bundled image before writing secrets or creating containers', async () => {
    const { root, daemon } = await adoptedDeployment('matrix-invalid');
    roots.push(root);
    vi.mocked(daemon.docker.inspectImageEnv!).mockResolvedValue([
      'VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE=evil.example/matrix:latest',
    ]);
    await expect(
      reconcileManagedMatrixConnector({ managedRoot: root, docker: daemon.docker }),
    ).rejects.toThrow('not an official digest');
    expect(daemon.names()).not.toContain(MANAGED_MATRIX_CONNECTOR_NAME);
    expect(daemon.names()).not.toContain('verity-managed-matrix-connector-init');
  });
});
