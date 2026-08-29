import { describe, expect, it } from 'vitest';

import type {
  ExecutionProfileRecord,
  RunGrantClaims,
  SecretAliasRecord,
  SecretToolInvocation,
} from '@verity/secret-contracts';

import {
  SecretAuthorizationRejectedError,
  createFakeSecretAuthorization,
  createInMemorySecretApprovalStore,
} from './secret-authorization.js';

const hash = 'a'.repeat(64);
const actor = { actorId: 'user-1', authorizationHash: hash };
const profile: ExecutionProfileRecord = {
  id: 'kubernetes-read',
  projectId: 'project-1',
  version: 1,
  policyHash: hash,
  state: 'active',
  limits: {
    timeoutSeconds: 30,
    cpuMillis: 1000,
    memoryMiB: 128,
    maxProcesses: 1,
    maxOutputBytes: 65_536,
  },
  trustMode: 'restricted',
  requiresApproval: true,
  imageDigest: hash,
  executablePath: '/opt/verity/kubernetes-read',
  executableDigest: hash,
  parameterSchemaHash: hash,
  snapshotPolicyHash: hash,
  egressPolicyHash: hash,
  resultSchemaHash: hash,
  allowDescendants: false,
};
const alias: SecretAliasRecord = {
  id: 'kubernetes-token',
  projectId: 'project-1',
  version: 1,
  name: 'kubernetes-read-token',
  description: 'Fake marker credential for the pinned Kubernetes fixture.',
  binding: { id: 'fake-binding', version: 1, provider: 'doppler' },
  providerKey: 'SECRET_PROVIDER_KEY_MUST_NOT_LEAK',
  injection: { kind: 'env', target: 'KUBERNETES_TOKEN' },
  profile: { id: profile.id, version: profile.version, policyHash: profile.policyHash },
  state: 'active',
};

function invocation(overrides: Partial<SecretToolInvocation> = {}): SecretToolInvocation {
  return {
    context: {
      protocolVersion: 1,
      toolCallId: 'call-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      channel: 'codex-mcp',
    },
    request: {
      kind: 'restricted',
      profile: { id: profile.id, version: profile.version, policyHash: profile.policyHash },
      parameters: { operation: 'list', resource: 'pods' },
      snapshotId: hash,
    },
    ...overrides,
  };
}

function setup(issueFailures = 0, claimsActive = true) {
  const issued: RunGrantClaims[] = [];
  let currentTime = '2026-07-19T00:01:00Z';
  const authorization = createFakeSecretAuthorization({
    projectId: 'project-1',
    catalogVersion: 1,
    entries: [{ profile, aliases: [alias] }],
    approvals: createInMemorySecretApprovalStore(),
    authorizeApproval: async (_approvalId, candidate) => candidate.authorizationHash === hash,
    authorizeCurrentClaims: async () => claimsActive,
    grants: {
      async issue(claims, recordInTx) {
        if (issueFailures > 0) {
          issueFailures -= 1;
          throw new Error('transient grant store failure');
        }
        await recordInTx?.(undefined);
        issued.push(claims);
        return { capability: 'opaque-capability', claims };
      },
    },
    validateParameters: (_profileId, parameters) =>
      parameters.operation === 'list' && parameters.resource === 'pods',
    now: () => new Date(currentTime),
  });
  const service = {
    ...authorization,
    request: (candidate: SecretToolInvocation) => authorization.request(candidate, hash),
  };
  return { service, issued, setNow: (value: string) => (currentTime = value) };
}

