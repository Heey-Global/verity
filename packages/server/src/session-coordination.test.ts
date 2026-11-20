import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import {
  createSessionCoordination,
  type CoordinationRequestReceipt,
  type SessionCoordinationDeps,
} from './session-coordination.js';

function harness() {
  const projects = new Map([
    [
      'app',
      { id: 'app', name: 'App', repo: 'app', kind: 'github', state: 'active', hiddenAt: null },
    ],
    [
      'control',
      {
        id: 'control',
        name: 'Control',
        repo: 'Control',
        kind: 'control_plane',
        state: 'active',
        hiddenAt: null,
      },
    ],
    [
      'private',
      {
        id: 'private',
        name: 'Private',
        repo: 'private',
        kind: 'github',
        state: 'active',
        hiddenAt: null,
      },
    ],
  ]);
  const sessions = new Map([
    ['source', { sessionId: 'source', projectId: 'app', name: 'Source' }],
    ['peer', { sessionId: 'peer', projectId: 'app', name: 'Mobile rendering' }],
    ['control-peer', { sessionId: 'control-peer', projectId: 'control', name: 'Infrastructure' }],
    ['secret', { sessionId: 'secret', projectId: 'private', name: 'Secret session' }],
  ]);
  const receipts = new Map<string, CoordinationRequestReceipt & { fingerprint: string }>();
  const granted = new Set(['app', 'control']);
  const links = new Set<string>();
  const store = {
    getProject: vi.fn(async (id: string) => projects.get(id)),
    listProjects: vi.fn(async () => [...projects.values()]),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    listSessions: vi.fn(async () => [...sessions.values()]),
    createSessionLink: vi.fn(async (source: string, target: string, requestId?: string) => {
      links.add(target);
      if (requestId) receipts.get(`${source}:${requestId}`)!.phase = 'linked';
      return true;
    }),
    listSessionLinks: vi.fn(async () => [...links].map((peerSessionId) => ({ peerSessionId }))),
  };
  const spawn = vi.fn(async (projectId: string, sessionId: string, name: string) => {
    sessions.set(sessionId, { projectId, sessionId, name });
  });
  const deliver = vi.fn<SessionCoordinationDeps['deliver']>(async () => ({ queued: true }));
  const readProgress = vi.fn<SessionCoordinationDeps['readProgress']>(async (id: string) =>
    id === 'peer'
      ? { summary: 'Expo export fails', stale: false, updatedAt: '2026-01-01T00:00:00Z' }
      : {},
  );
  const claim = vi.fn(async (source: string, requestId: string, fingerprint: string) => {
    const key = `${source}:${requestId}`;
    const existing = receipts.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new Error('request changed');
    if (!existing) receipts.set(key, { phase: 'reserved', fingerprint });
    return { ...receipts.get(key)! };
  });
  const update = vi.fn(
    async (source: string, requestId: string, receipt: CoordinationRequestReceipt) => {
      Object.assign(receipts.get(`${source}:${requestId}`)!, receipt);
    },
  );
  const deps = {
    store: store as unknown as EventStore,
    authorized: async (_userId: string | null, projectId: string) => granted.has(projectId),
    spawn,
    deliver,
    readProgress,
    status: () => 'idle',
    requests: { claim, update },
  };
  const execute = createSessionCoordination(deps);
  const call = (request: unknown) =>
    execute({ sourceSessionId: 'source', userId: 'user', request });
  return {
    projects,
    links,
    sessions,
    receipts,
    granted,
    store,
    spawn,
    deliver,
    readProgress,
    deps,
    call,
  };
}

const start = {
  operation: 'start',
  requestId: 'one',
  targetProjectId: 'control',
  name: 'Investigate',
  message: 'Find the fault',
};
const link = {
  operation: 'link',
  requestId: 'link',
  targetProjectId: 'app',
  targetSessionId: 'peer',
  message: 'Please investigate',
};

