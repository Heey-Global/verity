import { describe, expect, it } from 'vitest';
import {
  projectNetworkName,
  projectNodeModulesVolumeName,
  sandboxIdentity,
  sandboxPersonTag,
} from './sandbox-identity.js';

const project = { id: 'Proj_1', containerName: 'verity-acme--app' };

describe('sandbox identity', () => {
  // An upgrade must recreate nothing: the original sandbox keeps every name it had.
  it('keeps the original names for the project default sandbox', () => {
    expect(sandboxIdentity(project, { userId: 'admin', projectDefault: true })).toEqual({
      projectId: 'Proj_1',
      userId: 'admin',
      projectDefault: true,
      containerName: 'verity-acme--app',
      networkName: projectNetworkName('Proj_1'),
      nodeModulesVolume: projectNodeModulesVolumeName('Proj_1'),
      runnerDir: 'runners/Proj_1',
    });
    expect(projectNetworkName('Proj_1')).toBe('verity-proj-proj_1');
  });

  // Each person's container, network, volume and runtime are their own; sharing any
  // of them would join two credential boundaries.
  it("gives every other person's sandbox distinct, Docker- and path-safe names", () => {
    const lena = sandboxIdentity(project, { userId: 'lena', projectDefault: false });
    const mia = sandboxIdentity(project, { userId: 'mia/../x', projectDefault: false });
    const original = sandboxIdentity(project, { userId: 'admin', projectDefault: true });
    for (const key of ['containerName', 'networkName', 'nodeModulesVolume', 'runnerDir'] as const) {
      expect(new Set([lena[key], mia[key], original[key]]).size).toBe(3);
    }
    expect(lena.containerName).toBe(`verity-acme--app--${sandboxPersonTag('lena')}`);
    expect(mia.runnerDir).toMatch(/^runners\/u[0-9a-f]{16}\/Proj_1$/u);
    for (const name of [mia.containerName, mia.networkName, mia.nodeModulesVolume])
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
  });
});
