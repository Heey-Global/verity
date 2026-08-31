import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import {
  createGhTokenCapabilityRegistry,
  type GhTokenCapabilityRegistry,
} from './github-token-broker.js';
import { startProjectInternalUnixListener } from './internal-listener.js';

const conductor = {} as unknown as Conductor;
const TEST_UID = process.getuid?.() ?? 1000;
const TEST_GID = process.getgid?.() ?? 1000;

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

interface BuildOpts {
  capabilities?: GhTokenCapabilityRegistry;
  mint?: (project: { owner: string; repo: string }) => Promise<string | undefined>;
  wire?: boolean;
}

function build(opts: BuildOpts = {}): FastifyInstance {
  const cipher = createSealableSecretCipher();
  const store = new EventStore(ctx.db, cipher);
  const wire = opts.wire ?? true;
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(wire
      ? {
          ghTokenCapabilities: opts.capabilities ?? createGhTokenCapabilityRegistry(ctx.db),
          ghTokenMint:
            opts.mint ?? ((p): Promise<string | undefined> => Promise.resolve(`ghs_${p.repo}`)),
        }
      : {}),
  });
}

function postUnix(
  socketPath: string,
  path: string,
  authorization: string,
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request(
      {
        socketPath,
        method: 'POST',
        path,
        headers: {
          authorization,
          ...(body !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

describe('POST /internal/github/token (GitHub-token broker)', () => {
  it('rejects a valid capability on the retired TCP path', async () => {
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const mintCalls: Array<{ owner: string; repo: string }> = [];
    const app = build({
      capabilities,
      mint: (p) => {
        mintCalls.push(p);
        return Promise.resolve('ghs_minted');
      },
    });
    try {
      const cap = await capabilities.issue({
        projectId: 'p1',
        owner: 'Heey-Global',
        repo: 'Verity',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: `Bearer ${cap}` },
      });
      expect(res.statusCode).toBe(401);
      expect(mintCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('does not parse caller-selected scope on the retired TCP path', async () => {
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const mintCalls: Array<{ owner: string; repo: string }> = [];
    const app = build({
      capabilities,
      mint: (p) => {
        mintCalls.push(p);
        return Promise.resolve('ghs_minted');
      },
    });
    try {
      const cap = await capabilities.issue({
        projectId: 'p1',
        owner: 'Heey-Global',
        repo: 'Verity',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: `Bearer ${cap}`, 'content-type': 'application/json' },
        // A malicious sandbox trying to escalate to another repo.
        payload: { owner: 'victim', repo: 'secret-repo', permissions: { contents: 'write' } },
      });
      expect(res.statusCode).toBe(401);
      expect(mintCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing capability with 401', async () => {
    const app = build();
    try {
      const res = await app.inject({ method: 'POST', url: '/internal/github/token' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('unauthorized');
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown capability with 401 (no state leak)', async () => {
    const app = build();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: 'Bearer not-a-capability' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects every project capability on the retired TCP path', async () => {
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const seen: Array<{ owner: string; repo: string }> = [];
    const app = build({
      capabilities,
      mint: (p) => {
        seen.push(p);
        return Promise.resolve('ghs_minted');
      },
    });
    try {
      await capabilities.issue({ projectId: 'p1', owner: 'a', repo: 'one' });
      const capB = await capabilities.issue({ projectId: 'p2', owner: 'b', repo: 'two' });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: `Bearer ${capB}` },
      });
      expect(res.statusCode).toBe(401);
      expect(seen).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('binds a project Unix socket to the same project capability', async () => {
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const seen: Array<{ owner: string; repo: string }> = [];
    const app = build({
      capabilities,
      mint: (project) => {
        seen.push(project);
        return Promise.resolve('ghs_minted');
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'verity-gh-uds-'));
    await app.ready();
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    const oldGenerationListener = await startProjectInternalUnixListener(app, {
      socketRoot: dir,
      identity: { projectId: 'p1', containerGeneration: 'old-generation' },
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    try {
      const store = new EventStore(ctx.db, createSealableSecretCipher());
      await store.upsertProject({
        id: 'p1',
        owner: 'a',
        repo: 'one',
        containerName: 'dev-a-one',
        state: 'active',
      });
      const capA = await capabilities.issue({
        projectId: 'p1',
        owner: 'a',
        repo: 'one',
        containerGeneration: 'generation-1',
      });
      const capB = await capabilities.issue({
        projectId: 'p2',
        owner: 'b',
        repo: 'two',
        containerGeneration: 'generation-1',
      });

      const allowed = await postUnix(
        listener.socketPath,
        '/internal/github/token',
        `Bearer ${capA}`,
      );
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({ token: 'ghs_minted' });

      const crossProject = await postUnix(
        listener.socketPath,
        '/internal/github/token',
        `Bearer ${capB}`,
      );
      expect(crossProject.status).toBe(401);
      const staleGeneration = await postUnix(
        oldGenerationListener.socketPath,
        '/internal/github/token',
        `Bearer ${capA}`,
      );
      expect(staleGeneration.status).toBe(401);
      const memoryAllowed = await postUnix(
        listener.socketPath,
        '/internal/project/memory',
        `Bearer ${capA}`,
        { text: 'generation-bound' },
      );
      expect(memoryAllowed.status).toBe(200);
      const staleMemory = await postUnix(
        oldGenerationListener.socketPath,
        '/internal/project/memory',
        `Bearer ${capA}`,
        { text: 'must-not-append' },
      );
      expect(staleMemory.status).toBe(401);
      expect((await store.getProjectSettingsRaw('p1'))?.memory).toBe('generation-bound');
      expect(seen).toEqual([{ owner: 'a', repo: 'one' }]);
    } finally {
      await oldGenerationListener.close();
      await listener.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reveal mint availability on the retired TCP path', async () => {
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const app = build({ capabilities, mint: () => Promise.resolve(undefined) });
    try {
      const cap = await capabilities.issue({ projectId: 'p1', owner: 'a', repo: 'one' });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: `Bearer ${cap}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('does not register the route when the broker is not wired', async () => {
    const app = build({ wire: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/github/token',
        headers: { authorization: 'Bearer anything' },
      });
      // No route → 404 (and it is NOT in the pre-auth allowlist either).
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
