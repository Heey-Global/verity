import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import {
  createRepairSupervisor,
  repairTurnTerminated,
  type RepairDiscovery,
  type RepairSupervisorDeps,
} from './repair-supervisor.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'a',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
});
function harness() {
  const observation: RepairDiscovery = {
    page: {
      pulls: [{ number: 42, branch: 'renovate/x', sha: 'sha1', fork: false }],
      runs: [],
      nextPage: null,
      workflowsSupported: true,
    },
    statuses: [
      {
        branch: 'renovate/x',
        status: {
          number: 42,
          title: 'Update',
          url: 'https://example.test/42',
          headSha: 'sha1',
          phase: 'open',
          pipeline: 'failure',
          mergeable: false,
          checks: { completed: 1, total: 1, successful: 0, failed: 1, pending: 0 },
        },
      },
    ],
  };
  const deps: RepairSupervisorDeps = {
    store: ctx.store,
    result: () => Promise.resolve(null),
    discover: vi.fn(async () => observation),
    authorized: vi.fn(async () => true),
    busy: vi.fn(() => false),
    terminated: vi.fn(async () => false),
    target: vi.fn(async () => ({ blocked: false })),
    spawn: vi.fn(async (projectId, sessionId) => {
      await ctx.store.createSession({
        sessionId,
        projectId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
      });
    }),
    dispatch: vi.fn(async () => true),
  };
  return { deps, observation, supervisor: createRepairSupervisor(deps) };
}
describe('repair supervision', () => {
  it('discovers a sessionless Renovate failure without running agents in monitor mode', async () => {
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const h = harness();
    await h.supervisor.sweep();
    await h.supervisor.sweep();
    expect(await ctx.store.repairs.incidents('a')).toHaveLength(1);
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });
  it('creates one worker and retains its claim until termination is confirmed', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const h = harness();
    await h.supervisor.sweep();
    await h.supervisor.sweep();
    expect(h.deps.spawn).toHaveBeenCalledTimes(1);
    expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
    expect((await ctx.store.repairs.incidents('a'))[0]?.state).toBe('working');
  });
  it('respects active project sessions and revoked grants', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const h = harness();
    vi.mocked(h.deps.target).mockResolvedValue({ blocked: true });
    await h.supervisor.sweep();
    expect(h.deps.spawn).not.toHaveBeenCalled();
    vi.mocked(h.deps.authorized).mockResolvedValue(false);
    await h.supervisor.sweep();
    expect((await ctx.store.repairs.mandate('a'))?.health).toBe('access-revoked');
    expect(h.deps.discover).toHaveBeenCalledTimes(1);
  });
  it('never treats an API outage or a different green revision as repair proof', async () => {
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const h = harness();
    await h.supervisor.sweep();
    vi.mocked(h.deps.discover).mockRejectedValueOnce(new Error('offline'));
    await h.supervisor.sweep();
    expect((await ctx.store.repairs.incidents('a'))[0]?.state).toBe('open');
    h.observation.statuses[0]!.status = {
      ...h.observation.statuses[0]!.status,
      headSha: 'sha2',
      pipeline: 'success',
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
    };
    await h.supervisor.sweep();
    const incidents = await ctx.store.repairs.incidents('a');
    expect(incidents.find((i) => i.revision === 'sha1')?.state).toBe('superseded');
    expect(incidents.find((i) => i.revision === 'sha2')?.state).toBe('resolved');
  });
  it('does not dispatch when consent is revoked during session creation', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const h = harness();
    vi.mocked(h.deps.spawn).mockImplementation(async (projectId, sessionId) => {
      await ctx.store.createSession({
        sessionId,
        projectId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
      });
      await ctx.store.repairs.configure('a', 'user', 'off');
    });
    await h.supervisor.sweep();
    expect(h.deps.dispatch).not.toHaveBeenCalled();
    expect((await ctx.store.repairs.incidents('a'))[0]?.state).toBe('blocked');
  });
  it('restores ownership after coordinator restart without dispatching twice', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const h = harness();
    await h.supervisor.sweep();
    await ctx.store.repairs.health('a', 'healthy', '2');
    await createRepairSupervisor(h.deps).sweep();
    expect(vi.mocked(h.deps.discover).mock.calls.at(-1)?.[1]).toBe(2);
    expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not revive an older workflow failure from a later discovery page', async () => {
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const h = harness();
    h.observation.page.pulls = [];
    h.observation.statuses = [];
    h.observation.page.runs = [
      {
        id: '20',
        workflow: 'build',
        sha: 'new',
        branch: 'main',
        conclusion: 'success',
        url: 'https://example.test/run/20',
      },
    ];
    await h.supervisor.sweep();
    h.observation.page.runs = [
      {
        id: '19',
        workflow: 'build',
        sha: 'old',
        branch: 'main',
        conclusion: 'failure',
        url: 'https://example.test/run/19',
      },
    ];
    await h.supervisor.sweep();
    expect(await ctx.store.repairs.incidents('a')).toEqual([]);
  });
  it('releases a confirmed finished worker while paused without reading the forge or dispatching', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const h = harness();
    await h.supervisor.sweep();
    await ctx.store.repairs.configure('a', 'user', 'off');
    vi.mocked(h.deps.terminated).mockResolvedValue(true);
    await h.supervisor.sweep();
    expect(h.deps.discover).toHaveBeenCalledTimes(1);
    expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
    expect((await ctx.store.repairs.incidents('a'))[0]?.owner_session_id).toBeNull();
  });
  it('uses the compatible project session instead of spawning a second worker', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    await ctx.store.createSession({
      sessionId: 'existing',
      projectId: 'a',
      worktree: '/wt/existing',
      model: 'm',
    });
    const h = harness();
    vi.mocked(h.deps.target).mockResolvedValue({ sessionId: 'existing', blocked: false });
    await h.supervisor.sweep();
    expect(h.deps.spawn).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.dispatch).mock.calls[0]?.[0]).toBe('existing');
  });
});

