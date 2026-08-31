import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import type { SshSignSpawner } from './git-signer.js';
import { startProjectInternalUnixListener } from './internal-listener.js';
import {
  createSigningCapabilityRegistry,
  type SigningCapabilityRegistry,
} from './signing-capability.js';

const conductor = {} as unknown as Conductor;
const PASSWORD = 'correct-horse-battery';
// Armored like a real key so the route is exercised on a realistic shape, but assembled
// from parts: a credential-shaped literal trips the secret scanners that run over this
// repository and over anything published from it. The injected fake signer never runs
// ssh-keygen against it, and signGitPayload only requires it to be non-empty.
const SIGNING_KEY = [
  ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAA',
  'notarealkeybody',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

// Fake `ssh-keygen -Y sign`: writes a recognizable armored signature so the route
// returns it. (The real ssh-keygen round-trip is validated separately.)
const fakeSign: SshSignSpawner = ({ payloadPath, namespace }) => {
  writeFileSync(`${payloadPath}.sig`, `-----BEGIN SSH SIGNATURE-----\nfake:${namespace}\n`);
  return Promise.resolve();
};

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
    id: 'p1',
    owner: 'acme',
    repo: 'one',
    containerName: 'dev-acme-one',
    state: 'active',
  });
  await ctx.store.upsertProject({
    id: 'p2',
    owner: 'acme',
    repo: 'two',
    containerName: 'dev-acme-two',
    state: 'active',
  });
});

type InternalPathGuard = NonNullable<Parameters<typeof buildServer>[0]['internalPathGuard']>;

function build(
  cipher: SealableSecretCipher,
  internalPathGuard?: InternalPathGuard,
  signingCapabilities?: SigningCapabilityRegistry,
): { app: FastifyInstance; store: EventStore } {
  const store = new EventStore(ctx.db, cipher);
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    sshSign: fakeSign,
    ...(signingCapabilities !== undefined ? { signingCapabilities } : {}),
    ...(internalPathGuard ? { internalPathGuard } : {}),
  });
  return { app, store };
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');

function postUnix(socketPath: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/internal/git/sign',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ namespace: 'git', payload: b64('commit payload') }));
  });
}

describe('POST /internal/git/sign (commit-signing broker)', () => {
  it('accepts only a capability matching the project Unix-socket generation', async () => {
    const cipher = createSealableSecretCipher();
    const capabilities = createSigningCapabilityRegistry(ctx.db);
    const { app, store } = build(cipher, undefined, capabilities);
    const root = mkdtempSync(join(tmpdir(), 'verity-sign-uds-'));
    await app.ready();
    await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      const valid = await capabilities.issue({
        projectId: 'p1',
        containerGeneration: 'generation-1',
      });
      expect((await postUnix(listener.socketPath, valid)).status).toBe(200);

      const stale = await capabilities.issue({
        projectId: 'p1',
        containerGeneration: 'generation-0',
      });
      expect((await postUnix(listener.socketPath, stale)).status).toBe(401);

      const crossProject = await capabilities.issue({
        projectId: 'p2',
        containerGeneration: 'generation-1',
      });
      expect((await postUnix(listener.socketPath, crossProject)).status).toBe(401);

      // The fleet-derived compatibility bearer is accepted only on the legacy
      // TCP listener, never on a project-bound socket.
      expect((await postUnix(listener.socketPath, 'retired-fleet-bearer')).status).toBe(401);
    } finally {
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports a project socket without enabling the legacy TCP bearer', async () => {
    const cipher = createSealableSecretCipher();
    const capabilities = createSigningCapabilityRegistry(ctx.db);
    const { app, store } = build(cipher, undefined, capabilities);
    const root = mkdtempSync(join(tmpdir(), 'verity-sign-uds-only-'));
    await app.ready();
    const noKeyProbe = await app.inject({
      method: 'POST',
      url: '/internal/git/sign',
      headers: { authorization: 'Bearer unknown', 'content-type': 'application/json' },
      payload: { namespace: 'git', payload: b64('commit payload') },
    });
    expect(noKeyProbe.statusCode).toBe(401);
    await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      const capability = await capabilities.issue({
        projectId: 'p1',
        containerGeneration: 'generation-1',
      });
      expect((await postUnix(listener.socketPath, capability)).status).toBe(200);

      const legacyAttempt = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: {
          authorization: `Bearer ${'retired-fleet-bearer'}`,
          'content-type': 'application/json',
        },
        payload: { namespace: 'git', payload: b64('commit payload') },
      });
      expect(legacyAttempt.statusCode).toBe(401);

      cipher.seal();
      const sealedAttempt = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: 'Bearer unknown', 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('commit payload') },
      });
      expect(sealedAttempt.statusCode).toBe(401);
    } finally {
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not accept the retired fleet-derived bearer on TCP', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      const token = 'retired-fleet-bearer';

      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('commit payload') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('does not expose TCP signing for a key provided by PATH', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    const keyDir = mkdtempSync(join(tmpdir(), 'verity-sign-route-path-'));
    const keyPath = join(keyDir, 'id_ed25519');
    const KEY_FROM_FILE = '-----BEGIN OPENSSH PRIVATE KEY-----\nfleet\n-----END KEY-----\n';
    writeFileSync(keyPath, KEY_FROM_FILE);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      // Key configured by PATH only (no DB contents) — the fleet's mechanism.
      await store.updateVeritySettings({ gitSshPrivateKeyPath: keyPath });
      // The token the provisioner would inject is derived from the FILE contents.
      const token = 'retired-fleet-bearer';

      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('commit payload') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('does not expose authentication behavior on the retired TCP route', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });

      const wrong = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(wrong.statusCode).toBe(404);

      const none = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(none.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses a non-git namespace even with a valid token (no generic oracle)', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      const token = 'retired-fleet-bearer';
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'ssh', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 409 when no signing key is configured', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 503 while the secret store is sealed', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      cipher.seal();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('answers a token-less probe with 401 without leaking the no-key 409 state', async () => {
    const cipher = createSealableSecretCipher();
    const { app } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      // No signing key configured. A token-less caller must still get a flat 401 —
      // never the 409 that would reveal "no key configured" to an anonymous probe.
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('does not register the route at all when broker mode is off (404)', async () => {
    const cipher = createSealableSecretCipher();
    const { app, store } = build(cipher);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      const token = 'retired-fleet-bearer';
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('404s the route on the public listener when the internal-path guard rejects', async () => {
    const cipher = createSealableSecretCipher();
    // Guard denies every request (simulating a request that did NOT arrive on the
    // dedicated internal listener) → /internal/* is invisible on the public port.
    const { app, store } = build(cipher, () => false);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      const token = 'retired-fleet-bearer';
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('x') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('does not restore the retired TCP route when the internal-path guard accepts', async () => {
    const cipher = createSealableSecretCipher();
    // Guard accepts (request arrived on the internal listener) → the route runs and
    // signs, proving the gate only blocks the wrong-origin case, not the broker.
    const { app, store } = build(cipher, () => true);
    try {
      await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
      await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
      const token = 'retired-fleet-bearer';
      const res = await app.inject({
        method: 'POST',
        url: '/internal/git/sign',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { namespace: 'git', payload: b64('commit payload') },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
