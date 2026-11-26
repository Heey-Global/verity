import { describe, expect, it, vi } from 'vitest';
import {
  publishDevServerStatusMutation,
  publishSessionAutomationMutation,
  publishSessionStatusMutation,
  publishServerUpdateStatusMutation,
  subscribeDevServerStatusMutations,
  subscribeSessionAutomationMutations,
  subscribeSessionStatusMutations,
  subscribeServerUpdateStatusMutations,
} from './liveStatusMutation.js';

describe('live status mutations', () => {
  it('publishes server update states', () => {
    const updateListener = vi.fn();
    const unsubscribeUpdate = subscribeServerUpdateStatusMutations(updateListener);
    const update = { state: 'current', operation: null } as Parameters<
      typeof publishServerUpdateStatusMutation
    >[0];

    publishServerUpdateStatusMutation(update);

    expect(updateListener).toHaveBeenCalledWith(update);
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
