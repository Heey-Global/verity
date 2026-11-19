import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { isSandboxNotReadyError } from '@verity/events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedSessionBackend } from './embedded-session-backend.js';
import { resolveTurnSandbox, personalTurnRefusal } from './turn-sandbox.js';
import { waitForSandboxTurnReadiness } from './sandbox-turn-readiness.js';
import { DockerExecBackend } from './project-backend.js';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';

vi.mock('./turn-sandbox.js', () => ({
  resolveTurnSandbox: vi.fn(),
  personalTurnRefusal: vi.fn(),
}));
vi.mock('./sandbox-turn-readiness.js', () => ({ waitForSandboxTurnReadiness: vi.fn() }));

type Context = Parameters<typeof createEmbeddedSessionBackend>[0];
type Resolve = ReturnType<typeof createEmbeddedSessionBackend>;
type Session = Parameters<Resolve>[0];
const project = {
  id: 'project',
  kind: 'code',
  state: 'active',
  containerName: 'sandbox',
  owner: 'org',
  repo: 'repo',
};
const selected = { runnerSupervisorBackend: 'claude-acp', run: vi.fn() } as Parameters<Resolve>[1];
function fixture() {
  const order: string[] = [];
  const store = {
    getProject: vi.fn(async () => project),
    getProjectSettings: vi.fn(async () => undefined),
  };
  const runtime: Context['runtime'] = {
    log: { warn: vi.fn() } as unknown as Context['runtime']['log'],
    docker: {
      inspectContainer: vi.fn(async () => ({ running: true })),
    } as unknown as Context['runtime']['docker'],
    provisioner: {
      ensurePersonalSandbox: vi.fn(async () => ({ ...project, containerName: 'personal' })),
    } as unknown as Context['runtime']['provisioner'],
    claudeEgressActive: true,
    refreshControlPlaneRunnerIdentity: vi.fn(async () => {
      order.push('identity');
    }),
    awaitControlPlaneRunnerIdentity: vi.fn(async () => {
      order.push('ack');
    }),
  };
  const context: Context = {
    config: {
      runnerSupervisor: true,
      dockerBaseUrl: 'http://docker',
      hostCloneRoot: '/projects',
      dataVolumeRoot: '/data',
      claudeConnectorPort: 9444,
    },
    createStore: () => store as unknown as EventStore,
    secretRoot: '/secrets',
    dataVolumeRoot: '/data',
    agentGatewayUrl: new URL('https://gateway'),
    projectRelayEnabled: true,
    refreshProjectToken: vi.fn(async () => {
      order.push('token');
    }),
    refreshAgentGatewayCredential: vi.fn(async () => {
      order.push('credential');
    }),
    synchronizeAgentGatewayForTurn: vi.fn(async () => {
      order.push('gateway');
    }),
    agentGatewayReady: vi.fn(async () => true),
    probeSandboxEgressReadiness: vi.fn(async () => ({ kind: 'unsupported' as const })),
    repairPersonalSandboxForAgentTurn: vi.fn(async () => ({ ready: true })),
    repairSandboxForAgentTurn: vi.fn(async () => ({ ready: true })),
    serializeProjectTurnPreparation: vi.fn(async (_projectId, _sessionId, _canWait, prepare) => {
      order.push('serialize');
      return prepare(new Set(['session']));
    }),
    runtime,
  };
  const session: Session = {
    sessionId: 'session',
    worktree: '/work',
    name: null,
    lastSeenEventCount: null,
    projectId: 'project',
    model: 'claude-test',
  };
  const preparation: Parameters<Resolve>[2] = {
    sessionId: 'session',
    initiatedBy: { userId: 'person' },
    canWait: true,
    waitingOn: vi.fn(),
  };
  return {
    context,
    store,
    order,
    session,
    preparation,
    resolve: () => createEmbeddedSessionBackend(context)(session, selected, preparation),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveTurnSandbox).mockResolvedValue({ userId: 'person', projectDefault: true });
  vi.mocked(personalTurnRefusal).mockResolvedValue(undefined);
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('embedded session backend', () => {
  it('does not read runtime state before a session is resolved', () => {
    const { context } = fixture();
    context.runtime = new Proxy({} as Context['runtime'], {
      get() {
        throw new Error('not initialized');
      },
    });
    expect(() => createEmbeddedSessionBackend(context)).not.toThrow();
  });

  it('refreshes and acknowledges the control-plane identity before synchronizing the gateway', async () => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), 'verity-session-backend-'));
    directories.push(root);
    const dir = join(root, 'runners', CONTROL_PLANE_PROJECT_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'supervisor.sock'), '');
    f.context.config = { controlPlaneRunner: true, dataVolumeRoot: root };
    f.session.projectId = null;
    expect(await f.resolve()).toBe(selected);
    expect(f.order).toEqual(['identity', 'ack', 'gateway']);
    expect(f.store.getProject).not.toHaveBeenCalled();
  });

  it('fails closed when the dedicated control-plane Runner is disabled', async () => {
    const f = fixture();
    f.session.projectId = null;
    await expect(f.resolve()).rejects.toThrow('dedicated control-plane runner');
    expect(f.context.synchronizeAgentGatewayForTurn).not.toHaveBeenCalled();
  });

  it('refuses missing personal credentials before preparing a sandbox', async () => {
    const f = fixture();
    vi.mocked(personalTurnRefusal).mockResolvedValue('Connect your account');
    await expect(f.resolve()).rejects.toThrow('Connect your account');
    expect(f.context.serializeProjectTurnPreparation).not.toHaveBeenCalled();
    expect(f.context.refreshAgentGatewayCredential).not.toHaveBeenCalled();
  });

  it('refreshes a personal sandbox credential before gateway synchronization and readiness', async () => {
    const f = fixture();
    vi.mocked(resolveTurnSandbox).mockResolvedValue({ userId: 'person', projectDefault: false });
    vi.mocked(waitForSandboxTurnReadiness).mockImplementation(async () => {
      f.order.push('readiness');
      return { outcome: 'unsupported' };
    });
    expect(await f.resolve()).toBeInstanceOf(DockerExecBackend);
    expect(f.context.runtime.provisioner!.ensurePersonalSandbox).toHaveBeenCalledWith(
      'project',
      'person',
    );
    expect(f.order).toEqual(['serialize', 'token', 'credential', 'gateway', 'readiness']);
    expect(resolveTurnSandbox).toHaveBeenCalledWith(f.store, 'project', f.preparation.initiatedBy);
  });

  it('waits for personal credential publication before synchronizing the gateway', async () => {
    const f = fixture();
    vi.mocked(resolveTurnSandbox).mockResolvedValue({ userId: 'person', projectDefault: false });
    let release!: () => void;
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.context.refreshAgentGatewayCredential).mockReturnValue(publication);
    const pending = f.resolve();
    try {
      await vi.waitFor(() =>
        expect(f.context.refreshAgentGatewayCredential).toHaveBeenCalledOnce(),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.context.synchronizeAgentGatewayForTurn).not.toHaveBeenCalled();
      expect(waitForSandboxTurnReadiness).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(f.context.synchronizeAgentGatewayForTurn).toHaveBeenCalledOnce();
  });

  it('repairs only the personal sandbox when its gateway is unready', async () => {
    const f = fixture();
    vi.mocked(resolveTurnSandbox).mockResolvedValue({ userId: 'person', projectDefault: false });
    vi.mocked(f.context.agentGatewayReady).mockResolvedValue(false);
    await f.resolve();
    expect(f.context.repairPersonalSandboxForAgentTurn).toHaveBeenCalledWith(
      project,
      'person',
      f.preparation,
    );
    expect(f.context.repairSandboxForAgentTurn).not.toHaveBeenCalled();
  });

  it('keeps a failed background repair transient', async () => {
    const f = fixture();
    f.preparation = { ...f.preparation, canWait: false };
    vi.mocked(f.context.agentGatewayReady).mockResolvedValue(false);
    vi.mocked(f.context.repairSandboxForAgentTurn).mockResolvedValue({ ready: false });
    try {
      await createEmbeddedSessionBackend(f.context)(f.session, selected, f.preparation);
      expect.fail('unready sandbox was admitted');
    } catch (error) {
      expect(isSandboxNotReadyError(error)).toBe(true);
    }
    expect(f.context.synchronizeAgentGatewayForTurn).not.toHaveBeenCalled();
  });
});
