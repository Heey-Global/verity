// Server-side signing-key generation (#320, onboarding PR 2b): the
// `POST /settings/signing-key/generate` route + the `generateSigningKey` helper.
//
//   1. Route: sealed → {ok:false,error:'locked'} and the keygen spawner is NOT
//      called; an injected FAKE spawner writes fixture key files → the keys are
//      stored (both gitSshPrivateKey + gitSshPublicKey) and the response carries
//      the PUBLIC key + allowedSigners but NEVER the private key; allowedSigners
//      uses the stored git email when set.
//   2. Helper: the temp dir is cleaned up even when the spawner throws.
//
// The private key is generated at runtime (no key-shaped literal → gitleaks-clean).
import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { deriveAllowedSigners, generateSigningKey, type SshKeygenSpawner } from './signing-key.js';

const conductor = {} as unknown as Conductor;

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

const PASSWORD = 'correct-horse-battery';

/** A real ed25519 OpenSSH private key computed at runtime — never a hard-coded key
 *  literal, so gitleaks has nothing to trip on. Returned as an OpenSSH-format PEM
 *  plus its matching public line so the fake spawner can write both files. */
function fakeOpenSshKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    // A plausible OpenSSH public line shape; the exact base64 body is irrelevant to
    // the behaviour under test (we assert routing/storage/redaction, not crypto).
    publicKey: `ssh-ed25519 ${publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64')} test@verity`,
  };
}

/** Fake `ssh-keygen`: writes the provided key material to `<keyPath>` and
 *  `<keyPath>.pub`, exactly like the real tool, so the route reads it back. */
function fakeSpawner(keys: { privateKey: string; publicKey: string }): SshKeygenSpawner {
  return ({ keyPath }) => {
    writeFileSync(keyPath, keys.privateKey);
    writeFileSync(`${keyPath}.pub`, `${keys.publicKey}\n`);
    return Promise.resolve();
  };
}

function build(
  cipher: SealableSecretCipher,
  sshKeygen?: SshKeygenSpawner,
  resolveGitHubAppIdentity?: () => Promise<
    { ok: boolean; name?: string; email?: string; error?: string } | undefined
  >,
): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(sshKeygen ? { sshKeygen } : {}),
    ...(resolveGitHubAppIdentity ? { resolveGitHubAppIdentity } : {}),
  });
}

