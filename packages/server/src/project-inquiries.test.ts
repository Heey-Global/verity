import { describe, expect, it, vi } from 'vitest';
import type { EventStore, ProjectInquiry } from '@verity/store';
import Fastify from 'fastify';
import { createProjectInquiries, registerProjectInquiryRoutes } from './project-inquiries.js';

function harness({ granted = true }: { granted?: boolean } = {}) {
  const busy = new Set<string>();
  const replies: ProjectInquiry[] = [];
  const reply = vi.fn<(row: ProjectInquiry) => Promise<boolean>>(async () => true);
  const markAnswerDelivered = vi.fn();
  const rows = new Map<string, ProjectInquiry>();
  const sessions = new Map<string, { projectId: string }>([['source', { projectId: 'app' }]]);
  let grant = granted;
  const planning = vi.fn();
  const dispatch = vi.fn(async (_inquiry: ProjectInquiry, validate: () => Promise<boolean>) =>
    validate(),
  );
  const store = {
    repairs: {
      dispatchReceipt: vi.fn(async (): Promise<{ state: string } | undefined> => undefined),
    },
    getProject: vi.fn(async (id: string) => ({
      id,
      hiddenAt: null,
      state: 'active',
      kind: 'github',
    })),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    setSessionPlanning: planning,
    createSessionLink: vi.fn(),
    projectInquiries: {
      allowed: vi.fn(async () => grant),
      isTarget: vi.fn(async (id: string) => id !== 'source'),
      bind: vi.fn(),
      activate: vi.fn(),
      get: vi.fn(async (id: string) => rows.get(id)),
      // Mirrors the store: only a granted question is admitted without a card.
      create: vi.fn(async (input: ProjectInquiry) => {
        if (!rows.has(input.id)) {
          const admitted = input.kind === 'question' && grant;
          rows.set(input.id, {
            ...input,
            humanApproved: false,
            status: input.status === 'provisioning' && !admitted ? 'pending' : input.status,
          });
        }
        return rows.get(input.id)!;
      }),
      completeProvisioning: vi.fn(async (id: string) => {
        const row = rows.get(id)!;
        if (row.status === 'provisioning')
          row.status = row.kind === 'change' && !row.humanApproved ? 'pending' : 'approved';
      }),
      markQueued: vi.fn(async (id: string) => {
        rows.get(id)!.status = 'queued';
      }),
      decide: vi.fn(
        async (id: string, target: string, approve: boolean, _user: unknown, always = false) => {
          const row = rows.get(id);
          if (!row || row.targetSessionId !== target || row.status !== 'pending') return false;
          if (always && row.kind !== 'question') return false;
          row.status = approve ? 'provisioning' : 'rejected';
          row.humanApproved = approve;
          if (approve && always) grant = true;
          return true;
        },
      ),
      block: vi.fn(async (id: string) => {
        rows.get(id)!.status = 'blocked';
      }),
      answer: vi.fn(),
      unansweredDeliveries: vi.fn(async (after = '') =>
        replies
          .filter((r) => r.id > after)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 100),
      ),
      markAnswerDelivered,
      undelivered: vi.fn(async (after = '') =>
        [...rows.values()]
          .filter((r) => ['approved', 'provisioning'].includes(r.status) && r.id > after)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 100),
      ),
    },
  };
  const createSession = vi.fn(async (projectId: string, id: string) => {
    sessions.set(id, { projectId });
  });
  const service = createProjectInquiries({
    store: store as unknown as EventStore,
    authorized: async () => true,
    createSession,
    reply,
    busy: (id) => busy.has(id),
    dispatch,
  });
  return {
    service,
    store,
    rows,
    busy,
    sessions,
    replies,
    reply,
    markAnswerDelivered,
    createSession,
    planning,
    dispatch,
    revoke: () => {
      grant = false;
    },
    granted: () => grant,
  };
}
const request = {
  requestId: 'one',
  targetProjectId: 'cluster',
  title: 'Service',
  body: 'Inspect staging',
  kind: 'question',
};