describe('fake secret authorization', () => {
  it('publishes only public catalog fields', () => {
    const { service } = setup();
    const serialized = JSON.stringify(service.catalog());
    expect(serialized).not.toContain(alias.providerKey);
    expect(serialized).not.toContain('fake-binding');
    expect(serialized).toContain('kubernetes-read-token');
  });

  it('requires a decision before issuing a server-bound grant', async () => {
    const { service, issued } = setup();
    const pending = await service.request(invocation());
    expect(issued).toHaveLength(0);
    const result = await service.decide(pending.approvalId, actor, true);
    expect(result.decision).toBe('approved');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.aliases).toEqual([{ id: alias.id, version: alias.version }]);
    expect(issued[0]?.providerBindings).toEqual([alias.binding]);
    expect(issued[0]?.approval?.actorId).toBe('user-1');
  });

  it('does not issue a grant for a denial or repeated decision', async () => {
    const { service, issued } = setup();
    const pending = await service.request(invocation());
    await expect(service.decide(pending.approvalId, actor, false)).resolves.toEqual({
      decision: 'denied',
    });
    expect(issued).toHaveLength(0);
    await expect(service.decide(pending.approvalId, actor, true)).rejects.toThrow(/decided/);
  });

  it('rejects an unauthenticated actor without consuming the pending approval', async () => {
    const { service } = setup();
    const pending = await service.request(invocation());
    await expect(
      service.decide(
        pending.approvalId,
        { actorId: 'user-1', authorizationHash: 'b'.repeat(64) },
        true,
      ),
    ).rejects.toThrow(/not authorized/);
    await expect(service.decide(pending.approvalId, actor, true)).resolves.toMatchObject({
      decision: 'approved',
    });
  });

  it('rejects malformed approval identity before authorization', async () => {
    const { service } = setup();
    const pending = await service.request(invocation());
    await expect(
      service.decide(
        pending.approvalId,
        { actorId: 'user-1', authorizationHash: 'not-a-hash' },
        true,
      ),
    ).rejects.toThrow();
  });

  it('retries capability issuance after grant persistence fails before reservation', async () => {
    const { service } = setup(1);
    const pending = await service.request(invocation());
    await expect(service.decide(pending.approvalId, actor, true)).rejects.toThrow(/transient/);
    await expect(service.decide(pending.approvalId, actor, true)).resolves.toMatchObject({
      decision: 'approved',
      capability: 'opaque-capability',
    });
  });

  it('does not reserve or issue a grant after its claims are revoked', async () => {
    const { service, issued } = setup(0, false);
    const pending = await service.request(invocation());
    await expect(service.decide(pending.approvalId, actor, true)).rejects.toThrow(
      /no longer active/,
    );
    expect(issued).toHaveLength(0);
  });

  it('does not reserve or issue a grant after its frozen claims expire', async () => {
    const { service, issued, setNow } = setup();
    const pending = await service.request(invocation());
    setNow('2026-07-19T00:02:01Z');
    await expect(service.decide(pending.approvalId, actor, true)).rejects.toThrow(/expired/);
    expect(issued).toHaveLength(0);
  });

  it('rejects duplicate profile identities at configuration time', () => {
    expect(() =>
      createFakeSecretAuthorization({
        projectId: 'project-1',
        catalogVersion: 1,
        entries: [
          { profile, aliases: [alias] },
          { profile, aliases: [alias] },
        ],
        approvals: createInMemorySecretApprovalStore(),
        grants: { issue: (claims) => Promise.resolve({ capability: 'cap', claims }) },
        authorizeApproval: async () => true,
        authorizeCurrentClaims: async () => true,
        validateParameters: () => true,
      }),
    ).toThrow(/duplicate catalog profile/);
  });

  it('rejects duplicate alias identities across distinct profiles', () => {
    const otherProfile = { ...profile, id: 'fixed-json-api' };
    const duplicateAlias = {
      ...alias,
      name: 'different-visible-name',
      profile: {
        id: otherProfile.id,
        version: otherProfile.version,
        policyHash: otherProfile.policyHash,
      },
    };
    expect(() =>
      createFakeSecretAuthorization({
        projectId: 'project-1',
        catalogVersion: 1,
        entries: [
          { profile, aliases: [alias] },
          { profile: otherProfile, aliases: [duplicateAlias] },
        ],
        approvals: createInMemorySecretApprovalStore(),
        grants: { issue: (claims) => Promise.resolve({ capability: 'cap', claims }) },
        authorizeApproval: async () => true,
        authorizeCurrentClaims: async () => true,
        validateParameters: () => true,
      }),
    ).toThrow(/duplicate catalog alias/);
  });

  it('rejects project, profile, and parameter substitution before approval', async () => {
    const { service } = setup();
    const wrongParameters = invocation();
    if (wrongParameters.request.kind !== 'restricted') throw new Error('invalid test fixture');
    wrongParameters.request.parameters = { operation: 'delete' };
    await expect(
      service.request(
        invocation({
          ...invocation(),
          context: { ...invocation().context, projectId: 'other-project' },
        }),
      ),
    ).rejects.toThrow(SecretAuthorizationRejectedError);
    await expect(
      service.request({
        ...invocation(),
        request: {
          ...invocation().request,
          profile: { id: profile.id, version: 1, policyHash: 'b'.repeat(64) },
        },
      }),
    ).rejects.toThrow(/exact active catalog/);
    await expect(service.request(wrongParameters)).rejects.toThrow(/parameters/);
  });
});