async function unlock(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/secret/init',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

describe('POST /settings/signing-key/generate route', () => {
  it('returns {ok:false,error:"locked"} while sealed and never calls the spawner', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const spawner: SshKeygenSpawner = () => {
      called = true;
      return Promise.resolve();
    };
    const app = build(cipher, spawner);
    try {
      // Sealed (no init) → locked, spawner untouched (we can't store the key).
      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'locked' });
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('stores both keys encrypted and returns ONLY the public material', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    const app = build(cipher, fakeSpawner(keys));
    try {
      await unlock(app);
      // Set the git email first so the comment + allowed_signers principal use it.
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitUserEmail: 'dev@verity.test' },
      });

      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        ok: boolean;
        publicKey?: string;
        allowedSigners?: string;
      }>();
      expect(body.ok).toBe(true);
      expect(body.publicKey).toBe(keys.publicKey);
      // allowedSigners uses the stored email as the principal.
      expect(body.allowedSigners).toBe(`dev@verity.test namespaces="git" ${keys.publicKey}`);
      // The PRIVATE key must NEVER surface in the response.
      expect(JSON.stringify(body)).not.toContain(keys.privateKey);
      expect(body).not.toHaveProperty('privateKey');

      // Both keys were stored — read them back decrypted from the store.
      const store = new EventStore(ctx.db, cipher);
      const settings = await store.getVeritySettings();
      expect(settings?.gitSshPrivateKey).toBe(keys.privateKey.trim());
      expect(settings?.gitSshPublicKey).toBe(keys.publicKey.trim());
      // allowed_signers is persisted (not just returned on the wire) so the
      // provisioner can mount it for local signature verification.
      expect(settings?.gitAllowedSigners).toBe(
        `dev@verity.test namespaces="git" ${keys.publicKey}`,
      );
    } finally {
      await app.close();
    }
  });

  it('returns the pubkey with a principal-less allowedSigners when no email is set', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    const app = build(cipher, fakeSpawner(keys));
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      const body = res.json<{ ok: boolean; publicKey?: string; allowedSigners?: string }>();
      expect(body.ok).toBe(true);
      expect(body.publicKey).toBe(keys.publicKey);
      // No email → the principal is omitted (the email is still needed) but the
      // pubkey is returned regardless (no failure).
      expect(body.allowedSigners).toBe(`namespaces="git" ${keys.publicKey}`);
    } finally {
      await app.close();
    }
  });

  it('derives the git identity from the GitHub App when no email is set', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    const derived = { ok: true, name: 'octocat', email: '42+octocat@users.noreply.github.com' };
    const app = build(cipher, fakeSpawner(keys), () => Promise.resolve(derived));
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      const body = res.json<{ ok: boolean; allowedSigners?: string }>();
      expect(body.ok).toBe(true);
      // allowed_signers uses the DERIVED no-reply email as its principal.
      expect(body.allowedSigners).toBe(
        `42+octocat@users.noreply.github.com namespaces="git" ${keys.publicKey}`,
      );
      // The derived identity is persisted to settings for the provisioner to reuse.
      const settings = await new EventStore(ctx.db, cipher).getVeritySettings();
      expect(settings?.gitUserName).toBe('octocat');
      expect(settings?.gitUserEmail).toBe('42+octocat@users.noreply.github.com');
    } finally {
      await app.close();
    }
  });

  it('does not overwrite an already-set email with the App identity', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    let resolverCalled = false;
    const app = build(cipher, fakeSpawner(keys), () => {
      resolverCalled = true;
      return Promise.resolve({ ok: true, name: 'octocat', email: 'bot@noreply' });
    });
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitUserEmail: 'dev@verity.test' },
      });
      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      const body = res.json<{ ok: boolean; allowedSigners?: string }>();
      expect(body.ok).toBe(true);
      expect(body.allowedSigners).toBe(`dev@verity.test namespaces="git" ${keys.publicKey}`);
      // A pre-set email short-circuits the derivation entirely.
      expect(resolverCalled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('accepts a body-supplied identity and skips App derivation (org-install path)', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    // An org installation cannot yield a signing identity — the resolver would fail.
    let resolverCalled = false;
    const app = build(cipher, fakeSpawner(keys), () => {
      resolverCalled = true;
      return Promise.resolve({ ok: false, error: 'installed on an organization' });
    });
    try {
      await unlock(app);
      // The operator supplies a personal identity in the request body.
      const res = await app.inject({
        method: 'POST',
        url: '/settings/signing-key/generate',
        payload: { gitUserName: 'h-teske', gitUserEmail: 'me@personal.test' },
      });
      const body = res.json<{ ok: boolean; allowedSigners?: string }>();
      expect(body.ok).toBe(true);
      // The supplied email is the allowed_signers principal…
      expect(body.allowedSigners).toBe(`me@personal.test namespaces="git" ${keys.publicKey}`);
      // …and the org-App derivation is never attempted.
      expect(resolverCalled).toBe(false);
      // Body identity is persisted for the provisioner to reuse.
      const settings = await new EventStore(ctx.db, cipher).getVeritySettings();
      expect(settings?.gitUserName).toBe('h-teske');
      expect(settings?.gitUserEmail).toBe('me@personal.test');
    } finally {
      await app.close();
    }
  });

  it('fails the generation when the App is an organization installation', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    let spawnerCalled = false;
    const spawner: SshKeygenSpawner = (args) => {
      spawnerCalled = true;
      return fakeSpawner(keys)(args);
    };
    const app = build(cipher, spawner, () =>
      Promise.resolve({ ok: false, error: 'the GitHub App is installed on an organization' }),
    );
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: 'the GitHub App is installed on an organization',
      });
      // No key is generated when the identity can't be derived.
      expect(spawnerCalled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('generateSigningKey helper', () => {
  it('cleans up the temp dir even when the spawner throws', async () => {
    let seenKeyPath = '';
    const throwingSpawner: SshKeygenSpawner = ({ keyPath }) => {
      seenKeyPath = keyPath;
      return Promise.reject(new Error('ssh-keygen boom'));
    };
    await expect(generateSigningKey('dev@verity.test', throwingSpawner)).rejects.toThrow(
      'ssh-keygen boom',
    );
    // The temp dir (the parent of the key path) must be gone despite the failure.
    expect(seenKeyPath).not.toBe('');
    expect(existsSync(seenKeyPath)).toBe(false);
    // And its containing directory is removed too.
    const dir = seenKeyPath.slice(0, seenKeyPath.lastIndexOf('/'));
    expect(existsSync(dir)).toBe(false);
  });

  it('reads back the generated key material and derives allowed_signers', async () => {
    const keys = fakeOpenSshKeypair();
    let dir = '';
    const result = await generateSigningKey('dev@verity.test', ({ keyPath }) => {
      dir = keyPath.slice(0, keyPath.lastIndexOf('/'));
      writeFileSync(keyPath, keys.privateKey);
      writeFileSync(`${keyPath}.pub`, `${keys.publicKey}\n`);
      // Prove the private key existed on disk transiently before cleanup.
      expect(readFileSync(keyPath, 'utf8')).toBe(keys.privateKey);
      return Promise.resolve();
    });
    expect(result.privateKey).toBe(keys.privateKey);
    expect(result.publicKey).toBe(keys.publicKey);
    expect(result.allowedSigners).toBe(`dev@verity.test namespaces="git" ${keys.publicKey}`);
    // Temp dir cleaned up on the happy path too.
    expect(existsSync(dir)).toBe(false);
  });
});

describe('deriveAllowedSigners', () => {
  it('rejects an email with embedded whitespace/newline (no malformed multi-line entry)', () => {
    const pub = 'ssh-ed25519 AAAAFAKEPUBLICKEYVALUE';
    // A crafted email with a newline must not split the allowed_signers line.
    const line = deriveAllowedSigners(pub, 'evil@x\nssh-ed25519 INJECTED');
    expect(line).toBe(`namespaces="git" ${pub}`);
    expect(line).not.toContain('INJECTED');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('GET /settings/signing-key route', () => {
  it('returns configured=false, publicKey=null before any key is set', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, fakeSpawner(fakeOpenSshKeypair()));
    try {
      await unlock(app);
      const res = await app.inject({ method: 'GET', url: '/settings/signing-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false, publicKey: null });
    } finally {
      await app.close();
    }
  });

  it('re-displays the stored public key after generation (public material)', async () => {
    const cipher = createSealableSecretCipher();
    const keys = fakeOpenSshKeypair();
    const app = build(cipher, fakeSpawner(keys));
    try {
      await unlock(app);
      await app.inject({ method: 'POST', url: '/settings/signing-key/generate' });
      const res = await app.inject({ method: 'GET', url: '/settings/signing-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: true, publicKey: keys.publicKey.trim() });
    } finally {
      await app.close();
    }
  });
});
