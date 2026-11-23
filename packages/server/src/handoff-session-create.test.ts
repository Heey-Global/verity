import { describe, expect, it, vi } from 'vitest';

import { createHandoffSessionCreator } from './handoff-session-create.js';

type CreatorDeps = Parameters<typeof createHandoffSessionCreator>[0];

function creator(runningTurnInitiator: CreatorDeps['runningTurnInitiator']) {
  const createSession = vi.fn(async () => undefined);
  const create = createHandoffSessionCreator({
    deps: {
      eventStore: {
        getSession: async () => undefined,
        getProject: async () => ({
          id: 'website',
          kind: 'repository',
          state: 'active',
          hiddenAt: null,
        }),
        createSession,
      },
      projectCloneRoot: '/clones',
      projectBackend: {},
      projectWorktrees: () => ({ add: async () => '/wt/handoff', remove: async () => undefined }),
    } as never,
    isControlPlaneProject: () => false,
    projectsBeingDeleted: new Set(),
    beginProjectSpawn: () => () => undefined,
    projectSettingsStore: () => ({ getProjectSettings: async () => undefined }) as never,
    availableModels: async () => ({ models: ['m'], default: 'm' }) as never,
    isProjectSessionModel: () => true,
    isConfiguredProjectSessionModel: async () => true,
    makeBranch: (name) => name,
    runningTurnInitiator,
  });
  return { create, createSession };
}

const request = {
  projectId: 'website',
  name: 'Investigate',
  idempotencyKey: 'handoff-session:turn-1:invocation-1',
  caller: { sessionId: 'control', turnId: 'turn-1' },
};

describe('handoff session creator', () => {
  // Without this, a session a member hands off to lands with the project's
  // creator, and its questions appear on their Home instead.
  it('records the person the handing-off turn runs for as the creator', async () => {
    const initiator = vi.fn(async () => ({ userId: 'mara' }));
    const { create, createSession } = creator(initiator as never);
    await create(request);
    expect(initiator).toHaveBeenCalledWith('control', 'turn-1');
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'website', createdByUserId: 'mara' }),
    );
  });

  it('still creates the session when the person cannot be looked up', async () => {
    const { create, createSession } = creator((() => {
      throw new Error('offline');
    }) as never);
    await expect(create(request)).resolves.toEqual({ sessionId: expect.any(String) });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ createdByUserId: null }));
  });
});
