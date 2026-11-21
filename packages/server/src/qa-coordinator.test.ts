import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createQACoordinator, parseQADecision, type QACoordinatorDeps } from './qa-coordinator.js';
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
  const deps: QACoordinatorDeps = {
    store: ctx.store,
    authorized: vi.fn(async () => true),
    administrator: vi.fn(async () => true),
    busy: vi.fn(() => false),
    ensureSession: vi.fn(async (projectId: string, id: string) => {
      if (!(await ctx.store.getSession(id)))
        await ctx.store.createSession({
          sessionId: id,
          projectId,
          worktree: `/wt/qa-${id}`,
          model: 'm',
        });
    }),
    dispatch: vi.fn<QACoordinatorDeps['dispatch']>(
      async (id, prompt, validate, _sponsor, dispatchId) => {
        if (!(await validate())) return false;
        await ctx.store.clearRunningTurn(id);
        return !!(await ctx.store.admitBackgroundDispatch(dispatchId, id, {
          t: 'prompt',
          text: prompt,
        }));
      },
    ),
    delegate: vi.fn(async () => undefined),
  };
  return { deps, coordinator: createQACoordinator(deps) };
}
async function enroll(mode: 'monitor' | 'automatic' = 'automatic') {
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.configure('a', 'admin', mode);
  await ctx.store.repairs.health('a', 'healthy', null);
  return ctx.store.repairs.observe(
    'a',
    'pr:42',
    'sha',
    JSON.stringify({
      observedAt: new Date().toISOString(),
      status: { pipeline: 'failure', headSha: 'sha' },
    }),
  );
}
const role = async (projectId = 'a') => (await ctx.store.repairs.projectQA.role(projectId))!;
async function answer(incident: { id: string }, text?: string, projectId = 'a') {
  const state = await role(projectId);
  await ctx.store.appendEvent(state.session_id!, {
    t: 'text',
    delta:
      text ??
      '```qa:decision\n' +
        JSON.stringify({
          summary: 'Repair failing checks',
          assignments: [{ projectId: 'a', incidentId: incident.id, revision: 'sha' }],
        }) +
        '\n```',
  });
  await ctx.store.appendEvent(state.session_id!, { t: 'status', state: 'completed' });
}
describe('QA admission and durable inbox', () => {
  it('starts disabled and never creates a session or wakes a model', async () => {
    const { deps, coordinator } = harness();
    await coordinator.tick();
    expect((await ctx.store.repairs.qa()).enabled).toBe(false);
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it('coalesces concurrent ticks and retains one identity across restarts', async () => {
    await enroll();
    const { deps, coordinator } = harness();
    await Promise.all([coordinator.tick(), coordinator.tick()]);
    const first = await role();
    await createQACoordinator(deps).tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((await role()).session_id).toBe(first.session_id);
    // The QA session lives in the project it watches.
    expect((await ctx.store.getSession(first.session_id!))?.projectId).toBe('a');
    expect((await role()).health).toBe('awaiting-confirmed-termination');
  });
  it('admits a model decision only after termination and with matching evidence', async () => {
    const incident = await enroll();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
    await answer(incident);
    await coordinator.tick();
    expect(deps.delegate).toHaveBeenCalledWith('a', incident.id, 'sha');
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect(deps.delegate).toHaveBeenCalledTimes(1);
  });
  it('offers a permission card for monitor-only repairs without changing the mandate', async () => {
    const incident = await enroll('monitor');
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer(
      incident,
      '```qa:decision\n' +
        JSON.stringify({
          summary: 'Permission needed',
          assignments: [],
          requests: [{ projectId: 'a', incidentId: incident.id, revision: 'sha' }],
        }) +
        '\n```',
    );
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
    expect(await ctx.store.repairs.qaProposals()).toHaveLength(1);
    expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('monitor');
  });
  it('does not delegate monitor-only projects even if the model asks', async () => {
    const incident = await enroll('monitor');
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer(incident);
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
  });
  it('invalidates pending decisions across disable and re-enable', async () => {
    const incident = await enroll();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer(incident);
    await ctx.store.repairs.configureQA(false, 'admin');
    await coordinator.tick();
    await ctx.store.repairs.configureQA(true, 'admin');
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
  });
  it('rechecks revoked project access and changed mandates', async () => {
    const incident = await enroll();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer(incident);
    await ctx.store.repairs.configure('a', 'admin', 'off');
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
  });
  it('does not wake a busy role session', async () => {
    await enroll();
    const { deps, coordinator } = harness();
    vi.mocked(deps.busy).mockReturnValue(true);
    await coordinator.tick();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it('rejects fabricated assignments and leaves verification to the server', async () => {
    const incident = await enroll();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer({ id: 'invented' });
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
    expect((await ctx.store.repairs.incidents('a')).find((i) => i.id === incident.id)?.state).toBe(
      'open',
    );
  });
  it('shows malformed decisions as needing attention without looping', async () => {
    const incident = await enroll();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    await answer(incident, 'Everything is fixed');
    await coordinator.tick();
    await coordinator.tick();
    expect((await role()).health).toBe('needs-attention');
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.delegate).not.toHaveBeenCalled();
  });
  it('refuses a wake when the central sponsor lost administrator access', async () => {
    await enroll();
    const { deps, coordinator } = harness();
    vi.mocked(deps.administrator).mockResolvedValue(false);
    await coordinator.tick();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect((await ctx.store.repairs.qa()).health).toBe('access-revoked');
  });
  it('keeps unknown dispatch acceptance owned instead of retrying', async () => {
    await enroll();
    const { deps, coordinator } = harness();
    vi.mocked(deps.dispatch).mockImplementation(
      async (id, prompt, _validate, _sponsor, dispatchId) => {
        await ctx.store.admitBackgroundDispatch(dispatchId, id, { t: 'prompt', text: prompt });
        throw new Error('lost response');
      },
    );
    await coordinator.tick();
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((await role()).active_dispatch).not.toBeNull();
  });
  it('rejects extra authority fields in decisions', () => {
    expect(
      parseQADecision('```qa:decision\n{"summary":"ok","assignments":[],"merge":true}\n```'),
    ).toBeUndefined();
  });
});

it('reconsiders an assignment after temporary admission failure', async () => {
  const incident = await enroll();
  const { deps, coordinator } = harness();
  await coordinator.tick();
  await answer(incident);
  await coordinator.tick();
  expect(await ctx.store.repairs.qaPending(['a'])).toHaveLength(1);
  await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});
it('reviews a refused assignment once more, then waits for a change', async () => {
  const incident = await enroll();
  const { deps, coordinator } = harness();
  await coordinator.tick();
  await answer(incident);
  await coordinator.tick();
  await coordinator.tick();
  await answer(incident);
  for (let n = 0; n < 4; n++) await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});
it('releases a review claim when session creation fails before dispatch', async () => {
  await enroll();
  const { deps, coordinator } = harness();
  vi.mocked(deps.ensureSession).mockRejectedValueOnce(new Error('provisioning unavailable'));
  await coordinator.tick();
  expect((await role()).active_dispatch).toBeNull();
  expect(deps.dispatch).not.toHaveBeenCalled();
  await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(1);
});

it('admits a fresh same-repository failure despite unrelated partial discovery', async () => {
  const incident = await enroll();
  const { deps, coordinator } = harness();
  await ctx.store.repairs.health('a', 'partial', null);
  await coordinator.tick();
  await answer(incident);
  await coordinator.tick();
  expect(deps.delegate).toHaveBeenCalledWith('a', incident.id, 'sha');
});
it('does not use old incident evidence just because the repository was checked recently', async () => {
  const incident = await enroll();
  const { deps, coordinator } = harness();
  await ctx.store.repairs.observe(
    'a',
    'pr:42',
    'sha',
    JSON.stringify({
      observedAt: new Date(Date.now() - 600000).toISOString(),
      status: { pipeline: 'failure', headSha: 'sha' },
    }),
  );
  await coordinator.tick();
  await answer(incident);
  await coordinator.tick();
  expect(deps.delegate).not.toHaveBeenCalled();
});

it('retries a crashed review without losing its pending observation', async () => {
  await enroll();
  const { deps, coordinator } = harness();
  await coordinator.tick();
  const state = await role();
  await ctx.store.appendEvent(state.session_id!, { t: 'status', state: 'crashed' });
  await coordinator.tick();
  await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});

it('wakes again when an acknowledged pending rerun fails on the same revision', async () => {
  const incident = await enroll();
  const evidence = incident.evidence;
  await ctx.store.repairs.invalidateObservation('a', 'pr:42');
  const { deps, coordinator } = harness();
  await coordinator.tick();
  await answer(
    incident,
    '```qa:decision\n' + JSON.stringify({ summary: 'Wait for checks', assignments: [] }) + '\n```',
  );
  await coordinator.tick();
  await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(1);
  await ctx.store.repairs.observe('a', 'pr:42', 'sha', evidence);
  await coordinator.tick();
  expect(deps.dispatch).toHaveBeenCalledTimes(2);
});

it.each(['off', 'unauthorized'] as const)(
  'filters over fifty %s inbox entries before limiting eligible projects',
  async (reason) => {
    await enroll();
    const { deps, coordinator } = harness();
    for (let n = 0; n < 51; n++) {
      const id = 'ineligible-' + n;
      await ctx.store.upsertProject({
        id,
        owner: 'team',
        repo: id,
        containerName: id,
        state: 'active',
      });
      await ctx.store.repairs.configure(id, 'admin', reason === 'off' ? 'off' : 'monitor');
      await ctx.store.repairs.qaObserve(id, 'old');
    }
    vi.mocked(deps.authorized).mockImplementation(async (_user, id) => id === 'a');
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await role()).active_snapshot!)).toEqual(
      expect.objectContaining({ projectId: 'a' }),
    );
  },
);

