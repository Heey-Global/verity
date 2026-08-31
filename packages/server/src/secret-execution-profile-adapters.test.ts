import type { ExecutionProfileRecord } from '@verity/secret-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createSecretExecutionProfileAdapterRegistry } from './secret-execution-profile-adapters.js';

const hash = 'a'.repeat(64);
const profile: ExecutionProfileRecord = {
  id: 'fixed-read',
  projectId: 'project-1',
  version: 1,
  policyHash: hash,
  state: 'active',
  trustMode: 'restricted',
  requiresApproval: true,
  imageDigest: 'b'.repeat(64),
  executablePath: '/usr/local/bin/fixed-read',
  executableDigest: 'c'.repeat(64),
  parameterSchemaHash: 'd'.repeat(64),
  snapshotPolicyHash: 'e'.repeat(64),
  egressPolicyHash: 'f'.repeat(64),
  resultSchemaHash: '1'.repeat(64),
  allowDescendants: false,
  limits: {
    timeoutSeconds: 60,
    cpuMillis: 1_000,
    memoryMiB: 256,
    maxProcesses: 8,
    maxOutputBytes: 65_536,
  },
};
const policy = { ...profile };
Reflect.deleteProperty(policy, 'projectId');
Reflect.deleteProperty(policy, 'state');

describe('Secret execution profile adapter registry', () => {
  it('runs only the exact Verity-owned profile validator', async () => {
    const validateParameters = vi.fn((parameters: Readonly<Record<string, unknown>>) =>
      Promise.resolve(parameters.operation === 'read'),
    );
    const registry = createSecretExecutionProfileAdapterRegistry([
      {
        policy,
        validateParameters,
      },
    ]);

    await expect(registry.validate(profile, { operation: 'read' })).resolves.toBe(true);
    await expect(registry.validate(profile, { operation: 'write' })).resolves.toBe(false);
    await expect(
      registry.validate({ ...profile, policyHash: '2'.repeat(64) }, { operation: 'read' }),
    ).resolves.toBe(false);
    await expect(
      registry.validate({ ...profile, id: 'other-profile' }, { operation: 'read' }),
    ).resolves.toBe(false);
    await expect(
      registry.validate({ ...profile, version: 2 }, { operation: 'read' }),
    ).resolves.toBe(false);
    await expect(
      registry.validate(
        { ...profile, executablePath: '/usr/local/bin/other' },
        { operation: 'read' },
      ),
    ).resolves.toBe(false);
    expect(validateParameters).toHaveBeenCalledTimes(2);
  });

  it('fails closed for inactive, non-restricted, missing, or throwing adapters', async () => {
    const throwing = createSecretExecutionProfileAdapterRegistry([
      {
        policy,
        validateParameters: () => {
          throw new Error('validator failed');
        },
      },
    ]);
    await expect(throwing.validate(profile, {})).resolves.toBe(false);
    const rejecting = createSecretExecutionProfileAdapterRegistry([
      {
        policy,
        validateParameters: () => Promise.reject(new Error('validator rejected')),
      },
    ]);
    await expect(rejecting.validate(profile, {})).resolves.toBe(false);
    await expect(throwing.validate({ ...profile, state: 'disabled' }, {})).resolves.toBe(false);
    await expect(
      throwing.validate(
        {
          id: profile.id,
          projectId: profile.projectId,
          version: profile.version,
          policyHash: profile.policyHash,
          state: 'active',
          trustMode: 'action',
          requiresApproval: true,
          action: 'fixed-read',
          inputSchemaHash: '3'.repeat(64),
          resultSchemaHash: '4'.repeat(64),
          limits: profile.limits,
        },
        {},
      ),
    ).resolves.toBe(false);
    await expect(
      createSecretExecutionProfileAdapterRegistry([]).validate(profile, {}),
    ).resolves.toBe(false);
  });

  it('rejects duplicate and malformed adapter identities at startup', () => {
    const adapter = {
      policy,
      validateParameters: () => true,
    };
    expect(() => createSecretExecutionProfileAdapterRegistry([adapter, adapter])).toThrow(
      /duplicate/,
    );
    expect(() =>
      createSecretExecutionProfileAdapterRegistry([
        { ...adapter, policy: { ...adapter.policy, policyHash: 'invalid' } },
      ]),
    ).toThrow();
  });
});
