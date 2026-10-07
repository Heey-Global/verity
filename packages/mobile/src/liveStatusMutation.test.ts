import { describe, expect, it, vi } from 'vitest';
import {
  publishDevServerStatusMutation,
  publishProjectStatusMutation,
  publishSessionAutomationMutation,
  publishSessionStatusMutation,
  publishServerUpdateStatusMutation,
  subscribeDevServerStatusMutations,
  subscribeProjectStatusMutations,
  subscribeSessionAutomationMutations,
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

  it('publishes automation, dev-server, and session action projections', () => {
    const automationListener = vi.fn();
    const serverListener = vi.fn();
    const sessionListener = vi.fn();
    const unsubscribes = [
      subscribeSessionAutomationMutations(automationListener),
      subscribeDevServerStatusMutations(serverListener),
      subscribeSessionStatusMutations(sessionListener),
    ];
    const server = { id: 'dev-1', projectId: 'p1', running: true };

    publishSessionAutomationMutation('s1', null);
    publishDevServerStatusMutation(server);
    publishSessionStatusMutation('s1', 'running');

    expect(automationListener).toHaveBeenCalledWith('s1', null);
    expect(serverListener).toHaveBeenCalledWith(server);
    expect(sessionListener).toHaveBeenCalledWith('s1', 'running');
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
