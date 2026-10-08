import type { BranchList, SessionSummary, VerityClient } from '@verity/mobile';

import {
  cachedBranches,
  seedSessionBranches,
  invalidateBranches,
  prefetchBranches,
  registerBranchesClientScope,
  rememberBranches,
  branchesSnapshotWriter,
  takePrefetchedBranches,
} from './branchesPrefetch';

const branches: BranchList = {
  current: 'fix/status',
  switchable: [],
  previewable: [],
  currentPr: 42,
};

describe('branches prefetch', () => {
  it('preserves cached branch metadata for older summaries and clears a confirmed absent PR', () => {
    const client = {} as VerityClient;
    rememberBranches(client, 's', { ...branches, owner: 'example', repo: 'repo' });
    seedSessionBranches(client, { sessionId: 's' } as SessionSummary);
    expect(cachedBranches(client, 's')?.currentPr).toBe(42);
    seedSessionBranches(client, { sessionId: 's', pullRequest: null } as SessionSummary);
    expect(cachedBranches(client, 's')).toMatchObject({
      current: branches.current,
      owner: 'example',
      repo: 'repo',
      currentPr: null,
      pullRequest: null,
    });
  });

  it('does not reopen a cached PR after a confirmed terminal action in the overview', () => {
    const client = {} as VerityClient;
    rememberBranches(client, 's', {
      ...branches,
      pullRequest: {
        number: 42,
        title: 'Known',
        url: 'https://github.com/example/repo/pull/42',
        phase: 'open',
        pipeline: 'running',
        mergeable: null,
        checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
      },
    });
    seedSessionBranches(client, {
      sessionId: 's',
      pr: { phase: 'merged', pipeline: 'success', mergeable: false },
    } as SessionSummary);
    expect(cachedBranches(client, 's')?.pullRequest?.phase).toBe('merged');
  });

  it('disowns a speculative read that predates the overview snapshot', async () => {
    let resolve!: (value: BranchList) => void;
    const client = {
      getBranches: jest.fn(
        () =>
          new Promise<BranchList>((done) => {
            resolve = done;
          }),
      ),
    } as unknown as VerityClient;
    prefetchBranches(client, 's');
    seedSessionBranches(client, { sessionId: 's', pullRequest: null } as SessionSummary);
    resolve(branches);
    await Promise.resolve();
    expect(cachedBranches(client, 's')?.currentPr).toBeNull();
    expect(takePrefetchedBranches(client, 's')).toBeUndefined();
  });

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

describe('last known branches', () => {
  it('retains a completed prefetch for immediate painting, isolated by client and session', async () => {
    const client = {
      getBranches: jest.fn().mockResolvedValue(branches),
    } as unknown as VerityClient;
    const other = {} as VerityClient;
    prefetchBranches(client, 'known');
    await takePrefetchedBranches(client, 'known');
    expect(cachedBranches(client, 'known')).toBe(branches);
    expect(cachedBranches(client, 'other')).toBeUndefined();
    expect(cachedBranches(other, 'known')).toBeUndefined();
  });

  it('does not resurrect speculative state after mutation invalidation', async () => {
    let resolve!: (value: BranchList) => void;
    const promise = new Promise<BranchList>((done) => {
      resolve = done;
    });
    const client = { getBranches: jest.fn().mockReturnValue(promise) } as unknown as VerityClient;
    prefetchBranches(client, 'mutated');
    invalidateBranches(client, 'mutated');
    resolve(branches);
    await promise;
    expect(cachedBranches(client, 'mutated')).toBeUndefined();
    expect(takePrefetchedBranches(client, 'mutated')).toBeUndefined();
  });
});

describe('shared branches scope', () => {
  it('shares navigation requests and snapshots across clients with the same server and credential ID', async () => {
    const opener = {
      getBranches: jest.fn().mockResolvedValue(branches),
    } as unknown as VerityClient;
    const screen = { getBranches: jest.fn() } as unknown as VerityClient;
    registerBranchesClientScope(opener, () => 'shared-test-server:credential');
    registerBranchesClientScope(screen, () => 'shared-test-server:credential');
    prefetchBranches(opener, 's');
    await expect(takePrefetchedBranches(screen, 's')).resolves.toBe(branches);
    expect(cachedBranches(screen, 's')).toBe(branches);
    expect(screen.getBranches).not.toHaveBeenCalled();
  });

  it('captures request identity so old authentication cannot populate the rotated scope', async () => {
    let scope = 'rotation-test-server:old';
    let resolve!: (value: BranchList) => void;
    const promise = new Promise<BranchList>((done) => {
      resolve = done;
    });
    const client = { getBranches: jest.fn().mockReturnValue(promise) } as unknown as VerityClient;
    registerBranchesClientScope(client, () => scope);
    const publish = branchesSnapshotWriter(client, 'read');
    prefetchBranches(client, 'prefetch');
    scope = 'rotation-test-server:new';
    publish(branches);
    resolve(branches);
    await promise;
    expect(cachedBranches(client, 'read')).toBeUndefined();
    expect(cachedBranches(client, 'prefetch')).toBeUndefined();
    expect(takePrefetchedBranches(client, 'prefetch')).toBeUndefined();
    scope = 'rotation-test-server:old';
    expect(cachedBranches(client, 'read')).toBe(branches);
    expect(cachedBranches(client, 'prefetch')).toBe(branches);
  });

  it('ignores an older speculative response after a fresher read starts', () => {
    const client = {} as VerityClient;
    const old = branchesSnapshotWriter(client, 's');
    const fresh = branchesSnapshotWriter(client, 's');
    const changed = { ...branches, current: 'fix/new' };
    fresh(changed);
    old(branches);
    expect(cachedBranches(client, 's')).toBe(changed);
  });

  it('bounds retained snapshots', () => {
    const client = {} as VerityClient;
    for (let index = 0; index < 101; index += 1) rememberBranches(client, String(index), branches);
    expect(cachedBranches(client, '0')).toBeUndefined();
    expect(cachedBranches(client, '100')).toBe(branches);
  });
});

describe('prefetch freshness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('expires an abandoned completed prefetch but retains its immediate-paint snapshot', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const getBranches = jest.fn().mockResolvedValue(branches);
    const client = { getBranches } as unknown as VerityClient;
    prefetchBranches(client, 'abandoned');
    await getBranches.mock.results[0].value;
    now += 15_000;
    expect(takePrefetchedBranches(client, 'abandoned')).toBeUndefined();
    expect(cachedBranches(client, 'abandoned')).toBe(branches);
    prefetchBranches(client, 'abandoned');
    await expect(takePrefetchedBranches(client, 'abandoned')).resolves.toBe(branches);
    expect(getBranches).toHaveBeenCalledTimes(2);
  });

  it('joins an in-flight request even after the settled freshness window', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: BranchList) => void;
    const promise = new Promise<BranchList>((done) => {
      resolve = done;
    });
    const getBranches = jest.fn().mockReturnValue(promise);
    const client = { getBranches } as unknown as VerityClient;
    prefetchBranches(client, 'slow');
    now += 60_000;
    prefetchBranches(client, 'slow');
    const joined = takePrefetchedBranches(client, 'slow');
    expect(joined).toBeDefined();
    resolve(branches);
    await expect(joined).resolves.toBe(branches);
    expect(getBranches).toHaveBeenCalledTimes(1);
  });
});
