import { writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGitIdentityRoutes } from './git-identity-routes.js';
import type { SshKeygenSpawner } from './signing-key.js';

interface Row {
  authorName: string | null;
  authorEmail: string | null;
  sshPrivateKey: string | null;
  sshPublicKey: string | null;
}

function harness(options: { sealed?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const accounts = new Map([['lena', { githubUserId: '42', login: 'lena-dev' }]]);
  const row = (id: string): Row =>
    rows.get(id) ?? {
      authorName: null,
      authorEmail: null,
      sshPrivateKey: null,
      sshPublicKey: null,
    };
  const store = {
    userGitIdentities: {
      author: async (id: string) => {
        const r = rows.get(id);
        return r && { authorName: r.authorName, authorEmail: r.authorEmail };
      },
      publicIdentity: async (id: string) => {
        const r = row(id);
        return {
          authorName: r.authorName,
          authorEmail: r.authorEmail,
          sshPublicKey: r.sshPublicKey,
          hasSigningKey: r.sshPrivateKey !== null,
        };
      },
      set: async (id: string, input: Partial<Row>) => {
        rows.set(id, { ...row(id), ...input });
      },
    },
    userGithubAuthorizations: { account: async (id: string) => accounts.get(id) },
  };
  const comments: string[] = [];
  const sshKeygen: SshKeygenSpawner = async ({ comment, keyPath }) => {
    comments.push(comment);
    writeFileSync(keyPath, `PRIVATE-${comment}`);
    writeFileSync(`${keyPath}.pub`, `ssh-ed25519 AAAAtest ${comment}`);
  };
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-test-user']);
  });
  registerGitIdentityRoutes(app, {
    store: store as never,
    sshKeygen,
    secretCipher: { isSealed: () => options.sealed === true } as never,
  });
  return { app, rows, comments };
}

describe('personal git identity routes', () => {
  // The private key must never reach the app, and each person's key is minted
  // for their own GitHub account, never another person's.
  it("mints a person's own signing key and returns only public material", async () => {
    const { app, rows, comments } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/me/git-identity/signing-key',
      headers: { 'x-test-user': 'lena' },
      payload: { userId: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/PRIVATE/u);
    expect(comments).toEqual(['42+lena-dev@users.noreply.github.com']);
    expect(rows.get('lena')?.sshPrivateKey).toBe('PRIVATE-42+lena-dev@users.noreply.github.com');
    expect(rows.has('admin')).toBe(false);

    const view = await app.inject({ url: '/me/git-identity', headers: { 'x-test-user': 'lena' } });
    expect(view.json()).toEqual({
      authorName: null,
      authorEmail: null,
      signingKeyConfigured: true,
      publicKey: 'ssh-ed25519 AAAAtest 42+lena-dev@users.noreply.github.com',
      githubConnected: true,
    });
    expect(view.body).not.toMatch(/PRIVATE/u);
  });

  // Without a GitHub account the key could never be verified, and a sealed store
  // cannot encrypt it: both refuse instead of storing something unusable.
  it('refuses a key without GitHub or while sealed', async () => {
    const mia = await harness().app.inject({
      method: 'POST',
      url: '/me/git-identity/signing-key',
      headers: { 'x-test-user': 'mia' },
    });
    expect(mia.statusCode).toBe(409);
    expect(mia.json()).toMatchObject({ code: 'github_required' });
    const sealed = harness({ sealed: true });
    const locked = await sealed.app.inject({
      method: 'POST',
      url: '/me/git-identity/signing-key',
      headers: { 'x-test-user': 'lena' },
    });
    expect(locked.json()).toMatchObject({ code: 'locked' });
    expect(sealed.comments).toEqual([]);
  });

  it('sets only the given fields and refuses values that could forge a commit header', async () => {
    const { app, rows } = harness();
    const put = (payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/me/git-identity',
        headers: { 'x-test-user': 'lena' },
        payload: payload as object,
      });
    expect((await put({ authorName: 'Lena Berg' })).statusCode).toBe(200);
    expect((await put({ authorEmail: 'lena@example.com' })).json()).toMatchObject({
      authorName: 'Lena Berg',
      authorEmail: 'lena@example.com',
    });
    expect((await put({ authorName: 'Lena\nAuthor: x' })).statusCode).toBe(400);
    expect((await put({ authorEmail: 'lena@example.com> x' })).statusCode).toBe(400);
    expect((await put({ userId: 'admin' })).statusCode).toBe(400);
    expect(rows.get('lena')).toMatchObject({
      authorName: 'Lena Berg',
      authorEmail: 'lena@example.com',
    });
    expect((await put({ authorEmail: '' })).json()).toMatchObject({ authorEmail: null });
  });
});
