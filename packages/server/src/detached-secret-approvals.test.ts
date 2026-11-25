import { expect, it, vi } from 'vitest';
import type { Conductor } from '@verity/session';

import { configureDetachedSecretApprovals } from './detached-secret-approvals.js';
import type {
  BrokeredToolApprovalRecord,
  BrokeredToolApprovalStore,
} from './brokered-tool-approval-store.js';

const record: BrokeredToolApprovalRecord = {
  id: 'receipt',
  projectId: 'project',
  sessionId: 'session',
  invocationId: 'original',
  toolName: 'verity_http_request',
  canonicalInput: '{"url":"https://api.example.com"}',
  requestMac: 'mac',
  macKeyId: 'key',
  authorizationSnapshot:
    '{"bindings":[{"bindingId":"b","connectionId":"c","dopplerProject":"p","dopplerConfig":"staging"}]}',
  status: 'pending',
  scope: null,
  decidedBy: null,
  createdAt: '2026-11-20T00:00:00Z',
  decidedAt: null,
};

const obsolete: BrokeredToolApprovalRecord = {
  ...record,
  id: 'obsolete',
  authorizationSnapshot:
    '{"bindings":[{"connectionId":"c","dopplerProject":"p","dopplerConfig":"staging"}]}',
};
const malformed = { ...record, id: 'malformed', authorizationSnapshot: '{' };

function harness({
  pending = [record],
  approved = [],
  decisions = [],
}: {
  pending?: BrokeredToolApprovalRecord[];
  approved?: BrokeredToolApprovalRecord[];
  decisions?: BrokeredToolApprovalRecord[];
} = {}) {
  let provider!: Parameters<Conductor['configureDetachedPermissions']>[0];
  const decide = vi.fn(async () => ({ ...record, status: 'approved' as const }));
  const canExecute = vi.fn(async () => true);
  const snapshot = vi.fn(async () => record.authorizationSnapshot);
  const validated: (boolean | undefined)[] = [];
  const resume = vi.fn<Conductor['resumeDetachedPermission']>(
    async (_id, _request, _actor, validate) => {
      validated.push(await validate?.());
    },
  );
  const getSession = vi.fn(async () => ({ projectId: 'project' }));
  configureDetachedSecretApprovals({
    conductor: {
      configureDetachedPermissions: (next) => {
        provider = next;
      },
      resumeDetachedPermission: resume,
    },
    store: { getSession } as unknown as Parameters<
      typeof configureDetachedSecretApprovals
    >[0]['store'],
    approvals: {
      listApproved: async () => approved,
      listUnrecordedDecisions: async () => decisions,
      get: async (id: string) => pending.find((entry) => entry.id === id),
      listPending: async () => pending,
      decide,
    } as unknown as BrokeredToolApprovalStore,
    gateway: { authorizationSnapshot: snapshot },
    canExecute,
  });
  return { provider, decide, canExecute, snapshot, getSession, resume, validated };
}

it('restores the exact secret card without restoring a caller or executing a tool', async () => {
  const { provider, decide } = harness();
  expect(await provider.list('session')).toMatchObject([
    {
      toolUseId: 'receipt',
      toolName: 'verity_http_request',
      input: { url: 'https://api.example.com' },
    },
  ]);
  expect(decide).not.toHaveBeenCalled();
});

it('binds a restored decision to the answering user and retains the selected scope', async () => {
  const { provider, decide, canExecute } = harness();
  expect(
    await provider.decide('session', 'receipt', { behavior: 'allow' }, 'user', 'project'),
  ).toBe(true);
  expect(canExecute).toHaveBeenCalledWith('user', 'project');
  expect(decide).toHaveBeenCalledWith('receipt', 'session', true, 'user', 'project');
});

