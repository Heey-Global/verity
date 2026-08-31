import { describe, expect, it, vi } from 'vitest';
import { publishSettledPermission, subscribeSettledPermissions } from './permissionSettlement.js';

describe('permission settlement notifications', () => {
  it('publishes the exact session and tool-use ids until unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSettledPermissions(listener);

    publishSettledPermission('session-1', 'tool-1');
    expect(listener).toHaveBeenCalledWith('session-1', 'tool-1');

    unsubscribe();
    publishSettledPermission('session-1', 'tool-2');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
