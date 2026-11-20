import { describe, expect, it } from 'vitest';
import { PERSONLESS_TURN_REFUSAL } from './personless-credential.js';
import { personalTurnRefusal, resolveTurnSandbox } from './turn-sandbox.js';

const store = (owner: string) =>
  ({
    projectSandboxes: {
      projectDefault: async (projectId: string) => ({
        projectId,
        userId: owner,
        projectDefault: true,
      }),
      ensureProjectDefault: async () => {
        throw new Error('not expected');
      },
    },
  }) as never;

describe('resolveTurnSandbox', () => {
  // A turn must land in its own person's sandbox; landing in the original one
  // would run it with the owner's credentials.
  it("puts a person's turn in their own sandbox and the owner's in the original", async () => {
    await expect(resolveTurnSandbox(store('admin'), 'p1', { userId: 'lena' })).resolves.toEqual({
      userId: 'lena',
      projectDefault: false,
    });
    await expect(resolveTurnSandbox(store('admin'), 'p1', { userId: 'admin' })).resolves.toEqual({
      userId: 'admin',
      projectDefault: true,
    });
    await expect(resolveTurnSandbox(store('admin'), 'p1', undefined)).resolves.toEqual({
      userId: 'admin',
      projectDefault: true,
      personlessIn: 'p1',
    });
  });
});

describe('personalTurnRefusal', () => {
  const connections = (owned: string[]) =>
    ({
      userProviderConnections: {
        get: async (userId: string, provider: string) =>
          owned.includes(`${userId}/${provider}`) ? { userId, provider } : undefined,
      },
    }) as never;

  // A person's sandbox is served only with their own login. A turn whose model
  // they have no account for must stop here with a reason, not run on nobody's
  // login and fail inside the agent.
  it("starts a person's turn only on their own account for the model's provider", async () => {
    const lena = { userId: 'lena', projectDefault: false };
    await expect(
      personalTurnRefusal(connections(['lena/claude']), lena, 'claude'),
    ).resolves.toBeUndefined();
    await expect(personalTurnRefusal(connections(['lena/claude']), lena, 'codex')).resolves.toBe(
      'Connect your Codex account in Verity to send messages with this model.',
    );
    // Another person's account is not hers.
    await expect(
      personalTurnRefusal(connections(['admin/codex']), lena, 'codex'),
    ).resolves.toBeDefined();
    // The original sandbox keeps the instance login it always had.
    await expect(
      personalTurnRefusal(connections([]), { userId: 'admin', projectDefault: true }, 'codex'),
    ).resolves.toBeUndefined();
  });
});

describe('a turn without a person', () => {
  const project = (members: string[]) =>
    ({
      projectSandboxes: {
        projectDefault: async (projectId: string) => ({
          projectId,
          userId: 'admin',
          projectDefault: true,
        }),
      },
      projectTeam: { listMembers: async () => members.map((userId) => ({ userId })) },
      userProviderConnections: { get: async () => undefined },
    }) as never;

  // Nobody can tell whose work a personless turn is. In a shared project it would
  // run on the owner's instance login, Doppler token and forge access for
  // whoever sent it, so it stops before any of them is reached.
  it("runs on the owner's credentials only while nobody else is in the project", async () => {
    const personless = await resolveTurnSandbox(project(['admin']), 'p1', undefined);
    await expect(
      personalTurnRefusal(project(['admin']), personless, 'codex'),
    ).resolves.toBeUndefined();
    await expect(
      personalTurnRefusal(project(['admin', 'lena']), personless, 'codex'),
    ).resolves.toBe(PERSONLESS_TURN_REFUSAL);
    // The owner's own turn in the same shared project is unaffected.
    const owners = await resolveTurnSandbox(project(['admin', 'lena']), 'p1', { userId: 'admin' });
    await expect(
      personalTurnRefusal(project(['admin', 'lena']), owners, 'codex'),
    ).resolves.toBeUndefined();
  });
});