it.each(['provider', 'rights', 'project'] as const)(
  'rejects a restored allow after %s changes',
  async (changed) => {
    const { provider, decide, snapshot, canExecute, getSession } = harness();
    if (changed === 'provider') snapshot.mockResolvedValue('replacement');
    if (changed === 'rights') canExecute.mockResolvedValue(false);
    if (changed === 'project') getSession.mockResolvedValue({ projectId: 'other' });
    expect(await provider.decide('session', 'receipt', { behavior: 'allow' }, 'user', 'once')).toBe(
      false,
    );
    expect(decide).not.toHaveBeenCalled();
  },
);

it('recovers fresh requests and their decisions alongside obsolete and malformed snapshots', async () => {
  const once = { status: 'approved', scope: 'once', decidedBy: 'user' } as const;
  const { provider, decide, resume, validated } = harness({
    pending: [obsolete, malformed, record],
    approved: [
      { ...obsolete, ...once },
      { ...malformed, ...once },
      { ...record, ...once },
    ],
    decisions: [
      { ...obsolete, status: 'denied' },
      { ...record, ...once },
    ],
  });
  expect((await provider.list('session')).map((entry) => entry.toolUseId)).toEqual(['receipt']);
  expect(await provider.decide('session', 'obsolete', { behavior: 'allow' }, 'user', 'once')).toBe(
    false,
  );
  expect(decide).not.toHaveBeenCalled();
  await provider.resumeApproved?.('session');
  expect(resume).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ toolUseId: 'receipt' }),
    'user',
    expect.any(Function),
  );
  expect(validated).toEqual([true]);
  const notices = await provider.listUnrecordedDecisions?.('session');
  expect(notices?.map((event) => event.secretApproval)).toEqual([
    {
      id: 'obsolete',
      tool: record.toolName,
      input: { url: 'https://api.example.com' },
      decision: 'denied',
    },
    expect.objectContaining({
      id: 'receipt',
      decision: 'once',
      secretSource: { project: 'p', config: 'staging' },
    }),
  ]);
});

it.each([
  { auth: true, caller: 'alice', approver: 'alice', allowed: true },
  { auth: true, caller: 'bob', approver: 'alice', allowed: false },
  { auth: true, caller: undefined, approver: 'alice', allowed: false },
  { auth: true, caller: 'alice', approver: null, allowed: false },
  { auth: false, caller: undefined, approver: '__local__', allowed: true },
  { auth: true, caller: 'alice', approver: '__local__', allowed: false },
])(
  'redeems consent only for its answering actor ($caller / $approver / auth=$auth)',
  async ({ auth, caller, approver, allowed }) => {
    const { installDetachedSecretApprovals } = await import('./detached-secret-approvals.js');
    const { legacyAdministratorId } = await import('./view-state-routes.js');
    const upstream = vi.fn(async () => {});
    const deps = {
      eventStore: { runningTurnInitiator: async () => (caller ? { userId: caller } : undefined) },
      mcpGateway: { authorizeDetachedApproval: upstream },
      authRegistry: { isEnabled: () => auth },
    } as unknown as Parameters<typeof installDetachedSecretApprovals>[1];
    const gateway = installDetachedSecretApprovals(
      {} as Parameters<typeof installDetachedSecretApprovals>[0],
      deps,
      {} as Conductor,
      async () => true,
    );
    const check = gateway.authorizeDetachedApproval({
      projectId: 'p',
      sessionId: 's',
      turnId: 't',
      decidedBy: approver,
    });
    if (allowed) {
      await expect(check).resolves.toBeUndefined();
      expect(upstream).toHaveBeenCalledOnce();
      if (!auth) {
        await expect(
          gateway.authorizeDetachedApproval({
            projectId: 'p',
            sessionId: 's',
            turnId: 't',
            decidedBy: legacyAdministratorId,
          }),
        ).resolves.toBeUndefined();
      }
    } else {
      await expect(check).rejects.toThrow('different user');
      expect(upstream).not.toHaveBeenCalled();
    }
  },
);