it('retains ownership after uncertain dispatch even without a local busy marker', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const { deps } = harness();
  vi.mocked(deps.dispatch).mockRejectedValue(new Error('response lost'));
  const supervisor = createRepairSupervisor(deps);
  await supervisor.sweep();
  await supervisor.sweep();
  expect(deps.dispatch).toHaveBeenCalledTimes(1);
  expect((await ctx.store.repairs.incidents('a'))[0]?.owner_session_id).toBeTruthy();
});

it('recognizes cancellation without mistaking a previous interruption for the current turn', () => {
  expect(repairTurnTerminated([{ event: { t: 'interrupted' } }])).toBe(true);
  expect(
    repairTurnTerminated([
      { event: { t: 'interrupted' } },
      { event: { t: 'status', state: 'running' } },
    ]),
  ).toBe(false);
});

it('releases the worker claim on a persisted interruption', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const { deps } = harness();
  deps.terminated = async (id) =>
    repairTurnTerminated(await ctx.store.listRecentSessionProjectionEvents(id, 20));
  const supervisor = createRepairSupervisor(deps);
  await supervisor.sweep();
  const owned = (await ctx.store.repairs.incidents('a'))[0]!;
  expect(owned.owner_session_id).toBeTruthy();
  await ctx.store.appendEvent(owned.owner_session_id!, { t: 'interrupted' });
  await supervisor.sweep();
  const finished = (await ctx.store.repairs.incidents('a'))[0]!;
  expect(finished.owner_session_id).toBeNull();
  expect(finished.state).toBe('verifying');
});

it('releases a repair claim if session creation fails before dispatch', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const { deps, supervisor } = harness();
  vi.mocked(deps.spawn).mockRejectedValue(new Error('provisioning failed'));
  await supervisor.sweep();
  expect(deps.dispatch).not.toHaveBeenCalled();
  expect((await ctx.store.repairs.incidents('a'))[0]?.owner_session_id).toBeNull();
});