it('shares live QA preparation with repair recovery during slow session creation', async () => {
  await enroll();
  const { deps } = harness();
  const preparingDispatches = new Set<string>();
  deps.preparingDispatches = preparingDispatches;
  const ensure = deps.ensureSession;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Slow only after the review was reserved, when the session is prepared for dispatch.
  deps.ensureSession = async (projectId, id) => {
    if (await ctx.store.getSession(id)) {
      entered();
      await gate;
    }
    await ensure(projectId, id);
  };
  const coordinator = createQACoordinator(deps);
  const admission = coordinator.tick();
  await started;
  try {
    const { createRepairSupervisor } = await import('./repair-supervisor.js');
    const supervisor = createRepairSupervisor({
      store: ctx.store,
      preparingDispatches,
      enabled: async () => false,
      discover: async () => {
        throw new Error('disabled');
      },
      authorized: async () => false,
      busy: () => false,
      terminated: async () => false,
      result: async () => null,
      target: async () => ({ blocked: true }),
      spawn: async () => {},
      dispatch: async () => false,
    });
    await supervisor.sweep();
    const state = await role();
    expect(state.active_dispatch).toBeTruthy();
    expect((await ctx.store.repairs.dispatchReceipt(state.active_dispatch!))?.state).toBe(
      'reserved',
    );
  } finally {
    release();
    await admission;
  }
  expect(deps.dispatch).toHaveBeenCalledTimes(1);
  expect(preparingDispatches.size).toBe(0);
  expect((await ctx.store.repairs.dispatchReceipt((await role()).active_dispatch!))?.state).toBe(
    'admitted',
  );
});

