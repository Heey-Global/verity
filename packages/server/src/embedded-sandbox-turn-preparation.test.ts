import { describe, expect, it, vi } from 'vitest';
import type { Backend, TurnPreparationContext } from '@verity/session';
import type { ProjectRecord } from '@verity/store';
import { sandboxIdentity } from './sandbox-identity.js';
import { createEmbeddedSandboxTurnPreparation } from './embedded-sandbox-turn-preparation.js';

type Context = Parameters<typeof createEmbeddedSandboxTurnPreparation>[0];
type RepairProvisioner = NonNullable<ReturnType<Context['getProvisioner']>>;
const project = { id: 'project', containerName: 'original' } as ProjectRecord;
const inspected = { id: 'container', running: true };
function fixture() {
  const steps: string[] = [];
  const inspectContainer = vi.fn<(name: string) => Promise<typeof inspected>>(async () => {
    steps.push('inspect');
    return inspected;
  });
  const ensurePersonalSandbox = vi.fn<NonNullable<RepairProvisioner['ensurePersonalSandbox']>>(
    async () => {
      steps.push('personal');
      return sandboxIdentity(project, { userId: 'person', projectDefault: false });
    },
  );
  const repairSandboxForTurn = vi.fn<NonNullable<RepairProvisioner['repairSandboxForTurn']>>(
    async () => {
      steps.push('repair');
      return true;
    },
  );
  const waitForTurnSandboxRepair = vi.fn<
    NonNullable<RepairProvisioner['waitForTurnSandboxRepair']>
  >(async () => undefined);
  const turnSandboxRepairInFlight = vi.fn(() => false);
  const tryBeginProjectSandboxActivity = vi.fn(() => true);
  const endProjectSandboxActivity = vi.fn();
  const installed = {
    ensurePersonalSandbox,
    repairSandboxForTurn,
    waitForTurnSandboxRepair,
    turnSandboxRepairInFlight,
    tryBeginProjectSandboxActivity,
    endProjectSandboxActivity,
  };
  let provisioner: RepairProvisioner | undefined;
  let docker: ReturnType<Context['getDocker']>;
  const warn = vi.fn();
  const refreshAgentGatewayCredential = vi.fn(async () => {
    steps.push('refresh');
  });
  const synchronizeAgentGatewayForTurn = vi.fn(async () => {
    steps.push('synchronize');
  });
  const agentGatewayReady = vi.fn<Context['agentGatewayReady']>(async () => {
    steps.push('ready');
    return true;
  });
  const preparation: TurnPreparationContext = {
    sessionId: 'session',
    canWait: true,
    initiatedBy: { userId: 'person' },
    waitingOn: vi.fn(() => {
      steps.push('waiting');
    }),
  };
  const wiring = createEmbeddedSandboxTurnPreparation({
    getDocker: () => docker,
    getProvisioner: () => provisioner,
    getLogger: () => ({ warn }),
    refreshAgentGatewayCredential,
    synchronizeAgentGatewayForTurn,
    agentGatewayReady,
  });
  const queued = new Set(['session', 'queued']);
  const repair = (personal: boolean, context = preparation) =>
    personal
      ? wiring.repairPersonalSandboxForAgentTurn(project, 'person', context)
      : wiring.repairSandboxForAgentTurn(project, context, queued);
  return {
    ...wiring,
    repair,
    preparation,
    queued,
    steps,
    warn,
    installed,
    inspectContainer,
    ensurePersonalSandbox,
    repairSandboxForTurn,
    waitForTurnSandboxRepair,
    turnSandboxRepairInFlight,
    tryBeginProjectSandboxActivity,
    endProjectSandboxActivity,
    refreshAgentGatewayCredential,
    synchronizeAgentGatewayForTurn,
    agentGatewayReady,
    activate: () => {
      docker = { inspectContainer };
      provisioner = installed;
    },
    removeDocker: () => {
      docker = undefined;
    },
    setProvisioner: (value: RepairProvisioner | undefined) => {
      provisioner = value;
    },
  };
}

describe.each([false, true])('sandbox turn repair (personal=%s)', (personal) => {
  it('never rebuilds for background resolutions or unavailable dependencies', async () => {
    const f = fixture();
    expect(await f.repair(personal)).toEqual({ ready: false });
    f.activate();
    expect(await f.repair(personal, { ...f.preparation, canWait: false })).toEqual({
      ready: false,
    });
    f.removeDocker();
    expect(await f.repair(personal)).toEqual({ ready: false });
    f.activate();
    f.setProvisioner(undefined);
    expect(await f.repair(personal)).toEqual({ ready: false });
    f.setProvisioner({});
    expect(await f.repair(personal)).toEqual({ ready: false });
    expect(f.steps).toEqual([]);
  });

  it('verifies the repaired sandbox only after identity synchronization', async () => {
    const f = fixture();
    f.activate();
    expect(await f.repair(personal)).toEqual({ ready: true });
    expect(f.steps).toEqual(
      personal
        ? ['waiting', 'personal', 'inspect', 'refresh', 'synchronize', 'ready']
        : ['waiting', 'repair', 'inspect', 'synchronize', 'ready'],
    );
    if (personal) {
      expect(f.ensurePersonalSandbox).toHaveBeenCalledWith(project.id, 'person', {
        recreate: true,
      });
      expect(f.inspectContainer).toHaveBeenCalledWith(
        sandboxIdentity(project, { userId: 'person', projectDefault: false }).containerName,
      );
      expect(f.repairSandboxForTurn).not.toHaveBeenCalled();
    } else {
      expect(f.repairSandboxForTurn).toHaveBeenCalledWith(project.id, 'session', f.queued, {
        requireFreshAgentGatewayIdentity: true,
      });
      expect(f.inspectContainer).toHaveBeenCalledWith(project.containerName);
      expect(f.ensurePersonalSandbox).not.toHaveBeenCalled();
    }
    expect(f.agentGatewayReady).toHaveBeenCalledWith(
      personal
        ? { projectId: project.id, userId: 'person', projectDefault: false }
        : { projectId: project.id, projectDefault: true },
      inspected,
    );
  });

  it('does not trust rebuild success without gateway readiness', async () => {
    const f = fixture();
    f.activate();
    f.agentGatewayReady.mockResolvedValue(false);
    expect(await f.repair(personal)).toEqual({ ready: false, failure: { stage: 'still_unready' } });
  });

  it('returns the rebuild failure without attempting verification', async () => {
    const f = fixture();
    f.activate();
    const cause = new Error('rebuild failed');
    f.ensurePersonalSandbox.mockRejectedValue(cause);
    f.repairSandboxForTurn.mockRejectedValue(cause);
    expect(await f.repair(personal)).toEqual({
      ready: false,
      failure: { stage: 'rebuild', cause },
    });
    expect(f.inspectContainer).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalled();
  });

  it('reports inspection, synchronization and readiness exceptions as verification failures', async () => {
    for (const stage of ['inspect', 'synchronize', 'ready'] as const) {
      const f = fixture();
      f.activate();
      const cause = new Error(stage);
      const operation = {
        inspect: f.inspectContainer,
        synchronize: f.synchronizeAgentGatewayForTurn,
        ready: f.agentGatewayReady,
      }[stage];
      operation.mockRejectedValue(cause);
      expect(await f.repair(personal)).toEqual({
        ready: false,
        failure: { stage: 'verify', cause },
      });
      expect(f.warn).toHaveBeenCalled();
    }
  });
});

