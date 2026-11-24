import { describe, expect, it } from 'vitest';
import { createDopplerCredentials, createStoreDopplerCredentials } from './doppler-credential.js';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';

function credentials(options: {
  personal?: Record<string, string>;
  instance?: Record<string, string>;
}) {
  return createDopplerCredentials({
    personal: (userId, projectId, connectionId) => {
      const token = options.personal?.[`${userId}/${projectId}/${connectionId}`];
      return Promise.resolve(token === undefined ? undefined : Buffer.from(token));
    },
    instance: (connectionId) => {
      const token = options.instance?.[connectionId];
      return Promise.resolve(token === undefined ? undefined : Buffer.from(token));
    },
    isAdministrator: (userId) => Promise.resolve(userId === 'admin'),
    personless: (projectId) =>
      projectId === 'shared' ? Promise.reject(new Error('refused')) : Promise.resolve('admin'),
  });
}

describe('Doppler credential per person and connection', () => {
  it("uses a person's own token for that project and connection only", async () => {
    const forPerson = credentials({
      personal: { 'lena/p1/platform': 'lena-p1' },
      instance: { platform: 'instance', payments: 'instance-payments' },
    });
    expect((await forPerson('lena', 'p1', 'platform')).toString()).toBe('lena-p1');
    // Lena has no token for p2 and is not the administrator: refused, not the instance token.
    await expect(forPerson('lena', 'p2', 'platform')).rejects.toMatchObject({
      phase: 'Doppler connection',
    });
    // Nor does her Platform token answer for another connection of the same project.
    await expect(forPerson('lena', 'p1', 'payments')).rejects.toMatchObject({
      phase: 'Doppler connection',
    });
  });

  // A connection's instance token is the administrator's; it is their fallback and
  // nobody else's, and only for that connection.
  it('falls back to the connection instance token for the administrator and a turn without a person', async () => {
    const forPerson = credentials({
      personal: { 'admin/p1/platform': 'admin-p1' },
      instance: { platform: 'instance', payments: 'instance-payments' },
    });
    expect((await forPerson('admin', 'p1', 'platform')).toString()).toBe('admin-p1');
    expect((await forPerson('admin', 'p2', 'platform')).toString()).toBe('instance');
    expect((await forPerson('admin', 'p1', 'payments')).toString()).toBe('instance-payments');
    // Work without a person is the original sandbox's person's, here the administrator.
    expect((await forPerson(null, 'p1', 'platform')).toString()).toBe('admin-p1');
    expect((await forPerson(null, 'p2', 'platform')).toString()).toBe('instance');
    await expect(forPerson(null, 'shared', 'platform')).rejects.toThrow('refused');
    await expect(forPerson('mia', 'p2', 'platform')).rejects.toBeInstanceOf(
      DopplerSecretResolutionError,
    );
  });

  // Once members share a project nobody can tell whose work a personless turn or
  // dev server is; the owner's token must not serve it for them.
  it('refuses work without a person in a shared project, as a Doppler failure', async () => {
    const store = (members: string[]) =>
      ({
        userDopplerConnections: { tokenBytes: async () => undefined },
        dopplerConnections: { tokenBytes: async () => Buffer.from('instance') },
        isActiveAdministrator: async (userId: string) => userId === 'admin',
        projectSandboxes: {
          projectDefault: async (projectId: string) => ({
            projectId,
            userId: 'admin',
            projectDefault: true,
          }),
        },
        projectTeam: { listMembers: async () => members.map((userId) => ({ userId })) },
      }) as never;
    expect(
      (await createStoreDopplerCredentials(store(['admin']))(null, 'p1', 'platform')).toString(),
    ).toBe('instance');
    await expect(
      createStoreDopplerCredentials(store(['admin', 'lena']))(null, 'p1', 'platform'),
    ).rejects.toMatchObject({ phase: 'Doppler connection' });
  });

  it('reports a connection without an instance token as an authentication failure', async () => {
    await expect(credentials({})('admin', 'p1', 'platform')).rejects.toMatchObject({
      phase: 'Doppler authentication',
    });
  });
});