it.each(['unknown', 'pending'] as const)(
  'invalidates prior actionable evidence when PR becomes %s',
  async (pipeline) => {
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const { observation, supervisor } = harness();
    await supervisor.sweep();
    expect(JSON.parse((await ctx.store.repairs.incidents('a'))[0]!.evidence)).toHaveProperty(
      'observedAt',
      expect.any(String),
    );
    observation.statuses[0]!.status.pipeline = pipeline;
    await supervisor.sweep();
    expect(JSON.parse((await ctx.store.repairs.incidents('a'))[0]!.evidence)).toHaveProperty(
      'observedAt',
      null,
    );
  },
);

it('invalidates failed workflow evidence when a newer same-revision run is pending', async () => {
  await ctx.store.repairs.configure('a', 'user', 'monitor');
  const { observation, supervisor } = harness();
  observation.page.pulls = [];
  observation.statuses = [];
  observation.page.runs = [
    {
      id: '20',
      workflow: 'build',
      branch: 'main',
      sha: 'sha1',
      conclusion: 'failure',
      url: 'https://example.test/run/20',
    },
  ];
  await supervisor.sweep();
  observation.page.runs.unshift({ ...observation.page.runs[0]!, id: '21', conclusion: null });
  await supervisor.sweep();
  expect(JSON.parse((await ctx.store.repairs.incidents('a'))[0]!.evidence).observedAt).toBeNull();
});
it('retries a failed workflow repair but waits for a newer pending run', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const { observation, supervisor, deps } = harness();
  observation.page.pulls = [];
  observation.statuses = [];
  observation.page.runs = [
    {
      id: '20',
      workflow: 'build',
      branch: 'main',
      sha: 'sha1',
      conclusion: 'failure',
      url: 'https://example.test/run/20',
    },
  ];
  await supervisor.sweep();
  vi.mocked(deps.terminated).mockResolvedValue(true);
  await supervisor.sweep();
  observation.page.runs.unshift({ ...observation.page.runs[0]!, id: '21', conclusion: null });
  await supervisor.sweep();
  expect((await ctx.store.repairs.incidents('a'))[0]!.state).toBe('verifying');
  observation.page.runs[0]!.conclusion = 'failure';
  await supervisor.sweep();
  expect((await ctx.store.repairs.incidents('a'))[0]!.state).toBe('open');
  await supervisor.sweep();
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});

it('releases a confirmed terminated worker even when forge discovery fails', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const { deps, supervisor } = harness();
  await supervisor.sweep();
  vi.mocked(deps.terminated).mockResolvedValue(true);
  vi.mocked(deps.discover).mockRejectedValue(new Error('forge unavailable'));
  await supervisor.sweep();
  expect((await ctx.store.repairs.incidents('a'))[0]!.owner_session_id).toBeNull();
});

it('persists the event boundary before dispatch into a reused session', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  await ctx.store.createSession({
    sessionId: 'reused',
    projectId: 'a',
    worktree: '/wt/reused',
    model: 'm',
  });
  await ctx.store.appendEvent('reused', { t: 'status', state: 'completed' });
  const { deps, supervisor } = harness();
  vi.mocked(deps.target).mockResolvedValue({ sessionId: 'reused', blocked: false });
  await supervisor.sweep();
  const claim = (await ctx.store.repairs.incidents('a'))[0]!;
  const boundary = await ctx.store.repairs.attemptBoundary(claim.dispatch_id!);
  expect(boundary).toBeGreaterThan(0);
  const events = await ctx.store.listRecentSessionProjectionEvents('reused', 20);
  expect(repairTurnTerminated(events.filter((row) => row.seq > boundary!))).toBe(false);
  expect(vi.mocked(deps.dispatch).mock.calls[0]?.[5]).toBe('a');
});
