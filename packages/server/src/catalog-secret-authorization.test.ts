import type {
  ExecutionProfileRecord,
  SecretAliasRecord,
  SecretToolInvocation,
} from '@verity/secret-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createCatalogSecretAuthorization } from './catalog-secret-authorization.js';
import { createSecretExecutionProfileAdapterRegistry } from './secret-execution-profile-adapters.js';
import {
  createInMemorySecretApprovalStore,
  SecretAuthorizationRejectedError,
  type SecretGrantIssuer,
} from './secret-authorization.js';
import type { SecretExecutionProfileRegistry } from './secret-execution-profile-registry.js';
import type { SecretProviderCatalog } from './secret-provider-catalog.js';

const HASH = 'a'.repeat(64);
const IMAGE = 'b'.repeat(64);
const profile: ExecutionProfileRecord = {
  id: 'fixed-api',
  projectId: 'project-1',
  version: 1,
  policyHash: HASH,
  state: 'active',
  trustMode: 'restricted',
  requiresApproval: true,
  limits: {
    timeoutSeconds: 60,
    cpuMillis: 500,
    memoryMiB: 128,
    maxProcesses: 4,
    maxOutputBytes: 65_536,
  },
  imageDigest: IMAGE,
  executablePath: '/usr/local/bin/verity-secret-job-pilot',
  executableDigest: 'c'.repeat(64),
  parameterSchemaHash: 'd'.repeat(64),
  snapshotPolicyHash: 'e'.repeat(64),
  egressPolicyHash: 'f'.repeat(64),
  resultSchemaHash: '1'.repeat(64),
  allowDescendants: false,
};
const alias: SecretAliasRecord = {
  id: 'api-token',
  projectId: 'project-1',
  version: 1,
  name: 'api-token',
  description: 'Token for the fixed API profile.',
  binding: { id: 'doppler-main', version: 1, provider: 'doppler' },
  providerKey: 'API_TOKEN',
  injection: { kind: 'env', target: 'API_TOKEN' },
  profile: { id: profile.id, version: profile.version, policyHash: profile.policyHash },
  state: 'active',
};
const invocation: SecretToolInvocation = {
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
    profile: alias.profile,
    parameters: { operation: 'read' },
    snapshotId: '2'.repeat(64),
  },
};

function setup(
  options: {
    resolvedProfile?: ExecutionProfileRecord | undefined;
    aliases?: readonly SecretAliasRecord[];
    permissions?: boolean;
    parameters?: boolean;
    now?: () => Date;
    approvalTtlMs?: number;
    grantTtlMs?: number;
    skipCommit?: boolean;
    repeatCommit?: boolean;
    issuance?: boolean;
  } = {},
) {
  const resolvedProfile = 'resolvedProfile' in options ? options.resolvedProfile : profile;
  const resolveProfile = vi.fn(() => Promise.resolve(resolvedProfile));
  const profiles: SecretExecutionProfileRegistry = {
    provision: vi.fn(() => Promise.resolve()),
    resolve: resolveProfile,
    list: vi.fn(() => Promise.resolve(resolvedProfile === undefined ? [] : [resolvedProfile])),
  };
  const checkPermissions = vi.fn(() => Promise.resolve(options.permissions ?? true));
  const resolveAliases = vi.fn(() => Promise.resolve([...(options.aliases ?? [alias])]));
  const catalog = {
    resolveAliasesForProfile: resolveAliases,
    checkClaimsPermissions: checkPermissions,
  } as unknown as SecretProviderCatalog;
  const issue = vi.fn<SecretGrantIssuer['issue']>(async (claims, recordInTx) => {
    if (!options.skipCommit) await recordInTx(undefined);
    if (options.repeatCommit) await recordInTx(undefined);
    return { capability: 'single-use-capability', claims };
  });
  const authorization = createCatalogSecretAuthorization({
    profiles,
    profileAdapters: createSecretExecutionProfileAdapterRegistry([
      {
        policy: (() => {
          const policy = { ...profile };
          Reflect.deleteProperty(policy, 'projectId');
          Reflect.deleteProperty(policy, 'state');
          return policy;
        })(),
        validateParameters: () => options.parameters ?? true,
      },
    ]),
    catalog,
    approvals: createInMemorySecretApprovalStore(),
    grants: { issue },
    authorizeApproval: () => Promise.resolve(true),
    authorizeCurrentClaims: () => Promise.resolve(true),
    authorizeIssuanceClaims: () => Promise.resolve(options.issuance ?? true),
    now: options.now ?? (() => new Date('2026-07-23T00:00:00.000Z')),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
    ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
  });
  const service = {
    ...authorization,
    request: (candidate: SecretToolInvocation) => authorization.request(candidate, '3'.repeat(64)),
  };
  return { service, resolveProfile, resolveAliases, checkPermissions, issue };
}

