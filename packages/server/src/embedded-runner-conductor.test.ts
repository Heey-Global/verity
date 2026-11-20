import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedRunnerConductorWiring } from './embedded-runner-conductor.js';
import { buildRunnerConductorWiring } from './embedded-runner-wiring.js';

vi.mock('./embedded-runner-wiring.js', () => ({
  RUNNER_CONTAINER_PROJECT_ROOT: '/workspace',
  buildRunnerConductorWiring: vi.fn(() => ({})),
}));

type Context = Parameters<typeof createEmbeddedRunnerConductorWiring>[0];
function fixture(config: Context['config'] = {}) {
  const store = {
    getSession: vi.fn(async () => ({ projectId: 'project' })),
    listRunningTurns: vi.fn(async () => [{ sessionId: 'session', promptSeq: 42 }]),
    promptInitiatorAt: vi.fn(async () => ({ userId: 'person' })),
    listProjectMcpBindings: vi.fn(async () => [
      { connectionId: 'public', enabled: true },
      { connectionId: 'own', enabled: true },
      { connectionId: 'other', enabled: true },
    ]),
    listHttpMcpConnections: vi.fn(async () => [
      { id: 'public', name: 'Public', enabled: true, authorization: null, authType: 'none' },
      { id: 'own', name: 'Own', enabled: true, authorization: 'token', ownerUserId: 'person' },
      { id: 'other', name: 'Other', enabled: true, authorization: 'token', ownerUserId: 'other' },
    ]),
  };
  const check = vi.fn(async () => true);
  const getLog = vi.fn(() => ({ warn: vi.fn() }));
  const context = {
    config,
    eventStore: store,
    bus: {},
    transcriptStore: {},
    allocateEventFile: vi.fn(),
    allocateControlSocket: vi.fn(),
    getLog,
    brokeredGrantBindingId: vi.fn(async () => 'binding'),
    brokeredHttpGrants: { check },
  } as unknown as Context;
  createEmbeddedRunnerConductorWiring(context);
  const wiring = vi.mocked(buildRunnerConductorWiring).mock.calls.at(-1)![0];
  return { context, store, check, getLog, wiring };
}

beforeEach(() => vi.clearAllMocks());
describe('embedded Runner conductor binding', () => {
  it.each([
    [{}, false],
    [{ runnerSupervisor: true }, true],
    [{ controlPlaneRunner: true }, true],
    [{ runnerTransport: true }, false],
  ] as const)('keeps supervisor selection for %j', (config, expected) => {
    const { wiring } = fixture(config);
    expect(wiring.runnerSupervisor).toBe(expected);
    expect(wiring.runnerTransport).toBe(
      ('runnerTransport' in config && config.runnerTransport) === true,
    );
  });

  it('defers logger lookup until a missing socket is reported', () => {
    const { getLog, wiring } = fixture();
    expect(getLog).not.toHaveBeenCalled();
    wiring.onMissingSupervisorSocket!({
      projectId: 'project',
      socketPath: '/socket',
      reason: 'missing',
    });
    expect(getLog).toHaveBeenCalledOnce();
  });

  it('limits credentialed MCP connections to the turn person', async () => {
    const { wiring } = fixture();
    expect(await wiring.listProjectHttpMcpServers!('project', { userId: 'person' })).toEqual([
      { id: 'public', name: 'Public' },
      { id: 'own', name: 'Own' },
    ]);
    expect(await wiring.listProjectHttpMcpServers!('project', undefined)).toEqual([
      { id: 'public', name: 'Public' },
    ]);
  });

  it('checks grants for the running prompt person and supplied channel', async () => {
    const { wiring, store, check } = fixture();
    const approved = await wiring.autoApprovePermission!(
      'session',
      {
        requestId: 'request',
        toolUseId: 'tool',
        toolName: 'verity_http_request',
        input: { secretAlias: 'ATTENDEE_API_KEY', url: 'https://example.com/api' },
      },
      'acp',
    );
    expect(approved).toBe(true);
    expect(store.promptInitiatorAt).toHaveBeenCalledWith('session', 42);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'session',
        userId: 'person',
        bindingId: 'binding',
        channel: 'acp',
      }),
    );
  });

  it('refuses standing grants without a running turn', async () => {
    const { wiring, store, check } = fixture();
    store.listRunningTurns.mockResolvedValue([]);
    expect(
      await wiring.autoApprovePermission!(
        'session',
        {
          requestId: 'request',
          toolUseId: 'tool',
          toolName: 'verity_http_request',
          input: { secretAlias: 'ATTENDEE_API_KEY', url: 'https://example.com/api' },
        },
        'acp',
      ),
    ).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
