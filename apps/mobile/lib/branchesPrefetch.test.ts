import type { BranchList, VerityClient } from '@verity/mobile';

import { prefetchBranches, takePrefetchedBranches } from './branchesPrefetch';

const branches: BranchList = {
  current: 'fix/status',
  switchable: [],
  previewable: [],
  currentPr: 42,
};

describe('branches prefetch', () => {
  it('starts once and hands the opening request to the session screen', async () => {
    const getBranches = jest.fn().mockResolvedValue(branches);
    const client = { getBranches } as unknown as VerityClient;

    prefetchBranches(client, 'session-1');
    prefetchBranches(client, 'session-1');

    expect(getBranches).toHaveBeenCalledTimes(1);
    await expect(takePrefetchedBranches(client, 'session-1')).resolves.toBe(branches);
    expect(takePrefetchedBranches(client, 'session-1')).toBeUndefined();
  });

  it('immediately retries a failed prefetch through the normal screen request', async () => {
    const getBranches = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(branches);
    const client = { getBranches } as unknown as VerityClient;

    prefetchBranches(client, 'session-2');
    await expect(takePrefetchedBranches(client, 'session-2')).resolves.toBe(branches);
    expect(getBranches).toHaveBeenCalledTimes(2);
    expect(takePrefetchedBranches(client, 'session-2')).toBeUndefined();
  });
});