it.each(['monitor', 'automatic'] as const)(
  'observes session-owned failures in %s without granting or delegating repair',
  async (mode) => {
    const incident = await enroll(mode);
    await ctx.store.createSession({
      sessionId: 'origin',
      projectId: 'a',
      worktree: '/wt/origin',
      model: 'm',
    });
    await ctx.store.repairs.registerSessionOrigin('a', 'pr:42', 'origin');
    const { deps, coordinator } = harness();
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"sessionResponsibility":"origin"'),
      expect.any(Function),
      'admin',
      expect.any(String),
    );
    await answer(
      incident,
      '```qa:decision\n' +
        JSON.stringify({
          summary: 'Repeated failures',
          requests: [{ projectId: 'a', incidentId: incident.id, revision: 'sha' }],
          assignments: [{ projectId: 'a', incidentId: incident.id, revision: 'sha' }],
        }) +
        '\n```',
    );
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
    expect(await ctx.store.repairs.qaProposals()).toEqual([]);
  },
);

describe('per-project QA', () => {
  beforeEach(async () => {
    await ctx.store.upsertProject({
      id: 'b',
      owner: 'team',
      repo: 'site',
      containerName: 'site',
      state: 'active',
    });
  });
  async function enrollB() {
    await ctx.store.repairs.configure('b', 'admin', 'automatic');
    await ctx.store.repairs.health('b', 'healthy', null);
    return ctx.store.repairs.observe(
      'b',
      'pr:7',
      'shb',
      JSON.stringify({
        observedAt: new Date().toISOString(),
        status: { pipeline: 'failure', headSha: 'shb' },
      }),
    );
  }
  it('reviews every project in its own session and keeps decisions inside the project', async () => {
    const incidentA = await enroll();
    const incidentB = await enrollB();
    const { deps, coordinator } = harness();
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect((await role('a')).session_id).not.toBe((await role('b')).session_id);
    // Project a's QA names project b's incident: nothing happens to b.
    await answer(
      incidentA,
      '```qa:decision\n' +
        JSON.stringify({
          summary: 'reach across',
          assignments: [{ projectId: 'b', incidentId: incidentB.id, revision: 'shb' }],
          escalations: [{ incidentId: incidentB.id, reason: 'not mine' }],
        }) +
        '\n```',
      'a',
    );
    await coordinator.tick();
    expect(deps.delegate).not.toHaveBeenCalled();
    expect((await ctx.store.repairs.projectQA.issues('b'))[0]?.state).toBe('open');
  });
  it('groups incidents with one cause and escalates what exceeds the mandate', async () => {
    const first = await enroll();
    const second = await ctx.store.repairs.observe(
      'a',
      'pr:43',
      'sh2',
      JSON.stringify({
        observedAt: new Date().toISOString(),
        status: { pipeline: 'failure', headSha: 'sh2' },
      }),
    );
    const third = await ctx.store.repairs.observe('a', 'pr:44', 'sh3', '{}');
    const { coordinator } = harness();
    await coordinator.tick();
    await answer(
      first,
      '```qa:decision\n' +
        JSON.stringify({
          summary: 'same lockfile conflict; a migration is needed for 44',
          assignments: [],
          groups: [{ incidentIds: [first.id, second.id] }],
          escalations: [{ incidentId: third.id, reason: 'Needs a major migration' }],
        }) +
        '\n```',
    );
    await coordinator.tick();
    const issues = await ctx.store.repairs.projectQA.issues('a');
    expect(issues).toHaveLength(2);
    const stopped = issues.find((i) => i.state === 'needs_you');
    expect(stopped?.reason).toBe('beyond-mandate');
    expect(stopped?.detail).toBe('Needs a major migration');
  });
  it('starts no review while the emergency brake holds', async () => {
    await enroll();
    const { deps, coordinator } = harness();
    await sql`update qa_coordinator set brake_at = now()`.execute(ctx.db);
    await coordinator.tick();
    expect(deps.dispatch).not.toHaveBeenCalled();
    await ctx.store.repairs.projectQA.releaseBrake();
    await coordinator.tick();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });
});
