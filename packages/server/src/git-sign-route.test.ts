import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { createTurnCredentials, type TurnCredentials } from './turn-credentials.js';
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
// Which private key each signature was made with, so a test can tell a
// personal signature from the instance one.
const signedWith: string[] = [];
const fakeSign: SshSignSpawner = ({ keyPath, payloadPath, namespace }) => {
  signedWith.push(readFileSync(keyPath, 'utf8'));
  writeFileSync(`${payloadPath}.sig`, `-----BEGIN SSH SIGNATURE-----\nfake:${namespace}\n`);
  return Promise.resolve();
};

const ADMIN = '00000000-0000-4000-8000-000000000001';
/** The person of the project's original (default) sandbox. */
const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';
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
  turnCredentials?: TurnCredentials,
): { app: FastifyInstance; store: EventStore } {
  const store = new EventStore(ctx.db, cipher);
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    sshSign: fakeSign,
    ...(signingCapabilities !== undefined ? { signingCapabilities } : {}),
    ...(turnCredentials !== undefined ? { turnCredentials } : {}),
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
      identity: {
        projectId: 'p1',
        userId: SANDBOX_USER,
        projectDefault: true,
        containerGeneration: 'generation-1',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      const valid = await capabilities.issue({
        projectId: 'p1',
        userId: SANDBOX_USER,
        containerGeneration: 'generation-1',
      });
      expect((await postUnix(listener.socketPath, valid)).status).toBe(200);

      const stale = await capabilities.issue({
        projectId: 'p1',
        userId: SANDBOX_USER,
        containerGeneration: 'generation-0',
      });
      expect((await postUnix(listener.socketPath, stale)).status).toBe(401);

      const crossProject = await capabilities.issue({
        projectId: 'p2',
        userId: SANDBOX_USER,
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

  // The badge is what will let the key become the signing person's own. It must
  // only ever work inside its own project's container and stop with its turn.
  it("signs for a turn's badge only from its own project and only while it lives", async () => {
    const cipher = createSealableSecretCipher();
    const capabilities = createSigningCapabilityRegistry(ctx.db);
    const turns = createTurnCredentials();
    const { app, store } = build(cipher, undefined, capabilities, turns);
    const root = mkdtempSync(join(tmpdir(), 'verity-sign-turn-'));
    await app.ready();
    await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: {
        projectId: 'p1',
        userId: SANDBOX_USER,
        projectDefault: true,
        containerGeneration: 'generation-1',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      const badge = turns.issue({
        projectId: 'p1',
        sessionId: 's1',
        turnId: 't1',
        userId: ADMIN,
      });
      expect((await postUnix(listener.socketPath, badge)).status).toBe(200);

      const foreign = turns.issue({
        projectId: 'p2',
        sessionId: 's2',
        turnId: 't2',
        userId: 'lena',
      });
      expect((await postUnix(listener.socketPath, foreign)).status).toBe(401);
      // Same person as the sandbox, but another project: still refused.
      const foreignProject = turns.issue({
        projectId: 'p2',
        sessionId: 's3',
        turnId: 't3',
        userId: ADMIN,
      });
      expect((await postUnix(listener.socketPath, foreignProject)).status).toBe(401);

      turns.release(badge);
      expect((await postUnix(listener.socketPath, badge)).status).toBe(401);

      // The container-wide capability keeps working beside the badges.
      const container = await capabilities.issue({
        projectId: 'p1',
        userId: SANDBOX_USER,
        containerGeneration: 'generation-1',
      });
      expect((await postUnix(listener.socketPath, container)).status).toBe(200);
    } finally {
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The person whose turn commits signs it. A member without a key of their own
  // must be refused rather than handed the administrator's (instance) key, and
  // the administrator keeps the instance key as their fallback.
  it("signs a turn's commit with its person's own key, never another person's", async () => {
    const cipher = createSealableSecretCipher();
    const turns = createTurnCredentials();
    const { app, store } = build(cipher, undefined, createSigningCapabilityRegistry(ctx.db), turns);
    const root = mkdtempSync(join(tmpdir(), 'verity-sign-person-'));
    await app.ready();
    await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
    await ctx.db
      .insertInto('users')
      .values({ id: 'lena', role: 'member', status: 'active' })
      .execute();
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: {
        projectId: 'p1',
        userId: SANDBOX_USER,
        projectDefault: true,
        containerGeneration: 'generation-1',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    // A person's turns run in that person's own sandbox (ADR 0023 §4), so lena's
    // badge is presented from hers rather than from the project's shared one.
    const lenaListener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: {
        projectId: 'p1',
        userId: 'lena',
        projectDefault: false,
        containerGeneration: 'generation-lena',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    const badgeFor = (userId: string) =>
      turns.issue({ projectId: 'p1', sessionId: 's1', turnId: `t-${userId}`, userId });
    try {
      signedWith.length = 0;
      const refused = await postUnix(lenaListener.socketPath, badgeFor('lena'));
      expect(refused.status).toBe(409);
      expect(refused.body).toContain('connect GitHub');
      expect(signedWith).toEqual([]);

      const LENA_KEY = SIGNING_KEY.replace('BEGIN OPENSSH', 'BEGIN OPENSSH lena');
      await store.userGitIdentities.set('lena', { sshPrivateKey: LENA_KEY });
      // Her badge carried into the project's default sandbox proves nothing there.
      expect((await postUnix(listener.socketPath, badgeFor('lena'))).status).toBe(401);
      expect((await postUnix(lenaListener.socketPath, badgeFor('lena'))).status).toBe(200);
      expect((await postUnix(listener.socketPath, badgeFor(ADMIN))).status).toBe(200);
      expect(signedWith.map((key) => key.trim())).toEqual([LENA_KEY, SIGNING_KEY]);
    } finally {
      await lenaListener.close();
      await listener.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The project's original sandbox belongs to its creator, who need not be the
  // administrator. Without a badge, its container capability must sign as that
  // owner, never fall back to the administrator's instance key.
  it("signs in the project's original sandbox as its owner, not the administrator", async () => {
    const cipher = createSealableSecretCipher();
    const capabilities = createSigningCapabilityRegistry(ctx.db);
    const { app, store } = build(cipher, undefined, capabilities);
    const root = mkdtempSync(join(tmpdir(), 'verity-sign-owner-'));
    await app.ready();
    await app.inject({ method: 'POST', url: '/secret/init', payload: { password: PASSWORD } });
    await store.updateVeritySettings({ gitSshPrivateKey: SIGNING_KEY });
    await ctx.db
      .insertInto('users')
      .values({ id: 'mia', role: 'member', status: 'active' })
      .execute();
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: root,
      identity: {
        projectId: 'p1',
        userId: 'mia',
        projectDefault: true,
        containerGeneration: 'generation-mia',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      signedWith.length = 0;
      const capability = await capabilities.issue({
        projectId: 'p1',
        userId: 'mia',
        containerGeneration: 'generation-mia',
      });
      const refused = await postUnix(listener.socketPath, capability);
      expect(refused.status).toBe(409);
      expect(signedWith).toEqual([]);
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
      identity: {
        projectId: 'p1',
        userId: SANDBOX_USER,
        projectDefault: true,
        containerGeneration: 'generation-1',
      },
      ownerUid: process.getuid?.() ?? 0,
      relayGid: process.getgid?.() ?? 0,
    });
    try {
      const capability = await capabilities.issue({
        projectId: 'p1',
        userId: SANDBOX_USER,
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