describe('catalog Secret authorization', () => {
  it('returns the same approval for an at-least-once native tool delivery', async () => {
    const { service } = setup();
    const first = await service.request(invocation);
    await expect(service.request(invocation)).resolves.toEqual(first);
  });

  it('issues a grant bound to the durable profile and active aliases', async () => {
    const { service } = setup();
    const { approvalId } = await service.request(invocation);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).resolves.toMatchObject({
      decision: 'approved',
      capability: 'single-use-capability',
      claims: {
        projectId: 'project-1',
        profile: alias.profile,
        executorImageDigest: IMAGE,
        aliases: [{ id: alias.id, version: alias.version }],
        providerBindings: [alias.binding],
      },
    });
  });

  it.each([
    ['missing profile', { resolvedProfile: undefined }],
    ['missing aliases', { aliases: [] }],
    ['missing permission', { permissions: false }],
    ['invalid parameters', { parameters: false }],
  ] as const)('rejects %s before creating an approval', async (_label, options) => {
    const { service } = setup(options);
    await expect(service.request(invocation)).rejects.toBeInstanceOf(
      SecretAuthorizationRejectedError,
    );
  });

  it('rejects an approval when its profile is revoked before decision', async () => {
    const { service, resolveProfile, issue } = setup();
    const { approvalId } = await service.request(invocation);
    resolveProfile.mockResolvedValueOnce(undefined);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects an inactive profile returned during approval revalidation', async () => {
    const { service, resolveProfile, issue } = setup();
    const { approvalId } = await service.request(invocation);
    resolveProfile.mockResolvedValueOnce({ ...profile, state: 'disabled' });
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects permissions revoked before approval', async () => {
    const { service, checkPermissions, issue } = setup();
    const { approvalId } = await service.request(invocation);
    checkPermissions.mockResolvedValueOnce(false);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects aliases revoked before approval', async () => {
    const { service, resolveAliases, issue } = setup();
    const { approvalId } = await service.request(invocation);
    resolveAliases.mockResolvedValueOnce([]);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('starts the grant TTL at approval while enforcing a separate approval deadline', async () => {
    let instant = new Date('2026-07-23T00:00:00.000Z');
    const { service } = setup({ now: () => instant });
    const { approvalId } = await service.request(invocation);
    instant = new Date('2026-07-23T00:05:00.000Z');
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).resolves.toMatchObject({
      decision: 'approved',
      claims: {
        issuedAt: '2026-07-23T00:05:00.000Z',
        expiresAt: '2026-07-23T00:06:00.000Z',
      },
    });
  });

  it('rejects decisions after the approval deadline', async () => {
    let instant = new Date('2026-07-23T00:00:00.000Z');
    const { service, issue } = setup({ now: () => instant, approvalTtlMs: 1_000 });
    const { approvalId } = await service.request(invocation);
    instant = new Date('2026-07-23T00:00:01.000Z');
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('also rejects denials after the approval deadline', async () => {
    let instant = new Date('2026-07-23T00:00:00.000Z');
    const { service, issue } = setup({ now: () => instant, approvalTtlMs: 1_000 });
    const { approvalId } = await service.request(invocation);
    instant = new Date('2026-07-23T00:00:01.000Z');
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, false),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('can retry safely when grant issuance fails before the atomic reservation', async () => {
    const { service, issue } = setup();
    const { approvalId } = await service.request(invocation);
    issue.mockRejectedValueOnce(new Error('transient issuer failure'));
    const actor = { actorId: 'actor-1', authorizationHash: '3'.repeat(64) };
    await expect(service.decide(approvalId, actor, true)).rejects.toThrow(/transient/);
    await expect(service.decide(approvalId, actor, true)).resolves.toMatchObject({
      decision: 'approved',
      capability: 'single-use-capability',
    });
  });

  it.each([
    ['omits', { skipCommit: true }],
    ['repeats', { repeatCommit: true }],
  ] as const)('rejects an issuer that %s the atomic callback', async (_label, options) => {
    const { service } = setup(options);
    const { approvalId } = await service.request(invocation);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toBeInstanceOf(SecretAuthorizationRejectedError);
  });

  it('rejects revocation observed inside the grant transaction', async () => {
    const { service, issue } = setup({ issuance: false });
    const { approvalId } = await service.request(invocation);
    await expect(
      service.decide(approvalId, { actorId: 'actor-1', authorizationHash: '3'.repeat(64) }, true),
    ).rejects.toThrow(/revoked during grant issuance/);
    expect(issue).toHaveBeenCalledOnce();
  });
});