it('does not verify a declined project repair or a failed personal credential refresh', async () => {
  const f = fixture();
  f.activate();
  f.repairSandboxForTurn.mockResolvedValue(false);
  expect(await f.repair(false)).toEqual({ ready: false });
  expect(f.inspectContainer).not.toHaveBeenCalled();
  const cause = new Error('credentials');
  f.refreshAgentGatewayCredential.mockRejectedValue(cause);
  expect(await f.repair(true)).toEqual({ ready: false, failure: { stage: 'verify', cause } });
  expect(f.synchronizeAgentGatewayForTurn).not.toHaveBeenCalled();
});

describe('sandbox activity admission wiring', () => {
  function backend() {
    return {
      runnerSupervisorBackend: 'claude-acp' as const,
      run: vi.fn<Backend['run']>(async () => ({
        sessionId: 'session',
        exitCode: 0,
        stderr: '',
        aborted: false,
      })),
      query: vi.fn<NonNullable<Backend['query']>>(async () => 'answer'),
      closeSession: vi.fn(),
    };
  }
  it('uses the live provisioner for foreground admission and background repair rejection', async () => {
    const f = fixture();
    const selected = backend();
    expect(
      await f.serializeProjectTurnPreparation('project', 'early', true, async () => selected),
    ).toBe(selected);
    f.activate();
    expect(
      await f.serializeProjectTurnPreparation('project', 'foreground', true, async () => selected),
    ).toBe(selected);
    expect(f.waitForTurnSandboxRepair).toHaveBeenCalledWith('project', 'foreground');
    f.turnSandboxRepairInFlight.mockReturnValue(true);
    const prepare = vi.fn(async () => selected);
    await expect(
      f.serializeProjectTurnPreparation('project', 'background', false, prepare),
    ).rejects.toThrow(/preparation is already in progress/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('holds activity for run/query, releases on failure and leaves session close independent', async () => {
    const f = fixture();
    f.activate();
    const selected = backend();
    const wrapped = await f.serializeProjectTurnPreparation(
      'project',
      'background',
      false,
      async () => selected,
    );
    expect(wrapped?.runnerSupervisorBackend).toBe(selected.runnerSupervisorBackend);
    selected.run.mockImplementation(async () => {
      expect(f.tryBeginProjectSandboxActivity).toHaveBeenCalledWith('project');
      expect(f.endProjectSandboxActivity).not.toHaveBeenCalled();
      throw new Error('run failed');
    });
    await expect(wrapped!.run({} as Parameters<Backend['run']>[0])).rejects.toThrow('run failed');
    expect(f.endProjectSandboxActivity).toHaveBeenCalledTimes(1);
    expect(await wrapped!.query!({} as Parameters<NonNullable<Backend['query']>>[0])).toBe(
      'answer',
    );
    expect(f.endProjectSandboxActivity).toHaveBeenCalledTimes(2);
    wrapped!.closeSession!('session');
    expect(selected.closeSession).toHaveBeenCalledWith('session');
    expect(f.tryBeginProjectSandboxActivity).toHaveBeenCalledTimes(2);
    f.tryBeginProjectSandboxActivity.mockReturnValue(false);
    await expect(wrapped!.run({} as Parameters<Backend['run']>[0])).rejects.toThrow(
      /repair is already in progress/,
    );
    expect(selected.run).toHaveBeenCalledTimes(1);
    expect(f.endProjectSandboxActivity).toHaveBeenCalledTimes(2);
  });

  it('preserves an absent backend and optional backend methods', async () => {
    const f = fixture();
    expect(
      await f.serializeProjectTurnPreparation('project', 'none', false, async () => undefined),
    ).toBeUndefined();
    const wrapped = await f.serializeProjectTurnPreparation(
      'project',
      'minimal',
      false,
      async () => ({ run: backend().run }),
    );
    expect(wrapped).not.toHaveProperty('query');
    expect(wrapped).not.toHaveProperty('closeSession');
    expect(wrapped?.runnerSupervisorBackend).toBeUndefined();
  });
});
