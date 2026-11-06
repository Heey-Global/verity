import { describe, expect, it, vi } from 'vitest';
import type { EventStore, ProjectInquiry } from '@verity/store';
import { createProjectInquiries } from './project-inquiries.js';

function harness() {
  const busy = new Set<string>();
  const replies: ProjectInquiry[] = [];
  const reply = vi.fn<(row: ProjectInquiry) => Promise<boolean>>(async () => true);
  const markAnswerDelivered = vi.fn();
  const rows = new Map<string, ProjectInquiry>();
  const sessions = new Map<string, { projectId: string }>([['source', { projectId: 'app' }]]);
  let grant = true;
  const planning = vi.fn();
  const dispatch = vi.fn(async (_inquiry: ProjectInquiry, validate: () => Promise<boolean>) =>
    validate(),
  );
  const store = {
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
      get: vi.fn(async (id: string) => rows.get(id)),
      create: vi.fn(async (input: ProjectInquiry) => {
        if (!rows.has(input.id)) rows.set(input.id, input);
        return rows.get(input.id)!;
      }),
      markQueued: vi.fn(async (id: string) => {
        rows.get(id)!.status = 'queued';
      }),
      decide: vi.fn(async (id: string, target: string, approve: boolean) => {
        const row = rows.get(id);
        if (!row || row.targetSessionId !== target || row.status !== 'pending' || !grant)
          return false;
        row.status = approve ? 'approved' : 'rejected';
        return true;
      }),
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
          .filter((r) => r.status === 'approved' && r.id > after)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 100),
      ),
    },
  } as unknown as EventStore;
  const createSession = vi.fn(async (projectId: string, id: string) => {
    sessions.set(id, { projectId });
  });
  const service = createProjectInquiries({
    store,
    authorized: async () => true,
    createSession,
    reply,
    busy: (id) => busy.has(id),
    dispatch,
  });
  return {
    service,
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
  it('reuses one target for follow-up questions and sets read-only planning before dispatch', async () => {
    const h = harness();
    const first = await h.service.request('source', null, request);
    const second = await h.service.request('source', null, { ...request, requestId: 'two' });
    expect(second.targetSessionId).toBe(first.targetSessionId);
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.planning).toHaveBeenCalledWith(first.targetSessionId, 'active');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch changes before a target-side decision', async () => {
    const h = harness();
    const change = await h.service.request('source', null, { ...request, kind: 'change' });
    expect(change.status).toBe('pending');
    expect(h.dispatch).not.toHaveBeenCalled();
    await expect(h.service.decide('source', change.id, null, true)).rejects.toThrow('unavailable');
    await h.service.decide(change.targetSessionId, change.id, null, true);
    expect(h.planning).toHaveBeenCalledWith(change.targetSessionId, 'implemented');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rechecks revoked access before delivery and rejects forwarding loops', async () => {
    const h = harness();
    const change = await h.service.request('source', null, { ...request, kind: 'change' });
    h.revoke();
    await expect(h.service.decide(change.targetSessionId, change.id, null, true)).rejects.toThrow();
    await expect(h.service.request(change.targetSessionId, null, request)).rejects.toThrow(
      'forward',
    );
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

it('recovers approved requests once and retries independent answer deliveries after a failure', async () => {
  const h = harness();
  const inquiry = await h.service.request('source', null, { ...request, kind: 'change' });
  h.rows.get(inquiry.id)!.status = 'approved';
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
  h.rows.get(inquiry.id)!.status = 'approved';
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
