import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import type { OnboardingStatus } from './onboarding-routes.js';

// The onboarding-status route never touches the conductor; a bare stub satisfies it.
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

/** Build an app whose secret store is backed by a fresh sealable cipher. */
function buildWithCipher(cipher: SealableSecretCipher): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
  });
}

async function getStatus(app: FastifyInstance, token?: string): Promise<OnboardingStatus> {
  const res = await app.inject({
    method: 'GET',
    url: '/onboarding/status',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function initialize(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/secret/init',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

const PASSWORD = 'correct-horse-battery';
const PEM = '-----BEGIN KEY-----\nabc\n-----END KEY-----';

describe('GET /onboarding/status', () => {
  it('reports an empty first-run state and points at master-password (works while sealed)', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      // Fresh store: sealed (no key), nothing configured. The endpoint answers
      // WITHOUT unlocking — it is the pre-unlock gate.
      expect(cipher.isSealed()).toBe(true);
      const status = await getStatus(app);
      expect(status).toEqual({
        sealed: true,
        masterPasswordSet: false,
        githubAppConfigured: false,
        signingKeyConfigured: false,
        hasProject: false,
        dopplerConfigured: false,
        claudeConfigured: false,
        codexConfigured: false,
        complete: false,
        nextStep: 'master-password',
      });
    } finally {
      await app.close();
    }
  });

  it('does not treat deployment env as completed onboarding state', async () => {
    const prev = {
      appId: process.env.VERITY_GH_APP_ID,
      installationId: process.env.VERITY_GH_DEFAULT_INSTALLATION_ID,
      signingKeyPath: process.env.VERITY_GIT_SSH_PRIVATE_KEY_PATH,
    };
    process.env.VERITY_GH_APP_ID = '3836338';
    process.env.VERITY_GH_DEFAULT_INSTALLATION_ID = '135112757';
    process.env.VERITY_GIT_SSH_PRIVATE_KEY_PATH = '/data/dev/.shared/github/id_ed25519';

    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      const status = await getStatus(app);
      expect(status.githubAppConfigured).toBe(false);
      expect(status.signingKeyConfigured).toBe(false);
      expect(status.hasProject).toBe(false);
      expect(status.nextStep).toBe('master-password');
    } finally {
      await app.close();
      if (prev.appId === undefined) delete process.env.VERITY_GH_APP_ID;
      else process.env.VERITY_GH_APP_ID = prev.appId;
      if (prev.installationId === undefined) delete process.env.VERITY_GH_DEFAULT_INSTALLATION_ID;
      else process.env.VERITY_GH_DEFAULT_INSTALLATION_ID = prev.installationId;
      if (prev.signingKeyPath === undefined) delete process.env.VERITY_GIT_SSH_PRIVATE_KEY_PATH;
      else process.env.VERITY_GIT_SSH_PRIVATE_KEY_PATH = prev.signingKeyPath;
    }
  });

  it('reports Claude configured from stored credentials JSON', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      const token = await initialize(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          claudeCodeOauthCredentialsJson: JSON.stringify({
            claudeAiOauth: { accessToken: 'claude-access' },
          }),
        },
      });

      const status = await getStatus(app, token);
      expect(status.claudeConfigured).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('advances nextStep as each required step is completed, ending null when complete', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      // 1. Set the master password (init) → unlocked; nextStep advances to github.
      const token = await initialize(app);
      let status = await getStatus(app, token);
      expect(status.sealed).toBe(false); // init unlocks the cipher
      expect(status.masterPasswordSet).toBe(true);
      expect(status.nextStep).toBe('github');
      expect(status.complete).toBe(false);

      // 2. Connect GitHub. The combined GitHub step remains active until the
      // signing key is also ready.
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          githubAppId: '123',
          githubAppInstallationId: '456',
          githubAppPrivateKey: PEM,
        },
      });
      status = await getStatus(app, token);
      expect(status.githubAppConfigured).toBe(true);
      expect(status.nextStep).toBe('github');

      // 3. Configure a signing key (inline SSH key) → nextStep = first-project.
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitSshPrivateKey: PEM },
      });
      status = await getStatus(app, token);
      expect(status.signingKeyConfigured).toBe(true);
      expect(status.nextStep).toBe('first-project');
      expect(status.complete).toBe(false);

      // 4. Add and prepare a project → complete, nextStep null. Doppler is NOT required.
      await app.inject({ method: 'POST', url: '/projects', payload: { repo: 'octo/repo' } });
      const project = await ctx.store.getProjectByOwnerRepo('octo', 'repo');
      expect(project).toMatchObject({ state: 'absent' });
      await ctx.store.updateProjectState(project!.id, 'active');
      status = await getStatus(app, token);
      expect(status.hasProject).toBe(true);
      expect(status.complete).toBe(true);
      expect(status.nextStep).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('partial GitHub App config does not count as configured (all three fields required)', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      const token = await initialize(app);
      // Only id + installation id, no private key → still not configured.
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { githubAppId: '123', githubAppInstallationId: '456' },
      });
      const status = await getStatus(app, token);
      expect(status.githubAppConfigured).toBe(false);
      expect(status.nextStep).toBe('github');
    } finally {
      await app.close();
    }
  });

  it('accepts a signing-key PATH (not just an inline key) as configured', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      const token = await initialize(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { gitSshPrivateKeyPath: '/data/keys/id' },
      });
      const status = await getStatus(app, token);
      expect(status.signingKeyConfigured).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('dopplerConfigured reflects token presence but never gates complete/nextStep (#320)', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithCipher(cipher);
    try {
      const token = await initialize(app);
      // Before any token: informational flag is false.
      let status = await getStatus(app, token);
      expect(status.dopplerConfigured).toBe(false);
      // nextStep is still driven by the required steps (github first, unconfigured).
      const nextStepBefore = status.nextStep;
      const completeBefore = status.complete;

      // Save an account Doppler token (neutral fixture — not a real token).
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: 'doppler-service-token-fixture-value' },
      });
      status = await getStatus(app, token);
      // Presence flips the informational flag...
      expect(status.dopplerConfigured).toBe(true);
      // ...but does NOT change complete or nextStep (Doppler is optional).
      expect(status.complete).toBe(completeBefore);
      expect(status.nextStep).toBe(nextStepBefore);
    } finally {
      await app.close();
    }
  });

  it('reports the sealed flag true after a restart re-seals the cipher (still answers)', async () => {
    // Init a password under a first cipher (persists salt + verifier).
    const first = createSealableSecretCipher();
    const app1 = buildWithCipher(first);
    const token = await initialize(app1);
    await app1.close();

    // "Restart": a brand-new sealed cipher over the SAME db. The gate still answers
    // while sealed and reports the password as set (a sealed-safe meta read).
    const second = createSealableSecretCipher();
    const app2 = buildWithCipher(second);
    try {
      expect(second.isSealed()).toBe(true);
      const status = await getStatus(app2, token);
      expect(status.sealed).toBe(true);
      expect(status.masterPasswordSet).toBe(true);
      expect(status.nextStep).toBe('github');
    } finally {
      await app2.close();
    }
  });

  it('treats an unmanaged deployment (no cipher) as never sealed', async () => {
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
    });
    try {
      const status = await getStatus(app);
      expect(status.sealed).toBe(false);
      // masterPasswordSet is false (no meta), so nextStep is still master-password.
      expect(status.masterPasswordSet).toBe(false);
      expect(status.nextStep).toBe('master-password');
    } finally {
      await app.close();
    }
  });
});
