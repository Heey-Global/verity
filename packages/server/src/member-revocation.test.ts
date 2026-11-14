import { describe, expect, it, vi } from 'vitest';

import { createMemberRevocation } from './member-revocation.js';

describe('member revocation', () => {
  // Removing Lena from p1 must end exactly her work there: not the
  // administrator's in p1, not hers in another project.
  it("ends only the removed person's work in that project, even when a step fails", async () => {
    const sessions: Record<string, string> = { a: 'p1', b: 'p1', c: 'p2' };
    const initiators: Record<string, string> = { a: 'lena', b: 'admin', c: 'lena' };
    const dequeue = vi.fn(async () => undefined);
    const cancelTurn = vi.fn(async () => undefined);
    const order: string[] = [];
    const sleepSandbox = vi.fn(async () => void order.push('sleep'));
    const stopDevServers = vi.fn(async () => void order.push('servers'));
    const deleteDoppler = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const deleteGrants = vi.fn(async () => 1);
    const onError = vi.fn();
    const revoke = createMemberRevocation({
      store: {
        getSession: async (id: string) => ({ projectId: sessions[id] ?? null }),
        listQueuedTurns: async () => [
          { id: 'q1', sessionId: 'a', opts: { initiatedBy: { userId: 'lena' } } },
          { id: 'q2', sessionId: 'b', opts: { initiatedBy: { userId: 'admin' } } },
          { id: 'q3', sessionId: 'c', opts: { initiatedBy: { userId: 'lena' } } },
        ],
        listRunningTurns: async () => [
          { sessionId: 'a', promptSeq: 1 },
          { sessionId: 'b', promptSeq: 2 },
          { sessionId: 'c', promptSeq: 3 },
        ],
        promptInitiatorAt: async (sessionId: string) => ({ userId: initiators[sessionId]! }),
        userDopplerConnections: { delete: deleteDoppler },
        deleteUserProjectGrants: deleteGrants,
      } as never,
      dequeue,
      cancelTurn,
      sleepSandbox,
      stopDevServers,
      onError,
    });
    await revoke('p1', 'lena');
    expect(dequeue.mock.calls).toEqual([['a', 'q1']]);
    expect(cancelTurn.mock.calls).toEqual([['a']]);
    expect(deleteGrants).toHaveBeenCalledWith('p1', 'lena');
    expect(sleepSandbox).toHaveBeenCalledWith('p1', 'lena');
    // Servers stop first: a running one would wake the sandbox again.
    expect(stopDevServers).toHaveBeenCalledWith('p1', 'lena');
    expect(order).toEqual(['servers', 'sleep']);
    expect(onError).toHaveBeenCalledWith('Doppler connection', expect.any(Error));
  });
});