describe('project inquiries', () => {
  it('returns an actionable gateway refusal when an inquiry target tries to forward a request', async () => {
    const h = harness();
    const incoming = await h.service.request('source', null, request);
    h.store.projectInquiries.create.mockClear();

    await expect(
      h.service.request(incoming.targetSessionId, null, { ...request, targetProjectId: 'other' }),
    ).rejects.toMatchObject({
      name: 'ControlPlaneSessionAuthorityError',
      message:
        'Inquiry targets cannot forward requests. Ask the originating session to send the follow-up.',
    });
    expect(h.store.projectInquiries.create).not.toHaveBeenCalled();
  });

  it('reuses one target for follow-up questions and sets read-only planning before dispatch', async () => {
    const h = harness();
    const first = await h.service.request('source', null, request);
    const second = await h.service.request('source', null, { ...request, requestId: 'two' });
    expect(second.targetSessionId).toBe(first.targetSessionId);
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.planning).toHaveBeenCalledWith(first.targetSessionId, 'active');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('does not create or dispatch a change before a decision, even with a standing grant', async () => {
    const h = harness();
    const change = await h.service.request('source', null, { ...request, kind: 'change' });
    expect(change.status).toBe('pending');
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    // The decision is addressed to the target project, not to the asking one.
    await expect(h.service.decide('app', change.id, null, 'approve')).rejects.toThrow(
      'unavailable',
    );
    await expect(h.service.decide('cluster', change.id, null, 'approve_always')).rejects.toThrow(
      'questions',
    );
    await h.service.decide('cluster', change.id, null, 'approve');
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.planning).toHaveBeenCalledWith(change.targetSessionId, 'implemented');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps an ungranted question pending until it is allowed once', async () => {
    const h = harness({ granted: false });
    const question = await h.service.request('source', null, request);
    expect(question.status).toBe('pending');
    await h.service.recover();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    await h.service.decide('cluster', question.id, null, 'approve');
    expect(h.rows.get(question.id)?.status).toBe('queued');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    // Allowing once stores nothing: the next question asks again.
    expect(h.granted()).toBe(false);
    const next = await h.service.request('source', null, { ...request, requestId: 'two' });
    expect(next.status).toBe('pending');
  });
  it('lets later questions run without a card after "Always allow"', async () => {
    const h = harness({ granted: false });
    const question = await h.service.request('source', null, request);
    await h.service.decide('cluster', question.id, null, 'approve_always');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const next = await h.service.request('source', null, { ...request, requestId: 'two' });
    expect(next.status).toBe('queued');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('leaves no target session behind a rejected request', async () => {
    const h = harness({ granted: false });
    const question = await h.service.request('source', null, request);
    await h.service.decide('cluster', question.id, null, 'reject');
    await h.service.recover();
    expect(h.rows.get(question.id)?.status).toBe('rejected');
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
    await expect(h.service.decide('cluster', question.id, null, 'approve')).rejects.toThrow(
      'already decided',
    );
  });
  it('blocks a granted question after revocation and rejects forwarding loops', async () => {
    const h = harness();
    h.busy.add(
      (await h.service.request('source', null, { ...request, requestId: 'warm' })).targetSessionId,
    );
    const question = await h.service.request('source', null, request);
    expect(h.rows.get(question.id)?.status).toBe('approved');
    h.revoke();
    h.busy.clear();
    await h.service.recover();
    expect(h.rows.get(question.id)?.status).toBe('blocked');
    await expect(h.service.request(question.targetSessionId, null, request)).rejects.toThrow(
      'forward',
    );
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

it('recovers approved requests once and retries independent answer deliveries after a failure', async () => {
  const h = harness();
  const inquiry = await h.service.request('source', null, { ...request, kind: 'change' });
  // Allowed, but the server stopped before its target session was provisioned.
  Object.assign(h.rows.get(inquiry.id)!, { status: 'provisioning', humanApproved: true });
  await h.service.recover();
  await h.service.recover();
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  h.replies.push(
    { ...inquiry, id: 'first', status: 'answered', answer: 'First' },
    { ...inquiry, id: 'second', status: 'answered', answer: 'Second' },
  );
  h.reply.mockRejectedValueOnce(new Error('source temporarily unavailable'));
  await h.service.recover();
  expect(h.markAnswerDelivered).toHaveBeenCalledTimes(1);
  expect(h.markAnswerDelivered).toHaveBeenCalledWith('second');
  await h.service.recover();
  expect(h.markAnswerDelivered).toHaveBeenCalledWith('first');
});

it('surfaces a deleted target as blocked rather than retrying it forever', async () => {
  const h = harness();
  const inquiry = await h.service.request('source', null, { ...request, kind: 'change' });
  Object.assign(h.rows.get(inquiry.id)!, { status: 'approved', humanApproved: true });
  h.sessions.delete(inquiry.targetSessionId);
  await h.service.recover();
  expect(h.rows.get(inquiry.id)?.status).toBe('blocked');
  expect(h.dispatch).not.toHaveBeenCalled();
});

it('advances bounded recovery pages past 100 failing answer deliveries', async () => {
  const h = harness();
  const inquiry = await h.service.request('source', null, request);
  h.reply.mockImplementation(async (row: ProjectInquiry) => row.id === 'reply100');
  for (let n = 0; n < 101; n++)
    h.replies.push({
      ...inquiry,
      id: `reply${String(n).padStart(3, '0')}`,
      status: 'answered',
      answer: 'Answer',
    });
  await h.service.recover();
  expect(h.markAnswerDelivered).not.toHaveBeenCalled();
  await h.service.recover();
  expect(h.markAnswerDelivered).toHaveBeenCalledWith('reply100');
});

it('advances request recovery past 100 busy targets', async () => {
  const h = harness();
  const inquiry = await h.service.request('source', null, request);
  h.busy.add('busy');
  for (let n = 0; n < 101; n++) {
    const id = `row${String(n).padStart(3, '0')}`;
    h.rows.set(id, {
      ...inquiry,
      id,
      status: 'approved',
      targetSessionId: n < 100 ? 'busy' : inquiry.targetSessionId,
    });
  }
  const before = h.dispatch.mock.calls.length;
  await h.service.recover();
  expect(h.dispatch).toHaveBeenCalledTimes(before);
  await h.service.recover();
  expect(h.dispatch).toHaveBeenCalledTimes(before + 1);
});

it('does not provision a target when durable request admission is refused', async () => {
  const h = harness();
  vi.mocked(h.store.projectInquiries.create).mockRejectedValueOnce(
    new Error('Daily project inquiry limit reached (20)'),
  );
  await expect(h.service.request('source', null, request)).rejects.toThrow('Daily');
  expect(h.createSession).not.toHaveBeenCalled();
  expect(h.store.projectInquiries.bind).not.toHaveBeenCalled();
  expect(h.store.createSessionLink).not.toHaveBeenCalled();
});

it('filters project approval queries before the bounded store list', async () => {
  const list = vi.fn(async () => []);
  const store = {
    listProjects: async () => [{ id: 'other' }, { id: 'target' }],
    projectInquiries: { list },
  } as unknown as EventStore;
  const deps = {
    store,
    authorized: async () => true,
    busy: () => false,
    createSession: async () => {},
    dispatch: async () => true,
  };
  const app = Fastify();
  registerProjectInquiryRoutes(app, deps, createProjectInquiries(deps), () => null);
  try {
    expect((await app.inject('/project-inquiries/pending?projectId=target')).statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(undefined, true, ['target']);
  } finally {
    await app.close();
  }
});

it('does not replay an admitted request posture after queue bookkeeping failed', async () => {
  const h = harness();
  h.store.projectInquiries.markQueued.mockRejectedValueOnce(new Error('bookkeeping failed'));
  await expect(h.service.request('source', null, request)).rejects.toThrow('bookkeeping');
  h.store.repairs.dispatchReceipt.mockResolvedValue({ state: 'admitted' });
  h.planning.mockClear();
  h.store.projectInquiries.activate.mockClear();
  await h.service.recover();
  expect(h.planning).not.toHaveBeenCalled();
  expect(h.store.projectInquiries.activate).not.toHaveBeenCalled();
  expect([...h.rows.values()][0]?.status).toBe('queued');
});

it('lets a source manager revoke a grant without target execution access', async () => {
  const setGrant = vi.fn();
  const grants = vi.fn(async () => []);
  const store = { projectInquiries: { setGrant, grants } } as unknown as EventStore;
  const deps = {
    store,
    authorized: async () => false,
    busy: () => false,
    createSession: async () => {},
    dispatch: async () => true,
  };
  const app = Fastify();
  registerProjectInquiryRoutes(app, deps, createProjectInquiries(deps), () => null);
  try {
    const send = (enabled: boolean) =>
      app.inject({
        method: 'PUT',
        url: '/projects/source/inquiry-grants',
        payload: { targetProjectId: 'target', enabled },
      });
    // Only "Always allow" on a card creates a grant; this route can only revoke.
    expect((await send(true)).statusCode).toBe(400);
    expect((await send(false)).statusCode).toBe(200);
    expect(setGrant).toHaveBeenCalledExactlyOnceWith('source', 'target', false);
  } finally {
    await app.close();
  }
});

it('recovers a durably reserved request after target provisioning fails', async () => {
  const h = harness();
  h.createSession.mockRejectedValueOnce(new Error('provisioning failed'));
  await expect(h.service.request('source', null, request)).rejects.toThrow('provisioning failed');
  expect([...h.rows.values()][0]?.status).toBe('provisioning');
  await h.service.recover();
  expect(h.createSession).toHaveBeenCalledTimes(2);
  expect([...h.rows.values()][0]?.status).toBe('queued');
});