describe('user-requested session coordination', () => {
  it('stops linking and delivery when planning starts during session provisioning', async () => {
    const h = harness();
    let planning = false;
    h.spawn.mockImplementationOnce(async (projectId, sessionId, name) => {
      h.sessions.set(sessionId, { projectId, sessionId, name });
      planning = true;
    });
    const execute = createSessionCoordination(h.deps);
    await expect(
      execute({
        sourceSessionId: 'source',
        userId: 'user',
        request: start,
        validateCaller: async () => {
          if (planning) throw new Error('planning active');
        },
      }),
    ).rejects.toThrow('planning active');
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('retains the delivery id across exact-message approval without dispatching another assignment', async () => {
    const h = harness();
    h.deliver.mockResolvedValueOnce({ status: 'approval_required' });
    await h.call(link);
    const execute = createSessionCoordination(h.deps);
    await execute({
      sourceSessionId: 'source',
      userId: 'user',
      request: link,
      approvedByCard: true,
    });
    expect(h.deliver.mock.calls[0]![0]).toMatchObject({ approvedByCard: false });
    expect(h.deliver.mock.calls[1]![0]).toMatchObject({
      invocationId: h.deliver.mock.calls[0]![0].invocationId,
      message: link.message,
      targetSessionId: link.targetSessionId,
      approvedByCard: true,
    });
    await execute({
      sourceSessionId: 'source',
      userId: 'user',
      request: link,
      approvedByCard: true,
    });
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('keeps an approval-required delivery retryable without recording completion', async () => {
    const h = harness();
    h.deliver.mockResolvedValueOnce({ status: 'approval_required' });
    expect(await h.call(link)).toMatchObject({ status: 'approval_required' });
    expect(h.receipts.get('source:link')!.phase).toBe('linked');
    await h.call(link);
    expect(h.deliver).toHaveBeenCalledTimes(2);
    expect(h.receipts.get('source:link')!.phase).toBe('delivered');
  });

  it('does not reinstate a revoked link from a completed or partially delivered request', async () => {
    const h = harness();
    await h.call(link);
    h.links.clear();
    await expect(h.call(link)).rejects.toThrow('revoked');
    expect(h.store.createSessionLink).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('discovers authorized metadata and published summaries without reading transcripts', async () => {
    const h = harness();
    const result = await h.call({ operation: 'discover', query: 'Expo' });
    expect(result).toMatchObject({
      sessions: [{ sessionId: 'peer', progress: { summary: 'Expo export fails', stale: false } }],
    });
    expect(h.readProgress).not.toHaveBeenCalledWith('secret');
    expect(JSON.stringify(await h.call({ operation: 'discover' }))).not.toContain('Private');
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
  });

  it('reports ambiguity, missing progress and bounded discovery', async () => {
    const h = harness();
    expect(await h.call({ operation: 'discover' })).toMatchObject({ selectionRequired: true });
    expect(await h.call({ operation: 'discover', limit: 1 })).toMatchObject({
      hasMore: true,
      sessions: [{ sessionId: 'peer' }],
    });
    expect(await h.call({ operation: 'discover', targetProjectId: 'control' })).toMatchObject({
      sessions: [{ progress: { summary: null, stale: true } }],
    });
  });

  it.each(['app', 'control'])(
    'creates and links a session in %s, retaining user identity',
    async (targetProjectId) => {
      const h = harness();
      const result = await h.call({ ...start, targetProjectId });
      expect(result).toMatchObject({ created: true, linked: true, delivery: { queued: true } });
      expect(result.targetSessionId).toMatch(
        /^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/,
      );
      expect(h.spawn).toHaveBeenCalledWith(
        targetProjectId,
        result.targetSessionId,
        'Investigate',
        'user',
      );
      expect(h.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSessionId: 'source',
          targetSessionId: result.targetSessionId,
          userId: 'user',
        }),
      );
    },
  );

  it('serializes retries and reuses the durable receipt after service recreation', async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.call(start), h.call(start)]);
    expect(first).toEqual(second);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const recovered = createSessionCoordination(h.deps);
    expect(await recovered({ sourceSessionId: 'source', userId: 'user', request: start })).toEqual(
      first,
    );
    expect(h.deliver).toHaveBeenCalledTimes(1);
    await expect(h.call({ ...start, message: 'Different scope' })).rejects.toThrow(
      'request changed',
    );
  });

  it('resumes after link failure without creating a second session', async () => {
    const h = harness();
    h.store.createSessionLink.mockRejectedValueOnce(new Error('temporary'));
    await expect(h.call(start)).rejects.toThrow('temporary');
    expect(await h.call(start)).toMatchObject({ linked: true });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('retries delivery with a stable invocation without renewing the allowance', async () => {
    const h = harness();
    h.deliver.mockRejectedValueOnce(new Error('allowance unavailable'));
    await expect(h.call(link)).rejects.toThrow('allowance unavailable');
    await h.call(link);
    expect(h.deliver.mock.calls[0]).toEqual(h.deliver.mock.calls[1]);
    expect(h.deliver.mock.calls[1]![0]).toHaveProperty('approvedByCard', false);
  });

  it('refuses unauthorized, missing, moved and self targets before linking', async () => {
    const h = harness();
    await expect(h.call({ ...start, targetProjectId: 'private' })).rejects.toThrow('not permitted');
    await expect(
      h.call({ ...link, requestId: 'missing', targetSessionId: 'missing' }),
    ).rejects.toThrow('unavailable');
    await expect(h.call({ ...link, requestId: 'self', targetSessionId: 'source' })).rejects.toThrow(
      'unavailable',
    );
    h.sessions.get('peer')!.projectId = 'control';
    await expect(h.call(link)).rejects.toThrow('unavailable');
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('does not recreate a deleted created target or return cached delivery after revocation', async () => {
    const h = harness();
    const result = await h.call(start);
    h.granted.delete('control');
    await expect(h.call(start)).rejects.toThrow('not permitted');
    h.granted.add('control');
    h.sessions.delete(result.targetSessionId as string);
    await expect(h.call(start)).rejects.toThrow('deleted');
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('rechecks authorization after spawn and summary reads', async () => {
    const h = harness();
    h.spawn.mockImplementationOnce(async () => {
      h.granted.delete('control');
    });
    await expect(h.call(start)).rejects.toThrow('not permitted');
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
    h.readProgress.mockImplementationOnce(async () => {
      h.granted.delete('app');
      return { summary: 'hidden' };
    });
    await expect(h.call({ operation: 'discover' })).rejects.toThrow('not permitted');
  });

  it('rechecks the bound source project after spawn', async () => {
    const h = harness();
    h.spawn.mockImplementationOnce(async (projectId, sessionId, name) => {
      h.sessions.set(sessionId, { projectId, sessionId, name });
      h.sessions.get('source')!.projectId = 'control';
    });
    await expect(h.call(start)).rejects.toThrow('Source session project changed');
    expect(h.store.createSessionLink).not.toHaveBeenCalled();
  });
  it('continues beyond the summary scan limit to find a newer exact-name match', async () => {
    const h = harness();
    h.sessions.clear();
    h.sessions.set('source', { sessionId: 'source', projectId: 'app', name: 'Source' });
    for (let i = 0; i < 201; i++)
      h.sessions.set(`session-${i}`, {
        sessionId: `session-${i}`,
        projectId: 'app',
        name: i === 200 ? 'Newest exact topic' : `Old session ${i}`,
      });
    const first = await h.call({
      operation: 'discover',
      targetProjectId: 'app',
      query: 'Newest exact topic',
    });
    expect(first).toMatchObject({ sessions: [], nextSessionOffset: 200, scanTruncated: true });
    expect(h.readProgress).toHaveBeenCalledTimes(200);
    const next = await h.call({
      operation: 'discover',
      targetProjectId: 'app',
      query: 'Newest exact topic',
      sessionOffset: first.nextSessionOffset,
    });
    expect(next).toMatchObject({
      sessions: [{ sessionId: 'session-200' }],
      nextSessionOffset: null,
      hasMore: false,
    });
  });

  it('does not skip matching sessions when the result limit ends a page before the scan limit', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++)
      h.sessions.set(`match-${i}`, {
        sessionId: `match-${i}`,
        projectId: 'app',
        name: `Mobile rendering ${i}`,
      });
    const found: string[] = [];
    let sessionOffset = 0;
    for (let page = 0; page < 10; page++) {
      const result = await h.call({
        operation: 'discover',
        targetProjectId: 'app',
        query: 'rendering',
        limit: 1,
        sessionOffset,
      });
      found.push(...(result.sessions as { sessionId: string }[]).map((item) => item.sessionId));
      if (typeof result.nextSessionOffset !== 'number') break;
      sessionOffset = result.nextSessionOffset;
    }
    expect(found).toEqual(['peer', 'match-0', 'match-1', 'match-2', 'match-3', 'match-4']);
  });

  it('continues the project list independently of session pagination', async () => {
    const h = harness();
    expect(await h.call({ operation: 'discover', limit: 1 })).toMatchObject({
      projects: [{ projectId: 'app' }],
      nextProjectOffset: 1,
    });
    expect(await h.call({ operation: 'discover', limit: 1, projectOffset: 1 })).toMatchObject({
      projects: [{ projectId: 'control' }],
      nextProjectOffset: null,
    });
    expect(
      await h.call({ operation: 'discover', query: 'Private', projectOffset: 1 }),
    ).toMatchObject({ projects: [], sessions: [], nextProjectOffset: null });
  });
});
