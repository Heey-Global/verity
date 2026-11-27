import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import type { Conductor } from '@verity/session';
import Fastify from 'fastify';
import { createGatewaySessionCoordination } from './session-coordination-runtime.js';

function setup() {
  const session = { projectId: 'project', planning: null as string | null };
  const prompt = {
    seq: 7,
    event: { t: 'prompt', text: 'Find the existing session', peer: undefined as unknown },
  };
  const store = {
    sessionCoordination: { claim: vi.fn(), update: vi.fn() },
    getSession: vi.fn(async () => session),
    getProject: vi.fn(async () => ({
      id: 'project',
      kind: 'local',
      state: 'active',
      hiddenAt: null,
    })),
    listProjects: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listRunningTurns: vi.fn(async () => [{ sessionId: 'source', turnId: 'turn', promptSeq: 7 }]),
    getEventsBeforeSeq: vi.fn(async () => ({ events: [prompt], hasMore: false })),
    projectInquiries: { isTarget: vi.fn(async () => false) },
  };
  const authorized = vi.fn<
    (userId: string | null | undefined, projectId: string | null) => Promise<boolean>
  >(async () => true);
  const spawn = vi.fn();
  const app = Fastify();
  const gateway = createGatewaySessionCoordination({
    store: store as unknown as EventStore,
    conductor: { isBusy: () => false, isPlanningTurn: () => false } as unknown as Conductor,
    app,
    spawn: () => spawn,
    authorized,
    initiator: async () => ({ userId: 'human' }),
  });
  const caller = {
    projectId: 'project',
    sessionId: 'source',
    turnId: 'turn',
    request: { operation: 'discover' },
  };
  return { gateway, store, session, prompt, authorized, spawn, caller };
}

describe('coordination gateway authority', () => {
  it('uses the live initiator for discovery without spawning a session', async () => {
    const h = setup();
    expect(await h.gateway.execute(h.caller)).toMatchObject({ projects: [], sessions: [] });
    expect(h.authorized).toHaveBeenCalledWith('human', 'project');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('requires exact managed approval before a mutation reaches persistence', async () => {
    const h = setup();
    await expect(
      h.gateway.execute({ ...h.caller, request: { operation: 'start' } }),
    ).rejects.toThrow('require approval');
    expect(h.store.sessionCoordination.claim).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects a peer-initiated turn even when its inherited user has access', async () => {
    const h = setup();
    h.prompt.event.peer = { sessionId: 'peer', projectId: 'elsewhere' };
    await expect(h.gateway.execute({ ...h.caller, approvedByCard: true })).rejects.toThrow(
      'Peer messages',
    );
  });

  it('rejects planning, stale turns, changed source and revoked target rights', async () => {
    const h = setup();
    h.session.planning = 'active';
    await expect(h.gateway.authorize(h.caller)).rejects.toThrow('planning mode');
    h.session.planning = null;
    await expect(h.gateway.authorize({ ...h.caller, turnId: 'old' })).rejects.toThrow(
      'live user turn',
    );
    await expect(h.gateway.authorize({ ...h.caller, projectId: 'moved' })).rejects.toThrow(
      'not permitted',
    );
    h.authorized.mockImplementation(async (_user, project) => project !== 'revoked');
    await expect(
      h.gateway.authorize({
        ...h.caller,
        request: { operation: 'discover', targetProjectId: 'revoked' },
      }),
    ).rejects.toThrow('Target project');
  });

  it('does not forward coordination from an inquiry target', async () => {
    const h = setup();
    h.store.projectInquiries.isTarget.mockResolvedValue(true);
    await expect(h.gateway.authorize(h.caller)).rejects.toThrow('cannot coordinate');
  });
});
