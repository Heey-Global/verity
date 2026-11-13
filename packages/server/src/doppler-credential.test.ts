import { describe, expect, it } from 'vitest';
import { createDopplerCredentials } from './doppler-credential.js';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';

function credentials(options: { personal?: Record<string, string>; instance?: string }) {
  return createDopplerCredentials({
    personal: (userId, projectId) => {
      const token = options.personal?.[`${userId}/${projectId}`];
      return Promise.resolve(token === undefined ? undefined : Buffer.from(token));
    },
    instance: () =>
      Promise.resolve(options.instance === undefined ? undefined : Buffer.from(options.instance)),
    isAdministrator: (userId) => Promise.resolve(userId === 'admin'),
  });
}

describe('Doppler credential per person', () => {
  it("uses a person's own token for that project only", async () => {
    const forPerson = credentials({ personal: { 'lena/p1': 'lena-p1' }, instance: 'instance' });
    expect((await forPerson('lena', 'p1')).toString()).toBe('lena-p1');
    // Lena has no token for p2 and is not the administrator: refused, not the instance token.
    await expect(forPerson('lena', 'p2')).rejects.toMatchObject({ phase: 'Doppler connection' });
  });

  // The instance token was the administrator's; it is their fallback and nobody else's.
  it('falls back to the instance token for the administrator and a turn without a person', async () => {
    const forPerson = credentials({ personal: { 'admin/p1': 'admin-p1' }, instance: 'instance' });
    expect((await forPerson('admin', 'p1')).toString()).toBe('admin-p1');
    expect((await forPerson('admin', 'p2')).toString()).toBe('instance');
    expect((await forPerson(null, 'p2')).toString()).toBe('instance');
    await expect(forPerson('mia', 'p2')).rejects.toBeInstanceOf(DopplerSecretResolutionError);
  });

  it('reports a missing instance token as an authentication failure', async () => {
    await expect(credentials({})('admin', 'p1')).rejects.toMatchObject({
      phase: 'Doppler authentication',
    });
  });
});
