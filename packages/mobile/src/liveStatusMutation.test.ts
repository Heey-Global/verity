import { describe, expect, it, vi } from 'vitest';
import {
  publishAgentLoopMutation,
  publishDevServerStatusMutation,
  publishProjectStatusMutation,
  publishSessionStatusMutation,
  publishServerUpdateStatusMutation,
  subscribeAgentLoopMutations,
  subscribeDevServerStatusMutations,
  subscribeProjectStatusMutations,
  subscribeSessionStatusMutations,
  subscribeServerUpdateStatusMutations,
} from './liveStatusMutation.js';

describe('live status mutations', () => {
  it('publishes project and server update states independently', () => {
    const projectListener = vi.fn();
    const updateListener = vi.fn();
    const unsubscribeProject = subscribeProjectStatusMutations(projectListener);
    const unsubscribeUpdate = subscribeServerUpdateStatusMutations(updateListener);
    const project = { id: 'p1', state: 'active' } as Parameters<
      typeof publishProjectStatusMutation
    >[0];
    const update = { state: 'current', operation: null } as Parameters<
      typeof publishServerUpdateStatusMutation
    >[0];

    publishProjectStatusMutation(project);
    publishServerUpdateStatusMutation(update);

    expect(projectListener).toHaveBeenCalledWith(project);
    expect(updateListener).toHaveBeenCalledWith(update);
    unsubscribeProject();
    unsubscribeUpdate();
  });

  it('publishes loop, dev-server, and session action projections', () => {
    const loopListener = vi.fn();
    const serverListener = vi.fn();
    const sessionListener = vi.fn();
    const unsubscribes = [
      subscribeAgentLoopMutations(loopListener),
      subscribeDevServerStatusMutations(serverListener),
      subscribeSessionStatusMutations(sessionListener),
    ];
    const loop = { id: 'loop-1' } as Parameters<typeof publishAgentLoopMutation>[0];
    const server = { id: 'dev-1', projectId: 'p1', running: true };

    publishAgentLoopMutation(loop);
    publishDevServerStatusMutation(server);
    publishSessionStatusMutation('s1', 'running');

    expect(loopListener).toHaveBeenCalledWith(loop);
    expect(serverListener).toHaveBeenCalledWith(server);
    expect(sessionListener).toHaveBeenCalledWith('s1', 'running');
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
