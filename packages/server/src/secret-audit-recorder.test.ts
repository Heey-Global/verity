import { describe, expect, it } from 'vitest';

import type {
  ExecutionProfileRecord,
  SecretAliasRecord,
  SecretToolInvocation,
} from '@verity/secret-contracts';

import {
  createFakeSecretAuthorization,
  createInMemorySecretApprovalStore,
} from './secret-authorization.js';
import { createInMemorySecretAuditLog, type SecretAuditLog } from './secret-audit-log.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';

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

function invocation(): SecretToolInvocation {
  return {
    context: {
      protocolVersion: 1,
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      channel: 'codex-mcp',
    },
    request: {
      kind: 'restricted',
      profile: { id: profile.id, version: profile.version, policyHash: profile.policyHash },
      parameters: { operation: 'list', resource: 'pods' },
      snapshotId: hash,
    },
  };
}

function setup(claimsActive = true) {
  const log = createInMemorySecretAuditLog();
  const service = createFakeSecretAuthorization({
    projectId: 'project-1',
    catalogVersion: 1,
    entries: [{ profile, aliases: [alias] }],
    approvals: createInMemorySecretApprovalStore(),
    authorizeApproval: async (_id, candidate) => candidate.authorizationHash === hash,
    authorizeCurrentClaims: async () => claimsActive,
    grants: {
      issue: async (claims, recordInTx) => {
        await recordInTx?.(undefined);
        return { capability: 'opaque-capability', claims };
      },
    },
    validateParameters: (_id, parameters) =>
      parameters.operation === 'list' && parameters.resource === 'pods',
    recorder: createSecretAuditRecorder(log),
    now: () => new Date('2026-07-19T00:01:00Z'),
  });
  return { service, log };
}

describe('secret audit recorder wiring', () => {
  it('records approval_approved then grant_issued for an approved request', async () => {
    const { service, log } = setup();
    const pending = await service.request(invocation());
    await service.decide(pending.approvalId, actor, true);

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((e) => e.kind)).toEqual(['approval_approved', 'grant_issued']);
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(events.every((e) => e.approvalId === pending.approvalId)).toBe(true);
    expect(events[0]!.actorHash).toBe(hash);
    // Both events name the same grant, and neither leaks the provider key.
    expect(events[1]!.grantId).toBeDefined();
    expect(events[1]!.grantId).toBe(events[0]!.grantId);
    expect(JSON.stringify(events)).not.toContain(alias.providerKey);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 2 });
  });

  it('records only approval_denied for a denial', async () => {
    const { service, log } = setup();
    const pending = await service.request(invocation());
    await service.decide(pending.approvalId, actor, false);

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((e) => e.kind)).toEqual(['approval_denied']);
    expect(events[0]!.approvalId).toBe(pending.approvalId);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('records the approval but no grant when post-approval revocation blocks issuance', async () => {
    const { service, log } = setup(false);
    const pending = await service.request(invocation());
    await expect(service.decide(pending.approvalId, actor, true)).rejects.toThrow(
      /no longer active/,
    );

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((e) => e.kind)).toEqual(['approval_approved']);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('never lets a failing recorder orphan an issued grant', async () => {
    // A recorder whose append always fails must not break issuance: the capability is single-shot
    // and already reserved, so a throw here would strand a live, non-retryable grant.
    const failing: SecretAuditLog = {
      append: () => Promise.reject(new Error('audit store down')),
      query: () => Promise.resolve([]),
      verifyChain: () => Promise.resolve({ ok: true, checked: 0 }),
    };
    const errors: unknown[] = [];
    const service = createFakeSecretAuthorization({
      projectId: 'project-1',
      catalogVersion: 1,
      entries: [{ profile, aliases: [alias] }],
      approvals: createInMemorySecretApprovalStore(),
      authorizeApproval: async () => true,
      authorizeCurrentClaims: async () => true,
      grants: {
        issue: async (claims, recordInTx) => {
          await recordInTx?.(undefined);
          return { capability: 'opaque-capability', claims };
        },
      },
      validateParameters: () => true,
      recorder: createSecretAuditRecorder(failing, { onError: (error) => errors.push(error) }),
      now: () => new Date('2026-07-19T00:01:00Z'),
    });

    const pending = await service.request(invocation());
    const result = await service.decide(pending.approvalId, actor, true);
    expect(result).toMatchObject({ decision: 'approved', capability: 'opaque-capability' });
    // The append failures surfaced (approval + issuance) instead of breaking the operation.
    expect(errors).toHaveLength(2);
  });

  it('propagates standalone append failures in fail-closed mode', async () => {
    const failing: SecretAuditLog = {
      append: () => Promise.reject(new Error('audit store down')),
      query: () => Promise.resolve([]),
      verifyChain: () => Promise.resolve({ ok: true, checked: 0 }),
    };
    const recorder = createSecretAuditRecorder(failing, { failureMode: 'fail-closed' });

    await expect(
      recorder.cleanup({
        projectId: 'project-1',
        requestHash: hash,
        grantId: 'grant-1',
        jobId: 'job-1',
        state: 'complete',
        at: '2026-07-19T00:01:00Z',
      }),
    ).rejects.toThrow('audit store down');
  });

  it('is a no-op when no recorder is configured', async () => {
    const log = createInMemorySecretAuditLog();
    const service = createFakeSecretAuthorization({
      projectId: 'project-1',
      catalogVersion: 1,
      entries: [{ profile, aliases: [alias] }],
      approvals: createInMemorySecretApprovalStore(),
      authorizeApproval: async () => true,
      authorizeCurrentClaims: async () => true,
      grants: {
        issue: async (claims, recordInTx) => {
          await recordInTx?.(undefined);
          return { capability: 'cap', claims };
        },
      },
      validateParameters: () => true,
      now: () => new Date('2026-07-19T00:01:00Z'),
    });
    const pending = await service.request(invocation());
    await service.decide(pending.approvalId, actor, true);
    expect(await log.query({ projectId: 'project-1' })).toHaveLength(0);
  });
});
